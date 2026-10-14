"use client";

import { useEffect, useRef } from "react";

type Props = {
  symbol: string;
  market: "spot" | "futures";
  height?: number;
};

const ADVANCED_CHART_SCRIPT =
  "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

function tvSymbol(symbol: string, market: "spot" | "futures") {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return market === "futures" ? `BINANCE:${s}.P` : `BINANCE:${s}`;
}

export default function TradingViewChart({
  symbol,
  market,
  height = 480,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    root.innerHTML = "";

    const widgetMount = document.createElement("div");
    widgetMount.className = "tradingview-widget-container__widget";
    widgetMount.style.width = "100%";
    widgetMount.style.height = `${height}px`;
    root.appendChild(widgetMount);

    const script = document.createElement("script");
    script.src = ADVANCED_CHART_SCRIPT;
    script.type = "text/javascript";
    script.async = true;
    // Explicit height — autosize collapses inside our layout
    script.innerHTML = JSON.stringify({
      width: "100%",
      height,
      symbol: tvSymbol(symbol, market),
      interval: "15",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      backgroundColor: "#0a0a0a",
      gridColor: "rgba(255,255,255,0.06)",
      hide_top_toolbar: false,
      hide_legend: false,
      hide_side_toolbar: false,
      allow_symbol_change: false,
      save_image: false,
      calendar: false,
      withdateranges: true,
      details: false,
      hotlist: false,
      studies: ["Volume@tv-basicstudies"],
      support_host: "https://www.tradingview.com",
    });
    root.appendChild(script);

    return () => {
      root.innerHTML = "";
    };
  }, [symbol, market, height]);

  return (
    <div className="overflow-hidden border border-border bg-[#0a0a0a]">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="eyebrow">Chart · TradingView</p>
        <p className="text-[10px] uppercase tracking-wider text-muted">
          {tvSymbol(symbol, market)} · 15m · drawings on
        </p>
      </div>
      <div
        className="tradingview-widget-container relative w-full overflow-hidden"
        style={{ height, width: "100%" }}
        ref={containerRef}
      />
    </div>
  );
}
