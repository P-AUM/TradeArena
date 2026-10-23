"""Binance public market data (spot + USDT-M futures). No API key required.

REST calls are cached, de-duplicated, and stopped while Binance has banned or
rate-limited this process. HTTP 418 and 429 are not retried. Timeouts and 5xx
responses use a short bounded backoff. A Retry-After header or an "IP banned
until <timestamp>" body sets the wait; this client does not switch hosts.

Live trades, tickers, and order-book diffs are delivered by the shared
websocket hub in market_stream.py. REST depth is only the snapshot that
Binance requires to start that book. Stale REST cache is never returned for
execution prices (bookTicker / fill_price).
"""

from __future__ import annotations

import logging
import random
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from email.utils import parsedate_to_datetime
from functools import lru_cache
from typing import Any

import httpx

logger = logging.getLogger(__name__)

SPOT_REST = "https://api.binance.com"
FUTURES_REST = "https://fapi.binance.com"
SPOT_WS = "wss://stream.binance.com:9443/ws"
FUTURES_WS = "wss://fstream.binance.com/ws"
# Combined-stream bases on the same official hosts. Not alternate REST hosts.
SPOT_WS_COMBINED = "wss://stream.binance.com:9443/stream"
FUTURES_WS_COMBINED = "wss://fstream.binance.com/stream"

# Stay well under Binance's 6,000 request-weight per minute IP limit, including
# when a host runs more than one worker. The upstream used-weight header is a
# second guard when this IP is shared with other traffic.
LOCAL_WEIGHT_PER_MINUTE = 2000
LOCAL_WEIGHT_BURST = 150

MAX_ATTEMPTS = 3
BASE_BACKOFF = 0.2
MAX_BACKOFF = 1.5
# Only applied when Binance omits Retry-After. A present Retry-After is honored
# in full so a ban is not poked early (which is how 429 becomes a longer 418).
MAX_ASSUMED_BAN = 3600.0

_CONNECT_TIMEOUT = 3.0
_READ_TIMEOUT = 5.0
_FLIGHT_WAIT = 25.0

_lock = threading.Lock()
_http: httpx.Client | None = None
_http_lock = threading.Lock()


class BinanceUnavailable(Exception):
    """Upstream market data cannot be served right now."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 503,
        retry_after: float | None = None,
    ):
        super().__init__(message)
        self.public_message = message
        self.status_code = status_code
        self.retry_after = retry_after


@dataclass
class _CacheEntry:
    value: Any
    fresh_until: float
    stale_until: float


@dataclass
class _Flight:
    event: threading.Event = field(default_factory=threading.Event)
    result: Any = None
    error: Exception | None = None


@dataclass
class _HostGate:
    banned_until: float = 0.0
    cooldown_until: float = 0.0
    ban_strikes: int = 0
    weight_samples: list[tuple[float, int]] = field(default_factory=list)


_cache: dict[str, _CacheEntry] = {}
_flights: dict[str, _Flight] = {}
_hosts: dict[str, _HostGate] = {}


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


def _get_client() -> httpx.Client:
    global _http
    if _http is not None:
        return _http
    with _http_lock:
        if _http is None:
            _http = httpx.Client(
                timeout=httpx.Timeout(_READ_TIMEOUT, connect=_CONNECT_TIMEOUT),
                headers={
                    "Accept": "application/json",
                    "User-Agent": "TradeArena/1.0",
                },
                follow_redirects=False,
            )
        return _http


def _host_gate(host: str) -> _HostGate:
    gate = _hosts.get(host)
    if gate is None:
        gate = _HostGate()
        _hosts[host] = gate
    return gate


def reset_state_for_tests() -> None:
    """Drop cached payloads, ban state, the shared HTTP client, and the WS hub."""
    global _http
    clear_symbol_cache()
    with _lock:
        _cache.clear()
        _flights.clear()
        _hosts.clear()
    with _http_lock:
        if _http is not None:
            _http.close()
            _http = None
    try:
        from . import market_stream
    except Exception:
        return
    market_stream.reset_hub_for_tests()


def _cache_key(market: str, path: str, params: dict) -> str:
    items = "&".join(f"{k}={params[k]}" for k in sorted(params))
    return f"{market}|{path}|{items}"


def _fresh(key: str) -> Any | None:
    now = time.monotonic()
    with _lock:
        entry = _cache.get(key)
        if entry is not None and entry.fresh_until > now:
            return entry.value
    return None


def _stale(key: str) -> Any | None:
    now = time.monotonic()
    with _lock:
        entry = _cache.get(key)
        if entry is not None and entry.stale_until > now:
            return entry.value
    return None


def _store(key: str, value: Any, ttl: float, stale_ttl: float) -> None:
    now = time.monotonic()
    with _lock:
        _cache[key] = _CacheEntry(
            value=value,
            fresh_until=now + ttl,
            stale_until=now + max(ttl, stale_ttl),
        )


def _blocked_for(host: str) -> float:
    now = time.monotonic()
    with _lock:
        gate = _hosts.get(host)
        if gate is None:
            return 0.0
        return max(0.0, max(gate.banned_until, gate.cooldown_until) - now)


def _set_ban(host: str, seconds: float, *, counted_strike: bool) -> None:
    seconds = max(0.0, seconds)
    until = time.monotonic() + seconds
    with _lock:
        gate = _host_gate(host)
        if until > gate.banned_until:
            gate.banned_until = until
        gate.ban_strikes = gate.ban_strikes + 1 if counted_strike else 0


def _set_cooldown(host: str, seconds: float) -> None:
    until = time.monotonic() + max(0.0, seconds)
    with _lock:
        gate = _host_gate(host)
        if until > gate.cooldown_until:
            gate.cooldown_until = until


def _take_weight(host: str, weight: int) -> None:
    now = time.monotonic()
    with _lock:
        gate = _host_gate(host)
        gate.weight_samples = [
            (ts, w) for ts, w in gate.weight_samples if now - ts < 60
        ]
        used_minute = sum(w for _, w in gate.weight_samples)
        used_second = sum(w for ts, w in gate.weight_samples if now - ts < 1)
        if (
            used_minute + weight > LOCAL_WEIGHT_PER_MINUTE
            or used_second + weight > LOCAL_WEIGHT_BURST
        ):
            raise BinanceUnavailable(
                "Market data is temporarily busy. Please try again shortly.",
                status_code=503,
                retry_after=1,
            )
        gate.weight_samples.append((now, weight))


def _note_upstream_weight(host: str, response: httpx.Response) -> None:
    used = None
    for key, value in response.headers.items():
        if not key.upper().startswith("X-MBX-USED-WEIGHT"):
            continue
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            continue
        if used is None or parsed > used:
            used = parsed
    if used is None:
        return
    if used >= 5400:
        _set_cooldown(host, 30)
        logger.warning(
            "binance status=used-weight endpoint=%s used_weight=%s action=cooldown seconds=30",
            host,
            used,
        )
    elif used >= 4800:
        _set_cooldown(host, 10)
        logger.warning(
            "binance status=used-weight endpoint=%s used_weight=%s action=cooldown seconds=10",
            host,
            used,
        )


def _safe_body(response: httpx.Response) -> str:
    try:
        text = response.text or ""
    except Exception:
        return ""
    lowered = text.lower()
    for secret in ("apikey", "api_key", "secret", "signature", "password"):
        if secret in lowered:
            text = "[redacted]"
            break
    return " ".join(text.split())[:300]


def _parse_retry_after(response: httpx.Response) -> float | None:
    raw = (response.headers.get("Retry-After") or "").strip()
    if not raw:
        return None
    try:
        return max(0.0, float(raw))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(raw)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())


def _assumed_ban_seconds(status: int, strikes_after_increment: int) -> float:
    base = 120.0 if status == 418 else 30.0
    exponent = max(0, strikes_after_increment - 1)
    return min(MAX_ASSUMED_BAN, base * (2**exponent))


def _ban_seconds_from_body(response: httpx.Response) -> float | None:
    """Read Binance's 'banned until <epoch ms>' hint when Retry-After is absent."""
    match = re.search(r"banned until\s+(\d{10,16})", _safe_body(response))
    if not match:
        return None
    raw = int(match.group(1))
    until = raw / 1000.0 if raw > 10_000_000_000 else float(raw)
    seconds = until - time.time()
    if seconds <= 0:
        return None
    # Explicit deadline from Binance, capped so a bad parse cannot lock the process.
    return min(seconds, 24 * 3600.0)


def _backoff_delay(attempt: int, retry_after: float | None) -> float:
    exp = min(MAX_BACKOFF, BASE_BACKOFF * (2 ** (attempt - 1)))
    if retry_after is not None and retry_after > 0:
        exp = min(MAX_BACKOFF, max(exp, retry_after))
    jittered = exp * (0.8 + 0.4 * random.random())
    return min(MAX_BACKOFF, max(0.0, jittered))


def _weight(path: str, params: dict) -> int:
    try:
        limit = int(params.get("limit") or 0)
    except (TypeError, ValueError):
        limit = 0
    spot = "/api/v3/" in path
    if path.endswith("/trades"):
        return 25 if spot else 5
    if path.endswith("/depth"):
        if spot:
            if limit <= 100:
                return 5
            if limit <= 500:
                return 25
            if limit <= 1000:
                return 50
            return 250
        if limit <= 50:
            return 2
        if limit <= 100:
            return 5
        if limit <= 500:
            return 10
        return 20
    if path.endswith("/bookTicker"):
        return 2
    if path.endswith("/24hr"):
        return 2 if spot else 1
    if path.endswith("/exchangeInfo"):
        return 20 if spot else 1
    return 5


def _public_limit_message(status: int) -> str:
    if status == 418:
        return (
            "Market data is temporarily unavailable because Binance limited "
            "this server. Please try again later."
        )
    return "Market data is temporarily rate-limited. Please try again shortly."


def _fail(
    message: str,
    *,
    status_code: int,
    retry_after: float | None = None,
) -> BinanceUnavailable:
    return BinanceUnavailable(
        message, status_code=status_code, retry_after=retry_after
    )


def _log_response(
    response: httpx.Response,
    path: str,
    params: dict,
    *,
    action: str,
    retry_after: float | None,
) -> None:
    logger.warning(
        "binance status=%s endpoint=%s params=%s retry_after=%s action=%s body=%s",
        response.status_code,
        path,
        params,
        retry_after,
        action,
        _safe_body(response),
    )


def _fetch_json(host: str, path: str, params: dict, weight: int) -> Any:
    wait = _blocked_for(host)
    if wait > 0:
        logger.warning(
            "binance status=blocked endpoint=%s params=%s retry_after=%.3f action=not-calling",
            path,
            params,
            wait,
        )
        raise _fail(
            _public_limit_message(418 if wait >= 30 else 429),
            status_code=503,
            retry_after=wait,
        )

    _take_weight(host, weight)
    client = _get_client()
    url = f"{host}{path}"

    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = client.get(url, params=params)
        except httpx.TransportError as exc:
            if attempt >= MAX_ATTEMPTS:
                logger.warning(
                    "binance status=timeout endpoint=%s params=%s attempt=%s/%s action=give-up error=%s",
                    path,
                    params,
                    attempt,
                    MAX_ATTEMPTS,
                    exc.__class__.__name__,
                )
                timed_out = isinstance(exc, httpx.TimeoutException)
                raise _fail(
                    "Binance market data timed out. Please try again."
                    if timed_out
                    else "Binance market data is temporarily unavailable.",
                    status_code=504 if timed_out else 502,
                ) from exc
            delay = _backoff_delay(attempt, None)
            logger.warning(
                "binance status=timeout endpoint=%s params=%s attempt=%s/%s retry_after=%.3f action=backoff error=%s",
                path,
                params,
                attempt,
                MAX_ATTEMPTS,
                delay,
                exc.__class__.__name__,
            )
            _sleep(delay)
            continue

        status = response.status_code
        if status in (418, 429):
            retry_after = _parse_retry_after(response)
            body_after = _ban_seconds_from_body(response)
            explicit = [
                value
                for value in (retry_after, body_after)
                if value is not None and value > 0
            ]
            with _lock:
                strikes = _host_gate(host).ban_strikes
            if explicit:
                # Honor the longer explicit deadline so a short header cannot
                # poke the ban early. Do not invent extra retries.
                ban_for = max(explicit)
                counted_strike = False
            else:
                ban_for = _assumed_ban_seconds(status, strikes + 1)
                counted_strike = True
            _set_ban(host, ban_for, counted_strike=counted_strike)
            _log_response(
                response,
                path,
                params,
                action=f"not-retrying ban_seconds={ban_for:.3f}",
                retry_after=retry_after if retry_after is not None else body_after,
            )
            raise _fail(
                _public_limit_message(status),
                status_code=503,
                retry_after=ban_for,
            )

        if 500 <= status <= 599:
            retry_after = _parse_retry_after(response)
            if attempt >= MAX_ATTEMPTS:
                _log_response(
                    response,
                    path,
                    params,
                    action="give-up",
                    retry_after=retry_after,
                )
                raise _fail(
                    "Binance market data is temporarily unavailable.",
                    status_code=502,
                    retry_after=retry_after,
                )
            delay = _backoff_delay(attempt, retry_after)
            _log_response(
                response,
                path,
                params,
                action=f"backoff attempt={attempt}/{MAX_ATTEMPTS} delay={delay:.3f}",
                retry_after=retry_after,
            )
            _sleep(delay)
            continue

        if status >= 400:
            _log_response(
                response,
                path,
                params,
                action="not-retrying",
                retry_after=None,
            )
            message = "Binance rejected the market data request."
            try:
                payload = response.json()
            except Exception:
                payload = None
            if isinstance(payload, dict) and isinstance(payload.get("msg"), str):
                message = payload["msg"].strip()[:200] or message
            raise _fail(message, status_code=400 if status < 500 else 502)

        _note_upstream_weight(host, response)
        try:
            return response.json()
        except Exception as exc:
            logger.warning(
                "binance status=%s endpoint=%s params=%s action=bad-json body=%s",
                status,
                path,
                params,
                _safe_body(response),
            )
            raise _fail(
                "Binance market data is temporarily unavailable.",
                status_code=502,
            ) from exc

    raise _fail("Binance market data is temporarily unavailable.", status_code=502)


def _load(
    market: str,
    path: str,
    params: dict | None = None,
    *,
    ttl: float,
    stale_ttl: float,
    allow_stale: bool = True,
    use_cache: bool = True,
) -> tuple[Any, bool]:
    """Return ``(payload, stale)``.

    ``stale`` is true only when a cached payload is served after Binance
    refused a fresh fetch. Callers that price orders pass ``allow_stale=False``
    so a ban raises instead of returning that cache. The fresh window is not
    extended on a stale serve, or the next execution read would treat it as live.
    """
    params = dict(params or {})
    host = rest_base(market)
    key = _cache_key(market, path, params)
    if use_cache:
        cached = _fresh(key)
        if cached is not None:
            return cached, False

    with _lock:
        flight = _flights.get(key)
        if flight is None:
            flight = _Flight()
            _flights[key] = flight
            leader = True
        else:
            leader = False

    if not leader:
        if not flight.event.wait(_FLIGHT_WAIT):
            raise _fail(
                "Market data is temporarily unavailable.",
                status_code=504,
            )
        if flight.error is not None:
            err = flight.error
            if isinstance(err, BinanceUnavailable):
                raise BinanceUnavailable(
                    err.public_message,
                    status_code=err.status_code,
                    retry_after=err.retry_after,
                ) from err
            raise err
        value, stale = flight.result
        return value, stale

    try:
        try:
            data = _fetch_json(host, path, params, _weight(path, params))
        except BinanceUnavailable as exc:
            stale = _stale(key) if allow_stale else None
            if stale is not None:
                logger.warning(
                    "binance status=%s endpoint=%s params=%s action=serve-stale",
                    exc.status_code,
                    path,
                    params,
                )
                flight.result = (stale, True)
                return stale, True
            flight.error = exc
            raise
        if ttl > 0 or stale_ttl > 0:
            _store(key, data, ttl, stale_ttl)
        flight.result = (data, False)
        return data, False
    except BinanceUnavailable:
        raise
    except Exception as exc:
        flight.error = exc
        logger.exception(
            "binance status=error endpoint=%s params=%s action=give-up",
            path,
            params,
        )
        wrapped = _fail(
            "Market data is temporarily unavailable.",
            status_code=502,
        )
        flight.error = wrapped
        raise wrapped from exc
    finally:
        flight.event.set()
        with _lock:
            if _flights.get(key) is flight:
                del _flights[key]


def rest_base(market: str) -> str:
    if market == "futures":
        return FUTURES_REST
    if market == "spot":
        return SPOT_REST
    raise ValueError("market must be spot or futures")


def ws_base(market: str) -> str:
    if market == "futures":
        return FUTURES_WS
    if market == "spot":
        return SPOT_WS
    raise ValueError("market must be spot or futures")


@lru_cache(maxsize=2)
def _exchange_info(market: str) -> dict[str, Any]:
    path = "/fapi/v1/exchangeInfo" if market == "futures" else "/api/v3/exchangeInfo"
    data, _stale = _load(market, path, {}, ttl=3600, stale_ttl=6 * 3600)
    return data


def clear_symbol_cache() -> None:
    _exchange_info.cache_clear()
    with _lock:
        for key in list(_cache):
            if "exchangeInfo" in key:
                _cache.pop(key, None)


def list_symbols(market: str, query: str = "", limit: int = 50) -> list[dict]:
    info = _exchange_info(market)
    q = query.upper().strip().replace("-", "").replace("/", "")
    out: list[dict] = []
    for s in info.get("symbols", []):
        status = s.get("status") or s.get("contractStatus")
        if status and status not in ("TRADING",):
            continue
        symbol = s.get("symbol", "")
        base = s.get("baseAsset", "")
        quote = s.get("quoteAsset", "")
        if quote not in ("USDT", "USDC", "BUSD", "FDUSD", "BTC", "ETH"):
            continue
        if q and q not in symbol and q not in base:
            continue
        out.append(
            {
                "symbol": symbol,
                "base": base,
                "quote": quote,
                "market": market,
                "ws_stream": symbol.lower(),
            }
        )

    def rank(item: dict) -> tuple:
        sym, base, quote = item["symbol"], item["base"], item["quote"]
        exact = 0 if (q and (base == q or sym == q or sym == f"{q}USDT")) else 1
        usdt = 0 if quote == "USDT" else 1
        return (exact, usdt, sym)

    out.sort(key=rank)
    return out[:limit]


def book_ticker(market: str, symbol: str) -> dict[str, Decimal]:
    """Fresh best bid/ask. Refuses the stale cache — not safe for fills or risk."""
    symbol = symbol.upper()
    path = "/fapi/v1/ticker/bookTicker" if market == "futures" else "/api/v3/ticker/bookTicker"
    data, _stale = _load(
        market,
        path,
        {"symbol": symbol},
        ttl=1,
        stale_ttl=20,
        allow_stale=False,
    )
    try:
        bid = Decimal(str(data["bidPrice"]))
        ask = Decimal(str(data["askPrice"]))
    except (KeyError, TypeError, ValueError) as exc:
        raise BinanceUnavailable(
            "Binance market data is temporarily unavailable.",
            status_code=502,
        ) from exc
    mid = ((bid + ask) / Decimal("2")).quantize(Decimal("0.00000001"))
    return {"bid": bid, "ask": ask, "mid": mid, "symbol": symbol, "market": market}


def depth(market: str, symbol: str, limit: int = 20) -> dict:
    symbol = symbol.upper()
    # Binance only allows specific depth limits
    allowed = (5, 10, 20, 50, 100, 500, 1000)
    limit = min(allowed, key=lambda x: abs(x - int(limit or 20)))
    path = "/fapi/v1/depth" if market == "futures" else "/api/v3/depth"
    data, stale = _load(
        market,
        path,
        {"symbol": symbol, "limit": limit},
        ttl=1,
        stale_ttl=15,
    )
    return {
        "market": market,
        "symbol": symbol,
        "bids": [{"price": b[0], "qty": b[1]} for b in data.get("bids", [])],
        "asks": [{"price": a[0], "qty": a[1]} for a in data.get("asks", [])],
        "lastUpdateId": data.get("lastUpdateId") or data.get("E"),
        "stale": stale,
        "ws": {
            "url": ws_base(market),
            "stream": f"{symbol.lower()}@depth@100ms",
        },
    }


def depth_snapshot(market: str, symbol: str, limit: int = 100) -> dict:
    """One live depth snapshot for local-book sync.

    Not read from cache: a snapshot taken before the diff stream was buffering
    cannot be bridged, and retrying it would loop. Stale cache is never returned.
    """
    symbol = symbol.upper()
    allowed = (5, 10, 20, 50, 100, 500, 1000)
    limit = min(allowed, key=lambda x: abs(x - int(limit or 100)))
    path = "/fapi/v1/depth" if market == "futures" else "/api/v3/depth"
    data, _stale = _load(
        market,
        path,
        {"symbol": symbol, "limit": limit},
        ttl=0,
        stale_ttl=0,
        allow_stale=False,
        use_cache=False,
    )
    if not isinstance(data, dict) or data.get("lastUpdateId") is None:
        raise BinanceUnavailable(
            "Binance market data is temporarily unavailable.",
            status_code=502,
        )
    return data


def recent_trades(market: str, symbol: str, limit: int = 40) -> dict:
    symbol = symbol.upper()
    path = "/fapi/v1/trades" if market == "futures" else "/api/v3/trades"
    rows, stale = _load(
        market,
        path,
        {"symbol": symbol, "limit": limit},
        ttl=2,
        stale_ttl=30,
    )
    if not isinstance(rows, list):
        raise BinanceUnavailable(
            "Binance market data is temporarily unavailable.",
            status_code=502,
        )
    trades = [
        {
            "id": t.get("id"),
            "price": t.get("price"),
            "qty": t.get("qty"),
            "time": t.get("time"),
            "isBuyerMaker": t.get("isBuyerMaker"),
        }
        for t in rows
        if isinstance(t, dict)
    ]
    return {
        "market": market,
        "symbol": symbol,
        "trades": list(reversed(trades)),
        "stale": stale,
        "ws": {
            "url": ws_base(market),
            "stream": f"{symbol.lower()}@trade",
        },
    }


def ticker_24h(market: str, symbol: str) -> dict:
    symbol = symbol.upper()
    path = "/fapi/v1/ticker/24hr" if market == "futures" else "/api/v3/ticker/24hr"
    d, stale = _load(
        market,
        path,
        {"symbol": symbol},
        ttl=15,
        stale_ttl=120,
    )
    if not isinstance(d, dict):
        raise BinanceUnavailable(
            "Binance market data is temporarily unavailable.",
            status_code=502,
        )
    return {
        "market": market,
        "symbol": symbol,
        "lastPrice": d.get("lastPrice"),
        "priceChange": d.get("priceChange"),
        "priceChangePercent": d.get("priceChangePercent"),
        "highPrice": d.get("highPrice"),
        "lowPrice": d.get("lowPrice"),
        "volume": d.get("volume"),
        "quoteVolume": d.get("quoteVolume"),
        "stale": stale,
        "ws": {
            "url": ws_base(market),
            "stream": f"{symbol.lower()}@ticker",
        },
    }


def fill_price(market: str, symbol: str, side: str) -> Decimal:
    """Market fill: buy/long -> ask, sell/short -> bid."""
    book = book_ticker(market, symbol)
    if side in ("long", "buy"):
        return book["ask"]
    return book["bid"]
