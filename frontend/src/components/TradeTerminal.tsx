"use client";

import { FormEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";

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

  useEffect(() => {
    if (!authLoading && (!user || user.role !== "trader")) {
      router.replace(user ? "/dashboard" : "/login");
    }
  }, [authLoading, user, router]);

  const wallet = useMemo(
    () => wallets.find((w) => w.market === market),
    [wallets, market]
  );

  const effectiveLeverage = market === "spot" ? 1 : leverage;
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
      const [w, p, o] = await Promise.all([
        apiWallets(),
        apiPositions("open"),
        apiOrders("open"),
      ]);
      setWallets(w);
      setPositions(p);
      setOpenOrders(o);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Account load failed");
    }
  }, []);

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
        } catch {
          /* ignore */
        }
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Market data failed");
    }
  }, [market, symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (user?.role === "trader") {
      refreshAccount();
      loadMarketData();
    }
    return () => {
      depthWs.current?.close();
      tradeWs.current?.close();
    };
  }, [user, refreshAccount, loadMarketData]);

  // Poll account so resting limit orders can fill
  useEffect(() => {
    if (user?.role !== "trader") return;
    const id = setInterval(() => {
      refreshAccount();
    }, 8_000);
    return () => clearInterval(id);
  }, [user, refreshAccount]);

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
    setBusy(true);
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
      });
      await refreshAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Order failed");
    } finally {
      setBusy(false);
    }
  }

  async function onClose(id: number) {
    setBusy(true);
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
    setBusy(true);
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
    setBusy(true);
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
    setBusy(true);
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

            <div className="flex flex-wrap items-baseline gap-4">
              <div>
                <p
                  className="text-2xl md:text-3xl"
                  style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
                >
                  {symbol}
                </p>
                <p className="text-xs uppercase text-muted">{market} · Binance</p>
              </div>
              <div>
                <p
                  className={`text-2xl ${change >= 0 ? "text-accent" : "text-danger"}`}
                  style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
                >
                  {last ? Number(last).toLocaleString() : "—"}
                </p>
                <p
                  className={`text-xs ${change >= 0 ? "text-accent" : "text-danger"}`}
                >
                  {change >= 0 ? "+" : ""}
                  {change.toFixed(2)}%
                </p>
              </div>
              <span
                className={`rounded-full border px-3 py-1 text-xs ${
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

          {/* Chart + sticky order ticket */}
          <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <TradingViewChart symbol={symbol} market={market} height={480} />

            <section className="border border-border lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
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
                    onClick={() => setSide("long")}
                    className={`rounded-lg py-2.5 text-sm font-medium ${
                      side === "long"
                        ? "bg-accent text-black"
                        : "border border-border text-muted"
                    }`}
                  >
                    Buy / Long
                  </button>
                  <button
                    type="button"
                    onClick={() => setSide("short")}
                    className={`rounded-lg py-2.5 text-sm font-medium ${
                      side === "short"
                        ? "bg-danger text-white"
                        : "border border-border text-muted"
                    }`}
                  >
                    Sell / Short
                  </button>
                </div>

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
                  Long: SL below entry, TP above. Short: opposite. Checked while
                  the terminal refreshes.
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
                <button
                  type="submit"
                  disabled={busy}
                  className={`w-full rounded-lg py-3 text-sm font-semibold disabled:opacity-50 ${
                    side === "long"
                      ? "bg-accent text-black"
                      : "bg-danger text-white"
                  }`}
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {busy
                    ? "Sending…"
                    : `${orderType === "limit" ? "Place limit" : "Place market"} ${side}`}
                </button>
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
                <div className="my-2 border-y border-border px-2 py-2 text-center text-sm text-foreground">
                  {last ? Number(last).toLocaleString() : "—"}
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
