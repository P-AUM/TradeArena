"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import {
  ClosedTradesTable,
  OpenPositionsTable,
  TraderHistoryHeader,
} from "@/components/TradeHistoryTables";
import {
  apiFollow,
  apiTraderHistory,
  apiUnfollow,
  type TraderHistory,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function TraderHistoryPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const params = useParams();
  const username = decodeURIComponent(String(params.username || ""));

  const [data, setData] = useState<TraderHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [followPending, setFollowPending] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!user || !username) return;
    setLoading(true);
    setError(null);
    apiTraderHistory(username)
      .then(setData)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load history")
      )
      .finally(() => setLoading(false));

    const id = setInterval(() => {
      apiTraderHistory(username).then(setData).catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
  }, [user, username]);

  async function onToggleFollow() {
    if (!data || followPending) return;
    const wasFollowing = Boolean(data.trader.is_following);
    const prevFollowers = data.trader.followers_count ?? 0;
    setFollowPending(true);
    setData({
      ...data,
      trader: {
        ...data.trader,
        is_following: !wasFollowing,
        followers_count: prevFollowers + (wasFollowing ? -1 : 1),
      },
    });
    try {
      const res = wasFollowing
        ? await apiUnfollow(data.trader.username)
        : await apiFollow(data.trader.username);
      setData((cur) =>
        cur
          ? {
              ...cur,
              trader: {
                ...cur.trader,
                is_following: res.is_following,
                followers_count: res.followers_count,
              },
            }
          : cur
      );
    } catch (err) {
      setData((cur) =>
        cur
          ? {
              ...cur,
              trader: {
                ...cur.trader,
                is_following: wasFollowing,
                followers_count: prevFollowers,
              },
            }
          : cur
      );
      setError(err instanceof Error ? err.message : "Follow failed");
    } finally {
      setFollowPending(false);
    }
  }

  if (authLoading || !user) {
    return (
      <>
        <Navbar />
        <main className="pt-32 px-6 text-muted">Loading…</main>
      </>
    );
  }

  const isSelf = user.username.toLowerCase() === username.toLowerCase();

  return (
    <>
      <Navbar />
      <main className="min-h-dvh min-w-0 bg-background pt-28 pb-20">
        <div className="mx-auto max-w-6xl px-6">
          {loading && !data ? (
            <p className="text-muted">Loading history…</p>
          ) : error && !data ? (
            <p className="text-danger" role="alert">
              {error}
            </p>
          ) : data ? (
            <>
              {error ? (
                <p className="mb-4 text-sm text-danger" role="alert">
                  {error}
                </p>
              ) : null}
              <TraderHistoryHeader
                username={data.trader.username}
                openCount={data.trader.open_positions}
                closedCount={data.trader.closed_trades}
                realizedPnl={data.trader.realized_pnl}
                isSelf={isSelf}
                followersCount={data.trader.followers_count ?? 0}
                followingCount={data.trader.following_count ?? 0}
                isFollowing={Boolean(data.trader.is_following)}
                followPending={followPending}
                onToggleFollow={isSelf ? undefined : onToggleFollow}
              />

              <section className="mt-12 border border-border">
                <div className="border-b border-border px-4 py-3">
                  <p className="eyebrow">
                    Open positions ({data.open.length})
                  </p>
                </div>
                <OpenPositionsTable positions={data.open} />
              </section>

              <section className="mt-6 border border-border">
                <div className="border-b border-border px-4 py-3">
                  <p className="eyebrow">
                    Trade history · closed ({data.closed.length})
                  </p>
                </div>
                <ClosedTradesTable positions={data.closed} />
              </section>
            </>
          ) : null}
        </div>
      </main>
    </>
  );
}
