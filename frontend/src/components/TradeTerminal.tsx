"use client";

import {
  FormEvent,
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import Navbar from "@/components/Navbar";
import PendingButton from "@/components/PendingButton";

const TradingViewChart = dynamic(() => import("@/components/TradingViewChart"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[420px] items-center justify-center rounded-lg bg-white/[0.03] text-sm text-muted">
      Loading chart…
    </div>
  ),
});
import {
  apiAdjustPosition,
  apiCancelOrder,
  apiClosePosition,
  apiOrderBook,
  apiOrders,
  apiPlaceOrder,
  apiPositions,
  apiProtectPosition,
  apiRecentTrades,
  apiSearchSymbols,
  apiTicker,
  apiWallets,
  type MarketType,
  type OrderBookLevel,
  type OrderType,
  type PaperOrder,
  type Position,
  type RecentTrade,
  type SymbolHit,
  type Ticker,
  type Wallet,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

type BookSide = "spot" | "futures";

const LEVERAGE_PRESETS: Record<BookSide, number[]> = {
  spot: [1],
  futures: [1, 2, 5, 10, 20, 25, 40],
};

function money(n: string | number) {
  const v = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(v)) return "—";
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

/** uPnL can be tiny on small notionals — show more precision */
function pnlMoney(n: string | number) {
  const v = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs > 0 && abs < 0.01 ? 4 : 2;
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function liveMarkFor(p: Position, viewSymbol: string, liveLast: string | undefined) {
  if (p.symbol === viewSymbol && isValidPrice(liveLast)) return Number(liveLast);
  if (isValidPrice(p.mark_price)) return Number(p.mark_price);
  return null;
}

/** Reject empty / zero / NaN so UI never flashes 0 from a bad WS tick. */
function isValidPrice(raw: unknown): raw is string | number {
  if (raw == null || raw === "") return false;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0;
}

/** Always keep fraction digits so 123.00 and 123.34 occupy the same width. */
function formatLastPrice(raw: string | undefined | null): string {
  if (!isValidPrice(raw)) return "—";
  const v = Number(raw);
  const frac = String(raw).split(".")[1] ?? "";
  const significant = frac.replace(/0+$/, "").length;
  const decimals = Math.max(2, Math.min(8, significant || 2));
  return v.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function wsPayload(msg: Record<string, unknown>): Record<string, unknown> {
  // Combined streams: { stream, data: { ... } }
  const data = msg.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return msg;
}

function liveUpnl(p: Position, mark: number | null) {
  if (mark == null || Number.isNaN(mark)) {
    return p.unrealized_pnl != null ? Number(p.unrealized_pnl) : null;
  }
  const entry = Number(p.entry_price);
  const qty = Number(p.quantity);
  let diff = mark - entry;
  if (p.side === "short") diff = -diff;
  return diff * qty;
}

/** ROI % on margin (falls back to notional) */
function liveUpnlPct(p: Position, upnl: number | null) {
  if (upnl == null) return null;
  const base = Number(p.margin) > 0 ? Number(p.margin) : Number(p.notional);
  if (!base) return null;
  return (upnl / base) * 100;
}

export default function TradeTerminal() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tournamentParam = searchParams.get("tournament");
  const tournamentId = tournamentParam ? Number(tournamentParam) : null;
  const inTournament =
    tournamentId != null && Number.isFinite(tournamentId) && tournamentId > 0;

  const [market, setMarket] = useState<BookSide>("spot");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [showSearch, setShowSearch] = useState(false);

  const [bids, setBids] = useState<OrderBookLevel[]>([]);
  const [asks, setAsks] = useState<OrderBookLevel[]>([]);
  const [trades, setTrades] = useState<RecentTrade[]>([]);
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [openOrders, setOpenOrders] = useState<PaperOrder[]>([]);

  const [side, setSide] = useState<"long" | "short">("long");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [notional, setNotional] = useState("100");
  const [leverage, setLeverage] = useState(1);
  const [limitPrice, setLimitPrice] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [adjustId, setAdjustId] = useState<number | null>(null);
  const [adjustAction, setAdjustAction] = useState<"add" | "trim" | "protect">(
    "add"
  );
  const [adjustAmount, setAdjustAmount] = useState("50");
  const [editSl, setEditSl] = useState("");
  const [editTp, setEditTp] = useState("");

  const depthWs = useRef<WebSocket | null>(null);
  const tradeWs = useRef<WebSocket | null>(null);
  const ticketRef = useRef<HTMLElement | null>(null);
  const positionsRef = useRef<Position[]>([]);
  const protectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProtectCheckRef = useRef(0);
  /** Chart body height — synced to order ticket so bottoms align */
  const [chartHeight, setChartHeight] = useState(560);

  useEffect(() => {
    if (!authLoading && (!user || user.role !== "trader")) {
      router.replace(user ? "/dashboard" : "/login");
    }
  }, [authLoading, user, router]);

  const wallet = useMemo(
    () => wallets.find((w) => w.market === market),
    [wallets, market]
  );

  /** One open position per market+symbol — same side merges, opposite blocked. */
  const openOnSymbol = useMemo(
    () =>
      positions.find((p) => p.market === market && p.symbol === symbol) ?? null,
    [positions, market, symbol]
  );

  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  useEffect(() => {
    if (!openOnSymbol) return;
    setSide(openOnSymbol.side === "short" ? "short" : "long");
    if (market !== "spot") {
      setLeverage(Number(openOnSymbol.leverage) || 1);
    }
  }, [openOnSymbol?.id, openOnSymbol?.side, openOnSymbol?.leverage, market]);

  useLayoutEffect(() => {
    const el = ticketRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const CHART_TITLE_BAR = 52;
    const sync = () => {
      const ticketH = Math.round(el.getBoundingClientRect().height);
      const next = Math.max(480, ticketH - CHART_TITLE_BAR);
      setChartHeight((prev) => (Math.abs(prev - next) < 8 ? prev : next));
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [openOnSymbol?.id, orderType, market]);

  const effectiveLeverage =
    market === "spot"
      ? 1
      : openOnSymbol
        ? Number(openOnSymbol.leverage) || 1
        : leverage;
  const marginRequired = useMemo(() => {
    const n = Number(notional);
    if (!n || !effectiveLeverage) return 0;
    return n / effectiveLeverage;
  }, [notional, effectiveLeverage]);

  const estLiqPrice = useMemo(() => {
    if (effectiveLeverage <= 1) return null;
    const entry =
      orderType === "limit" ? Number(limitPrice) : Number(ticker?.lastPrice);
    if (!entry || Number.isNaN(entry)) return null;
    const frac = 1 / effectiveLeverage;
    return side === "long" ? entry * (1 - frac) : entry * (1 + frac);
  }, [effectiveLeverage, orderType, limitPrice, ticker?.lastPrice, side]);

  useEffect(() => {
    if (market === "spot") setLeverage(1);
    else if (leverage > 40) setLeverage(40);
  }, [market]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshAccount = useCallback(async () => {
    try {
      const tid = inTournament ? tournamentId : null;
      // Positions first — backend runs SL/TP/limit/liquidation checks here
      const p = await apiPositions("open", tid);
      setPositions(p);
      positionsRef.current = p;
      const [w, o] = await Promise.all([
        apiWallets(tid),
        apiOrders("open", tid),
      ]);
      setWallets(w);
      setOpenOrders(o);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Account load failed");
    }
  }, [inTournament, tournamentId]);

  /** Near-instant SL/TP check when live price crosses (throttled). */
  const scheduleProtectCheck = useCallback(() => {
    const now = Date.now();
    const minGap = 350;
    const run = () => {
      lastProtectCheckRef.current = Date.now();
      void refreshAccount();
    };
    if (now - lastProtectCheckRef.current >= minGap) {
      run();
      return;
    }
    if (protectTimerRef.current) return;
    protectTimerRef.current = setTimeout(() => {
      protectTimerRef.current = null;
      run();
    }, minGap - (now - lastProtectCheckRef.current));
  }, [refreshAccount]);

  const loadMarketData = useCallback(async () => {
    setError(null);
    try {
      const [book, t, tr] = await Promise.all([
        apiOrderBook(market, symbol),
        apiTicker(market, symbol),
        apiRecentTrades(market, symbol),
      ]);
      setBids(book.bids);
      setAsks([...book.asks].reverse());
      setTicker(t);
      setTrades(tr.trades);
      if (!limitPrice && t.lastPrice) {
        setLimitPrice(String(Number(t.lastPrice)));
      }

      depthWs.current?.close();
      tradeWs.current?.close();
      setLive(false);

      const depthUrl = `${book.ws.url}/${book.ws.stream}`;
      const tUrl = `${tr.ws.url}/${tr.ws.stream}`;

      const dws = new WebSocket(depthUrl);
      depthWs.current = dws;
      dws.onopen = () => setLive(true);
      dws.onmessage = (ev) => {
        try {
          const msg = wsPayload(JSON.parse(ev.data));
          const b = (msg.bids || msg.b) as string[][] | undefined;
          const a = (msg.asks || msg.a) as string[][] | undefined;
          if (b?.length) {
            const next = b
              .slice(0, 20)
              .filter((x) => isValidPrice(x?.[0]))
              .map((x) => ({ price: String(x[0]), qty: String(x[1] ?? "0") }));
            if (next.length) setBids(next);
          }
          if (a?.length) {
            const next = [...a.slice(0, 20)]
              .reverse()
              .filter((x) => isValidPrice(x?.[0]))
              .map((x) => ({ price: String(x[0]), qty: String(x[1] ?? "0") }));
            if (next.length) setAsks(next);
          }
        } catch {
          /* ignore */
        }
      };

      const tws = new WebSocket(tUrl);
      tradeWs.current = tws;
      tws.onmessage = (ev) => {
        try {
          const msg = wsPayload(JSON.parse(ev.data));
          const price = msg.p;
          if (!isValidPrice(price)) return;

          const px = Number(price);
          const row: RecentTrade = {
            id: Number(msg.t ?? msg.a ?? Date.now()),
            price: String(price),
            qty: String(msg.q ?? "0"),
            time: Number(msg.T ?? Date.now()),
            isBuyerMaker: Boolean(msg.m),
          };
          setTrades((prev) => [row, ...prev].slice(0, 40));
          setTicker((prev) =>
            prev ? { ...prev, lastPrice: String(price) } : prev
          );

          // If live trade price crosses SL/TP on this symbol, check immediately
          for (const p of positionsRef.current) {
            if (p.market !== market || p.symbol !== symbol) continue;
            const sl = p.stop_loss != null ? Number(p.stop_loss) : null;
            const tp = p.take_profit != null ? Number(p.take_profit) : null;
            if (sl == null && tp == null) continue;
            let hit = false;
            if (p.side === "long") {
              if (sl != null && px <= sl) hit = true;
              if (tp != null && px >= tp) hit = true;
            } else {
              if (sl != null && px >= sl) hit = true;
              if (tp != null && px <= tp) hit = true;
            }
            if (hit) {
              scheduleProtectCheck();
              break;
            }
          }
        } catch {
          /* ignore */
        }
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Market data failed");
    }
  }, [market, symbol, scheduleProtectCheck]);

  useEffect(() => {
    if (user?.role === "trader") {
      refreshAccount();
      loadMarketData();
    }
    return () => {
      depthWs.current?.close();
      tradeWs.current?.close();
      if (protectTimerRef.current) clearTimeout(protectTimerRef.current);
    };
  }, [user, refreshAccount, loadMarketData]);

  // Fast poll when positions/orders need watching; slow when idle
  useEffect(() => {
    if (user?.role !== "trader") return;
    const needsFast =
      positions.length > 0 ||
      openOrders.length > 0 ||
      positions.some((p) => p.stop_loss != null || p.take_profit != null);
    const ms = needsFast ? 1_000 : 8_000;
    const id = setInterval(() => {
      void refreshAccount();
    }, ms);
    return () => clearInterval(id);
  }, [user, refreshAccount, positions, openOrders]);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      apiSearchSymbols(market, query)
        .then(setHits)
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query, market]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    flushSync(() => setBusy(true));
    setError(null);
    try {
      const sl = stopLoss.trim() ? Number(stopLoss) : null;
      const tp = takeProfit.trim() ? Number(takeProfit) : null;
      await apiPlaceOrder({
        market: market as MarketType,
        symbol,
        side,
        order_type: orderType,
        notional: Number(notional),
        leverage: effectiveLeverage,
        limit_price:
          orderType === "limit" ? Number(limitPrice) : undefined,
        stop_loss: sl && sl > 0 ? sl : null,
        take_profit: tp && tp > 0 ? tp : null,
        tournament_id: inTournament ? tournamentId : null,
      });
      await refreshAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Order failed");
    } finally {
      setBusy(false);
    }
  }

  async function onClose(id: number) {
    flushSync(() => setBusy(true));
    try {
      await apiClosePosition(id);
      await refreshAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Close failed");
    } finally {
      setBusy(false);
    }
  }

  async function onProtectSave() {
    if (adjustId == null) return;
    flushSync(() => setBusy(true));
    setError(null);
    try {
      const sl = editSl.trim() ? Number(editSl) : null;
      const tp = editTp.trim() ? Number(editTp) : null;
      await apiProtectPosition(adjustId, {
        stop_loss: sl && sl > 0 ? sl : null,
        take_profit: tp && tp > 0 ? tp : null,
      });
      setAdjustId(null);
      await refreshAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update SL/TP");
    } finally {
      setBusy(false);
    }
  }

  async function onAdjust() {
    if (adjustId == null || adjustAction === "protect") return;
    flushSync(() => setBusy(true));
    setError(null);
    try {
      await apiAdjustPosition(adjustId, {
        action: adjustAction,
        notional: Number(adjustAmount),
      });
      setAdjustId(null);
      await refreshAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Adjust failed");
    } finally {
      setBusy(false);
    }
  }

  async function onCancelOrder(id: number) {
    flushSync(() => setBusy(true));
    try {
      await apiCancelOrder(id);
      await refreshAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || !user) {
    return (
      <>
        <Navbar />
        <main className="pt-32 px-6 text-muted">Loading terminal…</main>
      </>
    );
  }

  const change = Number(ticker?.priceChangePercent ?? 0);
  const last = ticker?.lastPrice;
  const marketPositions = positions.filter((p) => p.market === market);
  const otherMarketPositions = positions.filter((p) => p.market !== market);
  const marketOrders = openOrders.filter((o) => o.market === market);

  return (
    <>
      <Navbar />
      <main className="relative min-h-screen overflow-x-hidden bg-background pt-24 pb-28">
        <div className="mx-auto max-w-[1600px] px-4">
          {inTournament ? (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
              <p>
                <span className="font-semibold text-accent">Tournament mode</span>
                <span className="text-muted">
                  {" "}
                  · isolated $10k wallets · crypto spot &amp; futures only
                </span>
              </p>
              <Link
                href="/tournaments"
                className="text-muted underline-offset-2 hover:text-foreground hover:underline"
              >
                Back to tournaments
              </Link>
            </div>
          ) : null}
          {/* Top bar */}
          <div className="flex flex-wrap items-center gap-3 border-b border-border pb-4">
            <div className="flex rounded-full border border-border p-1 text-sm">
              {(["spot", "futures"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMarket(m);
                    setSymbol("BTCUSDT");
                    setQuery("");
                    setLimitPrice("");
                  }}
                  className={`rounded-full px-4 py-1.5 capitalize ${
                    market === m ? "bg-foreground text-black" : "text-muted"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>

            <div className="relative min-w-[220px] max-w-md flex-1">
              <input
                value={showSearch || query ? query : symbol}
                onFocus={() => setShowSearch(true)}
                onChange={(e) => {
                  setShowSearch(true);
                  setQuery(e.target.value);
                }}
                placeholder="Search any coin (BTC, ETH, PEPE…)"
                className="w-full rounded-lg border border-border bg-white/[0.03] px-4 py-2.5 text-sm outline-none focus:border-accent/40"
              />
              {showSearch && hits.length > 0 ? (
                <ul className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-[#0c0c0c] shadow-xl">
                  {hits.map((h) => (
                    <li key={h.symbol}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm hover:bg-white/5"
                        onClick={() => {
                          setSymbol(h.symbol);
                          setQuery("");
                          setShowSearch(false);
                          setLimitPrice("");
                        }}
                      >
                        <span style={{ fontFamily: "var(--font-display)" }}>
                          {h.symbol}
                        </span>
                        <span className="text-xs text-muted">
                          {h.base}/{h.quote}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div className="flex flex-nowrap items-center gap-5">
              <div className="shrink-0">
                <p
                  className="text-2xl md:text-3xl"
                  style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
                >
                  {symbol}
                </p>
                <p className="text-xs uppercase text-muted">{market} · Binance</p>
              </div>
              <div className="min-w-[12ch]">
                <p
                  className={`text-2xl tabular-nums ${change >= 0 ? "text-accent" : "text-danger"}`}
                  style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
                >
                  {formatLastPrice(last)}
                </p>
                <p
                  className={`text-xs tabular-nums ${change >= 0 ? "text-accent" : "text-danger"}`}
                >
                  {change >= 0 ? "+" : ""}
                  {change.toFixed(2)}%
                </p>
              </div>
              <span
                className={`inline-flex h-7 w-[7.5rem] shrink-0 items-center justify-center rounded-full border text-xs ${
                  live
                    ? "border-accent/40 text-accent"
                    : "border-border text-muted"
                }`}
              >
                {live ? "Live WS" : "Connecting…"}
              </span>
            </div>
          </div>

          {error ? (
            <p className="mt-3 text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}

          {/* Chart + sticky order ticket — heights stay aligned */}
          <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <TradingViewChart
              symbol={symbol}
              market={market}
              height={chartHeight}
            />

            <section
              ref={ticketRef}
              className="border border-border lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto"
            >
              <div className="border-b border-border px-4 py-3">
                <p className="eyebrow">Order ticket</p>
                <p className="mt-1 text-xs text-muted">
                  Market = taker · Limit = maker
                </p>
              </div>
              <form onSubmit={onSubmit} className="space-y-4 p-4">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setOrderType("market")}
                    className={`rounded-lg py-2 text-sm font-medium ${
                      orderType === "market"
                        ? "bg-foreground text-black"
                        : "border border-border text-muted"
                    }`}
                  >
                    Market · Taker
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOrderType("limit");
                      if (!limitPrice && last) setLimitPrice(String(Number(last)));
                    }}
                    className={`rounded-lg py-2 text-sm font-medium ${
                      orderType === "limit"
                        ? "bg-foreground text-black"
                        : "border border-border text-muted"
                    }`}
                  >
                    Limit · Maker
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={!!openOnSymbol && openOnSymbol.side === "short"}
                    onClick={() => setSide("long")}
                    className={`rounded-lg py-2.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
                      side === "long"
                        ? "bg-accent text-black"
                        : "border border-border text-muted"
                    }`}
                  >
                    Buy / Long
                  </button>
                  <button
                    type="button"
                    disabled={!!openOnSymbol && openOnSymbol.side === "long"}
                    onClick={() => setSide("short")}
                    className={`rounded-lg py-2.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
                      side === "short"
                        ? "bg-danger text-white"
                        : "border border-border text-muted"
                    }`}
                  >
                    Sell / Short
                  </button>
                </div>
                {openOnSymbol ? (
                  <p className="text-xs text-accent">
                    Open {openOnSymbol.side} {openOnSymbol.symbol} (
                    {money(openOnSymbol.notional)}). Same side adds to this
                    position; opposite side is blocked.
                  </p>
                ) : null}

                {orderType === "limit" ? (
                  <label className="block">
                    <span className="eyebrow">Limit price</span>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      required
                      value={limitPrice}
                      onChange={(e) => setLimitPrice(e.target.value)}
                      className="mt-2 w-full rounded-lg border border-border bg-white/[0.03] px-3 py-2.5 font-mono text-sm outline-none focus:border-accent/40"
                    />
                  </label>
                ) : (
                  <p className="text-xs text-muted">
                    Fills at live {side === "long" ? "ask" : "bid"} (taker).
                  </p>
                )}

                <div>
                  <div className="flex items-center justify-between">
                    <span className="eyebrow">Leverage</span>
                    <span
                      className="text-sm text-accent"
                      style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
                    >
                      {effectiveLeverage}x
                    </span>
                  </div>
                  {market === "spot" ? (
                    <p className="mt-2 text-xs text-muted">
                      Spot is cash · 1x only
                    </p>
                  ) : openOnSymbol ? (
                    <p className="mt-2 text-xs text-muted">
                      Locked to existing position leverage ({effectiveLeverage}x)
                      when adding size.
                    </p>
                  ) : (
                    <>
                      <input
                        type="range"
                        min={1}
                        max={40}
                        step={1}
                        value={leverage}
                        onChange={(e) => setLeverage(Number(e.target.value))}
                        className="mt-3 w-full accent-[var(--accent)]"
                      />
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {LEVERAGE_PRESETS.futures.map((x) => (
                          <button
                            key={x}
                            type="button"
                            onClick={() => setLeverage(x)}
                            className={`rounded px-2 py-1 text-[11px] ${
                              leverage === x
                                ? "bg-accent text-black"
                                : "border border-border text-muted hover:text-foreground"
                            }`}
                          >
                            {x}x
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <label className="block">
                  <span className="eyebrow">Size (USD notional)</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    required
                    value={notional}
                    onChange={(e) => setNotional(e.target.value)}
                    className="mt-2 w-full rounded-lg border border-border bg-white/[0.03] px-3 py-2.5 text-sm outline-none focus:border-accent/40"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="eyebrow">Stop-loss</span>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      placeholder="Optional"
                      value={stopLoss}
                      onChange={(e) => setStopLoss(e.target.value)}
                      className="mt-2 w-full rounded-lg border border-border bg-white/[0.03] px-3 py-2.5 font-mono text-sm outline-none focus:border-accent/40"
                    />
                  </label>
                  <label className="block">
                    <span className="eyebrow">Take-profit</span>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      placeholder="Optional"
                      value={takeProfit}
                      onChange={(e) => setTakeProfit(e.target.value)}
                      className="mt-2 w-full rounded-lg border border-border bg-white/[0.03] px-3 py-2.5 font-mono text-sm outline-none focus:border-accent/40"
                    />
                  </label>
                </div>
                <p className="text-[11px] text-muted">
                  Long: SL below entry, TP above. Short: opposite. When mark hits
                  SL/TP (or limit), fill is exact at that price.
                </p>
                <div className="space-y-1 text-xs text-muted">
                  <p>
                    Margin required:{" "}
                    <span className="text-foreground">
                      {money(marginRequired)}
                    </span>
                    {effectiveLeverage > 1 ? (
                      <span> · {effectiveLeverage}x</span>
                    ) : null}
                  </p>
                  {estLiqPrice != null ? (
                    <p>
                      Est. liquidation:{" "}
                      <span className="font-mono text-danger">
                        {estLiqPrice.toLocaleString(undefined, {
                          maximumFractionDigits: 6,
                        })}
                      </span>
                    </p>
                  ) : (
                    <p>No forced liquidation at 1x (spot / cash).</p>
                  )}
                  <p>
                    Available ({market}):{" "}
                    <span className="text-foreground">
                      {wallet ? money(wallet.balance) : "—"}
                    </span>
                  </p>
                </div>
                <PendingButton
                  pending={busy}
                  pendingLabel={
                    openOnSymbol ? "Adding to position…" : "Sending order…"
                  }
                  className={`rounded-lg ${
                    side === "long"
                      ? "bg-accent text-black"
                      : "bg-danger text-white"
                  }`}
                >
                  {openOnSymbol
                    ? `${orderType === "limit" ? "Limit add" : "Add"} to ${side}`
                    : `${orderType === "limit" ? "Place limit" : "Place market"} ${side}`}
                </PendingButton>
              </form>
            </section>
          </div>

          {/* Order book + trades */}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <section className="border border-border">
              <div className="border-b border-border px-4 py-3">
                <p className="eyebrow">Order book</p>
              </div>
              <div className="grid grid-cols-3 px-4 py-2 text-[10px] uppercase tracking-wider text-muted">
                <span>Price</span>
                <span className="text-right">Size</span>
                <span className="text-right">Sum</span>
              </div>
              <div className="max-h-[280px] overflow-auto px-2">
                {asks.slice(0, 12).map((a, i) => (
                  <div
                    key={`a-${i}`}
                    className="grid grid-cols-3 px-2 py-0.5 font-mono text-xs text-danger"
                  >
                    <span>{Number(a.price).toPrecision(6)}</span>
                    <span className="text-right text-muted">
                      {Number(a.qty).toPrecision(4)}
                    </span>
                    <span className="text-right text-muted/70">—</span>
                  </div>
                ))}
                <div className="my-2 border-y border-border px-2 py-2 text-center text-sm tabular-nums text-foreground">
                  {formatLastPrice(last)}
                </div>
                {bids.slice(0, 12).map((b, i) => (
                  <div
                    key={`b-${i}`}
                    className="grid grid-cols-3 px-2 py-0.5 font-mono text-xs text-accent"
                  >
                    <span>{Number(b.price).toPrecision(6)}</span>
                    <span className="text-right text-muted">
                      {Number(b.qty).toPrecision(4)}
                    </span>
                    <span className="text-right text-muted/70">—</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="border border-border">
              <div className="border-b border-border px-4 py-3">
                <p className="eyebrow">Trades · tick</p>
              </div>
              <div className="grid grid-cols-3 px-4 py-2 text-[10px] uppercase tracking-wider text-muted">
                <span>Price</span>
                <span className="text-right">Qty</span>
                <span className="text-right">Time</span>
              </div>
              <div className="max-h-[320px] overflow-auto">
                {trades.map((t, i) => (
                  <div
                    key={`${t.id}-${i}`}
                    className={`grid grid-cols-3 px-4 py-1 font-mono text-xs ${
                      t.isBuyerMaker ? "text-danger" : "text-accent"
                    }`}
                  >
                    <span>{Number(t.price).toPrecision(6)}</span>
                    <span className="text-right text-muted">
                      {Number(t.qty).toPrecision(4)}
                    </span>
                    <span className="text-right text-muted">
                      {new Date(t.time).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* Open orders */}
          <section className="mt-4 border border-border">
            <div className="border-b border-border px-4 py-3">
              <p className="eyebrow">
                Open orders ({marketOrders.length}) · limit / maker
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-muted">
                    <th className="eyebrow px-4 py-3 font-normal">Symbol</th>
                    <th className="eyebrow px-4 py-3 font-normal">Type</th>
                    <th className="eyebrow px-4 py-3 font-normal">Side</th>
                    <th className="eyebrow px-4 py-3 font-normal">Lev</th>
                    <th className="eyebrow px-4 py-3 font-normal">Size</th>
                    <th className="eyebrow px-4 py-3 font-normal">Margin</th>
                    <th className="eyebrow px-4 py-3 font-normal">Limit</th>
                    <th className="eyebrow px-4 py-3 font-normal" />
                  </tr>
                </thead>
                <tbody>
                  {marketOrders.map((o) => (
                    <tr key={o.id} className="border-b border-border/50">
                      <td className="px-4 py-3">{o.symbol}</td>
                      <td className="px-4 py-3 uppercase text-muted">
                        {o.order_type}
                      </td>
                      <td className="px-4 py-3 uppercase">{o.side}</td>
                      <td className="px-4 py-3">{o.leverage}x</td>
                      <td className="px-4 py-3">{money(o.notional)}</td>
                      <td className="px-4 py-3">{money(o.margin)}</td>
                      <td className="px-4 py-3 font-mono">
                        {o.limit_price
                          ? Number(o.limit_price).toPrecision(6)
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onCancelOrder(o.id)}
                          className="rounded-full border border-border px-3 py-1 text-xs hover:bg-white/5"
                        >
                          Cancel
                        </button>
                      </td>
                    </tr>
                  ))}
                  {marketOrders.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-6 text-muted">
                        No resting limit orders.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          {/* Positions */}
          <section className="mt-4 mb-8 border border-border">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <p className="eyebrow">
                {market} positions ({marketPositions.length})
                {positions.length > marketPositions.length ? (
                  <span className="ml-2 normal-case tracking-normal text-accent">
                    · {positions.length} total open
                  </span>
                ) : null}
              </p>
              <Link
                href="/dashboard"
                className="text-xs text-muted hover:text-foreground"
              >
                Dashboard
              </Link>
            </div>
            {otherMarketPositions.length > 0 ? (
              <div className="border-b border-border px-4 py-2 text-xs text-muted">
                Also open:{" "}
                {otherMarketPositions.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() =>
                      setMarket(p.market === "futures" ? "futures" : "spot")
                    }
                    className="mr-2 text-accent hover:underline"
                  >
                    {p.market} {p.symbol}
                  </button>
                ))}
                — switch market tab to view / manage them.
              </div>
            ) : null}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-muted">
                    <th className="eyebrow px-4 py-3 font-normal">Symbol</th>
                    <th className="eyebrow px-4 py-3 font-normal">Market</th>
                    <th className="eyebrow px-4 py-3 font-normal">Side</th>
                    <th className="eyebrow px-4 py-3 font-normal">Lev</th>
                    <th className="eyebrow px-4 py-3 font-normal">Size</th>
                    <th className="eyebrow px-4 py-3 font-normal">Margin</th>
                    <th className="eyebrow px-4 py-3 font-normal">Entry</th>
                    <th className="eyebrow px-4 py-3 font-normal">Mark</th>
                    <th className="eyebrow px-4 py-3 font-normal">Liq</th>
                    <th className="eyebrow px-4 py-3 font-normal">SL</th>
                    <th className="eyebrow px-4 py-3 font-normal">TP</th>
                    <th className="eyebrow px-4 py-3 font-normal">uPnL</th>
                    <th className="eyebrow px-4 py-3 font-normal" />
                  </tr>
                </thead>
                <tbody>
                  {marketPositions.map((p) => {
                    const mark = liveMarkFor(p, symbol, last);
                    const upnl = liveUpnl(p, mark);
                    const pct = liveUpnlPct(p, upnl);
                    return (
                    <Fragment key={p.id}>
                    <tr className="border-b border-border/50">
                      <td className="px-4 py-3">{p.symbol}</td>
                      <td className="px-4 py-3 uppercase text-muted">
                        {p.market}
                      </td>
                      <td className="px-4 py-3 uppercase">{p.side}</td>
                      <td className="px-4 py-3">{p.leverage ?? 1}x</td>
                      <td className="px-4 py-3">{money(p.notional)}</td>
                      <td className="px-4 py-3">
                        {money(p.margin || p.notional)}
                      </td>
                      <td className="px-4 py-3">
                        {Number(p.entry_price).toPrecision(6)}
                      </td>
                      <td className="px-4 py-3">
                        {mark != null ? mark.toPrecision(6) : "—"}
                      </td>
                      <td className="px-4 py-3 font-mono text-danger">
                        {p.liquidation_price
                          ? Number(p.liquidation_price).toPrecision(6)
                          : "—"}
                      </td>
                      <td className="px-4 py-3 font-mono text-danger">
                        {p.stop_loss
                          ? Number(p.stop_loss).toPrecision(6)
                          : "—"}
                      </td>
                      <td className="px-4 py-3 font-mono text-accent">
                        {p.take_profit
                          ? Number(p.take_profit).toPrecision(6)
                          : "—"}
                      </td>
                      <td
                        className={`px-4 py-3 ${
                          (upnl ?? 0) >= 0 ? "text-accent" : "text-danger"
                        }`}
                      >
                        {upnl != null ? (
                          <>
                            {pnlMoney(upnl)}
                            {pct != null ? (
                              <span className="ml-1.5 text-xs opacity-90">
                                ({pct >= 0 ? "+" : ""}
                                {pct.toFixed(2)}%)
                              </span>
                            ) : null}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setAdjustId(p.id);
                              setAdjustAction("add");
                              setAdjustAmount("50");
                            }}
                            className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-white/5"
                          >
                            Add
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setAdjustId(p.id);
                              setAdjustAction("trim");
                              setAdjustAmount(
                                String(Math.max(1, Math.floor(Number(p.notional) / 2)))
                              );
                            }}
                            className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-white/5"
                          >
                            Trim
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setAdjustId(p.id);
                              setAdjustAction("protect");
                              setEditSl(p.stop_loss ? String(Number(p.stop_loss)) : "");
                              setEditTp(
                                p.take_profit ? String(Number(p.take_profit)) : ""
                              );
                            }}
                            className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-white/5"
                          >
                            SL/TP
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onClose(p.id)}
                            className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-white/5"
                          >
                            Close
                          </button>
                        </div>
                      </td>
                    </tr>
                    {adjustId === p.id ? (
                      <tr className="border-b border-border/50 bg-white/[0.02]">
                        <td colSpan={13} className="px-4 py-3">
                          {adjustAction === "protect" ? (
                            <div className="flex flex-wrap items-end gap-3">
                              <p className="text-xs text-muted">
                                Edit stop-loss / take-profit (clear field to remove)
                              </p>
                              <label className="block">
                                <span className="eyebrow">Stop-loss</span>
                                <input
                                  type="number"
                                  min={0}
                                  step="any"
                                  value={editSl}
                                  onChange={(e) => setEditSl(e.target.value)}
                                  className="mt-1 w-32 rounded-lg border border-border bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-accent/40"
                                />
                              </label>
                              <label className="block">
                                <span className="eyebrow">Take-profit</span>
                                <input
                                  type="number"
                                  min={0}
                                  step="any"
                                  value={editTp}
                                  onChange={(e) => setEditTp(e.target.value)}
                                  className="mt-1 w-32 rounded-lg border border-border bg-black/40 px-3 py-2 font-mono text-sm outline-none focus:border-accent/40"
                                />
                              </label>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => onProtectSave()}
                                className="rounded-full bg-accent px-4 py-2 text-xs font-semibold text-black disabled:opacity-50"
                              >
                                Save SL/TP
                              </button>
                              <button
                                type="button"
                                onClick={() => setAdjustId(null)}
                                className="rounded-full border border-border px-4 py-2 text-xs text-muted hover:text-foreground"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                          <div className="flex flex-wrap items-end gap-3">
                            <p className="text-xs text-muted">
                              {adjustAction === "add"
                                ? "Add size (USD) — fills at live ask/bid, avg entry updates"
                                : "Trim size (USD) — partial close; trim ≥ full size closes all"}
                            </p>
                            <label className="block">
                              <span className="eyebrow">USD</span>
                              <input
                                type="number"
                                min={1}
                                step={1}
                                value={adjustAmount}
                                onChange={(e) => setAdjustAmount(e.target.value)}
                                className="mt-1 w-28 rounded-lg border border-border bg-black/40 px-3 py-2 text-sm outline-none focus:border-accent/40"
                              />
                            </label>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => onAdjust()}
                              className="rounded-full bg-accent px-4 py-2 text-xs font-semibold text-black disabled:opacity-50"
                            >
                              Confirm {adjustAction}
                            </button>
                            <button
                              type="button"
                              onClick={() => setAdjustId(null)}
                              className="rounded-full border border-border px-4 py-2 text-xs text-muted hover:text-foreground"
                            >
                              Cancel
                            </button>
                          </div>
                          )}
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                    );
                  })}
                  {marketPositions.length === 0 ? (
                    <tr>
                      <td colSpan={13} className="px-4 py-8 text-muted">
                        No open {market} positions.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
