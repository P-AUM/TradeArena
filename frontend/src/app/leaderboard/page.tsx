"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import {
  apiLeaderboard,
  type LeaderboardEntry,
  type LeaderboardMetric,
  type LeaderboardPeriod,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

const PERIODS: { id: LeaderboardPeriod; label: string }[] = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "all_time", label: "All-time" },
];

const METRICS: { id: LeaderboardMetric; label: string }[] = [
  { id: "pnl", label: "PnL" },
  { id: "roi", label: "ROI" },
  { id: "win_rate", label: "Win rate" },
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

function colClass(active: boolean) {
  return active ? "text-accent" : "";
}

export default function LeaderboardPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [period, setPeriod] = useState<LeaderboardPeriod>("all_time");
  const [metric, setMetric] = useState<LeaderboardMetric>("pnl");
  const [rows, setRows] = useState<LeaderboardEntry[]>([]);
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
    apiLeaderboard({ period, metric })
      .then((data) => {
        if (!cancelled) setRows(data.results);
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
  }, [user, period, metric]);

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
          <p className="thin mt-4 max-w-xl text-muted">
            Rank by realized PnL, ROI on starting capital, or win rate. Daily and
            weekly use closed trades since UTC midnight / Monday.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <ToggleGroup
              options={PERIODS}
              value={period}
              onChange={setPeriod}
              ariaLabel="Time period"
            />
            <ToggleGroup
              options={METRICS}
              value={metric}
              onChange={setMetric}
              ariaLabel="Ranking metric"
            />
          </div>

          {error ? (
            <p className="mt-4 text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-10 overflow-x-auto border-y border-border">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="eyebrow py-4 pr-3 font-normal">#</th>
                  <th className="eyebrow py-4 pr-3 font-normal">Trader</th>
                  <th
                    className={`eyebrow py-4 pr-3 font-normal ${colClass(metric === "pnl")}`}
                  >
                    PnL
                  </th>
                  <th
                    className={`eyebrow py-4 pr-3 font-normal ${colClass(metric === "roi")}`}
                  >
                    ROI
                  </th>
                  <th
                    className={`eyebrow py-4 pr-3 font-normal ${colClass(metric === "win_rate")}`}
                  >
                    Win rate
                  </th>
                  <th className="eyebrow py-4 pr-3 font-normal">Closed</th>
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
                      No traders on the board yet.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => {
                    const isYou = row.username === user.username;
                    return (
                      <tr
                        key={row.id}
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
                          className={`py-4 pr-3 ${
                            Number(row.realized_pnl) >= 0
                              ? "text-accent"
                              : "text-danger"
                          } ${metric === "pnl" ? "font-semibold" : ""}`}
                        >
                          {money(row.realized_pnl)}
                        </td>
                        <td
                          className={`py-4 pr-3 ${
                            Number(row.roi_pct) >= 0
                              ? "text-accent"
                              : "text-danger"
                          } ${metric === "roi" ? "font-semibold" : ""}`}
                        >
                          {pct(row.roi_pct)}
                        </td>
                        <td
                          className={`py-4 pr-3 ${
                            metric === "win_rate"
                              ? "font-semibold text-foreground"
                              : "text-muted"
                          }`}
                        >
                          {pct(row.win_rate_pct)}
                          <span className="ml-1.5 text-xs text-muted">
                            {row.wins}W/{row.losses}L
                          </span>
                        </td>
                        <td className="py-4 pr-3 text-muted">
                          {row.closed_trades}
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
        </div>
      </main>
    </>
  );
}
