"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import Navbar from "@/components/Navbar";
import {
  apiFollowers,
  apiFollowing,
  apiMySocial,
  apiUnfollow,
  type Role,
  type SocialUser,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

type Tab = "following" | "followers";

function SocialContent() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const profileUser = searchParams.get("user") || user?.username || "";
  const tabParam = searchParams.get("tab");
  const initialTab: Tab =
    tabParam === "followers" ? "followers" : "following";

  const [tab, setTab] = useState<Tab>(initialTab);
  const [followers, setFollowers] = useState<SocialUser[]>([]);
  const [following, setFollowing] = useState<SocialUser[]>([]);
  const [followersCount, setFollowersCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [profileRole, setProfileRole] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyUser, setBusyUser] = useState<string | null>(null);

  const isOwn = useMemo(
    () =>
      Boolean(
        user &&
          profileUser &&
          user.username.toLowerCase() === profileUser.toLowerCase()
      ),
    [user, profileUser]
  );

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [authLoading, user, router]);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const load = useCallback(async () => {
    if (!user || !profileUser) return;
    setLoading(true);
    setError(null);
    try {
      if (isOwn) {
        const data = await apiMySocial();
        setFollowers(data.followers);
        setFollowing(data.following);
        setFollowersCount(data.followers_count);
        setFollowingCount(data.following_count);
        setProfileRole(user.role);
      } else {
        const [fol, fing] = await Promise.all([
          apiFollowers(profileUser),
          apiFollowing(profileUser),
        ]);
        setFollowers(fol.results);
        setFollowing(fing.results);
        setFollowersCount(fol.count);
        setFollowingCount(fing.count);
        setProfileRole(fol.role);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [user, profileUser, isOwn]);

  useEffect(() => {
    load();
  }, [load]);

  function switchTab(next: Tab) {
    setTab(next);
    const params = new URLSearchParams();
    params.set("tab", next);
    if (profileUser) params.set("user", profileUser);
    router.replace(`/social?${params.toString()}`);
  }

  async function onUnfollow(username: string) {
    setBusyUser(username);
    setError(null);
    const prev = following;
    setFollowing((list) => list.filter((u) => u.username !== username));
    setFollowingCount((c) => Math.max(0, c - 1));
    try {
      await apiUnfollow(username);
    } catch (err) {
      setFollowing(prev);
      setFollowingCount(prev.length);
      setError(err instanceof Error ? err.message : "Unfollow failed");
    } finally {
      setBusyUser(null);
    }
  }

  if (authLoading || !user) {
    return <main className="pt-32 px-6 text-muted">Loading…</main>;
  }

  const viewerOwnFollowers =
    isOwn && user.role === "viewer" && tab === "followers";
  const rows = tab === "following" ? following : followers;
  const emptyCopy =
    tab === "following"
      ? "Not following anyone yet."
      : profileRole === "viewer"
        ? "Viewers don’t have followers — only traders do."
        : "No followers yet.";

  return (
    <main className="min-h-screen bg-background pt-28 pb-20">
      <div className="mx-auto max-w-3xl px-6">
        <p className="eyebrow">Social</p>
        <h1 className="statement mt-4 text-5xl uppercase md:text-6xl">
          {isOwn ? "Your circle" : `@${profileUser}`}
        </h1>
        <p className="thin mt-4 max-w-xl text-muted">
          Follow traders to watch their book.{" "}
          {isOwn && user.role === "viewer"
            ? "As a viewer you can follow traders; nobody follows viewers."
            : "Anyone can follow a trader."}
        </p>

        <div
          className="mt-8 inline-flex flex-wrap gap-1 rounded-full border border-border p-1"
          role="tablist"
          aria-label="Social lists"
        >
          {(
            [
              {
                id: "following" as const,
                label: `Following (${followingCount})`,
              },
              {
                id: "followers" as const,
                label: `Followers (${followersCount})`,
              },
            ] as const
          ).map((opt) => {
            const active = tab === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => switchTab(opt.id)}
                className={`rounded-full px-3.5 py-1.5 text-xs transition-colors ${
                  active
                    ? "bg-accent text-black"
                    : "text-muted hover:text-foreground"
                }`}
                style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {error ? (
          <p className="mt-4 text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-10 border-y border-border">
          {loading ? (
            <p className="py-8 text-muted">Loading…</p>
          ) : viewerOwnFollowers || rows.length === 0 ? (
            <p className="py-8 text-muted">{emptyCopy}</p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row) => {
                const isTrader = row.role === "trader";
                return (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-4"
                  >
                    <div>
                      <p
                        style={{
                          fontFamily: "var(--font-display)",
                          fontWeight: 600,
                        }}
                      >
                        @{row.username}
                      </p>
                      <p className="eyebrow mt-1">{row.role}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {isTrader ? (
                        <Link
                          href={`/traders/${encodeURIComponent(row.username)}`}
                          className="rounded-full border border-border px-3 py-1.5 text-xs hover:bg-white/5"
                        >
                          View
                        </Link>
                      ) : null}
                      {tab === "following" && isOwn ? (
                        <button
                          type="button"
                          disabled={busyUser === row.username}
                          onClick={() => onUnfollow(row.username)}
                          className="rounded-full border border-border px-3 py-1.5 text-xs hover:bg-white/5 disabled:opacity-50"
                        >
                          {busyUser === row.username ? "…" : "Unfollow"}
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}

export default function SocialPage() {
  return (
    <>
      <Navbar />
      <Suspense
        fallback={<main className="pt-32 px-6 text-muted">Loading…</main>}
      >
        <SocialContent />
      </Suspense>
    </>
  );
}
