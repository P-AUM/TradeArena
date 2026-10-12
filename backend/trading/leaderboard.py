"""Compute trader rankings by realized PnL, ROI, and win rate."""

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
Metric = Literal["pnl", "roi", "win_rate"]

VALID_PERIODS = ("daily", "weekly", "all_time")
VALID_METRICS = ("pnl", "roi", "win_rate")


def period_start(period: str) -> datetime | None:
    now = timezone.now()
    if period == "daily":
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "weekly":
        # Monday 00:00 UTC (ISO week)
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return start - timedelta(days=start.weekday())
    return None


def _closed_filter(start: datetime | None) -> Q:
    q = Q(positions__status=Position.Status.CLOSED)
    if start is not None:
        q &= Q(positions__closed_at__gte=start)
    return q


def build_leaderboard(
    *,
    period: str = "all_time",
    metric: str = "pnl",
    limit: int = 100,
) -> dict:
    if period not in VALID_PERIODS:
        period = "all_time"
    if metric not in VALID_METRICS:
        metric = "pnl"

    start = period_start(period)
    closed = _closed_filter(start)

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
            open_positions=Count(
                "positions",
                filter=Q(positions__status=Position.Status.OPEN),
            ),
        )
        .prefetch_related("wallets")
    )

    rows: list[dict] = []
    for u in traders:
        capital = sum(
            (w.starting_balance for w in u.wallets.all()),
            Decimal("0"),
        )
        if capital <= 0:
            # Spot + futures + forex defaults
            capital = STARTING_BALANCE * Decimal("3")

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

    def sort_key(row: dict):
        if metric == "roi":
            primary = Decimal(row["roi_pct"])
        elif metric == "win_rate":
            # Prefer higher win rate; break ties with more decided trades
            primary = Decimal(row["win_rate_pct"])
            return (
                primary,
                row["wins"] + row["losses"],
                Decimal(row["realized_pnl"]),
                row["username"],
            )
        else:
            primary = Decimal(row["realized_pnl"])
        return (primary, Decimal(row["roi_pct"]), row["closed_trades"], row["username"])

    rows.sort(key=sort_key, reverse=True)

    ranked = []
    for i, row in enumerate(rows[:limit], start=1):
        ranked.append({"rank": i, **row})

    return {
        "period": period,
        "metric": metric,
        "period_start": start.isoformat() if start else None,
        "count": len(ranked),
        "results": ranked,
    }
