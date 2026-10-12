"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AuthUser, TraderSummary } from "@/lib/api";
import { apiMySocial, apiTraders } from "@/lib/api";
import TraderSearch from "@/components/TraderSearch";

function money(n: string | number) {
  const v = typeof n === "string" ? Number(n) : n;
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

const WATCH_STEPS = [
  {
    title: "Search traders",
    body: "Type a username — suggestions appear as you type.",
  },
  {
    title: "Read their book",
    body: "See open positions and every closed trade — size, side, PnL.",
  },
  {
    title: "Follow traders",
    body: "Hit Follow on a trader’s page. Manage your list under Following.",
  },
];

export default function ViewerDashboard({ user }: { user: AuthUser }) {
  const [traders, setTraders] = useState<TraderSummary[]>([]);
  const [followingCount, setFollowingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([apiTraders(), apiMySocial()])
      .then(([list, social]) => {
        setTraders(list);
        setFollowingCount(social.following_count);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Could not load traders")
      );
  }, []);

  return (
    <div className="mx-auto max-w-7xl px-6 pt-32 pb-20">
      <p className="eyebrow">Viewer gallery</p>
      <h1 className="statement mt-4 text-5xl uppercase sm:text-6xl md:text-7xl">
        Watch
        <br />
        the floor.
      </h1>
      <p className="thin mt-6 max-w-2xl text-base text-muted md:text-lg">
        Welcome, <span className="text-foreground">{user.username}</span>. Search
        any trader and open their history.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <div className="max-w-lg flex-1">
          <TraderSearch />
        </div>
        <Link
          href="/social"
          className="rounded-full border border-border px-5 py-2.5 text-sm transition-colors hover:bg-white/5"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Following ({followingCount})
        </Link>
      </div>

      {error ? (
        <p className="mt-6 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-14 grid gap-10 border-y border-border py-12 md:grid-cols-4">
        <div>
          <p className="eyebrow">Following</p>
          <p
            className="mt-3 text-3xl text-accent md:text-4xl"
            style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
          >
            {followingCount}
          </p>
        </div>
        <div>
          <p className="eyebrow">Traders</p>
          <p
            className="mt-3 text-3xl text-foreground md:text-4xl"
            style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
          >
            {traders.length}
          </p>
        </div>
        <div>
          <p className="eyebrow">Open books</p>
          <p
            className="mt-3 text-3xl text-muted md:text-4xl"
            style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
          >
            {traders.reduce((s, t) => s + t.open_positions, 0)}
          </p>
        </div>
        <div>
          <p className="eyebrow">Closed trades</p>
          <p
            className="mt-3 text-3xl text-muted md:text-4xl"
            style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
          >
            {traders.reduce((s, t) => s + t.closed_trades, 0)}
          </p>
        </div>
      </div>

      <section className="mt-16">
        <p className="eyebrow">How you watch</p>
        <h2
          className="mt-4 text-3xl uppercase tracking-tight md:text-4xl"
          style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
        >
          Spectate with intent.
        </h2>
        <ul className="mt-10 divide-y divide-border border-y border-border">
          {WATCH_STEPS.map((s, i) => (
            <li
              key={s.title}
              className="grid gap-3 py-8 md:grid-cols-[auto_minmax(0,0.35fr)_minmax(0,1fr)] md:gap-10"
            >
              <span className="eyebrow text-accent">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3
                className="text-xl uppercase md:text-2xl"
                style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
              >
                {s.title}
              </h3>
              <p className="thin self-center text-base leading-relaxed text-muted">
                {s.body}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-16">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">All traders</p>
            <h2
              className="mt-4 text-3xl uppercase tracking-tight md:text-4xl"
              style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
            >
              Live books
            </h2>
          </div>
          <Link
            href="/traders"
            className="text-sm text-muted hover:text-foreground"
          >
            Full list
          </Link>
        </div>

        <div className="mt-8 overflow-x-auto border-y border-border">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-muted">
                <th className="eyebrow py-4 pr-4 font-normal">Trader</th>
                <th className="eyebrow py-4 pr-4 font-normal">Open</th>
                <th className="eyebrow py-4 pr-4 font-normal">Closed</th>
                <th className="eyebrow py-4 pr-4 font-normal">Realized</th>
                <th className="eyebrow py-4 font-normal" />
              </tr>
            </thead>
            <tbody>
              {traders.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-muted">
                    No traders yet.
                  </td>
                </tr>
              ) : (
                traders.map((t) => (
                  <tr key={t.id} className="border-b border-border/60">
                    <td
                      className="py-4 pr-4"
                      style={{
                        fontFamily: "var(--font-display)",
                        fontWeight: 600,
                      }}
                    >
                      @{t.username}
                    </td>
                    <td className="py-4 pr-4 text-muted">{t.open_positions}</td>
                    <td className="py-4 pr-4 text-muted">{t.closed_trades}</td>
                    <td
                      className={`py-4 pr-4 ${
                        Number(t.realized_pnl) >= 0
                          ? "text-accent"
                          : "text-danger"
                      }`}
                    >
                      {money(t.realized_pnl)}
                    </td>
                    <td className="py-4 text-right">
                      <Link
                        href={`/traders/${encodeURIComponent(t.username)}`}
                        className="rounded-full border border-border px-3 py-1.5 text-xs hover:bg-white/5"
                      >
                        View history
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
