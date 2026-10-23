import threading
import time
from email.utils import formatdate
from unittest.mock import patch

import httpx
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from rest_framework.test import APIClient

from trading import binance
from trading.binance import (
    BASE_BACKOFF,
    MAX_BACKOFF,
    BinanceUnavailable,
    book_ticker,
    recent_trades,
    reset_state_for_tests,
)

User = get_user_model()

RAW_TRADES = [
    {
        "id": 1,
        "price": "100.00",
        "qty": "0.10",
        "time": 1,
        "isBuyerMaker": False,
    },
    {
        "id": 2,
        "price": "101.50",
        "qty": "0.20",
        "time": 2,
        "isBuyerMaker": True,
    },
]


class BinanceMarketDataTests(SimpleTestCase):
    def setUp(self):
        reset_state_for_tests()
        self.calls = []
        self.sleeps = []
        self.sleep_patch = patch(
            "trading.binance._sleep", side_effect=self.sleeps.append
        )
        self.random_patch = patch(
            "trading.binance.random.random", return_value=0.5
        )
        self.sleep_patch.start()
        self.random_patch.start()

    def tearDown(self):
        self.sleep_patch.stop()
        self.random_patch.stop()
        reset_state_for_tests()

    def _install(self, handler):
        reset_state_for_tests()
        binance._http = httpx.Client(transport=httpx.MockTransport(handler))

    def test_recent_trades_success_shape(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            self.assertIn("/api/v3/trades", str(request.url))
            self.assertIn("symbol=BTCUSDT", str(request.url))
            self.assertIn("limit=40", str(request.url))
            return httpx.Response(200, json=RAW_TRADES)

        self._install(handler)
        payload = recent_trades("spot", "btcusdt", 40)

        self.assertEqual(payload["market"], "spot")
        self.assertEqual(payload["symbol"], "BTCUSDT")
        self.assertEqual(payload["ws"]["stream"], "btcusdt@trade")
        self.assertIn("stream.binance.com", payload["ws"]["url"])
        self.assertEqual([row["id"] for row in payload["trades"]], [2, 1])
        self.assertEqual(payload["trades"][0]["price"], "101.50")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.sleeps, [])

    def test_recent_trades_are_cached(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            return httpx.Response(200, json=RAW_TRADES)

        self._install(handler)
        first = recent_trades("spot", "BTCUSDT", 40)
        second = recent_trades("spot", "BTCUSDT", 40)

        self.assertEqual(first, second)
        self.assertEqual(len(self.calls), 1)

    def test_http_418_does_not_retry_and_honors_retry_after(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            return httpx.Response(
                418,
                headers={"Retry-After": "120"},
                json={"code": -1003, "msg": "Way too many requests; IP banned."},
            )

        self._install(handler)
        with self.assertLogs("trading.binance", level="WARNING") as captured:
            with self.assertRaises(BinanceUnavailable) as raised:
                recent_trades("spot", "BTCUSDT", 40)

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.retry_after, 120)
        self.assertNotIn("teapot", raised.exception.public_message.lower())
        self.assertNotIn("api.binance.com", raised.exception.public_message)
        self.assertEqual(self.sleeps, [])
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(
            any(
                "status=418" in line
                and "endpoint=/api/v3/trades" in line
                and "retry_after=120" in line
                and "not-retrying" in line
                for line in captured.output
            )
        )

        with self.assertRaises(BinanceUnavailable):
            recent_trades("spot", "ETHUSDT", 40)
        self.assertEqual(len(self.calls), 1)

    def test_http_418_without_retry_after_uses_bounded_ban(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(str(request.url))
            return httpx.Response(418, content=b"I'm a teapot")

        self._install(handler)
        before = time.monotonic()
        with self.assertRaises(BinanceUnavailable) as raised:
            recent_trades("spot", "BTCUSDT", 40)

        gate = binance._hosts[binance.SPOT_REST]
        self.assertEqual(self.sleeps, [])
        self.assertEqual(len(self.calls), 1)
        self.assertGreaterEqual(raised.exception.retry_after, 120)
        self.assertLessEqual(gate.banned_until - before, binance.MAX_ASSUMED_BAN + 1)
        self.assertGreaterEqual(gate.banned_until - before, 120)

        gate.banned_until = 0
        with self.assertRaises(BinanceUnavailable) as second:
            recent_trades("spot", "BTCUSDT", 40)
        self.assertEqual(len(self.calls), 2)
        self.assertGreaterEqual(second.exception.retry_after, 240)
        self.assertEqual(self.sleeps, [])

    def test_http_429_honors_retry_after_without_immediate_retry(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            return httpx.Response(
                429,
                headers={"Retry-After": "15"},
                json={"code": -1003, "msg": "Too many requests."},
            )

        self._install(handler)
        with self.assertLogs("trading.binance", level="WARNING") as captured:
            with self.assertRaises(BinanceUnavailable) as raised:
                recent_trades("spot", "BTCUSDT", 40)

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.retry_after, 15)
        self.assertEqual(self.sleeps, [])
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(
            any(
                "status=429" in line and "retry_after=15" in line and "not-retrying" in line
                for line in captured.output
            )
        )

        with self.assertRaises(BinanceUnavailable):
            book_ticker("spot", "BTCUSDT")
        self.assertEqual(len(self.calls), 1)

    def test_retry_after_http_date(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            return httpx.Response(
                429,
                headers={"Retry-After": formatdate(time.time() + 60, usegmt=True)},
                json={"msg": "Too many requests."},
            )

        self._install(handler)
        with self.assertRaises(BinanceUnavailable) as raised:
            recent_trades("spot", "BTCUSDT", 40)

        self.assertGreater(raised.exception.retry_after, 45)
        self.assertLess(raised.exception.retry_after, 75)
        self.assertEqual(self.sleeps, [])
        self.assertEqual(len(self.calls), 1)

    def test_server_error_retries_with_bounded_backoff_then_succeeds(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            if len(self.calls) < 3:
                return httpx.Response(
                    503,
                    headers={"Retry-After": "30"},
                    json={"msg": "unavailable"},
                )
            return httpx.Response(200, json=RAW_TRADES)

        self._install(handler)
        payload = recent_trades("spot", "BTCUSDT", 40)

        self.assertEqual(payload["trades"][0]["id"], 2)
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(len(self.sleeps), 2)
        self.assertTrue(all(delay <= MAX_BACKOFF for delay in self.sleeps))
        self.assertEqual(self.sleeps[0], MAX_BACKOFF)

    def test_server_error_gives_up_after_max_attempts(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            return httpx.Response(500, json={"msg": "down"})

        self._install(handler)
        with self.assertRaises(BinanceUnavailable) as raised:
            recent_trades("spot", "BTCUSDT", 40)

        self.assertEqual(raised.exception.status_code, 502)
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(len(self.sleeps), 2)
        self.assertAlmostEqual(self.sleeps[0], BASE_BACKOFF)
        self.assertAlmostEqual(self.sleeps[1], BASE_BACKOFF * 2)

    def test_timeout_retries_then_succeeds(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            if len(self.calls) == 1:
                raise httpx.ReadTimeout("timed out")
            return httpx.Response(200, json=RAW_TRADES)

        self._install(handler)
        payload = recent_trades("spot", "BTCUSDT", 40)

        self.assertEqual(payload["symbol"], "BTCUSDT")
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(len(self.sleeps), 1)
        self.assertAlmostEqual(self.sleeps[0], BASE_BACKOFF)

    def test_timeout_gives_up_without_tight_loop(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            raise httpx.ConnectTimeout("timed out")

        self._install(handler)
        with self.assertLogs("trading.binance", level="WARNING") as captured:
            with self.assertRaises(BinanceUnavailable) as raised:
                recent_trades("spot", "BTCUSDT", 40)

        self.assertEqual(raised.exception.status_code, 504)
        self.assertIn("timed out", raised.exception.public_message)
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(len(self.sleeps), 2)
        self.assertTrue(any("status=timeout" in line for line in captured.output))
        self.assertTrue(any("action=give-up" in line for line in captured.output))

    def test_secret_like_response_body_is_not_logged(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                418,
                headers={"Retry-After": "5"},
                content=b'{"msg":"banned","signature":"super-secret-value"}',
            )

        self._install(handler)
        with self.assertLogs("trading.binance", level="WARNING") as captured:
            with self.assertRaises(BinanceUnavailable):
                recent_trades("spot", "BTCUSDT", 40)

        joined = "\n".join(captured.output)
        self.assertNotIn("super-secret-value", joined)
        self.assertIn("[redacted]", joined)

    def test_ban_on_spot_does_not_block_futures_host(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(str(request.url))
            host = request.url.host or ""
            if host == "api.binance.com":
                return httpx.Response(
                    418,
                    headers={"Retry-After": "30"},
                    json={"msg": "banned"},
                )
            return httpx.Response(200, json=RAW_TRADES)

        self._install(handler)
        with self.assertRaises(BinanceUnavailable):
            recent_trades("spot", "BTCUSDT", 40)
        payload = recent_trades("futures", "BTCUSDT", 40)

        self.assertEqual(payload["market"], "futures")
        self.assertTrue(any("fapi.binance.com/fapi/v1/trades" in url for url in self.calls))
        self.assertEqual(len(self.calls), 2)

    def test_stale_trades_are_served_during_a_ban(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            return httpx.Response(200, json=RAW_TRADES)

        self._install(handler)
        first = recent_trades("spot", "BTCUSDT", 40)
        entry = next(iter(binance._cache.values()))
        entry.fresh_until = 0
        binance._hosts[binance.SPOT_REST].banned_until = time.monotonic() + 100

        second = recent_trades("spot", "BTCUSDT", 40)
        self.assertEqual(second["trades"], first["trades"])
        self.assertEqual(len(self.calls), 1)

    def test_high_used_weight_pauses_further_requests(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(str(request.url))
            return httpx.Response(
                200,
                headers={"X-MBX-USED-WEIGHT-1M": "5600"},
                json=RAW_TRADES,
            )

        self._install(handler)
        recent_trades("spot", "BTCUSDT", 40)
        with self.assertRaises(BinanceUnavailable):
            recent_trades("spot", "ETHUSDT", 40)
        self.assertEqual(len(self.calls), 1)

    def test_invalid_symbol_is_not_retried_or_treated_as_a_ban(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(str(request.url))
            if "symbol=NOPE" in str(request.url):
                return httpx.Response(
                    400, json={"code": -1121, "msg": "Invalid symbol."}
                )
            return httpx.Response(200, json=RAW_TRADES)

        self._install(handler)
        with self.assertRaises(BinanceUnavailable) as raised:
            recent_trades("spot", "NOPE", 40)
        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("Invalid symbol", raised.exception.public_message)

        payload = recent_trades("spot", "BTCUSDT", 40)
        self.assertEqual(payload["symbol"], "BTCUSDT")
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.sleeps, [])

    def test_concurrent_calls_share_one_request(self):
        started = threading.Event()
        release = threading.Event()

        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            started.set()
            self.assertTrue(release.wait(2))
            return httpx.Response(200, json=RAW_TRADES)

        self._install(handler)
        results = []
        errors = []

        def worker():
            try:
                results.append(recent_trades("spot", "BTCUSDT", 40))
            except Exception as exc:  # pragma: no cover - failure path for the assertion
                errors.append(exc)

        first = threading.Thread(target=worker)
        first.start()
        self.assertTrue(started.wait(2))
        second = threading.Thread(target=worker)
        second.start()
        time.sleep(0.05)
        release.set()
        first.join(2)
        second.join(2)

        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(results[0]["trades"][0]["id"], 2)


class RecentTradesViewTests(TestCase):
    def setUp(self):
        reset_state_for_tests()
        self.user = User.objects.create_user(
            username="trader1",
            email="trader1@example.com",
            password="test-pass-123",
            role=User.Role.TRADER,
        )
        self.api = APIClient()
        self.api.force_authenticate(self.user)
        self.calls = []
        self.sleep_patch = patch("trading.binance._sleep", return_value=None)
        self.sleep_patch.start()

    def tearDown(self):
        self.sleep_patch.stop()
        reset_state_for_tests()

    def _install(self, handler):
        reset_state_for_tests()
        binance._http = httpx.Client(transport=httpx.MockTransport(handler))

    def test_view_returns_trades(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            return httpx.Response(200, json=RAW_TRADES)

        self._install(handler)
        response = self.api.get(
            "/api/trading/trades/?market=spot&symbol=BTCUSDT&limit=40"
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["symbol"], "BTCUSDT")
        self.assertEqual(body["trades"][0]["id"], 2)
        self.assertEqual(body["ws"]["stream"], "btcusdt@trade")
        self.assertEqual(len(self.calls), 1)

    def test_view_418_is_a_graceful_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            return httpx.Response(
                418,
                headers={"Retry-After": "120"},
                content=b"I'm a teapot",
            )

        self._install(handler)
        response = self.api.get(
            "/api/trading/trades/?market=spot&symbol=BTCUSDT&limit=40"
        )

        self.assertEqual(response.status_code, 503)
        detail = response.json()["detail"]
        self.assertNotIn("teapot", detail.lower())
        self.assertNotIn("api.binance.com", detail)
        self.assertEqual(response["Retry-After"], "120")

        again = self.api.get(
            "/api/trading/trades/?market=spot&symbol=BTCUSDT&limit=40"
        )
        self.assertEqual(again.status_code, 503)
        self.assertEqual(len(self.calls), 1)

    def test_view_429_includes_retry_after(self):
        def handler(request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            return httpx.Response(
                429,
                headers={"Retry-After": "15"},
                json={"msg": "Too many requests."},
            )

        self._install(handler)
        response = self.api.get(
            "/api/trading/trades/?market=spot&symbol=BTCUSDT&limit=40"
        )

        self.assertEqual(response.status_code, 503)
        self.assertIn("rate-limited", response.json()["detail"])
        self.assertEqual(response["Retry-After"], "15")
        self.assertEqual(len(self.calls), 1)
