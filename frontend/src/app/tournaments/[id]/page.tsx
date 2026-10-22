"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import PendingButton from "@/components/PendingButton";
import {
  ClosedTradesTable,
  OpenPositionsTable,
} from "@/components/TradeHistoryTables";
import {
  apiJoinTournament,
  apiTournament,
  apiTournamentMe,
  apiTournamentStandings,
  apiTournamentTrades,
  type Position,
  type Tournament,
  type TournamentBoardRow,
  type TournamentMyResponse,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

function money(n: string | number) {
  const v = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(v)) return "—";
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function pct(n: string | number) {
  const v = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(v)) return "—";
  const digits = Math.abs(v) > 0 && Math.abs(v) < 0.01 ? 4 : 2;
  return `${v.toFixed(digits)}%`;
}

function fmtWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function pnlClass(n: string | number) {
  const v = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(v)) return "";
  return v >= 0 ? "text-accent" : "text-danger";
}

function MarketBoardTable({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle: string;
  rows: TournamentBoardRow[];
}) {
  return (
    <section className="mt-8">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted">{subtitle}</p>
      <div className="mt-3 overflow-x-auto border border-border">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="eyebrow px-4 py-3 font-normal">#</th>
              <th className="eyebrow px-4 py-3 font-normal">Trader</th>
              <th className="eyebrow px-4 py-3 font-normal text-accent">ROI</th>
              <th className="eyebrow px-4 py-3 font-normal">Win rate</th>
              <th className="eyebrow px-4 py-3 font-normal">Closed</th>
              <th className="eyebrow px-4 py-3 font-normal">PnL</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-muted">
                  No closed trades on this board yet.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={`${title}-${r.username}`} className="border-b border-border/50">
                  <td className="px-4 py-3 text-muted">{r.rank}</td>
                  <td className="px-4 py-3">{r.username}</td>
                  <td className={`px-4 py-3 font-semibold ${pnlClass(r.roi_pct)}`}>
                    {pct(r.roi_pct)}
                  </td>
                  <td className="px-4 py-3">
                    {pct(r.win_rate_pct)}
                    <span className="ml-1.5 text-xs text-muted">
                      {r.winning_trades}W/
                      {Math.max(0, r.closed_trades - r.winning_trades)}L
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted">{r.closed_trades}</td>
                  <td className={`px-4 py-3 ${pnlClass(r.realized_pnl)}`}>
                    {money(r.realized_pnl)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function TournamentDetailPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const params = useParams();
  const id = Number(params.id);

  const [t, setT] = useState<Tournament | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [liveBoards, setLiveBoards] = useState<{
    spot: TournamentBoardRow[];
    futures: TournamentBoardRow[];
  } | null>(null);
  const [trades, setTrades] = useState<(Position & { username: string })[]>([]);
  const [mine, setMine] = useState<TournamentMyResponse | null>(null);

  const isAdmin = user?.role === "admin";
  const isTrader = user?.role === "trader";

  const refresh = useCallback(async () => {
    if (!Number.isFinite(id)) return;
    setError(null);
    try {
      const data = await apiTournament(id);
      setT(data);

      // Own performance + history: joined trader, while tournament is not ended
      if (data.i_joined && data.status !== "ended" && user?.role === "trader") {
        try {
          setMine(await apiTournamentMe(id));
        } catch {
          setMine(null);
        }
      } else {
        setMine(null);
      }

      if (data.status === "ended" || isAdmin) {
        try {
          const tr = await apiTournamentTrades(id);
          setTrades(tr);
        } catch {
          setTrades([]);
        }
      } else {
        setTrades([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [id, isAdmin, user?.role]);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  useEffect(() => {
    if (!user || !Number.isFinite(id)) return;
    void refresh();
  }, [user, id, refresh]);

  // Refresh own book while live
  useEffect(() => {
    if (!t?.i_joined || t.status !== "live" || user?.role !== "trader") return;
    const timer = setInterval(() => {
      void apiTournamentMe(id)
        .then(setMine)
        .catch(() => {});
    }, 10_000);
    return () => clearInterval(timer);
  }, [t?.i_joined, t?.status, id, user?.role]);

  async function onJoin() {
    setBusy(true);
    setError(null);
    try {
      await apiJoinTournament(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Join failed");
    } finally {
      setBusy(false);
    }
  }

  async function onStandings() {
    setBusy(true);
    setError(null);
    try {
      const data = await apiTournamentStandings(id);
      setLiveBoards(
        data.boards ?? { spot: [], futures: [] }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Standings failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading || !user || !t) {
    return (
      <>
        <Navbar />
        <main className="pt-40 px-6 text-muted">
          {error || "Loading tournament…"}
        </main>
      </>
    );
  }

  const showMyDesk = Boolean(mine && t.i_joined && t.status !== "ended");

  return (
    <>
      <Navbar />
      <main className="relative min-h-screen pt-28 pb-24">
        <div className="mx-auto max-w-5xl px-6">
          <Link
            href="/tournaments"
            className="text-sm text-muted hover:text-foreground"
          >
            ← All tournaments
          </Link>
          <h1 className="statement mt-4 text-4xl">{t.name}</h1>
          <p className="mt-2 text-sm uppercase tracking-wider text-muted">
            {t.status}
          </p>
          <p className="mt-2 text-sm text-muted">
            Organized by{" "}
            <span className="text-foreground">@{t.organizer}</span>
          </p>
          <p className="thin mt-4 text-muted">
            {fmtWhen(t.start_at)} → {fmtWhen(t.end_at)}
          </p>
          <p className="mt-2 text-sm text-muted">
            Entry {money(t.entry_fee)} · {t.entrant_count}/{t.max_participants}{" "}
            · prize pool est. {money(t.prize_pool_estimate)} · capital{" "}
            {money(t.starting_capital)} each (spot + futures)
          </p>

          {error ? (
            <p className="mt-4 text-sm text-danger">{error}</p>
          ) : null}

          <div className="mt-6 flex flex-wrap gap-2">
            {isTrader && t.status === "scheduled" && !t.i_joined ? (
              <PendingButton
                type="button"
                pending={busy}
                pendingLabel="Joining…"
                onClick={onJoin}
                className="!w-auto rounded-full bg-accent px-4 py-2 text-sm font-semibold text-black"
              >
                Join (pay stub)
              </PendingButton>
            ) : null}
            {isTrader && t.i_joined && t.status === "live" ? (
              <Link
                href={`/trade?tournament=${t.id}`}
                className="rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-black"
              >
                Open tournament terminal
              </Link>
            ) : null}
            {isAdmin ? (
              <PendingButton
                type="button"
                pending={busy}
                pendingLabel="Loading…"
                onClick={onStandings}
                className="!w-auto rounded-full border border-border px-4 py-2 text-sm"
              >
                Refresh standings
              </PendingButton>
            ) : null}
          </div>

          {showMyDesk && mine ? (
            <>
              <section className="mt-10">
                <h2 className="text-lg font-semibold">Your performance</h2>
                <p className="mt-1 text-sm text-muted">
                  Only you can see this while the tournament is running.
                </p>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-muted">
                      Realized PnL
                    </p>
                    <p
                      className={`mt-1 text-xl font-semibold ${pnlClass(
                        mine.performance.realized_pnl
                      )}`}
                    >
                      {money(mine.performance.realized_pnl)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wider text-muted">
                      Unrealized PnL
                    </p>
                    <p
                      className={`mt-1 text-xl font-semibold ${pnlClass(
                        mine.performance.unrealized_pnl ?? 0
                      )}`}
                    >
                      {money(mine.performance.unrealized_pnl ?? 0)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wider text-muted">
                      Win rate
                    </p>
                    <p className="mt-1 text-xl font-semibold">
                      {(Number(mine.performance.win_rate) * 100).toFixed(1)}%
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wider text-muted">
                      Closed trades
                    </p>
                    <p className="mt-1 text-xl font-semibold">
                      {mine.performance.closed_trades}
                    </p>
                  </div>
                </div>
              </section>

              <section className="mt-10">
                <h2 className="text-lg font-semibold">Your open positions</h2>
                <div className="mt-3 border border-border">
                  <OpenPositionsTable positions={mine.open} />
                </div>
              </section>

              <section className="mt-10">
                <h2 className="text-lg font-semibold">Your closed trades</h2>
                <div className="mt-3 border border-border">
                  <ClosedTradesTable positions={mine.closed} />
                </div>
              </section>
            </>
          ) : null}

          {t.status === "ended" ? (
            <section className="mt-10">
              <h2 className="text-lg font-semibold">Tournament boards</h2>
              <p className="mt-1 text-sm text-muted">
                Ranked by ROI on that market&apos;s $10k capital, then win rate,
                then closed trades / PnL.
              </p>
              <MarketBoardTable
                title="Spot leaders"
                subtitle="Spot only · no leverage"
                rows={t.boards?.spot ?? []}
              />
              <MarketBoardTable
                title="Futures leaders"
                subtitle="Futures only · leveraged book"
                rows={t.boards?.futures ?? []}
              />
            </section>
          ) : null}

          {t.status === "ended" && t.leaderboard?.length ? (
            <section className="mt-10">
              <h2 className="text-lg font-semibold">Prize payouts</h2>
              <p className="mt-1 text-sm text-muted">
                Overall settlement ranking (combined book) for prizes.
              </p>
              <table className="mt-3 w-full text-left text-sm">
                <thead className="text-muted">
                  <tr>
                    <th className="py-1 pr-3">#</th>
                    <th className="py-1 pr-3">Trader</th>
                    <th className="py-1 pr-3">PnL</th>
                    <th className="py-1 pr-3">Win rate</th>
                    <th className="py-1">Prize</th>
                  </tr>
                </thead>
                <tbody>
                  {t.leaderboard.map((e) => (
                    <tr key={e.id} className="border-t border-border">
                      <td className="py-1.5 pr-3">{e.rank ?? "—"}</td>
                      <td className="py-1.5 pr-3">{e.username}</td>
                      <td className="py-1.5 pr-3">
                        {e.realized_pnl != null ? money(e.realized_pnl) : "—"}
                      </td>
                      <td className="py-1.5 pr-3">
                        {e.win_rate != null
                          ? `${(Number(e.win_rate) * 100).toFixed(1)}%`
                          : "—"}
                      </td>
                      <td className="py-1.5">
                        {e.prize_amount != null ? money(e.prize_amount) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {liveBoards ? (
            <section className="mt-10">
              <h2 className="text-lg font-semibold">Live standings (admin)</h2>
              <p className="mt-1 text-sm text-muted">
                ROI → win rate → closed / PnL. Spot and Futures separate.
              </p>
              <MarketBoardTable
                title="Spot leaders"
                subtitle="Live · spot only"
                rows={liveBoards.spot}
              />
              <MarketBoardTable
                title="Futures leaders"
                subtitle="Live · futures only"
                rows={liveBoards.futures}
              />
            </section>
          ) : null}

          {(t.status === "ended" || isAdmin) && trades.length > 0 ? (
            <section className="mt-10">
              <h2 className="text-lg font-semibold">
                {t.status === "ended" ? "Public trades" : "Entrant trades (admin)"}
              </h2>
              <div className="mt-3 overflow-x-auto border border-border">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted">
                      <th className="eyebrow px-4 py-3 font-normal">Trader</th>
                      <th className="eyebrow px-4 py-3 font-normal">Side</th>
                      <th className="eyebrow px-4 py-3 font-normal">Symbol</th>
                      <th className="eyebrow px-4 py-3 font-normal">Market</th>
                      <th className="eyebrow px-4 py-3 font-normal">Status</th>
                      <th className="eyebrow px-4 py-3 font-normal">PnL</th>
                      <th className="eyebrow px-4 py-3 font-normal">Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.slice(0, 80).map((p) => (
                      <tr key={p.id} className="border-b border-border/50">
                        <td className="px-4 py-3 text-foreground">
                          {p.username}
                        </td>
                        <td className="px-4 py-3 uppercase">{p.side}</td>
                        <td className="px-4 py-3">{p.symbol}</td>
                        <td className="px-4 py-3 uppercase text-muted">
                          {p.market}
                        </td>
                        <td className="px-4 py-3 capitalize text-muted">
                          {p.status}
                        </td>
                        <td
                          className={`px-4 py-3 ${
                            p.realized_pnl != null
                              ? pnlClass(p.realized_pnl)
                              : "text-muted"
                          }`}
                        >
                          {p.realized_pnl != null
                            ? money(p.realized_pnl)
                            : "—"}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted">
                          {p.closed_at
                            ? fmtWhen(p.closed_at)
                            : p.opened_at
                              ? fmtWhen(p.opened_at)
                              : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      </main>
      <Footer />
    </>
  );
}
