"""Price helpers: Binance for spot/futures, mock for forex."""

from decimal import Decimal
from hashlib import sha256
import time

from . import binance as bn

FOREX_BASE: dict[str, Decimal] = {
    "EURUSD": Decimal("1.0850"),
    "GBPUSD": Decimal("1.2720"),
    "USDJPY": Decimal("149.80"),
    "AUDUSD": Decimal("0.6580"),
}


def execution_book(market: str, symbol: str) -> dict[str, Decimal]:
    """Fresh bid/ask for fills and risk. Never a stale REST cache."""
    symbol = symbol.upper().replace("-", "").replace("/", "")
    from .market_stream import get_hub

    hub = get_hub()
    quote = hub.fresh_quote(market, symbol)
    if quote is None:
        hub.ensure(market, symbol)
        quote = hub.fresh_quote(market, symbol)
    if quote is not None:
        return quote
    return bn.book_ticker(market, symbol)


def get_fill_price(market: str, symbol: str, side: str) -> Decimal:
    symbol = symbol.upper().replace("-", "").replace("/", "")
    if market in ("spot", "futures"):
        book = execution_book(market, symbol)
        if side in ("long", "buy"):
            return book["ask"]
        return book["bid"]
    # forex mock
    base = FOREX_BASE.get(symbol)
    if base is None:
        raise KeyError(f"Unknown forex symbol {symbol}")
    tick = int(time.time() // 60)
    h = sha256(f"forex:{symbol}:{tick}".encode()).hexdigest()
    jitter = (int(h[:6], 16) % 200 - 100) / Decimal("10000")
    px = base * (Decimal("1") + jitter)
    # slight bid/ask spread
    if side in ("long", "buy"):
        return (px * Decimal("1.00005")).quantize(Decimal("0.00000001"))
    return (px * Decimal("0.99995")).quantize(Decimal("0.00000001"))


def get_mark_price(market: str, symbol: str) -> Decimal:
    symbol = symbol.upper().replace("-", "").replace("/", "")
    if market in ("spot", "futures"):
        return execution_book(market, symbol)["mid"]
    return get_fill_price(market, symbol, "long")


def get_all_quotes(market: str | None = None) -> list[dict]:
    # Kept for dashboard compatibility — top pairs only
    out = []
    if market in (None, "spot"):
        for sym in ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"):
            try:
                book = bn.book_ticker("spot", sym)
                out.append(
                    {
                        "market": "spot",
                        "symbol": sym,
                        "price": str(book["mid"]),
                        "bid": str(book["bid"]),
                        "ask": str(book["ask"]),
                    }
                )
            except Exception:
                pass
    if market in (None, "futures"):
        for sym in ("BTCUSDT", "ETHUSDT", "SOLUSDT"):
            try:
                book = bn.book_ticker("futures", sym)
                out.append(
                    {
                        "market": "futures",
                        "symbol": sym,
                        "price": str(book["mid"]),
                        "bid": str(book["bid"]),
                        "ask": str(book["ask"]),
                    }
                )
            except Exception:
                pass
    if market in (None, "forex"):
        for sym, _ in FOREX_BASE.items():
            px = get_mark_price("forex", sym)
            out.append({"market": "forex", "symbol": sym, "price": str(px)})
    return out
