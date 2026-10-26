"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import TraderSearch from "@/components/TraderSearch";
import { apiTraders, type TraderSummary } from "@/lib/api";
import { useAuth } from "@/lib/auth";

function money(n: string | number) {
  const v = typeof n === "string" ? Number(n) : n;
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export default function TradersPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [traders, setTraders] = useState<TraderSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    apiTraders()
      .then(setTraders)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, [user]);

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
      <main className="min-h-dvh min-w-0 bg-background pt-28 pb-20">
        <div className="mx-auto max-w-5xl px-6">
          <p className="eyebrow">Arena</p>
          <h1 className="statement mt-4 text-5xl uppercase md:text-6xl">
            Traders
          </h1>
          <p className="thin mt-4 max-w-xl text-muted">
            Search a trader — suggestions appear as you type. Open their
            history to see positions and closed trades.
          </p>

          <TraderSearch className="mt-8 max-w-md" />

          {error ? (
            <p className="mt-4 text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-10 overflow-x-auto border-y border-border">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="eyebrow py-4 pr-3 font-normal">Trader</th>
                  <th className="eyebrow py-4 pr-3 font-normal">Open</th>
                  <th className="eyebrow py-4 pr-3 font-normal">Closed</th>
                  <th className="eyebrow py-4 pr-3 font-normal">Realized PnL</th>
                  <th className="eyebrow py-4 font-normal" />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-muted">
                      Loading…
                    </td>
                  </tr>
                ) : traders.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-muted">
                      No traders yet.
                    </td>
                  </tr>
                ) : (
                  traders.map((t) => (
                    <tr key={t.id} className="border-b border-border/60">
                      <td
                        className="py-4 pr-3"
                        style={{
                          fontFamily: "var(--font-display)",
                          fontWeight: 600,
                        }}
                      >
                        @{t.username}
                        {t.username === user.username ? (
                          <span className="ml-2 text-xs text-accent">you</span>
                        ) : null}
                      </td>
                      <td className="py-4 pr-3 text-muted">
                        {t.open_positions}
                      </td>
                      <td className="py-4 pr-3 text-muted">
                        {t.closed_trades}
                      </td>
                      <td
                        className={`py-4 pr-3 ${
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
        </div>
      </main>
    </>
  );
}
