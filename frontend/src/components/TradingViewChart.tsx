"use client";

import { useEffect, useId, useRef } from "react";

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => { remove?: () => void };
    };
  }
}

type Props = {
  symbol: string;
  market: "spot" | "futures";
  height?: number;
};

function tvSymbol(symbol: string, market: "spot" | "futures") {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return market === "futures" ? `BINANCE:${s}.P` : `BINANCE:${s}`;
}

function loadTvScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.TradingView) return Promise.resolve();

  const existing = document.getElementById(
    "tradingview-widget-script"
  ) as HTMLScriptElement | null;

  if (existing) {
    return new Promise((resolve, reject) => {
      if (window.TradingView) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("TradingView script failed")),
        { once: true }
      );
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.id = "tradingview-widget-script";
    script.src = "https://s3.tradingview.com/tv.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("TradingView script failed to load"));
    document.head.appendChild(script);
  });
}

export default function TradingViewChart({
  symbol,
  market,
  height = 480,
}: Props) {
  const reactId = useId().replace(/:/g, "");
  const containerId = `tv_chart_${reactId}`;
  const widgetRef = useRef<{ remove?: () => void } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function mount() {
      try {
        await loadTvScript();
        if (cancelled || !window.TradingView) return;

        const el = document.getElementById(containerId);
        if (el) el.innerHTML = "";

        widgetRef.current = new window.TradingView.widget({
          width: "100%",
          height,
          symbol: tvSymbol(symbol, market),
          interval: "15",
          timezone: "Etc/UTC",
          theme: "dark",
          style: "1",
          locale: "en",
          toolbar_bg: "#0a0a0a",
          enable_publishing: false,
          hide_top_toolbar: false,
          hide_legend: false,
          allow_symbol_change: false,
          save_image: false,
          calendar: false,
          withdateranges: true,
          details: false,
          hotlist: false,
          studies: ["Volume@tv-basicstudies"],
          container_id: containerId,
          backgroundColor: "#0a0a0a",
          gridColor: "rgba(255,255,255,0.06)",
        });
      } catch {
        /* ignore */
      }
    }

    mount();

    return () => {
      cancelled = true;
      try {
        widgetRef.current?.remove?.();
      } catch {
        /* ignore */
      }
      widgetRef.current = null;
      const el = document.getElementById(containerId);
      if (el) el.innerHTML = "";
    };
  }, [symbol, market, containerId, height]);

  return (
    <div className="overflow-hidden border border-border bg-[#0a0a0a]">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="eyebrow">Chart · TradingView</p>
        <p className="text-[10px] uppercase tracking-wider text-muted">
          {tvSymbol(symbol, market)} · 15m
        </p>
      </div>
      <div
        className="relative w-full overflow-hidden"
        style={{ height }}
      >
        <div id={containerId} className="h-full w-full" />
      </div>
    </div>
  );
}
