"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import PendingButton from "@/components/PendingButton";
import {
  apiCreateTournament,
  apiJoinTournament,
  apiSettleTournament,
  apiTournamentStandings,
  apiTournaments,
  type Tournament,
  type TournamentBoardRow,
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
  return `${v.toFixed(2)}%`;
}

function fmtWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusTone(status: Tournament["status"]) {
  if (status === "live") return "text-accent";
  if (status === "scheduled") return "text-foreground";
  if (status === "ended") return "text-muted";
  return "text-danger";
}

export default function TournamentsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [list, setList] = useState<Tournament[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [standings, setStandings] = useState<{
    id: number;
    spot: TournamentBoardRow[];
    futures: TournamentBoardRow[];
  } | null>(null);

  const [name, setName] = useState("");
  const [maxP, setMaxP] = useState("50");
  const [fee, setFee] = useState("10");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");

  const isAdmin = user?.role === "admin";
  const isTrader = user?.role === "trader";

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const rows = await apiTournaments();
      setList(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [user, refresh]);

  async function onJoin(id: number) {
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

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiCreateTournament({
        name: name.trim(),
        max_participants: Number(maxP),
        entry_fee: Number(fee),
        start_at: new Date(startAt).toISOString(),
        end_at: new Date(endAt).toISOString(),
      });
      setName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function onStandings(id: number) {
    setBusy(true);
    setError(null);
    try {
      const data = await apiTournamentStandings(id);
      setStandings({
        id,
        spot: data.boards?.spot ?? [],
        futures: data.boards?.futures ?? [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Standings failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSettle(id: number) {
    setBusy(true);
    setError(null);
    try {
      await apiSettleTournament(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Settle failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading || !user) {
    return (
      <>
        <Navbar />
        <main className="pt-40 px-6 text-muted">Loading tournaments…</main>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <main className="relative min-h-screen overflow-hidden pt-28 pb-24">
        <div className="hero-atmosphere absolute inset-0 opacity-60" />
        <div className="relative mx-auto max-w-5xl px-6">
          <p className="eyebrow">Competition</p>
          <h1 className="statement mt-3 text-4xl sm:text-5xl">Tournaments</h1>
          <p className="thin mt-4 max-w-xl text-muted">
            Pay the entry fee (stub), trade with a separate $10k crypto book while
            live. Standings stay private until the event ends — admins see live
            scores.
          </p>

          {error ? (
            <p className="mt-6 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
              {error}
            </p>
          ) : null}

          {isAdmin ? (
            <section className="mt-10 border-t border-border pt-8">
              <h2 className="text-lg font-semibold">Organize event</h2>
              <form
                onSubmit={onCreate}
                className="mt-4 grid gap-3 sm:grid-cols-2"
              >
                <label className="block text-sm sm:col-span-2">
                  <span className="text-muted">Name</span>
                  <input
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-border bg-white/[0.03] px-3 py-2 outline-none focus:border-accent/40"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-muted">Max participants</span>
                  <input
                    required
                    type="number"
                    min={2}
                    value={maxP}
                    onChange={(e) => setMaxP(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-border bg-white/[0.03] px-3 py-2 outline-none focus:border-accent/40"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-muted">Entry fee (USD)</span>
                  <input
                    required
                    type="number"
                    min={0}
                    step="0.01"
                    value={fee}
                    onChange={(e) => setFee(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-border bg-white/[0.03] px-3 py-2 outline-none focus:border-accent/40"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-muted">Start</span>
                  <input
                    required
                    type="datetime-local"
                    value={startAt}
                    onChange={(e) => setStartAt(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-border bg-white/[0.03] px-3 py-2 outline-none focus:border-accent/40"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-muted">End</span>
                  <input
                    required
                    type="datetime-local"
                    value={endAt}
                    onChange={(e) => setEndAt(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-border bg-white/[0.03] px-3 py-2 outline-none focus:border-accent/40"
                  />
                </label>
                <div className="sm:col-span-2">
                  <PendingButton
                    type="submit"
                    pending={busy}
                    pendingLabel="Creating…"
                    className="!w-auto rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-black"
                  >
                    Create tournament
                  </PendingButton>
                </div>
              </form>
            </section>
          ) : null}

          <section className="mt-10 space-y-4">
            {list.length === 0 ? (
              <p className="text-sm text-muted">No tournaments yet.</p>
            ) : (
              list.map((t) => (
                <article
                  key={t.id}
                  className="rounded-xl border border-border bg-white/[0.02] px-5 py-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <Link
                        href={`/tournaments/${t.id}`}
                        className="text-lg font-semibold hover:text-accent"
                      >
                        {t.name}
                      </Link>
                      <p className={`mt-1 text-xs uppercase tracking-wider ${statusTone(t.status)}`}>
                        {t.status}
                      </p>
                      <p className="mt-1 text-sm text-muted">
                        Organized by{" "}
                        <span className="text-foreground">@{t.organizer}</span>
                      </p>
                      <p className="mt-2 text-sm text-muted">
                        {fmtWhen(t.start_at)} → {fmtWhen(t.end_at)}
                      </p>
                      <p className="mt-1 text-sm text-muted">
                        Entry {money(t.entry_fee)} · {t.entrant_count}/
                        {t.max_participants} joined · prize pool est.{" "}
                        {money(t.prize_pool_estimate)} · start capital{" "}
                        {money(t.starting_capital)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {isTrader && t.status === "scheduled" && !t.i_joined ? (
                        <PendingButton
                          type="button"
                          pending={busy}
                          pendingLabel="Joining…"
                          onClick={() => onJoin(t.id)}
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
                          Trade in tournament
                        </Link>
                      ) : null}
                      {isTrader && t.i_joined && t.status === "scheduled" ? (
                        <span className="rounded-full border border-border px-4 py-2 text-sm text-muted">
                          Joined — waits for start
                        </span>
                      ) : null}
                      {isAdmin && t.status === "live" ? (
                        <PendingButton
                          type="button"
                          pending={busy}
                          pendingLabel="Loading…"
                          onClick={() => onStandings(t.id)}
                          className="!w-auto rounded-full border border-border px-4 py-2 text-sm"
                        >
                          Live standings
                        </PendingButton>
                      ) : null}
                      {isAdmin &&
                      t.status === "ended" &&
                      !t.settled_at ? (
                        <PendingButton
                          type="button"
                          pending={busy}
                          pendingLabel="Settling…"
                          onClick={() => onSettle(t.id)}
                          className="!w-auto rounded-full border border-accent/40 px-4 py-2 text-sm text-accent"
                        >
                          Settle prizes
                        </PendingButton>
                      ) : null}
                      <Link
                        href={`/tournaments/${t.id}`}
                        className="rounded-full border border-border px-4 py-2 text-sm text-muted hover:text-foreground"
                      >
                        Details
                      </Link>
                    </div>
                  </div>
                  {standings?.id === t.id ? (
                    <div className="mt-4 space-y-4 border-t border-border pt-3">
                      {(
                        [
                          ["Spot", standings.spot],
                          ["Futures", standings.futures],
                        ] as const
                      ).map(([label, rows]) => (
                        <div key={label}>
                          <p className="mb-2 text-xs uppercase tracking-wider text-muted">
                            {label} · ROI first
                          </p>
                          <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm">
                              <thead className="text-muted">
                                <tr>
                                  <th className="py-1 pr-3">#</th>
                                  <th className="py-1 pr-3">Trader</th>
                                  <th className="py-1 pr-3">ROI</th>
                                  <th className="py-1 pr-3">Win rate</th>
                                  <th className="py-1 pr-3">Closed</th>
                                  <th className="py-1">PnL</th>
                                </tr>
                              </thead>
                              <tbody>
                                {rows.length === 0 ? (
                                  <tr>
                                    <td
                                      colSpan={6}
                                      className="py-2 text-muted"
                                    >
                                      No closed trades yet.
                                    </td>
                                  </tr>
                                ) : (
                                  rows.map((r) => (
                                    <tr
                                      key={`${label}-${r.username}`}
                                      className="border-t border-border/60"
                                    >
                                      <td className="py-1.5 pr-3">{r.rank}</td>
                                      <td className="py-1.5 pr-3">
                                        {r.username}
                                      </td>
                                      <td className="py-1.5 pr-3">
                                        {pct(r.roi_pct)}
                                      </td>
                                      <td className="py-1.5 pr-3">
                                        {pct(r.win_rate_pct)}
                                      </td>
                                      <td className="py-1.5 pr-3">
                                        {r.closed_trades}
                                      </td>
                                      <td className="py-1.5">
                                        {money(r.realized_pnl)}
                                      </td>
                                    </tr>
                                  ))
                                )}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))
            )}
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
