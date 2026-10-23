"""One Binance combined stream per symbol, shared by every viewer in this process.

Trades, 24h ticker, best bid/ask, and depth diffs arrive on that socket.
The only REST call is the depth snapshot Binance requires before diffs can
be applied, and it is not repeated for each browser refresh. HTTP 418/429
waits are taken from BinanceUnavailable.retry_after (Retry-After or the
banned-until timestamp). This module does not change hosts or egress IPs.

Execution quotes come only from a connected bookTicker stream younger than
EXECUTION_MAX_AGE. A disconnected or old quote is omitted so fills and risk
checks fall through to a fresh REST bookTicker or fail closed.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import threading
import time
from decimal import Decimal
from typing import Any, Callable

from .binance import (
    FUTURES_WS_COMBINED,
    SPOT_WS_COMBINED,
    BinanceUnavailable,
    depth_snapshot,
)
from .orderbook_sync import OrderBookSync

logger = logging.getLogger(__name__)

EXECUTION_MAX_AGE = 5.0
IDLE_SECONDS = 120.0
MAX_BACKOFF = 30.0

Connector = Callable[[str], Any]
SnapshotFn = Callable[[str, str], dict]
Sleeper = Callable[[float, asyncio.Event], Any]
Clock = Callable[[], float]


def combined_stream_url(market: str, symbol: str) -> str:
    sym = symbol.lower()
    streams = "/".join(
        (
            f"{sym}@trade",
            f"{sym}@ticker",
            f"{sym}@bookTicker",
            f"{sym}@depth@100ms",
        )
    )
    base = FUTURES_WS_COMBINED if market == "futures" else SPOT_WS_COMBINED
    return f"{base}?streams={streams}"


def stream_names(symbol: str) -> list[str]:
    sym = symbol.lower()
    return [
        f"{sym}@trade",
        f"{sym}@ticker",
        f"{sym}@bookTicker",
        f"{sym}@depth@100ms",
    ]


def parse_ws_payload(raw: Any) -> tuple[str, dict] | None:
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    if isinstance(raw, str):
        data = json.loads(raw)
    elif isinstance(raw, dict):
        data = raw
    else:
        return None
    if not isinstance(data, dict):
        return None
    inner = data.get("data")
    if "stream" in data and isinstance(inner, dict):
        return str(data["stream"]), inner
    return "", data


def kind_of(stream: str, data: dict) -> str:
    if stream.endswith("@bookTicker") or data.get("e") == "bookTicker":
        return "bookTicker"
    if stream.endswith("@trade") or data.get("e") == "trade":
        return "trade"
    if "@depth" in stream or data.get("e") == "depthUpdate":
        return "depth"
    if stream.endswith("@ticker") or data.get("e") == "24hrTicker":
        return "ticker"
    return ""


def build_notice(
    *,
    connected: bool,
    book_synced: bool,
    book_stale: bool,
    has_cached: bool,
    limited: bool,
) -> str | None:
    if connected and book_synced and not book_stale:
        return None
    if connected and not book_synced:
        if limited and book_stale:
            return (
                "Order book is stale because Binance limited this server. "
                "Live trades and prices continue."
            )
        if limited:
            return (
                "Order book is syncing after a Binance limit. "
                "Live trades and prices continue."
            )
        if book_stale:
            return (
                "Order book is stale while it resyncs. "
                "Live trades and prices continue."
            )
        return "Order book is syncing. Live trades and prices continue."
    if has_cached:
        return (
            "Cached market data is stale. It is not used for orders or risk checks."
        )
    return "Reconnecting to Binance live market data."


def _positive(value: Any) -> Decimal | None:
    try:
        number = Decimal(str(value))
    except Exception:
        return None
    if number <= 0:
        return None
    return number


def _depth_event(data: dict) -> dict | None:
    try:
        event = {
            "U": int(data["U"]),
            "u": int(data["u"]),
            "pu": int(data["pu"]) if data.get("pu") is not None else None,
            "b": data.get("b") or [],
            "a": data.get("a") or [],
        }
    except (KeyError, TypeError, ValueError):
        return None
    return event


class Feed:
    def __init__(self, market: str, symbol: str, clock: Clock):
        self.market = market
        self.symbol = symbol.upper()
        self.clock = clock
        self.lock = threading.Lock()
        self.book = OrderBookSync(market)
        self.trades: list[dict] = []
        self.ticker: dict | None = None
        self.quote: dict[str, Decimal] | None = None
        self.quote_at: float | None = None
        self.connected = False
        self.generation = 0
        self.needs_snapshot = True
        self.snapshot_in_flight = False
        self.snapshot_not_before = 0.0
        self.snapshot_error: str | None = None
        self.gap_streak = 0
        self.snapshot_streak = 0
        self.stale_book: dict | None = None
        self.last_access = clock()
        self.seen_trade = False
        self.seen_ticker = False
        self.seen_depth = False
        self.seen_book = False
        self.stop_event: asyncio.Event | None = None
        self.task: asyncio.Task | None = None

    def touch(self, now: float) -> None:
        with self.lock:
            self.last_access = now

    def idle_for(self, now: float, limit: float) -> bool:
        with self.lock:
            return now - self.last_access > limit

    def on_connected(self) -> None:
        with self.lock:
            if self.book.synced:
                self.stale_book = self.book.top(20)
            self.book.reset()
            self.connected = True
            self.generation += 1
            self.snapshot_in_flight = False
            self.needs_snapshot = True
            self.quote = None
            self.quote_at = None
            self.seen_trade = False
            self.seen_ticker = False
            self.seen_depth = False
            self.seen_book = False

    def on_disconnected(self) -> None:
        with self.lock:
            if self.book.synced:
                self.stale_book = self.book.top(20)
            self.book.reset()
            self.connected = False
            self.generation += 1
            self.snapshot_in_flight = False
            self.needs_snapshot = True
            self.quote = None
            self.quote_at = None

    def begin_snapshot(self, now: float) -> int | None:
        with self.lock:
            if not self.needs_snapshot or self.snapshot_in_flight:
                return None
            if now < self.snapshot_not_before:
                return None
            self.snapshot_in_flight = True
            return self.generation

    def fail_snapshot(self, generation: int, exc: Exception, now: float) -> None:
        with self.lock:
            if generation != self.generation:
                return
            self.snapshot_in_flight = False
            self.needs_snapshot = True
            retry_after = None
            message = "Binance market data is temporarily unavailable."
            if isinstance(exc, BinanceUnavailable):
                retry_after = exc.retry_after
                message = exc.public_message
            if retry_after is not None and retry_after > 0:
                wait = float(retry_after)
            else:
                self.snapshot_streak += 1
                wait = min(MAX_BACKOFF, 2.0 ** min(self.snapshot_streak, 4))
            self.snapshot_not_before = now + wait
            self.snapshot_error = message
            logger.warning(
                "binance ws status=snapshot-failed market=%s symbol=%s retry_after=%.3f action=not-retrying-until-then",
                self.market,
                self.symbol,
                wait,
            )

    def complete_snapshot(self, generation: int, raw: Any, now: float) -> str:
        with self.lock:
            if generation != self.generation:
                return "stale"
            self.snapshot_in_flight = False
            if not isinstance(raw, dict) or raw.get("lastUpdateId") is None:
                self.needs_snapshot = True
                self.snapshot_streak += 1
                wait = min(MAX_BACKOFF, 2.0 ** min(self.snapshot_streak, 4))
                self.snapshot_not_before = now + wait
                self.snapshot_error = "Binance market data is temporarily unavailable."
                return "bad"
            status = self.book.apply_snapshot(
                int(raw["lastUpdateId"]),
                raw.get("bids") or [],
                raw.get("asks") or [],
            )
            if status == "synced":
                self.needs_snapshot = False
                self.snapshot_not_before = 0.0
                self.snapshot_error = None
                self.gap_streak = 0
                self.snapshot_streak = 0
                self.stale_book = None
                logger.info(
                    "binance ws status=book-synced market=%s symbol=%s last_update_id=%s",
                    self.market,
                    self.symbol,
                    self.book.last_update_id,
                )
                return "synced"
            top = self.book.top(20)
            pending = list(self.book.buffer)
            if top["bids"] or top["asks"]:
                self.stale_book = top
            self.book.reset()
            self.book.buffer = pending
            self.needs_snapshot = True
            self.gap_streak += 1
            wait = min(MAX_BACKOFF, 2.0 ** min(self.gap_streak, 5))
            self.snapshot_not_before = now + wait
            logger.warning(
                "binance ws status=book-gap market=%s symbol=%s retry_after=%.3f action=resync",
                self.market,
                self.symbol,
                wait,
            )
            return "gap"

    def handle_message(self, raw: Any) -> None:
        try:
            parsed = parse_ws_payload(raw)
        except Exception:
            logger.warning(
                "binance ws status=bad-message market=%s symbol=%s action=ignore",
                self.market,
                self.symbol,
            )
            return
        if parsed is None:
            return
        stream, data = parsed
        kind = kind_of(stream, data)
        with self.lock:
            if kind == "trade":
                self._on_trade(data)
            elif kind == "ticker":
                self._on_ticker(data)
            elif kind == "bookTicker":
                self._on_book_ticker(data)
            elif kind == "depth":
                self._on_depth(data)

    def _on_trade(self, data: dict) -> None:
        price = _positive(data.get("p"))
        if price is None:
            return
        trade_id = data.get("t")
        try:
            trade_id = int(trade_id) if trade_id is not None else 0
        except (TypeError, ValueError):
            trade_id = 0
        try:
            when = int(data.get("T") or data.get("E") or 0)
        except (TypeError, ValueError):
            when = 0
        self.trades.insert(
            0,
            {
                "id": trade_id,
                "price": str(price),
                "qty": str(data.get("q") or "0"),
                "time": when,
                "isBuyerMaker": bool(data.get("m")),
            },
        )
        del self.trades[40:]
        if self.ticker is None:
            text = str(price)
            self.ticker = {
                "lastPrice": text,
                "priceChange": "0",
                "priceChangePercent": "0",
                "highPrice": text,
                "lowPrice": text,
                "volume": "0",
                "quoteVolume": "0",
            }
        else:
            self.ticker["lastPrice"] = str(price)
        if not self.seen_trade:
            self.seen_trade = True
            logger.info(
                "binance ws status=trade market=%s symbol=%s action=received",
                self.market,
                self.symbol,
            )

    def _on_ticker(self, data: dict) -> None:
        last = _positive(data.get("c"))
        if last is None:
            return
        text = str(last)
        self.ticker = {
            "lastPrice": text,
            "priceChange": str(data.get("p") or "0"),
            "priceChangePercent": str(data.get("P") or "0"),
            "highPrice": str(data.get("h") or text),
            "lowPrice": str(data.get("l") or text),
            "volume": str(data.get("v") or "0"),
            "quoteVolume": str(data.get("q") or "0"),
        }
        if not self.seen_ticker:
            self.seen_ticker = True
            logger.info(
                "binance ws status=ticker market=%s symbol=%s action=received",
                self.market,
                self.symbol,
            )

    def _on_book_ticker(self, data: dict) -> None:
        bid = _positive(data.get("b"))
        ask = _positive(data.get("a"))
        if bid is None or ask is None:
            return
        self.quote = {
            "bid": bid,
            "ask": ask,
            "mid": ((bid + ask) / Decimal("2")).quantize(Decimal("0.00000001")),
        }
        self.quote_at = self.clock()
        if not self.seen_book:
            self.seen_book = True
            logger.info(
                "binance ws status=bookTicker market=%s symbol=%s action=received",
                self.market,
                self.symbol,
            )

    def _on_depth(self, data: dict) -> None:
        event = _depth_event(data)
        if event is None:
            return
        if not self.seen_depth:
            self.seen_depth = True
            logger.info(
                "binance ws status=depth market=%s symbol=%s action=received",
                self.market,
                self.symbol,
            )
        if not self.book.synced:
            self.book.buffer_event(event)
            self.needs_snapshot = True
            return
        status = self.book.consider(event)
        if status != "gap":
            return
        top = self.book.top(20)
        if top["bids"] or top["asks"]:
            self.stale_book = top
        self.book.reset()
        self.book.buffer_event(event)
        self.needs_snapshot = True
        self.gap_streak += 1
        wait = min(MAX_BACKOFF, 2.0 ** min(self.gap_streak, 5))
        self.snapshot_not_before = self.clock() + wait
        logger.warning(
            "binance ws status=book-gap market=%s symbol=%s retry_after=%.3f action=resync",
            self.market,
            self.symbol,
            wait,
        )

    def fresh_quote(self, max_age: float) -> dict[str, Decimal] | None:
        with self.lock:
            if not self.connected or self.quote is None or self.quote_at is None:
                return None
            if self.clock() - self.quote_at > max_age:
                return None
            return dict(self.quote)

    def public_state(self) -> dict:
        with self.lock:
            connected = self.connected
            book_synced = self.book.synced
            if book_synced:
                book = self.book.top(20)
                book_stale = False
            elif self.stale_book is not None:
                book = self.stale_book
                book_stale = True
            else:
                book = {"bids": [], "asks": [], "lastUpdateId": None}
                book_stale = False
            now = self.clock()
            retry_after = None
            if self.snapshot_not_before > now:
                retry_after = round(self.snapshot_not_before - now, 3)
            limited = bool(self.snapshot_error) and retry_after is not None
            ticker = dict(self.ticker) if self.ticker else None
            trades = list(self.trades)
            has_cached = bool(trades) or ticker is not None or book_stale
        if ticker is not None:
            ticker["stale"] = not connected
            ticker["source"] = "websocket" if connected else "cache"
        notice = build_notice(
            connected=connected,
            book_synced=book_synced,
            book_stale=book_stale,
            has_cached=has_cached,
            limited=limited,
        )
        return {
            "market": self.market,
            "symbol": self.symbol,
            "ws": {
                "connected": connected,
                "url": combined_stream_url(self.market, self.symbol),
                "streams": stream_names(self.symbol),
            },
            "ticker": ticker,
            "trades": {
                "trades": trades,
                "stale": bool(trades) and not connected,
                "source": "websocket" if connected else "cache",
            },
            "orderbook": {
                "bids": book["bids"],
                "asks": book["asks"],
                "lastUpdateId": book.get("lastUpdateId"),
                "synced": book_synced,
                "stale": book_stale,
                "source": "websocket" if book_synced else "cache",
            },
            "notice": notice,
            "retry_after": retry_after,
        }


def default_connector(url: str):
    import websockets

    kwargs: dict[str, Any] = {
        "open_timeout": 10,
        "close_timeout": 5,
        "ping_interval": 20,
        "ping_timeout": 20,
        "max_queue": 2048,
    }
    # Ignore HTTP(S)_PROXY so a proxy cannot move this process onto another IP.
    if "proxy" in inspect.signature(websockets.connect).parameters:
        kwargs["proxy"] = None
    return websockets.connect(url, **kwargs)


async def default_sleeper(delay: float, stop: asyncio.Event) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=max(0.0, delay))
    except asyncio.TimeoutError:
        return


def default_snapshot(market: str, symbol: str) -> dict:
    return depth_snapshot(market, symbol, limit=100)


class MarketHub:
    def __init__(
        self,
        connector: Connector | None = None,
        snapshot: SnapshotFn | None = None,
        sleeper: Sleeper | None = None,
        clock: Clock | None = None,
    ):
        self._connector = connector or default_connector
        self._snapshot = snapshot or default_snapshot
        self._sleeper = sleeper or default_sleeper
        self._clock = clock or time.monotonic
        self._feeds: dict[tuple[str, str], Feed] = {}
        self._feeds_lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._start_lock = threading.Lock()

    def start(self) -> None:
        with self._start_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._ready.clear()
            self._thread = threading.Thread(
                target=self._thread_main,
                name="binance-market-hub",
                daemon=True,
            )
            self._thread.start()
        if not self._ready.wait(5):
            raise RuntimeError("Binance market hub did not start")

    def _thread_main(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        self._ready.set()
        try:
            loop.run_forever()
        finally:
            loop.close()

    def ensure(self, market: str, symbol: str) -> None:
        symbol = symbol.upper()
        try:
            self.start()
        except Exception:
            logger.warning(
                "binance ws status=hub-start-failed market=%s symbol=%s action=continue",
                market,
                symbol,
            )
            return
        loop = self._loop
        if loop is None or not loop.is_running():
            return
        try:
            fut = asyncio.run_coroutine_threadsafe(
                self._ensure_async(market, symbol), loop
            )
            fut.result(timeout=2)
        except Exception:
            logger.warning(
                "binance ws status=subscribe-failed market=%s symbol=%s action=continue",
                market,
                symbol,
            )

    async def _ensure_async(self, market: str, symbol: str) -> None:
        symbol = symbol.upper()
        key = (market, symbol)
        with self._feeds_lock:
            feed = self._feeds.get(key)
            if feed is None or feed.task is None or feed.task.done():
                feed = Feed(market, symbol, self._clock)
                feed.stop_event = asyncio.Event()
                self._feeds[key] = feed
                feed.task = asyncio.create_task(
                    self.serve(feed, feed.stop_event),
                    name=f"binance-{market}-{symbol}",
                )
        feed.touch(self._clock())

    def fresh_quote(
        self, market: str, symbol: str, max_age: float = EXECUTION_MAX_AGE
    ) -> dict[str, Decimal] | None:
        key = (market, symbol.upper())
        with self._feeds_lock:
            feed = self._feeds.get(key)
        if feed is None:
            return None
        return feed.fresh_quote(max_age)

    def market_payload(self, market: str, symbol: str) -> dict:
        symbol = symbol.upper()
        self.ensure(market, symbol)
        key = (market, symbol)
        with self._feeds_lock:
            feed = self._feeds.get(key)
        if feed is None:
            raise BinanceUnavailable(
                "Market data is temporarily unavailable.",
                status_code=503,
            )
        feed.touch(self._clock())
        return feed.public_state()

    def close(self) -> None:
        loop = self._loop
        if loop is not None and loop.is_running():
            with self._feeds_lock:
                feeds = list(self._feeds.values())
            for feed in feeds:
                if feed.stop_event is not None:
                    loop.call_soon_threadsafe(feed.stop_event.set)
            loop.call_soon_threadsafe(loop.stop)
        thread = self._thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2)
        self._thread = None

    async def serve(self, feed: Feed, stop: asyncio.Event) -> None:
        backoff = 1.0
        while not stop.is_set():
            if feed.idle_for(self._clock(), IDLE_SECONDS):
                logger.info(
                    "binance ws status=idle market=%s symbol=%s action=close",
                    feed.market,
                    feed.symbol,
                )
                break
            url = combined_stream_url(feed.market, feed.symbol)
            try:
                async with self._connector(url) as ws:
                    feed.on_connected()
                    backoff = 1.0
                    logger.info(
                        "binance ws status=connected market=%s symbol=%s url=%s",
                        feed.market,
                        feed.symbol,
                        url,
                    )
                    await self._snapshot_if_needed(feed)
                    async for raw in ws:
                        if stop.is_set() or feed.idle_for(self._clock(), IDLE_SECONDS):
                            break
                        feed.handle_message(raw)
                        await self._snapshot_if_needed(feed)
            except asyncio.CancelledError:
                feed.on_disconnected()
                raise
            except Exception as exc:
                feed.on_disconnected()
                logger.warning(
                    "binance ws status=connect-failed market=%s symbol=%s retry_after=%.3f action=reconnect error=%s",
                    feed.market,
                    feed.symbol,
                    backoff,
                    exc.__class__.__name__,
                )
            else:
                feed.on_disconnected()
                logger.warning(
                    "binance ws status=closed market=%s symbol=%s retry_after=%.3f action=reconnect",
                    feed.market,
                    feed.symbol,
                    backoff,
                )
            if stop.is_set() or feed.idle_for(self._clock(), IDLE_SECONDS):
                break
            await self._sleeper(backoff, stop)
            backoff = min(MAX_BACKOFF, backoff * 2)
        with self._feeds_lock:
            key = (feed.market, feed.symbol)
            if self._feeds.get(key) is feed:
                del self._feeds[key]

    async def _snapshot_if_needed(self, feed: Feed) -> None:
        generation = feed.begin_snapshot(self._clock())
        if generation is None:
            return
        try:
            raw = await asyncio.to_thread(self._snapshot, feed.market, feed.symbol)
        except Exception as exc:
            feed.fail_snapshot(generation, exc, self._clock())
            return
        feed.complete_snapshot(generation, raw, self._clock())


_hub: MarketHub | None = None
_hub_lock = threading.Lock()


def get_hub() -> MarketHub:
    global _hub
    with _hub_lock:
        if _hub is None:
            _hub = MarketHub()
        return _hub


def set_hub_for_tests(hub: MarketHub | None) -> None:
    global _hub
    with _hub_lock:
        if _hub is not None and _hub is not hub:
            _hub.close()
        _hub = hub


def reset_hub_for_tests() -> None:
    set_hub_for_tests(None)
