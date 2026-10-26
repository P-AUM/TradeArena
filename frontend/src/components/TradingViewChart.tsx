"use client";

import { useEffect, useRef, useState } from "react";

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
  height = 560,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    setArmed(false);
  }, [symbol, market]);

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
    <section
      aria-label="Price chart"
      className="min-w-0 self-start overflow-visible border border-border bg-[#0a0a0a] lg:min-w-[480px]"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <p className="eyebrow">Price chart</p>
        <p className="text-[10px] uppercase tracking-wider text-muted">
          {tvSymbol(symbol, market)} · 15m
        </p>
      </div>
      <div
        className="tv-chart-host relative w-full"
        style={{ height, width: "100%" }}
        onMouseLeave={() => setArmed(false)}
      >
        <div
          className="tradingview-widget-container h-full w-full"
          style={{ height, width: "100%" }}
          ref={containerRef}
        />
        {!armed ? (
          <button
            type="button"
            aria-label="Enable chart zoom and pan"
            className="absolute bottom-0 right-0 top-11 left-14 z-10 cursor-pointer bg-transparent"
            onClick={() => setArmed(true)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setArmed(false)}
            className="absolute right-2 top-12 z-10 rounded-full border border-border bg-black/70 px-3 py-1 text-[11px] text-foreground backdrop-blur-sm"
          >
            Done
          </button>
        )}
      </div>
    </section>
  );
}
