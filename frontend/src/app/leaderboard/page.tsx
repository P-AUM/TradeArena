"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import {
  apiLeaderboard,
  type LeaderboardEntry,
  type LeaderboardPeriod,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

const PERIODS: { id: LeaderboardPeriod; label: string }[] = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "all_time", label: "All-time" },
];

function money(n: string | number) {
  const v = typeof n === "string" ? Number(n) : n;
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function pct(n: string | number) {
  const v = typeof n === "string" ? Number(n) : n;
  const digits = Math.abs(v) > 0 && Math.abs(v) < 0.01 ? 4 : 2;
  return `${v.toFixed(digits)}%`;
}

function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      className="inline-flex flex-wrap gap-1 rounded-full border border-border p-1"
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className={`rounded-full px-3.5 py-1.5 text-xs transition-colors ${
              active
                ? "bg-accent text-black"
                : "text-muted hover:text-foreground"
            }`}
            style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}
            aria-pressed={active}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function BoardTable({
  title,
  subtitle,
  rows,
  loading,
  you,
}: {
  title: string;
  subtitle: string;
  rows: LeaderboardEntry[];
  loading: boolean;
  you: string;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted">{subtitle}</p>
      <div className="mt-4 overflow-x-auto border-y border-border">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="eyebrow py-4 pr-3 font-normal">#</th>
              <th className="eyebrow py-4 pr-3 font-normal">Trader</th>
              <th className="eyebrow py-4 pr-3 font-normal text-accent">ROI</th>
              <th className="eyebrow py-4 pr-3 font-normal">Win rate</th>
              <th className="eyebrow py-4 pr-3 font-normal">Closed</th>
              <th className="eyebrow py-4 pr-3 font-normal">PnL</th>
              <th className="eyebrow py-4 font-normal" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="py-8 text-muted">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-muted">
                  No closed trades on this board yet.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isYou = row.username === you;
                return (
                  <tr
                    key={`${title}-${row.id}`}
                    className={`border-b border-border/60 ${
                      isYou ? "bg-accent/[0.04]" : ""
                    }`}
                  >
                    <td
                      className="py-4 pr-3 text-muted"
                      style={{
                        fontFamily: "var(--font-display)",
                        fontWeight: 700,
                      }}
                    >
                      {row.rank}
                    </td>
                    <td
                      className="py-4 pr-3"
                      style={{
                        fontFamily: "var(--font-display)",
                        fontWeight: 600,
                      }}
                    >
                      @{row.username}
                      {isYou ? (
                        <span className="ml-2 text-xs text-accent">you</span>
                      ) : null}
                    </td>
                    <td
                      className={`py-4 pr-3 font-semibold ${
                        Number(row.roi_pct) >= 0 ? "text-accent" : "text-danger"
                      }`}
                    >
                      {pct(row.roi_pct)}
                    </td>
                    <td className="py-4 pr-3 text-foreground">
                      {pct(row.win_rate_pct)}
                      <span className="ml-1.5 text-xs text-muted">
                        {row.wins}W/{row.losses}L
                      </span>
                    </td>
                    <td className="py-4 pr-3 text-muted">{row.closed_trades}</td>
                    <td
                      className={`py-4 pr-3 ${
                        Number(row.realized_pnl) >= 0
                          ? "text-accent"
                          : "text-danger"
                      }`}
                    >
                      {money(row.realized_pnl)}
                    </td>
                    <td className="py-4 text-right">
                      <Link
                        href={`/traders/${encodeURIComponent(row.username)}`}
                        className="rounded-full border border-border px-3 py-1.5 text-xs hover:bg-white/5"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function LeaderboardPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [period, setPeriod] = useState<LeaderboardPeriod>("all_time");
  const [spot, setSpot] = useState<LeaderboardEntry[]>([]);
  const [futures, setFutures] = useState<LeaderboardEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiLeaderboard({ period })
      .then((data) => {
        if (cancelled) return;
        setSpot(data.boards?.spot ?? []);
        setFutures(data.boards?.futures ?? []);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, period]);

  if (authLoading || !user) {
    return (
      <>
        <Navbar />
        <main className="pt-32 px-6 text-muted">Loading…</main>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <main className="min-h-screen bg-background pt-28 pb-20">
        <div className="mx-auto max-w-5xl px-6">
          <p className="eyebrow">Arena</p>
          <h1 className="statement mt-4 text-5xl uppercase md:text-6xl">
            Leaderboard
          </h1>
          <p className="thin mt-4 max-w-2xl text-muted">
            Separate Spot and Futures boards. Ranked by ROI on that market&apos;s
            starting capital, then win rate, then closed trades / PnL. PnL is
            shown for context. Tournament trades are excluded.
          </p>

          <div className="mt-8">
            <ToggleGroup
              options={PERIODS}
              value={period}
              onChange={setPeriod}
              ariaLabel="Time period"
            />
          </div>

          {error ? (
            <p className="mt-4 text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}

          <BoardTable
            title="Spot leaders"
            subtitle="Spot only · no leverage · ROI first, then win rate"
            rows={spot}
            loading={loading}
            you={user.username}
          />

          <BoardTable
            title="Futures leaders"
            subtitle="Futures only · leveraged book · ROI first, then win rate"
            rows={futures}
            loading={loading}
            you={user.username}
          />
        </div>
      </main>
    </>
  );
}
