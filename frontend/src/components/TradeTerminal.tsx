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
import { ClosedTradesTable } from "@/components/TradeHistoryTables";

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
  apiTournament,
  apiWallets,
  type MarketType,
  type OrderBookLevel,
  type OrderType,
  type PaperOrder,
  type Position,
  type RecentTrade,
  type SymbolHit,
  type Ticker,
  type Tournament,
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
type DeskTab = "positions" | "orders" | "orderHistory" | "tradeHistory";

function formatCountdown(ms: number) {
  if (ms <= 0) return "00:00:00";
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const clock = [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
  return d > 0 ? `${d}d ${clock}` : clock;
}

function splitPair(sym: string) {
  const s = sym.toUpperCase();
  for (const q of ["USDT", "USDC", "FDUSD", "BUSD", "USD", "BTC", "ETH"]) {
    if (s.endsWith(q) && s.length > q.length) {
      return { base: s.slice(0, -q.length), quote: q };
    }
  }
  return { base: s, quote: "USD" };
}

function depthLevels(levels: OrderBookLevel[], count: number) {
  const slice = levels.slice(0, count);
  const fromSpread = [...slice].reverse();
  let cum = 0;
  const rows = fromSpread.map((l) => {
    const qty = Number(l.qty);
    cum += qty;
    return { price: l.price, qty, cum };
  });
  const max = cum || 1;
  return rows
    .map((r) => ({ ...r, pct: (r.cum / max) * 100 }))
    .reverse();
}

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
  const [showOrderType, setShowOrderType] = useState(false);
  const [showLevMenu, setShowLevMenu] = useState(false);
  const typeMenuRef = useRef<HTMLDivElement>(null);
  const levMenuRef = useRef<HTMLDivElement>(null);

  const [bids, setBids] = useState<OrderBookLevel[]>([]);
  const [asks, setAsks] = useState<OrderBookLevel[]>([]);
  const [trades, setTrades] = useState<RecentTrade[]>([]);
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [openOrders, setOpenOrders] = useState<PaperOrder[]>([]);
  const [orderHistory, setOrderHistory] = useState<PaperOrder[]>([]);
  const [tradeHistory, setTradeHistory] = useState<Position[]>([]);
  const [deskTab, setDeskTab] = useState<DeskTab>("positions");

  const [side, setSide] = useState<"long" | "short">("long");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [notional, setNotional] = useState("100");
  const [leverage, setLeverage] = useState(1);
  const [limitPrice, setLimitPrice] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [showProtect, setShowProtect] = useState(false);
  const [event, setEvent] = useState<Tournament | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closingId, setClosingId] = useState<number | null>(null);
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
  /** Chart body height — matches the book + tape rail on desktop */
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
    const stackedQuery = window.matchMedia("(max-width: 1023px)");
    const sync = () => {
      const next = stackedQuery.matches
        ? Math.round(Math.min(420, Math.max(320, window.innerHeight * 0.42)))
        : Math.round(Math.min(620, Math.max(520, window.innerHeight - 240)));
      setChartHeight((prev) => (Math.abs(prev - next) < 8 ? prev : next));
    };
    sync();
    stackedQuery.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    return () => {
      stackedQuery.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);

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

  const loadDeskHistory = useCallback(async () => {
    try {
      const tid = inTournament ? tournamentId : null;
      const [orders, closed] = await Promise.all([
        apiOrders("all", tid),
        apiPositions("closed", tid),
      ]);
      setOrderHistory(orders.filter((o) => o.status !== "open"));
      setTradeHistory(closed);
    } catch {
      /* keep last snapshot */
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
      void loadDeskHistory();
    }
    return () => {
      depthWs.current?.close();
      tradeWs.current?.close();
      if (protectTimerRef.current) clearTimeout(protectTimerRef.current);
    };
  }, [user, refreshAccount, loadMarketData, loadDeskHistory]);

  useEffect(() => {
    if (!inTournament || !tournamentId) {
      setEvent(null);
      return;
    }
    let cancelled = false;
    apiTournament(tournamentId)
      .then((row) => {
        if (!cancelled) setEvent(row);
      })
      .catch(() => {
        if (!cancelled) setEvent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [inTournament, tournamentId]);

  useEffect(() => {
    if (!inTournament) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [inTournament]);

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
    if (user?.role !== "trader") return;
    const id = setInterval(() => void loadDeskHistory(), 12_000);
    return () => clearInterval(id);
  }, [user, loadDeskHistory]);

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

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (!typeMenuRef.current?.contains(t)) setShowOrderType(false);
      if (!levMenuRef.current?.contains(t)) setShowLevMenu(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

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
      void loadDeskHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Order failed");
    } finally {
      setBusy(false);
    }
  }

  async function onClose(id: number) {
    if (closingId != null) return;
    flushSync(() => {
      setClosingId(id);
      setBusy(true);
      setError(null);
    });
    try {
      await apiClosePosition(id);
      await refreshAccount();
      void loadDeskHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Close failed");
    } finally {
      setClosingId(null);
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
      void loadDeskHistory();
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
      void loadDeskHistory();
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
      void loadDeskHistory();
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
  const marketOrderHistory = orderHistory.filter((o) => o.market === market);
  const marketTradeHistory = tradeHistory.filter((p) => p.market === market);
  const askRows = depthLevels(asks, 8);
  const bidRows = depthLevels(bids, 8);
  const railHeight = chartHeight;
  const pair = splitPair(symbol);
  const px =
    orderType === "limit" && Number(limitPrice) > 0
      ? Number(limitPrice)
      : Number(last) > 0
        ? Number(last)
        : 0;
  const available = Number(wallet?.balance ?? 0);
  const maxNotional = Math.max(0, available * effectiveLeverage);
  const coinQty = px > 0 ? Number(notional || 0) / px : 0;
  const sizePct =
    maxNotional > 0
      ? Math.min(100, Math.max(0, (Number(notional || 0) / maxNotional) * 100))
      : 0;
  const eventStart = event ? new Date(event.start_at).getTime() : 0;
  const eventEnd = event ? new Date(event.end_at).getTime() : 0;
  const eventOver =
    !!event &&
    (event.status === "ended" ||
      event.status === "cancelled" ||
      now >= eventEnd);
  const eventSoon = !!event && !eventOver && now < eventStart;
  const eventRemain = eventOver
    ? 0
    : eventSoon
      ? eventStart - now
      : Math.max(0, eventEnd - now);

  return (
    <>
      <Navbar />
      <main className="relative min-h-dvh min-w-0 bg-background pt-24 pb-28">
        <div className="mx-auto max-w-[1600px] px-4">
          {inTournament ? (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
              <div className="min-w-0">
                <p>
                  <span className="font-semibold text-accent">
                    {event?.name ?? "Tournament mode"}
                  </span>
                  <span className="text-muted">
                    {" "}
                    · isolated $10k wallets · crypto spot &amp; futures only
                  </span>
                </p>
                {event ? (
                  <p className="mt-1 text-xs text-muted">
                    {eventOver
                      ? "This event has ended."
                      : eventSoon
                        ? `Starts ${new Date(event.start_at).toLocaleString()}`
                        : `Ends ${new Date(event.end_at).toLocaleString()}`}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {event ? (
                  <div
                    className={`rounded-lg border px-3 py-2 text-right ${
                      eventOver
                        ? "border-border text-muted"
                        : eventRemain < 5 * 60 * 1000
                          ? "border-danger/40 text-danger"
                          : "border-accent/30 text-accent"
                    }`}
                    aria-live="polite"
                  >
                    <p className="text-[10px] uppercase tracking-wider opacity-80">
                      {eventOver
                        ? event.status === "cancelled"
                          ? "Cancelled"
                          : "Ended"
                        : eventSoon
                          ? "Starts in"
                          : "Ends in"}
                    </p>
                    <p
                      className="mt-0.5 font-mono text-lg tabular-nums leading-none"
                      style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
                    >
                      {eventOver ? "00:00:00" : formatCountdown(eventRemain)}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-muted">Loading event clock…</p>
                )}
                <Link
                  href="/tournaments"
                  className="text-muted underline-offset-2 hover:text-foreground hover:underline"
                >
                  Back to tournaments
                </Link>
              </div>
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

          {/* Chart | book + tape | order ticket */}
          <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(480px,1fr)_minmax(200px,250px)_minmax(260px,300px)]">
            <TradingViewChart
              symbol={symbol}
              market={market}
              height={chartHeight}
            />

            <div
              className="grid min-h-0 grid-rows-2 gap-4"
              style={{ height: railHeight }}
            >
              <section className="flex min-h-0 flex-col overflow-hidden border border-border">
                <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
                  <p className="eyebrow">Order book</p>
                  <p className="text-[10px] uppercase tracking-wider text-muted">
                    {symbol}
                  </p>
                </div>
                <div className="grid shrink-0 grid-cols-3 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted">
                  <span>Price</span>
                  <span className="text-right">Size</span>
                  <span className="text-right">Total</span>
                </div>
                <div className="min-h-0 flex-1 overflow-auto px-1">
                  {askRows.map((a, i) => (
                    <div
                      key={`a-${i}`}
                      className="relative grid grid-cols-3 px-2 py-0.5 font-mono text-[11px] text-danger"
                    >
                      <span
                        className="pointer-events-none absolute inset-y-0 right-0 bg-danger/15"
                        style={{ width: `${a.pct}%` }}
                      />
                      <span className="relative">{Number(a.price).toPrecision(6)}</span>
                      <span className="relative text-right text-muted">
                        {a.qty.toPrecision(4)}
                      </span>
                      <span className="relative text-right text-muted/70">
                        {a.cum.toPrecision(4)}
                      </span>
                    </div>
                  ))}
                  <div className="my-1 border-y border-border px-2 py-1.5 text-center text-sm tabular-nums text-foreground">
                    {formatLastPrice(last)}
                    {change ? (
                      <span
                        className={`ml-2 text-[10px] ${change >= 0 ? "text-accent" : "text-danger"}`}
                      >
                        {change >= 0 ? "+" : ""}
                        {change.toFixed(2)}%
                      </span>
                    ) : null}
                  </div>
                  {bidRows.map((b, i) => (
                    <div
                      key={`b-${i}`}
                      className="relative grid grid-cols-3 px-2 py-0.5 font-mono text-[11px] text-accent"
                    >
                      <span
                        className="pointer-events-none absolute inset-y-0 right-0 bg-accent/15"
                        style={{ width: `${b.pct}%` }}
                      />
                      <span className="relative">{Number(b.price).toPrecision(6)}</span>
                      <span className="relative text-right text-muted">
                        {b.qty.toPrecision(4)}
                      </span>
                      <span className="relative text-right text-muted/70">
                        {b.cum.toPrecision(4)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="flex min-h-0 flex-col overflow-hidden border border-border">
                <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
                  <p className="eyebrow">Trades · tick</p>
                  <p className="text-[10px] uppercase tracking-wider text-muted">
                    Live
                  </p>
                </div>
                <div className="grid shrink-0 grid-cols-3 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted">
                  <span>Price</span>
                  <span className="text-right">Qty</span>
                  <span className="text-right">Time</span>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {trades.slice(0, 24).map((t, i) => (
                    <div
                      key={`${t.id}-${i}`}
                      className={`grid grid-cols-3 px-3 py-0.5 font-mono text-[11px] ${
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

            <section
              ref={ticketRef}
              className="border border-border lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto"
            >
              <form onSubmit={onSubmit} className="space-y-3.5 p-4">
                <div className="flex items-center gap-2">
                  <div className="grid min-w-0 flex-1 grid-cols-2 rounded-full bg-white/[0.04] p-1">
                    <button
                      type="button"
                      disabled={!!openOnSymbol && openOnSymbol.side === "short"}
                      onClick={() => setSide("long")}
                      className={`rounded-full py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                        side === "long"
                          ? "bg-accent text-black"
                          : "text-muted"
                      }`}
                    >
                      Buy
                    </button>
                    <button
                      type="button"
                      disabled={!!openOnSymbol && openOnSymbol.side === "long"}
                      onClick={() => setSide("short")}
                      className={`rounded-full py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                        side === "short"
                          ? "bg-danger text-white"
                          : "text-muted"
                      }`}
                    >
                      Sell
                    </button>
                  </div>
                  <div className="relative shrink-0" ref={typeMenuRef}>
                    <button
                      type="button"
                      aria-haspopup="listbox"
                      aria-expanded={showOrderType}
                      aria-label="Order type"
                      onClick={() => setShowOrderType((o) => !o)}
                      className="flex items-center gap-2 rounded-lg border border-border bg-white/[0.03] px-3 py-2 text-sm outline-none hover:bg-white/5"
                    >
                      {orderType === "limit" ? "Limit" : "Market"}
                      <span className="text-[10px] text-muted" aria-hidden>
                        ▾
                      </span>
                    </button>
                    {showOrderType ? (
                      <ul
                        role="listbox"
                        className="absolute right-0 z-30 mt-1 min-w-[9rem] overflow-hidden rounded-lg border border-border bg-[#0c0c0c] shadow-xl"
                      >
                        {(["limit", "market"] as const).map((t) => (
                          <li key={t}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={orderType === t}
                              className={`flex w-full px-4 py-2.5 text-left text-sm hover:bg-white/5 ${
                                orderType === t
                                  ? "text-foreground"
                                  : "text-muted"
                              }`}
                              onClick={() => {
                                setOrderType(t);
                                setShowOrderType(false);
                                if (t === "limit" && !limitPrice && last) {
                                  setLimitPrice(String(Number(last)));
                                }
                              }}
                            >
                              {t === "limit" ? "Limit" : "Market"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>

                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted">Available balance</span>
                  <span className="tabular-nums text-foreground">
                    {wallet
                      ? `${Number(wallet.balance).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${pair.quote}`
                      : "—"}
                  </span>
                </div>

                {openOnSymbol ? (
                  <p className="text-xs text-accent">
                    Open {openOnSymbol.side} · {money(openOnSymbol.notional)}.
                    Same side adds; opposite is blocked.
                  </p>
                ) : null}

                <label className="block">
                  <span className="text-xs text-muted">
                    {orderType === "limit" ? "Limit price" : "Fill price"}
                  </span>
                  <span className="relative mt-1 block">
                    <input
                      type="number"
                      min={0}
                      step="any"
                      required={orderType === "limit"}
                      readOnly={orderType === "market"}
                      value={
                        orderType === "limit"
                          ? limitPrice
                          : last
                            ? String(Number(last))
                            : ""
                      }
                      onChange={(e) => setLimitPrice(e.target.value)}
                      className="w-full rounded-xl border border-border bg-white/[0.04] px-3 py-2.5 pr-14 font-mono text-sm outline-none focus:border-accent/40 read-only:text-muted"
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">
                      {pair.quote}
                    </span>
                  </span>
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-xs text-muted">{pair.quote}</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      required
                      value={notional}
                      onChange={(e) => setNotional(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-border bg-white/[0.04] px-3 py-2.5 font-mono text-sm outline-none focus:border-accent/40"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted">{pair.base}</span>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={
                        coinQty > 0
                          ? coinQty.toPrecision(6).replace(/\.?0+$/, "")
                          : ""
                      }
                      onChange={(e) => {
                        const q = Number(e.target.value);
                        if (!px || !Number.isFinite(q)) return;
                        setNotional(String(Math.max(1, Math.round(q * px))));
                      }}
                      className="mt-1 w-full rounded-xl border border-border bg-white/[0.04] px-3 py-2.5 font-mono text-sm outline-none focus:border-accent/40"
                    />
                  </label>
                </div>

                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(sizePct)}
                  aria-label="Size as percent of available"
                  onChange={(e) => {
                    const pct = Number(e.target.value);
                    const next = Math.max(1, Math.round((pct / 100) * maxNotional));
                    setNotional(String(maxNotional > 0 ? next : 1));
                  }}
                  className="w-full accent-[var(--accent)]"
                />

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-border bg-white/[0.04] px-3 py-2.5">
                    <p className="text-[10px] uppercase tracking-wider text-muted">
                      Mode
                    </p>
                    <p className="mt-0.5 text-sm">
                      {market === "spot" ? "Spot · cash" : "Isolated"}
                    </p>
                  </div>
                  <div className="rounded-xl border border-border bg-white/[0.04] px-3 py-2.5">
                    <p className="text-[10px] uppercase tracking-wider text-muted">
                      Leverage
                    </p>
                    {market === "spot" || openOnSymbol ? (
                      <p className="mt-0.5 text-sm">{effectiveLeverage}x</p>
                    ) : (
                      <div className="relative mt-0.5" ref={levMenuRef}>
                        <button
                          type="button"
                          aria-haspopup="listbox"
                          aria-expanded={showLevMenu}
                          aria-label="Leverage"
                          onClick={() => setShowLevMenu((o) => !o)}
                          className="flex w-full items-center justify-between text-sm outline-none"
                        >
                          {leverage}x
                          <span className="text-[10px] text-muted" aria-hidden>
                            ▾
                          </span>
                        </button>
                        {showLevMenu ? (
                          <ul
                            role="listbox"
                            className="absolute left-0 right-0 z-30 mt-1 max-h-48 overflow-auto rounded-lg border border-border bg-[#0c0c0c] shadow-xl"
                          >
                            {LEVERAGE_PRESETS.futures.map((x) => (
                              <li key={x}>
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={leverage === x}
                                  className={`flex w-full px-3 py-2 text-left text-sm hover:bg-white/5 ${
                                    leverage === x
                                      ? "text-foreground"
                                      : "text-muted"
                                  }`}
                                  onClick={() => {
                                    setLeverage(x);
                                    setShowLevMenu(false);
                                  }}
                                >
                                  {x}x
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5">
                  <span className="text-sm">Take profit / Stop loss</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showProtect}
                    onClick={() => {
                      setShowProtect((on) => {
                        if (on) {
                          setStopLoss("");
                          setTakeProfit("");
                        }
                        return !on;
                      });
                    }}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                      showProtect ? "bg-accent" : "bg-white/15"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                        showProtect ? "left-5" : "left-0.5"
                      }`}
                    />
                  </button>
                </div>
                {showProtect ? (
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-xs text-muted">Stop-loss</span>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        placeholder="Optional"
                        value={stopLoss}
                        onChange={(e) => setStopLoss(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-border bg-white/[0.04] px-3 py-2.5 font-mono text-sm outline-none focus:border-accent/40"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-muted">Take-profit</span>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        placeholder="Optional"
                        value={takeProfit}
                        onChange={(e) => setTakeProfit(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-border bg-white/[0.04] px-3 py-2.5 font-mono text-sm outline-none focus:border-accent/40"
                      />
                    </label>
                  </div>
                ) : null}

                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between text-muted">
                    <span>Quantity</span>
                    <span className="tabular-nums text-foreground">
                      {coinQty > 0
                        ? `${coinQty.toPrecision(6)} ${pair.base}`
                        : "—"}
                    </span>
                  </div>
                  <div className="flex justify-between text-muted">
                    <span>Estimated fee</span>
                    <span className="tabular-nums text-foreground">
                      Paper · 0 {pair.quote}
                    </span>
                  </div>
                  <div className="flex justify-between text-muted">
                    <span>Cost / margin</span>
                    <span className="tabular-nums text-foreground">
                      {money(marginRequired)}
                    </span>
                  </div>
                  {estLiqPrice != null ? (
                    <div className="flex justify-between text-muted">
                      <span>Est. liquidation</span>
                      <span className="font-mono text-danger">
                        {estLiqPrice.toLocaleString(undefined, {
                          maximumFractionDigits: 6,
                        })}
                      </span>
                    </div>
                  ) : null}
                </div>

                <PendingButton
                  pending={busy}
                  pendingLabel={
                    openOnSymbol ? "Adding to position…" : "Sending order…"
                  }
                  className={`rounded-full ${
                    side === "long"
                      ? "bg-accent text-black"
                      : "bg-danger text-white"
                  }`}
                >
                  {openOnSymbol
                    ? `Add to ${side === "long" ? "Buy" : "Sell"}`
                    : side === "long"
                      ? "Buy"
                      : "Sell"}
                </PendingButton>
              </form>
            </section>
          </div>

          {/* Desk: positions / orders / history */}
          <section className="mt-4 mb-8 border border-border">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-2">
              <div
                className="flex min-w-0 flex-wrap gap-1 py-1.5"
                role="tablist"
                aria-label="Account lists"
              >
                {(
                  [
                    ["positions", "Positions", marketPositions.length],
                    ["orders", "Open orders", marketOrders.length],
                    ["orderHistory", "Order history", marketOrderHistory.length],
                    ["tradeHistory", "Trade history", marketTradeHistory.length],
                  ] as const
                ).map(([id, label, count]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={deskTab === id}
                    onClick={() => setDeskTab(id)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                      deskTab === id
                        ? "bg-foreground text-black"
                        : "text-muted hover:text-foreground"
                    }`}
                  >
                    {label}
                    <span className="ml-1.5 tabular-nums opacity-70">{count}</span>
                  </button>
                ))}
              </div>
              <Link
                href="/dashboard"
                className="px-3 py-2 text-xs text-muted hover:text-foreground"
              >
                Dashboard
              </Link>
            </div>

            {deskTab === "orders" ? (
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
            ) : null}

            {deskTab === "positions" ? (
            <>
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
            {error ? (
              <p
                className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger"
                role="alert"
              >
                {error}
              </p>
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
                            disabled={busy || closingId != null}
                            onClick={() => onClose(p.id)}
                            className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-white/5 disabled:opacity-50"
                          >
                            {closingId === p.id ? "Closing…" : "Close"}
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
            </>
            ) : null}

            {deskTab === "orderHistory" ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted">
                      <th className="eyebrow px-4 py-3 font-normal">Symbol</th>
                      <th className="eyebrow px-4 py-3 font-normal">Type</th>
                      <th className="eyebrow px-4 py-3 font-normal">Side</th>
                      <th className="eyebrow px-4 py-3 font-normal">Status</th>
                      <th className="eyebrow px-4 py-3 font-normal">Size</th>
                      <th className="eyebrow px-4 py-3 font-normal">Limit</th>
                      <th className="eyebrow px-4 py-3 font-normal">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {marketOrderHistory.map((o) => (
                      <tr key={o.id} className="border-b border-border/50">
                        <td className="px-4 py-3">{o.symbol}</td>
                        <td className="px-4 py-3 uppercase text-muted">
                          {o.order_type}
                        </td>
                        <td className="px-4 py-3 uppercase">{o.side}</td>
                        <td className="px-4 py-3 uppercase text-muted">
                          {o.status}
                        </td>
                        <td className="px-4 py-3">{money(o.notional)}</td>
                        <td className="px-4 py-3 font-mono">
                          {o.limit_price
                            ? Number(o.limit_price).toPrecision(6)
                            : "—"}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted">
                          {new Date(
                            o.filled_at ?? o.created_at
                          ).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                    {marketOrderHistory.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-8 text-muted">
                          No filled or cancelled orders yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            ) : null}

            {deskTab === "tradeHistory" ? (
              <ClosedTradesTable positions={marketTradeHistory} />
            ) : null}
          </section>
        </div>
      </main>
    </>
  );
}
