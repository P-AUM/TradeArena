"""Local order book sync, following Binance's snapshot-plus-diff rules.

Spot: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams
Futures: https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams

Diff events carry absolute quantities. A quantity of 0 deletes the level.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any


def _set_levels(side: dict[str, str], updates: Any) -> None:
    if not isinstance(updates, list):
        return
    for row in updates:
        if not isinstance(row, (list, tuple)) or len(row) < 2:
            continue
        price, qty = str(row[0]), str(row[1])
        try:
            zero = Decimal(qty) == 0
        except Exception:
            continue
        if zero:
            side.pop(price, None)
        else:
            side[price] = qty


class OrderBookSync:
    def __init__(self, market: str):
        if market not in ("spot", "futures"):
            raise ValueError("market must be spot or futures")
        self.market = market
        self.bids: dict[str, str] = {}
        self.asks: dict[str, str] = {}
        self.last_update_id: int | None = None
        self.prev_u: int | None = None
        self.synced = False
        self.buffer: list[dict] = []
        self.buffer_limit = 5000

    def reset(self) -> None:
        self.bids = {}
        self.asks = {}
        self.last_update_id = None
        self.prev_u = None
        self.synced = False
        self.buffer = []

    def buffer_event(self, event: dict) -> None:
        if len(self.buffer) >= self.buffer_limit:
            # Dropping the backlog means the next snapshot must bridge whatever
            # remains. Keeping a partial backlog would hide a gap.
            self.buffer.clear()
        self.buffer.append(event)

    def apply_snapshot(self, last_update_id: int, bids: Any, asks: Any) -> str:
        self.bids = {}
        self.asks = {}
        _set_levels(self.bids, bids)
        _set_levels(self.asks, asks)
        self.last_update_id = int(last_update_id)
        self.prev_u = None
        buffered = self.buffer
        self.buffer = []
        pending: list[dict] = []
        saw_gap = False
        for event in buffered:
            if saw_gap:
                pending.append(event)
                continue
            status = self.consider(event)
            if status == "gap":
                saw_gap = True
                pending.append(event)
        self.buffer = pending
        self.synced = not saw_gap
        return "gap" if saw_gap else "synced"

    def consider(self, event: dict) -> str:
        """Apply one diff, or report that it was old or that the sequence broke."""
        if self.last_update_id is None:
            return "gap"
        first = int(event["U"])
        final = int(event["u"])
        if self.market == "futures":
            if final < self.last_update_id:
                return "ignored"
            if self.prev_u is None:
                if first <= self.last_update_id <= final:
                    self._mutate(event)
                    self.prev_u = final
                    return "applied"
                return "gap"
            previous = event.get("pu")
            if previous is None or int(previous) != self.prev_u:
                return "gap"
        else:
            if final <= self.last_update_id:
                return "ignored"
            if self.prev_u is None:
                if first <= self.last_update_id + 1 <= final:
                    self._mutate(event)
                    self.prev_u = final
                    return "applied"
                return "gap"
            if first != self.prev_u + 1:
                return "gap"
        self._mutate(event)
        self.prev_u = final
        return "applied"

    def _mutate(self, event: dict) -> None:
        _set_levels(self.bids, event.get("b") or [])
        _set_levels(self.asks, event.get("a") or [])

    def top(self, limit: int = 20) -> dict:
        def levels(side: dict[str, str], *, reverse: bool) -> list[dict[str, str]]:
            usable: list[tuple[Decimal, str, str]] = []
            for price, qty in side.items():
                try:
                    usable.append((Decimal(price), price, qty))
                except Exception:
                    continue
            usable.sort(key=lambda row: row[0], reverse=reverse)
            return [
                {"price": price, "qty": qty}
                for _dec, price, qty in usable[:limit]
            ]

        return {
            "bids": levels(self.bids, reverse=True),
            "asks": levels(self.asks, reverse=False),
            "lastUpdateId": self.last_update_id,
        }
