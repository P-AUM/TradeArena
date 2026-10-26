"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import Logo from "./Logo";
import NotificationBell from "./NotificationBell";
import { useAuth } from "@/lib/auth";

function prefetchTvScript() {
  if (typeof document === "undefined") return;
  if (document.getElementById("tradingview-preload")) return;
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "script";
  link.href =
    "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
  link.id = "tradingview-preload";
  document.head.appendChild(link);
}

function isNavActive(
  href: string,
  pathname: string,
  hash: string,
  username?: string
) {
  if (href.includes("#")) {
    const fragment = href.split("#")[1] ?? "";
    return pathname === "/" && hash === fragment;
  }
  if (href === "/traders") {
    if (pathname === "/traders") return true;
    if (
      username &&
      pathname.startsWith("/traders/") &&
      pathname !== `/traders/${encodeURIComponent(username)}`
    ) {
      return true;
    }
    return false;
  }
  return pathname === href;
}

export default function Navbar() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [hash, setHash] = useState("");

  useEffect(() => {
    const read = () => setHash(window.location.hash.replace(/^#/, ""));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [pathname]);

  const publicLinks = [
    { label: "How it works", href: "/#how-it-works" },
    { label: "Features", href: "/#features" },
  ];

  const authedLinks =
    user?.role === "trader"
      ? [
          { label: "Dashboard", href: "/dashboard" },
          { label: "Trade", href: "/trade" },
          { label: "Tournaments", href: "/tournaments" },
          { label: "History", href: `/traders/${encodeURIComponent(user.username)}` },
          { label: "Leaderboard", href: "/leaderboard" },
          { label: "Following", href: "/social" },
          { label: "Traders", href: "/traders" },
        ]
      : user?.role === "admin"
        ? [
            { label: "Dashboard", href: "/dashboard" },
            { label: "Tournaments", href: "/tournaments" },
            { label: "Leaderboard", href: "/leaderboard" },
            { label: "Traders", href: "/traders" },
          ]
        : [
            { label: "Dashboard", href: "/dashboard" },
            { label: "Tournaments", href: "/tournaments" },
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
    <header className="site-header fixed top-0 inset-x-0 z-50 w-full">
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
        <nav className="mt-4 flex min-w-0 items-center justify-between gap-2 rounded-full border border-border bg-white/[0.03] px-3 py-2.5 backdrop-blur-md sm:px-5">
          <Link href={user ? "/dashboard" : "/"} className="flex items-center">
            <Logo />
          </Link>

          <ul className="hidden md:flex items-center gap-1.5 text-sm text-muted">
            {(user ? authedLinks : publicLinks).map((link) => {
              const active = isNavActive(
                link.href,
                pathname,
                hash,
                user?.username
              );
              return (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    prefetch
                    aria-current={active ? "page" : undefined}
                    onMouseEnter={() => router.prefetch(link.href)}
                    onClick={() => {
                      if (link.href.includes("#")) {
                        setHash(link.href.split("#")[1] ?? "");
                      }
                    }}
                    className={
                      active
                        ? "rounded-full bg-foreground px-3 py-1.5 font-semibold text-black"
                        : "rounded-full px-3 py-1.5 transition-colors hover:bg-white/5 hover:text-foreground"
                    }
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
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
                  aria-current={pathname === "/login" ? "page" : undefined}
                  className={
                    pathname === "/login"
                      ? "hidden sm:inline text-sm font-semibold text-foreground"
                      : "hidden sm:inline text-sm text-muted transition-colors hover:text-foreground"
                  }
                >
                  Log in
                </Link>
                <Link
                  href="/signup"
                  aria-current={pathname === "/signup" ? "page" : undefined}
                  className={
                    pathname === "/signup"
                      ? "rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-black ring-2 ring-accent/70"
                      : "rounded-full bg-foreground px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90"
                  }
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
