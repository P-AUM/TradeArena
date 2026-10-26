"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { AuthUser, Position, Wallet } from "@/lib/api";
import {
  apiClosePosition,
  apiMySocial,
  apiPositions,
  apiWallets,
} from "@/lib/api";
import { PAPER_STARTING_BALANCE_USD } from "@/lib/constants";

function money(n: string | number) {
  const v = typeof n === "string" ? Number(n) : n;
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export default function TraderDashboard({ user }: { user: AuthUser }) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [followersCount, setFollowersCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [w, p, social] = await Promise.all([
        apiWallets(),
        apiPositions("open"),
        apiMySocial(),
      ]);
      setWallets(w);
      setPositions(p);
      setFollowersCount(social.followers_count);
      setFollowingCount(social.following_count);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load desk");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const spot = wallets.find((w) => w.market === "spot");
  const futures = wallets.find((w) => w.market === "futures");
  const forex = wallets.find((w) => w.market === "forex");

  async function onClose(id: number) {
    setBusy(true);
    setError(null);
    try {
      await apiClosePosition(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close");
    } finally {
      setBusy(false);
    }
  }

  const startLabel = PAPER_STARTING_BALANCE_USD.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

  return (
    <div className="mx-auto max-w-7xl px-6 pt-32 pb-20">
      <p className="eyebrow">Trader desk</p>
      <h1 className="statement mt-4 max-w-full break-words text-4xl uppercase sm:text-6xl md:text-7xl">
        Your
        <br />
        arena.
      </h1>
      <p className="thin mt-6 max-w-2xl text-base text-muted md:text-lg">
        Welcome back, <span className="text-foreground">{user.username}</span>.
        Live Binance spot &amp; futures · paper filled at bid/ask.{" "}
        <span className="text-accent">{startLabel}</span> per wallet.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Link
          href="/trade"
          className="inline-flex items-center bg-accent px-5 py-2.5 text-sm font-semibold tracking-wide text-black"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Trade terminal
        </Link>
        <Link
          href="/tournaments"
          className="text-sm text-muted transition-colors hover:text-foreground"
        >
          Tournaments
        </Link>
        <Link
          href={`/traders/${encodeURIComponent(user.username)}`}
          className="text-sm text-muted transition-colors hover:text-foreground"
        >
          History
        </Link>
        <Link
          href="/traders"
          className="text-sm text-muted transition-colors hover:text-foreground"
        >
          Traders
        </Link>
        <Link
          href="/social"
          className="text-sm text-muted transition-colors hover:text-foreground"
        >
          Following ({followingCount})
        </Link>
        <button
          type="button"
          onClick={() => refresh()}
          className="text-sm text-muted transition-colors hover:text-foreground"
        >
          Refresh
        </button>
      </div>

      {error ? (
        <p className="mt-6 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-14 border-y border-border">
        <div className="grid gap-10 py-12 sm:grid-cols-3">
          <div>
            <p className="eyebrow">Followers</p>
            <p
              className="mt-4 text-4xl tracking-tight text-foreground sm:text-5xl"
              style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
            >
              {loading ? "…" : followersCount}
            </p>
          </div>
          <div>
            <p className="eyebrow">Following</p>
            <p
              className="mt-4 text-4xl tracking-tight text-foreground sm:text-5xl"
              style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
            >
              {loading ? "…" : followingCount}
            </p>
          </div>
          <div>
            <p className="eyebrow">Open positions</p>
            <p
              className="mt-4 text-4xl tracking-tight text-foreground sm:text-5xl"
              style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
            >
              {loading ? "…" : positions.length}
            </p>
          </div>
        </div>

        <div className="grid gap-10 border-t border-border py-12 sm:grid-cols-3">
          {(
            [
              ["Spot", spot],
              ["Futures", futures],
              ["Forex", forex],
            ] as const
          ).map(([label, w]) => (
            <div key={label} className="min-w-0">
              <p className="eyebrow">{label}</p>
              <p
                className="mt-4 text-3xl tracking-tight text-accent tabular-nums sm:text-4xl"
                style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
                title={loading ? undefined : money(w?.balance ?? "0")}
              >
                {loading ? "…" : money(w?.balance ?? "0")}
              </p>
            </div>
          ))}
        </div>
      </div>

      <section className="mt-16">
        <p className="eyebrow">Open book</p>
        <h2
          className="mt-4 text-3xl uppercase tracking-tight md:text-4xl"
          style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
        >
          Positions
        </h2>
        {positions.length === 0 ? (
          <p className="thin mt-8 text-muted">
            No open positions.{" "}
            <Link href="/trade" className="text-accent underline-offset-2 hover:underline">
              Trade terminal
            </Link>
          </p>
        ) : (
          <div className="mt-8 overflow-x-auto border-y border-border">
            <table className="w-full min-w-[800px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="eyebrow py-4 pr-3 font-normal">Symbol</th>
                  <th className="eyebrow py-4 pr-3 font-normal">Market</th>
                  <th className="eyebrow py-4 pr-3 font-normal">Side</th>
                  <th className="eyebrow py-4 pr-3 font-normal">Notional</th>
                  <th className="eyebrow py-4 pr-3 font-normal">Entry</th>
                  <th className="eyebrow py-4 pr-3 font-normal">Mark</th>
                  <th className="eyebrow py-4 pr-3 font-normal">uPnL</th>
                  <th className="eyebrow py-4 font-normal" />
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.id} className="border-b border-border/60">
                    <td className="py-4 pr-3">{p.symbol}</td>
                    <td className="py-4 pr-3 uppercase text-muted">{p.market}</td>
                    <td className="py-4 pr-3 uppercase text-muted">{p.side}</td>
                    <td className="py-4 pr-3">{money(p.notional)}</td>
                    <td className="py-4 pr-3">
                      {Number(p.entry_price).toPrecision(6)}
                    </td>
                    <td className="py-4 pr-3">
                      {p.mark_price ? Number(p.mark_price).toPrecision(6) : "—"}
                    </td>
                    <td
                      className={`py-4 pr-3 ${
                        Number(p.unrealized_pnl ?? 0) >= 0
                          ? "text-accent"
                          : "text-danger"
                      }`}
                    >
                      {p.unrealized_pnl != null ? money(p.unrealized_pnl) : "—"}
                    </td>
                    <td className="py-4 text-right">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onClose(p.id)}
                        className="rounded-full border border-border px-3 py-1.5 text-xs transition-colors hover:bg-white/5 disabled:opacity-50"
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
