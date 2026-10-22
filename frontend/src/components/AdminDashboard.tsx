"use client";

import Link from "next/link";
import type { AuthUser } from "@/lib/api";

export default function AdminDashboard({ user }: { user: AuthUser }) {
  return (
    <div className="mx-auto max-w-7xl px-6 pt-36 pb-24">
      <p className="eyebrow">Admin</p>
      <h1 className="statement mt-3 text-4xl sm:text-5xl">
        Hello, {user.username}
      </h1>
      <p className="thin mt-4 max-w-lg text-muted">
        Organize tournaments, watch live standings, and settle prizes when
        events end. Traders join before start via the payment stub.
      </p>
      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/tournaments"
          className="rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-black"
        >
          Manage tournaments
        </Link>
        <Link
          href="/leaderboard"
          className="rounded-full border border-border px-5 py-2.5 text-sm text-muted hover:text-foreground"
        >
          Paper leaderboard
        </Link>
      </div>
    </div>
  );
}
