"""Binance public market data (spot + USDT-M futures). No API key required."""

from __future__ import annotations

from decimal import Decimal
from functools import lru_cache
from typing import Any

import httpx

SPOT_REST = "https://api.binance.com"
FUTURES_REST = "https://fapi.binance.com"
SPOT_WS = "wss://stream.binance.com:9443/ws"
FUTURES_WS = "wss://fstream.binance.com/ws"


def _client() -> httpx.Client:
    return httpx.Client(timeout=15.0)


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
    with _client() as client:
        r = client.get(f"{rest_base(market)}{path}")
        r.raise_for_status()
        return r.json()


def clear_symbol_cache() -> None:
    _exchange_info.cache_clear()


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
    # Prefer exact base / USDT pairs first
    def rank(item: dict) -> tuple:
        sym, base, quote = item["symbol"], item["base"], item["quote"]
        exact = 0 if (q and (base == q or sym == q or sym == f"{q}USDT")) else 1
        usdt = 0 if quote == "USDT" else 1
        return (exact, usdt, sym)

    out.sort(key=rank)
    return out[:limit]

def book_ticker(market: str, symbol: str) -> dict[str, Decimal]:
    symbol = symbol.upper()
    path = "/fapi/v1/ticker/bookTicker" if market == "futures" else "/api/v3/ticker/bookTicker"
    with _client() as client:
        r = client.get(f"{rest_base(market)}{path}", params={"symbol": symbol})
        r.raise_for_status()
        data = r.json()
    bid = Decimal(str(data["bidPrice"]))
    ask = Decimal(str(data["askPrice"]))
    mid = ((bid + ask) / Decimal("2")).quantize(Decimal("0.00000001"))
    return {"bid": bid, "ask": ask, "mid": mid, "symbol": symbol, "market": market}


def depth(market: str, symbol: str, limit: int = 20) -> dict:
    symbol = symbol.upper()
    # Binance only allows specific depth limits
    allowed = (5, 10, 20, 50, 100, 500, 1000)
    limit = min(allowed, key=lambda x: abs(x - int(limit or 20)))
    path = "/fapi/v1/depth" if market == "futures" else "/api/v3/depth"
    with _client() as client:
        r = client.get(
            f"{rest_base(market)}{path}",
            params={"symbol": symbol, "limit": limit},
        )
        r.raise_for_status()
        data = r.json()
    return {
        "market": market,
        "symbol": symbol,
        "bids": [{"price": b[0], "qty": b[1]} for b in data.get("bids", [])],
        "asks": [{"price": a[0], "qty": a[1]} for a in data.get("asks", [])],
        "lastUpdateId": data.get("lastUpdateId") or data.get("E"),
        "ws": {
            "url": ws_base(market),
            "stream": f"{symbol.lower()}@depth20@100ms",
        },
    }


def recent_trades(market: str, symbol: str, limit: int = 40) -> dict:
    symbol = symbol.upper()
    path = "/fapi/v1/trades" if market == "futures" else "/api/v3/trades"
    with _client() as client:
        r = client.get(
            f"{rest_base(market)}{path}",
            params={"symbol": symbol, "limit": limit},
        )
        r.raise_for_status()
        rows = r.json()
    trades = [
        {
            "id": t.get("id"),
            "price": t.get("price"),
            "qty": t.get("qty"),
            "time": t.get("time"),
            "isBuyerMaker": t.get("isBuyerMaker"),
        }
        for t in rows
    ]
    return {
        "market": market,
        "symbol": symbol,
        "trades": list(reversed(trades)),
        "ws": {
            "url": ws_base(market),
            "stream": f"{symbol.lower()}@trade",
        },
    }


def ticker_24h(market: str, symbol: str) -> dict:
    symbol = symbol.upper()
    path = "/fapi/v1/ticker/24hr" if market == "futures" else "/api/v3/ticker/24hr"
    with _client() as client:
        r = client.get(f"{rest_base(market)}{path}", params={"symbol": symbol})
        r.raise_for_status()
        d = r.json()
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
        "ws": {
            "url": ws_base(market),
            "stream": f"{symbol.lower()}@bookTicker",
        },
    }


def fill_price(market: str, symbol: str, side: str) -> Decimal:
    """Market fill: buy/long -> ask, sell/short -> bid."""
    book = book_ticker(market, symbol)
    if side in ("long", "buy"):
        return book["ask"]
    return book["bid"]
