"""Compute Spot / Futures leaderboards ranked by ROI, then win rate."""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Literal

from django.db.models import Count, Q, Sum
from django.db.models.functions import Coalesce
from django.utils import timezone

from accounts.models import User
from .models import Position
from .services import STARTING_BALANCE

Period = Literal["daily", "weekly", "all_time"]
MarketBoard = Literal["spot", "futures"]

VALID_PERIODS = ("daily", "weekly", "all_time")
VALID_MARKETS = ("spot", "futures")


def period_start(period: str) -> datetime | None:
    now = timezone.now()
    if period == "daily":
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "weekly":
        # Monday 00:00 UTC (ISO week)
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return start - timedelta(days=start.weekday())
    return None


def _closed_filter(start: datetime | None, market: str) -> Q:
    # Paper book only; market-scoped (spot vs futures)
    q = (
        Q(positions__status=Position.Status.CLOSED)
        & Q(positions__tournament__isnull=True)
        & Q(positions__market=market)
    )
    if start is not None:
        q &= Q(positions__closed_at__gte=start)
    return q


def _open_filter(market: str) -> Q:
    return (
        Q(positions__status=Position.Status.OPEN)
        & Q(positions__tournament__isnull=True)
        & Q(positions__market=market)
    )


def _board_for_market(
    *,
    market: str,
    period: str,
    limit: int,
) -> list[dict]:
    start = period_start(period)
    closed = _closed_filter(start, market)
    open_f = _open_filter(market)

    traders = (
        User.objects.filter(role=User.Role.TRADER)
        .annotate(
            realized_pnl=Coalesce(
                Sum("positions__realized_pnl", filter=closed),
                Decimal("0"),
            ),
            closed_trades=Count("positions", filter=closed),
            wins=Count(
                "positions",
                filter=closed & Q(positions__realized_pnl__gt=0),
            ),
            losses=Count(
                "positions",
                filter=closed & Q(positions__realized_pnl__lt=0),
            ),
            open_positions=Count("positions", filter=open_f),
        )
        .prefetch_related("wallets")
    )

    rows: list[dict] = []
    for u in traders:
        if (u.closed_trades or 0) < 1:
            continue

        wallet = next(
            (w for w in u.wallets.all() if w.market == market),
            None,
        )
        capital = (
            wallet.starting_balance
            if wallet is not None and wallet.starting_balance > 0
            else STARTING_BALANCE
        )

        pnl = u.realized_pnl or Decimal("0")
        decided = (u.wins or 0) + (u.losses or 0)
        if decided > 0:
            win_rate = round(Decimal(u.wins) / Decimal(decided) * Decimal("100"), 2)
        else:
            win_rate = Decimal("0")

        roi = (
            (pnl / capital * Decimal("100")).quantize(Decimal("0.0001"))
            if capital > 0
            else Decimal("0")
        )

        rows.append(
            {
                "id": u.id,
                "username": u.username,
                "market": str(market),
                "realized_pnl": str(pnl),
                "roi_pct": str(roi),
                "win_rate_pct": str(win_rate),
                "wins": u.wins or 0,
                "losses": u.losses or 0,
                "closed_trades": u.closed_trades or 0,
                "open_positions": u.open_positions or 0,
                "starting_capital": str(capital),
            }
        )

    # Rank: ROI → win rate → closed trades → PnL
    def sort_key(row: dict):
        return (
            Decimal(row["roi_pct"]),
            Decimal(row["win_rate_pct"]),
            row["closed_trades"],
            Decimal(row["realized_pnl"]),
            row["username"],
        )

    rows.sort(key=sort_key, reverse=True)

    ranked = []
    for i, row in enumerate(rows[:limit], start=1):
        ranked.append({"rank": i, **row})
    return ranked


def build_leaderboard(
    *,
    period: str = "all_time",
    metric: str = "roi",  # kept for API compat; ranking is always ROI-first
    limit: int = 100,
    market: str | None = None,
) -> dict:
    if period not in VALID_PERIODS:
        period = "all_time"
    start = period_start(period)
    limit = max(1, min(limit, 200))

    # Single market board (legacy / optional)
    if market in VALID_MARKETS:
        results = _board_for_market(market=market, period=period, limit=limit)
        return {
            "period": period,
            "metric": "roi",
            "market": market,
            "period_start": start.isoformat() if start else None,
            "count": len(results),
            "results": results,
            "boards": {
                market: results,
            },
        }

    spot = _board_for_market(market="spot", period=period, limit=limit)
    futures = _board_for_market(market="futures", period=period, limit=limit)
    return {
        "period": period,
        "metric": "roi",
        "market": None,
        "period_start": start.isoformat() if start else None,
        "count": len(spot) + len(futures),
        "results": spot,  # legacy field: spot board
        "boards": {
            "spot": spot,
            "futures": futures,
        },
    }
