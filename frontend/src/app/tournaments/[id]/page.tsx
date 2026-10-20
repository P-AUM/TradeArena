"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import PendingButton from "@/components/PendingButton";
import {
  apiJoinTournament,
  apiTournament,
  apiTournamentMe,
  apiTournamentStandings,
  apiTournamentTrades,
  type Position,
  type Tournament,
  type TournamentMyResponse,
  type TournamentStanding,
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

function fmtWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function PositionRows({
  rows,
  empty,
}: {
  rows: Position[];
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="mt-2 text-sm text-muted">{empty}</p>;
  }
  return (
    <ul className="mt-3 space-y-2 text-sm">
      {rows.map((p) => (
        <li
          key={p.id}
          className="flex flex-wrap gap-x-3 border-b border-border/50 py-2 text-muted"
        >
          <span className="capitalize text-foreground">{p.side}</span>
          <span>
            {p.symbol} ({p.market})
          </span>
          <span>{p.leverage}x</span>
          <span>entry {money(p.entry_price)}</span>
          {p.status === "open" && p.unrealized_pnl != null ? (
            <span>uPnL {money(p.unrealized_pnl)}</span>
          ) : null}
          {p.status === "closed" && p.realized_pnl != null ? (
            <span>PnL {money(p.realized_pnl)}</span>
          ) : null}
          {p.closed_at ? (
            <span className="text-xs">{fmtWhen(p.closed_at)}</span>
          ) : (
            <span className="text-xs">{fmtWhen(p.opened_at)}</span>
          )}
        </li>
      ))}
    </ul>
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
  const [standings, setStandings] = useState<TournamentStanding[] | null>(null);
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
      setStandings(data.standings);
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
        <div className="mx-auto max-w-4xl px-6">
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
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-muted">
                      Realized PnL
                    </p>
                    <p className="mt-1 text-xl font-semibold">
                      {money(mine.performance.realized_pnl)}
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
                <PositionRows
                  rows={mine.open}
                  empty="No open tournament positions."
                />
              </section>

              <section className="mt-10">
                <h2 className="text-lg font-semibold">Your closed trades</h2>
                <PositionRows
                  rows={mine.closed}
                  empty="No closed tournament trades yet."
                />
              </section>
            </>
          ) : null}

          {t.status === "ended" && t.leaderboard?.length ? (
            <section className="mt-10">
              <h2 className="text-lg font-semibold">Final leaderboard</h2>
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

          {standings ? (
            <section className="mt-10">
              <h2 className="text-lg font-semibold">Live standings (admin)</h2>
              <table className="mt-3 w-full text-left text-sm">
                <thead className="text-muted">
                  <tr>
                    <th className="py-1 pr-3">#</th>
                    <th className="py-1 pr-3">Trader</th>
                    <th className="py-1 pr-3">PnL</th>
                    <th className="py-1 pr-3">Win rate</th>
                    <th className="py-1">Closed</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.map((r) => (
                    <tr key={r.username} className="border-t border-border">
                      <td className="py-1.5 pr-3">{r.rank}</td>
                      <td className="py-1.5 pr-3">{r.username}</td>
                      <td className="py-1.5 pr-3">{money(r.realized_pnl)}</td>
                      <td className="py-1.5 pr-3">
                        {(Number(r.win_rate) * 100).toFixed(1)}%
                      </td>
                      <td className="py-1.5">{r.closed_trades}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {(t.status === "ended" || isAdmin) && trades.length > 0 ? (
            <section className="mt-10">
              <h2 className="text-lg font-semibold">
                {t.status === "ended" ? "Public trades" : "Entrant trades (admin)"}
              </h2>
              <ul className="mt-3 space-y-2 text-sm">
                {trades.slice(0, 80).map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap gap-x-3 border-b border-border/50 py-2 text-muted"
                  >
                    <span className="text-foreground">{p.username}</span>
                    <span>
                      {p.side} {p.symbol} ({p.market})
                    </span>
                    <span>{p.status}</span>
                    {p.realized_pnl != null ? (
                      <span>{money(p.realized_pnl)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </main>
      <Footer />
    </>
  );
}
