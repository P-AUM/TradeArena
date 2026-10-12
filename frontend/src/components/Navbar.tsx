"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Logo from "./Logo";
import NotificationBell from "./NotificationBell";
import { useAuth } from "@/lib/auth";

function prefetchTvScript() {
  if (typeof document === "undefined") return;
  if (document.getElementById("tradingview-widget-script")) return;
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "script";
  link.href = "https://s3.tradingview.com/tv.js";
  link.id = "tradingview-preload";
  document.head.appendChild(link);
}

export default function Navbar() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();

  const publicLinks = [
    { label: "How it works", href: "/#how-it-works" },
    { label: "Features", href: "/#features" },
  ];

  const authedLinks =
    user?.role === "trader"
      ? [
          { label: "Dashboard", href: "/dashboard" },
          { label: "Trade", href: "/trade" },
          { label: "History", href: `/traders/${encodeURIComponent(user.username)}` },
          { label: "Leaderboard", href: "/leaderboard" },
          { label: "Following", href: "/social" },
          { label: "Traders", href: "/traders" },
        ]
      : [
          { label: "Dashboard", href: "/dashboard" },
          { label: "Leaderboard", href: "/leaderboard" },
          { label: "Following", href: "/social" },
          { label: "Traders", href: "/traders" },
        ];

  // Warm route chunks so History → Trade feels instant
  useEffect(() => {
    if (!user) return;
    for (const link of authedLinks) {
      router.prefetch(link.href);
    }
    if (user.role === "trader") prefetchTvScript();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prefetch when user identity changes
  }, [user?.id, user?.role, user?.username, router]);

  return (
    <header className="fixed top-0 inset-x-0 z-50">
      <div className="mx-auto max-w-7xl px-6">
        <nav className="mt-4 flex items-center justify-between rounded-full border border-border bg-white/[0.03] px-5 py-2.5 backdrop-blur-md">
          <Link href={user ? "/dashboard" : "/"} className="flex items-center">
            <Logo />
          </Link>

          <ul className="hidden md:flex items-center gap-7 text-sm text-muted">
            {(user ? authedLinks : publicLinks).map((link) => (
              <li key={link.label}>
                <Link
                  href={link.href}
                  prefetch
                  onMouseEnter={() => router.prefetch(link.href)}
                  className="transition-colors hover:text-foreground"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-3">
            {loading && !user ? (
              <span className="text-xs text-muted">…</span>
            ) : user ? (
              <>
                <NotificationBell />
                <span className="hidden sm:inline text-xs text-muted">
                  <span className="text-foreground">{user.username}</span>
                  {" · "}
                  {user.role}
                </span>
                <button
                  type="button"
                  onClick={logout}
                  className="rounded-full border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-white/5"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  Log out
                </button>
              </>
            ) : (
              <>
                <Link
                  href="/login"
                  className="hidden sm:inline text-sm text-muted transition-colors hover:text-foreground"
                >
                  Log in
                </Link>
                <Link
                  href="/signup"
                  className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  Enter Arena
                </Link>
              </>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}
