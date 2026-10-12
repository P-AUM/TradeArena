"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiTraders, type TraderSummary } from "@/lib/api";

type Props = {
  placeholder?: string;
  className?: string;
  onSelect?: (trader: TraderSummary) => void;
};

export default function TraderSearch({
  placeholder = "Search traders by username…",
  className = "",
  onSelect,
}: Props) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<TraderSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      setLoading(true);
      apiTraders(q.trim())
        .then((list) => setHits(list.slice(0, 8)))
        .catch(() => setHits([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function go(t: TraderSummary) {
    setQ(t.username);
    setOpen(false);
    if (onSelect) onSelect(t);
    else router.push(`/traders/${encodeURIComponent(t.username)}`);
  }

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-border bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-accent/40"
        autoComplete="off"
      />
      {open && q.trim() ? (
        <ul className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-border bg-[#0c0c0c] shadow-xl">
          {loading ? (
            <li className="px-4 py-3 text-sm text-muted">Searching…</li>
          ) : hits.length === 0 ? (
            <li className="px-4 py-3 text-sm text-muted">No traders found</li>
          ) : (
            hits.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm hover:bg-white/5"
                  onClick={() => go(t)}
                >
                  <span style={{ fontFamily: "var(--font-display)" }}>
                    @{t.username}
                  </span>
                  <span className="text-xs text-muted">
                    {t.open_positions} open · {t.closed_trades} closed
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
