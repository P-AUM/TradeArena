"""Websocket hub, REST ban handling, and order-book synchronization."""

import asyncio
import json
from decimal import Decimal
from unittest.mock import patch

import httpx
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from rest_framework.test import APIClient

from trading.binance import BinanceUnavailable, reset_state_for_tests
from trading.market_stream import (
    Feed,
    MarketHub,
    combined_stream_url,
    reset_hub_for_tests,
    set_hub_for_tests,
)
from trading.orderbook_sync import OrderBookSync
from trading.prices import execution_book

User = get_user_model()


class Clock:
    def __init__(self, now: float = 1_000.0):
        self.now = now

    def __call__(self) -> float:
        return self.now


class ListSocket:
    def __init__(self, messages):
        self.messages = list(messages)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.messages:
            raise StopAsyncIteration
        return self.messages.pop(0)


class QueueSocket:
    def __init__(self, queue: asyncio.Queue):
        self.queue = queue

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.queue.get()
        if item is None:
            raise StopAsyncIteration
        if isinstance(item, BaseException):
            raise item
        return item


class FlakyConnect:
    def __init__(self, fail_times: int, messages):
        self.fail_times = fail_times
        self.messages = messages
        self.calls = 0
        self.urls: list[str] = []

    def __call__(self, url: str):
        self.calls += 1
        self.urls.append(url)
        if self.calls <= self.fail_times:
            raise OSError("connection refused")
        return ListSocket(self.messages)


def trade_message(price="100.5", trade_id=7):
    return json.dumps(
        {
            "stream": "btcusdt@trade",
            "data": {
                "e": "trade",
                "t": trade_id,
                "p": price,
                "q": "0.01",
                "T": 1_700_000_000_000,
                "m": False,
            },
        }
    )


def ticker_message(last="101.25", percent="1.50"):
    return json.dumps(
        {
            "stream": "btcusdt@ticker",
            "data": {
                "e": "24hrTicker",
                "c": last,
                "p": "1.50",
                "P": percent,
                "h": "110",
                "l": "90",
                "v": "12",
                "q": "1200",
            },
        }
    )


def book_message(bid="100", ask="101"):
    return json.dumps(
        {
            "stream": "btcusdt@bookTicker",
            "data": {"u": 1, "s": "BTCUSDT", "b": bid, "B": "1", "a": ask, "A": "1"},
        }
    )


def depth_message(first, final, bids=None, asks=None, previous=None, symbol="btcusdt"):
    data = {
        "e": "depthUpdate",
        "U": first,
        "u": final,
        "b": bids or [],
        "a": asks or [],
    }
    if previous is not None:
        data["pu"] = previous
    return json.dumps({"stream": f"{symbol}@depth@100ms", "data": data})


async def wait_until(predicate, timeout=2.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError("timed out waiting for market stream")
        await asyncio.sleep(0.01)


class OrderBookSyncTests(SimpleTestCase):
    def test_spot_snapshot_then_diffs_ignore_old_events_and_delete_zero_qty(self):
        book = OrderBookSync("spot")
        self.assertEqual(
            book.apply_snapshot(100, [["10", "1"]], [["11", "1"]]),
            "synced",
        )
        self.assertEqual(
            book.consider({"U": 90, "u": 100, "b": [["10", "9"]], "a": []}),
            "ignored",
        )
        self.assertEqual(book.bids["10"], "1")
        self.assertEqual(
            book.consider({"U": 101, "u": 101, "b": [["10", "4"]], "a": []}),
            "applied",
        )
        self.assertEqual(
            book.consider(
                {"U": 102, "u": 103, "b": [["10", "0"]], "a": [["12", "2"]]}
            ),
            "applied",
        )
        self.assertNotIn("10", book.bids)
        self.assertEqual(book.asks["12"], "2")
        self.assertEqual(
            book.consider({"U": 105, "u": 106, "b": [["10", "1"]], "a": []}),
            "gap",
        )
        self.assertEqual(book.bids, {})

    def test_spot_buffer_is_applied_across_the_snapshot(self):
        book = OrderBookSync("spot")
        book.buffer_event({"U": 100, "u": 102, "b": [["10", "5"]], "a": []})
        book.buffer_event({"U": 103, "u": 104, "b": [["10", "0"]], "a": []})
        self.assertEqual(
            book.apply_snapshot(100, [["10", "1"]], [["11", "1"]]),
            "synced",
        )
        self.assertNotIn("10", book.bids)
        self.assertEqual(book.asks["11"], "1")

    def test_spot_buffer_gap_is_not_treated_as_synced(self):
        book = OrderBookSync("spot")
        book.buffer_event({"U": 110, "u": 111, "b": [], "a": []})
        self.assertEqual(
            book.apply_snapshot(100, [["10", "1"]], [["11", "1"]]),
            "gap",
        )
        self.assertFalse(book.synced)
        self.assertEqual(len(book.buffer), 1)

    def test_futures_uses_previous_update_id(self):
        book = OrderBookSync("futures")
        self.assertEqual(
            book.apply_snapshot(50, [["1", "1"]], [["2", "1"]]),
            "synced",
        )
        self.assertEqual(
            book.consider(
                {"U": 49, "u": 51, "pu": 1, "b": [["1", "3"]], "a": []}
            ),
            "applied",
        )
        self.assertEqual(book.bids["1"], "3")
        self.assertEqual(
            book.consider(
                {"U": 52, "u": 53, "pu": 51, "b": [], "a": [["2", "0"]]}
            ),
            "applied",
        )
        self.assertNotIn("2", book.asks)
        self.assertEqual(
            book.consider(
                {"U": 54, "u": 55, "pu": 50, "b": [["9", "1"]], "a": []}
            ),
            "gap",
        )
        self.assertNotIn("9", book.bids)
        self.assertTrue(book.synced)

    def test_top_of_book_sorts_bids_desc_and_asks_asc(self):
        book = OrderBookSync("spot")
        book.apply_snapshot(
            1,
            [["10", "1"], ["12", "1"], ["11", "1"]],
            [["20", "1"], ["18", "1"]],
        )
        top = book.top(2)
        self.assertEqual([row["price"] for row in top["bids"]], ["12", "11"])
        self.assertEqual([row["price"] for row in top["asks"]], ["18", "20"])


class MarketStreamTests(SimpleTestCase):
    def tearDown(self):
        reset_hub_for_tests()

    def test_official_stream_hosts_only(self):
        spot = combined_stream_url("spot", "BTCUSDT")
        futures = combined_stream_url("futures", "ETHUSDT")
        self.assertTrue(spot.startswith("wss://stream.binance.com:9443/stream?"))
        for name in (
            "btcusdt@trade",
            "btcusdt@ticker",
            "btcusdt@bookTicker",
            "btcusdt@depth@100ms",
        ):
            self.assertIn(name, spot)
        self.assertNotIn("depth20", spot)
        self.assertNotIn("api.binance.com", spot)
        self.assertNotIn("binance.vision", spot)
        self.assertTrue(futures.startswith("wss://fstream.binance.com/stream?"))
        self.assertIn("ethusdt@depth@100ms", futures)

    def test_reconnects_after_connection_failures_and_receives_a_trade(self):
        sleeps: list[float] = []
        connector = FlakyConnect(2, [trade_message(), ticker_message(), book_message()])
        clock = Clock()
        feed = Feed("spot", "BTCUSDT", clock)

        async def sleeper(delay, stop):
            sleeps.append(delay)
            if feed.trades:
                stop.set()

        hub = MarketHub(
            connector=connector,
            snapshot=lambda market, symbol: {
                "lastUpdateId": 100,
                "bids": [["100", "1"]],
                "asks": [["101", "1"]],
            },
            sleeper=sleeper,
            clock=clock,
        )

        async def run():
            with self.assertLogs("trading.market_stream", level="WARNING") as captured:
                await hub.serve(feed, asyncio.Event())
            return captured.output

        output = asyncio.run(run())
        self.assertEqual(connector.calls, 3)
        self.assertEqual(sleeps[0], 1.0)
        self.assertEqual(sleeps[1], 2.0)
        self.assertEqual(feed.trades[0]["price"], "100.5")
        self.assertEqual(feed.ticker["priceChangePercent"], "1.50")
        self.assertIn("btcusdt@depth@100ms", connector.urls[-1])
        self.assertIn("stream.binance.com", connector.urls[-1])
        self.assertTrue(
            any(
                "status=connect-failed" in line and "action=reconnect" in line
                for line in output
            )
        )
        self.assertIsNone(feed.fresh_quote(5))

    def test_snapshot_418_does_not_retry_until_retry_after_and_keeps_trades(self):
        asyncio.run(self._snapshot_ban(retry_after=30, second_delay=30))

    def test_snapshot_503_backs_off_instead_of_retrying_immediately(self):
        asyncio.run(self._snapshot_ban(retry_after=None, second_delay=2))

    async def _snapshot_ban(self, retry_after, second_delay):
        queue: asyncio.Queue = asyncio.Queue()
        clock = Clock(0)
        calls: list[float] = []

        def snapshot(market, symbol):
            calls.append(clock.now)
            if len(calls) == 1:
                raise BinanceUnavailable(
                    "limited" if retry_after else "unavailable",
                    status_code=503 if retry_after else 502,
                    retry_after=retry_after,
                )
            return {
                "lastUpdateId": 100,
                "bids": [["10", "2"]],
                "asks": [["11", "3"]],
            }

        async def sleeper(delay, stop):
            return None

        hub = MarketHub(
            connector=lambda url: QueueSocket(queue),
            snapshot=snapshot,
            sleeper=sleeper,
            clock=clock,
        )
        feed = Feed("spot", "BTCUSDT", clock)
        stop = asyncio.Event()
        task = asyncio.create_task(hub.serve(feed, stop))
        try:
            await wait_until(lambda: len(calls) == 1)
            await queue.put(trade_message())
            await queue.put(book_message())
            await wait_until(lambda: bool(feed.trades) and feed.quote is not None)
            await asyncio.sleep(0.05)
            self.assertEqual(len(calls), 1)
            state = feed.public_state()
            self.assertTrue(state["ws"]["connected"])
            self.assertEqual(state["trades"]["trades"][0]["price"], "100.5")
            self.assertFalse(state["trades"]["stale"])
            self.assertFalse(state["orderbook"]["synced"])
            self.assertIn("Live trades", state["notice"])
            self.assertIsNotNone(feed.fresh_quote(5))
            if retry_after:
                self.assertGreater(state["retry_after"], 20)
                self.assertIn("Binance limit", state["notice"])
            clock.now = second_delay
            await queue.put(
                depth_message(100, 102, bids=[["10", "1"]], asks=[["11", "4"]])
            )
            await wait_until(lambda: feed.book.synced)
            self.assertEqual(len(calls), 2)
            synced = feed.public_state()
            self.assertTrue(synced["orderbook"]["synced"])
            self.assertFalse(synced["orderbook"]["stale"])
            self.assertIsNone(synced["notice"])
            self.assertEqual(synced["orderbook"]["bids"][0]["qty"], "1")
        finally:
            stop.set()
            await queue.put(None)
            await task

    def test_disconnect_marks_book_stale_and_drops_execution_quote(self):
        async def scenario():
            queue: asyncio.Queue = asyncio.Queue()
            clock = Clock(10)
            feed = Feed("spot", "BTCUSDT", clock)

            async def sleeper(delay, stop):
                if not feed.connected and feed.stale_book is not None:
                    stop.set()

            hub = MarketHub(
                connector=lambda url: QueueSocket(queue),
                snapshot=lambda market, symbol: {
                    "lastUpdateId": 100,
                    "bids": [["10", "1"]],
                    "asks": [["11", "1"]],
                },
                sleeper=sleeper,
                clock=clock,
            )
            stop = asyncio.Event()
            task = asyncio.create_task(hub.serve(feed, stop))
            await wait_until(lambda: feed.book.synced)
            await queue.put(book_message())
            await wait_until(lambda: feed.fresh_quote(5) is not None)
            await queue.put(ConnectionError("dropped"))
            await task
            self.assertIsNone(feed.fresh_quote(5))
            self.assertFalse(feed.connected)
            state = feed.public_state()
            self.assertTrue(state["orderbook"]["stale"])
            self.assertFalse(state["orderbook"]["synced"])
            self.assertIn("not used for orders", state["notice"])

        asyncio.run(scenario())

    def test_execution_book_uses_a_fresh_websocket_quote_without_rest(self):
        clock = Clock(50)
        hub = MarketHub(clock=clock)
        feed = Feed("spot", "BTCUSDT", clock)
        feed.connected = True
        feed.quote = {
            "bid": Decimal("10"),
            "ask": Decimal("12"),
            "mid": Decimal("11"),
        }
        feed.quote_at = 50
        hub._feeds[("spot", "BTCUSDT")] = feed
        set_hub_for_tests(hub)
        book = execution_book("spot", "BTCUSDT")
        self.assertEqual(book["bid"], Decimal("10"))
        self.assertEqual(book["ask"], Decimal("12"))
        self.assertIsNone(hub._thread)

    def test_aged_websocket_quote_is_not_used_for_execution(self):
        clock = Clock(50)
        hub = MarketHub(clock=clock)
        feed = Feed("spot", "BTCUSDT", clock)
        feed.connected = True
        feed.quote = {
            "bid": Decimal("10"),
            "ask": Decimal("12"),
            "mid": Decimal("11"),
        }
        feed.quote_at = 40
        hub._feeds[("spot", "BTCUSDT")] = feed
        self.assertIsNone(hub.fresh_quote("spot", "BTCUSDT"))
        set_hub_for_tests(hub)
        with patch.object(hub, "ensure") as ensure:
            with patch(
                "trading.prices.bn.book_ticker",
                side_effect=BinanceUnavailable(
                    "no fresh price", status_code=503, retry_after=12
                ),
            ):
                with self.assertRaises(BinanceUnavailable) as raised:
                    execution_book("spot", "BTCUSDT")
        ensure.assert_called_once()
        self.assertEqual(raised.exception.retry_after, 12)
        self.assertNotIn("10", str(raised.exception))


class MarketViewTests(TestCase):
    def setUp(self):
        reset_state_for_tests()
        self.user = User.objects.create_user(
            username="trader-stream",
            email="stream@example.com",
            password="test-pass-123",
            role=User.Role.TRADER,
        )
        self.api = APIClient()
        self.api.force_authenticate(self.user)
        self.calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(str(request.url))
            return httpx.Response(500, json={"msg": "REST should not be called"})

        from trading import binance

        binance._http = httpx.Client(transport=httpx.MockTransport(handler))
        self.clock = Clock(100)
        self.hub = MarketHub(
            connector=lambda url: (_ for _ in ()).throw(AssertionError(url)),
            snapshot=lambda market, symbol: (_ for _ in ()).throw(
                AssertionError("snapshot")
            ),
            clock=self.clock,
        )
        self.hub.ensure = lambda *args, **kwargs: None  # type: ignore[method-assign]
        set_hub_for_tests(self.hub)

    def tearDown(self):
        reset_hub_for_tests()
        reset_state_for_tests()

    def _seed(self, **overrides):
        feed = Feed("spot", "BTCUSDT", self.clock)
        feed.connected = True
        feed.trades = [
            {
                "id": 1,
                "price": "100",
                "qty": "0.1",
                "time": 1,
                "isBuyerMaker": False,
            }
        ]
        feed.ticker = {
            "lastPrice": "100",
            "priceChange": "1",
            "priceChangePercent": "1",
            "highPrice": "110",
            "lowPrice": "90",
            "volume": "5",
            "quoteVolume": "500",
        }
        for key, value in overrides.items():
            setattr(feed, key, value)
        self.hub._feeds[("spot", "BTCUSDT")] = feed
        return feed

    def test_market_view_serves_synced_book_without_rest(self):
        feed = self._seed()
        self.assertEqual(
            feed.book.apply_snapshot(5, [["100", "1"]], [["101", "2"]]),
            "synced",
        )
        response = self.api.get("/api/trading/market/?market=spot&symbol=BTCUSDT")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["ws"]["connected"])
        self.assertEqual(body["trades"]["trades"][0]["price"], "100")
        self.assertFalse(body["trades"]["stale"])
        self.assertTrue(body["orderbook"]["synced"])
        self.assertFalse(body["orderbook"]["stale"])
        self.assertIsNone(body["notice"])
        self.assertEqual(self.calls, [])

    def test_market_view_keeps_trades_when_book_snapshot_is_banned(self):
        feed = self._seed()
        feed.needs_snapshot = True
        feed.snapshot_error = (
            "Market data is temporarily unavailable because Binance limited this server."
        )
        feed.snapshot_not_before = self.clock.now + 36
        response = self.api.get("/api/trading/market/?market=spot&symbol=BTCUSDT")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["trades"]["trades"][0]["price"], "100")
        self.assertFalse(body["orderbook"]["synced"])
        self.assertIn("Live trades", body["notice"])
        self.assertIn("Binance limit", body["notice"])
        self.assertEqual(response["Retry-After"], "36")
        self.assertEqual(self.calls, [])

    def test_market_view_marks_cached_data_stale_when_socket_is_down(self):
        feed = self._seed(connected=False)
        feed.stale_book = {
            "bids": [{"price": "100", "qty": "1"}],
            "asks": [{"price": "101", "qty": "1"}],
            "lastUpdateId": 5,
        }
        response = self.api.get("/api/trading/market/?market=spot&symbol=BTCUSDT")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["ws"]["connected"])
        self.assertTrue(body["trades"]["stale"])
        self.assertTrue(body["ticker"]["stale"])
        self.assertTrue(body["orderbook"]["stale"])
        self.assertFalse(body["orderbook"]["synced"])
        self.assertIn("not used for orders", body["notice"])
        self.assertEqual(self.calls, [])
