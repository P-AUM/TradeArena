"use client";

import Link from "next/link";
import type { Position } from "@/lib/api";

function money(n: string | number) {
  const v = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(v)) return "—";
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function upnlWithPct(p: Position) {
  const upnl =
    p.unrealized_pnl != null ? Number(p.unrealized_pnl) : null;
  if (upnl == null) return "—";
  const base = Number(p.margin) > 0 ? Number(p.margin) : Number(p.notional);
  const pct = base ? (upnl / base) * 100 : null;
  const moneyStr = money(upnl);
  if (pct == null) return moneyStr;
  return `${moneyStr} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
}

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function OpenPositionsTable({ positions }: { positions: Position[] }) {
  if (positions.length === 0) {
    return <p className="thin px-4 py-8 text-muted">No open positions.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-muted">
            <th className="eyebrow px-4 py-3 font-normal">Symbol</th>
            <th className="eyebrow px-4 py-3 font-normal">Market</th>
            <th className="eyebrow px-4 py-3 font-normal">Side</th>
            <th className="eyebrow px-4 py-3 font-normal">Lev</th>
            <th className="eyebrow px-4 py-3 font-normal">Size</th>
            <th className="eyebrow px-4 py-3 font-normal">Entry</th>
            <th className="eyebrow px-4 py-3 font-normal">Mark</th>
            <th className="eyebrow px-4 py-3 font-normal">uPnL</th>
            <th className="eyebrow px-4 py-3 font-normal">Opened</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.id} className="border-b border-border/50">
              <td className="px-4 py-3">{p.symbol}</td>
              <td className="px-4 py-3 uppercase text-muted">{p.market}</td>
              <td className="px-4 py-3 uppercase">{p.side}</td>
              <td className="px-4 py-3">{p.leverage ?? 1}x</td>
              <td className="px-4 py-3">{money(p.notional)}</td>
              <td className="px-4 py-3">
                {Number(p.entry_price).toPrecision(6)}
              </td>
              <td className="px-4 py-3">
                {p.mark_price ? Number(p.mark_price).toPrecision(6) : "—"}
              </td>
              <td
                className={`px-4 py-3 ${
                  Number(p.unrealized_pnl ?? 0) >= 0
                    ? "text-accent"
                    : "text-danger"
                }`}
              >
                {upnlWithPct(p)}
              </td>
              <td className="px-4 py-3 text-xs text-muted">
                {fmtTime(p.opened_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ClosedTradesTable({ positions }: { positions: Position[] }) {
  if (positions.length === 0) {
    return <p className="thin px-4 py-8 text-muted">No closed trades yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[960px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-muted">
            <th className="eyebrow px-4 py-3 font-normal">Symbol</th>
            <th className="eyebrow px-4 py-3 font-normal">Market</th>
            <th className="eyebrow px-4 py-3 font-normal">Side</th>
            <th className="eyebrow px-4 py-3 font-normal">Lev</th>
            <th className="eyebrow px-4 py-3 font-normal">Size</th>
            <th className="eyebrow px-4 py-3 font-normal">Entry</th>
            <th className="eyebrow px-4 py-3 font-normal">Exit</th>
            <th className="eyebrow px-4 py-3 font-normal">PnL</th>
            <th className="eyebrow px-4 py-3 font-normal">Opened</th>
            <th className="eyebrow px-4 py-3 font-normal">Closed</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.id} className="border-b border-border/50">
              <td className="px-4 py-3">{p.symbol}</td>
              <td className="px-4 py-3 uppercase text-muted">{p.market}</td>
              <td className="px-4 py-3 uppercase">{p.side}</td>
              <td className="px-4 py-3">{p.leverage ?? 1}x</td>
              <td className="px-4 py-3">{money(p.notional)}</td>
              <td className="px-4 py-3">
                {Number(p.entry_price).toPrecision(6)}
              </td>
              <td className="px-4 py-3">
                {p.exit_price ? Number(p.exit_price).toPrecision(6) : "—"}
              </td>
              <td
                className={`px-4 py-3 ${
                  Number(p.realized_pnl ?? 0) >= 0
                    ? "text-accent"
                    : "text-danger"
                }`}
              >
                {p.realized_pnl != null ? money(p.realized_pnl) : "—"}
              </td>
              <td className="px-4 py-3 text-xs text-muted">
                {fmtTime(p.opened_at)}
              </td>
              <td className="px-4 py-3 text-xs text-muted">
                {fmtTime(p.closed_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TraderHistoryHeader({
  username,
  openCount,
  closedCount,
  realizedPnl,
  isSelf,
  followersCount = 0,
  followingCount = 0,
  isFollowing = false,
  followPending = false,
  onToggleFollow,
}: {
  username: string;
  openCount: number;
  closedCount: number;
  realizedPnl: string;
  isSelf?: boolean;
  followersCount?: number;
  followingCount?: number;
  isFollowing?: boolean;
  followPending?: boolean;
  onToggleFollow?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="eyebrow">
          {isSelf ? "Your trade history" : "Trader history"}
        </p>
        <h1
          className="mt-3 text-4xl uppercase md:text-5xl"
          style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
        >
          @{username}
        </h1>
        <p className="thin mt-3 text-sm text-muted">
          {openCount} open · {closedCount} closed · realized{" "}
          <span
            className={
              Number(realizedPnl) >= 0 ? "text-accent" : "text-danger"
            }
          >
            {money(realizedPnl)}
          </span>
        </p>
        <p className="thin mt-2 text-sm text-muted">
          <Link
            href={`/social?tab=followers&user=${encodeURIComponent(username)}`}
            className="hover:text-foreground"
          >
            <span className="text-foreground">{followersCount}</span> followers
          </Link>
          {" · "}
          <Link
            href={`/social?tab=following&user=${encodeURIComponent(username)}`}
            className="hover:text-foreground"
          >
            <span className="text-foreground">{followingCount}</span> following
          </Link>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!isSelf && onToggleFollow ? (
          <button
            type="button"
            onClick={onToggleFollow}
            disabled={followPending}
            className={
              isFollowing
                ? "rounded-full border border-border px-4 py-2 text-sm hover:bg-white/5 disabled:opacity-50"
                : "rounded-full bg-accent px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
            }
            style={{ fontFamily: "var(--font-display)" }}
          >
            {followPending ? (
              <span className="inline-flex items-center gap-2">
                <span className="btn-spinner" aria-hidden="true" />
                {isFollowing ? "Updating…" : "Following…"}
              </span>
            ) : isFollowing ? (
              "Following"
            ) : (
              "Follow"
            )}
          </button>
        ) : null}
        <Link
          href="/traders"
          className="rounded-full border border-border px-4 py-2 text-sm hover:bg-white/5"
          style={{ fontFamily: "var(--font-display)" }}
        >
          All traders
        </Link>
      </div>
    </div>
  );
}
