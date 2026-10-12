"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  apiMarkAllNotificationsRead,
  apiMarkNotificationRead,
  apiNotifications,
  type AppNotification,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function NotificationBell() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const data = await apiNotifications();
      setItems(data.results);
      setUnread(data.unread_count);
    } catch {
      /* ignore poll errors */
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => clearInterval(id);
  }, [user, refresh]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!user) return null;

  async function onOpen() {
    setOpen((v) => !v);
    if (!open) refresh();
  }

  async function onClickItem(n: AppNotification) {
    if (!n.read) {
      try {
        await apiMarkNotificationRead(n.id);
        setItems((list) =>
          list.map((x) => (x.id === n.id ? { ...x, read: true } : x))
        );
        setUnread((c) => Math.max(0, c - 1));
      } catch {
        /* ignore */
      }
    }
    setOpen(false);
  }

  async function onMarkAll() {
    try {
      await apiMarkAllNotificationsRead();
      setItems((list) => list.map((x) => ({ ...x, read: true })));
      setUnread(0);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={onOpen}
        className="relative rounded-full border border-border px-3 py-2 text-sm transition-colors hover:bg-white/5"
        aria-label="Notifications"
        aria-expanded={open}
      >
        Alerts
        {unread > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-black">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 mt-2 w-[min(100vw-2rem,22rem)] overflow-hidden rounded-xl border border-border bg-[#0c0c0c] shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <p className="eyebrow">Notifications</p>
            {unread > 0 ? (
              <button
                type="button"
                onClick={onMarkAll}
                className="text-[11px] text-accent hover:underline"
              >
                Mark all read
              </button>
            ) : null}
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {items.length === 0 ? (
              <li className="px-3 py-6 text-sm text-muted">
                No alerts yet. Follow traders to get trade updates.
              </li>
            ) : (
              items.map((n) => (
                <li key={n.id} className="border-b border-border/60 last:border-0">
                  {n.href ? (
                    <Link
                      href={n.href}
                      onClick={() => onClickItem(n)}
                      className={`block px-3 py-3 text-left transition-colors hover:bg-white/[0.04] ${
                        n.read ? "opacity-70" : ""
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p
                          className="text-sm text-foreground"
                          style={{
                            fontFamily: "var(--font-display)",
                            fontWeight: 600,
                          }}
                        >
                          {n.title}
                        </p>
                        <span className="shrink-0 text-[10px] text-muted">
                          {timeAgo(n.created_at)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted">{n.body}</p>
                      {!n.read ? (
                        <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-accent" />
                      ) : null}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onClickItem(n)}
                      className="block w-full px-3 py-3 text-left"
                    >
                      <p className="text-sm">{n.title}</p>
                      <p className="mt-1 text-xs text-muted">{n.body}</p>
                    </button>
                  )}
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
