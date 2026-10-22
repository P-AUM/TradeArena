from __future__ import annotations

import math
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from trading.models import Position

from .models import Tournament, TournamentEntry, TournamentWallet

STARTING = Decimal("10000.00")


def sync_tournament_statuses() -> None:
    for t in Tournament.objects.exclude(status=Tournament.Status.CANCELLED):
        prev = t.status
        t.refresh_status(save=True)
        if (
            prev != Tournament.Status.ENDED
            and t.status == Tournament.Status.ENDED
            and t.settled_at is None
        ):
            settle_tournament(t)


def assert_one_live_or_none(exclude_id: int | None = None) -> None:
    """M1: at most one LIVE tournament."""
    qs = Tournament.objects.filter(status=Tournament.Status.LIVE)
    if exclude_id:
        qs = qs.exclude(pk=exclude_id)
    if qs.exists():
        raise ValueError("Only one live tournament is allowed at a time.")


def create_tournament(
    *,
    admin,
    name: str,
    max_participants: int,
    entry_fee: Decimal,
    start_at,
    end_at,
) -> Tournament:
    if admin.role != "admin":
        raise ValueError("Only admins can create tournaments.")
    if max_participants < 2:
        raise ValueError("Need at least 2 participants.")
    if entry_fee < 0:
        raise ValueError("Entry fee cannot be negative.")
    if end_at <= start_at:
        raise ValueError("End must be after start.")
    if start_at <= timezone.now():
        raise ValueError("Start must be in the future.")

    # Look ahead: if another tournament would still be live when this starts
    overlapping_live = Tournament.objects.filter(
        status__in=[Tournament.Status.SCHEDULED, Tournament.Status.LIVE],
        start_at__lt=end_at,
        end_at__gt=start_at,
    ).exclude(status=Tournament.Status.CANCELLED)
    # Allow multiple scheduled if they don't overlap in time
    if overlapping_live.exists():
        raise ValueError(
            "Tournament time overlaps another scheduled/live event "
            "(only one may run at a time)."
        )

    return Tournament.objects.create(
        name=name.strip(),
        max_participants=max_participants,
        entry_fee=entry_fee,
        start_at=start_at,
        end_at=end_at,
        status=Tournament.Status.SCHEDULED,
        created_by=admin,
        starting_capital=STARTING,
    )


def ensure_tournament_wallets(user, tournament: Tournament) -> list[TournamentWallet]:
    out = []
    for market, _ in TournamentWallet.Market.choices:
        w, _ = TournamentWallet.objects.get_or_create(
            tournament=tournament,
            user=user,
            market=market,
            defaults={
                "balance": tournament.starting_capital,
                "starting_balance": tournament.starting_capital,
            },
        )
        out.append(w)
    return out


def join_tournament(user, tournament_id: int) -> TournamentEntry:
    """Pay stub: marks paid and creates tournament wallets. Join only before start."""
    if user.role != "trader":
        raise ValueError("Only traders can join tournaments.")

    with transaction.atomic():
        t = Tournament.objects.select_for_update().get(pk=tournament_id)
        t.refresh_status(save=True)
        if t.status != Tournament.Status.SCHEDULED:
            raise ValueError("Joining is only allowed before the tournament starts.")
        if timezone.now() >= t.start_at:
            raise ValueError("Tournament has already started.")
        if t.entries.count() >= t.max_participants:
            raise ValueError("Tournament is full.")
        if TournamentEntry.objects.filter(tournament=t, user=user).exists():
            raise ValueError("You already joined this tournament.")

        entry = TournamentEntry.objects.create(
            tournament=t,
            user=user,
            paid=True,  # stub — real payment later
            paid_at=timezone.now(),
        )
        ensure_tournament_wallets(user, t)
        return entry


def assert_user_can_trade_tournament(user, tournament: Tournament) -> None:
    tournament.refresh_status(save=True)
    if tournament.status != Tournament.Status.LIVE:
        raise ValueError("Tournament trading is only allowed while live.")
    if not TournamentEntry.objects.filter(
        tournament=tournament, user=user, paid=True
    ).exists():
        raise ValueError("You are not a paid entrant in this tournament.")


def entry_stats(user, tournament: Tournament, *, market: str | None = None) -> dict:
    closed = Position.objects.filter(
        user=user,
        tournament=tournament,
        status=Position.Status.CLOSED,
    )
    if market:
        closed = closed.filter(market=market)
    n = closed.count()
    wins = closed.filter(realized_pnl__gt=0).count()
    pnl = closed.aggregate(s=Sum("realized_pnl"))["s"] or Decimal("0")
    win_rate = (Decimal(wins) / Decimal(n)) if n else Decimal("0")
    return {
        "realized_pnl": pnl.quantize(Decimal("0.01")),
        "win_rate": win_rate.quantize(Decimal("0.0001")),
        "closed_trades": n,
        "winning_trades": wins,
    }


def tournament_market_board(tournament: Tournament, market: str) -> list[dict]:
    """
    Spot or Futures board for one tournament.
    Rank: ROI % (on that market's tournament starting capital) → win rate
    → closed trades → realized PnL.
    """
    capital = tournament.starting_capital or Decimal("10000.00")
    if capital <= 0:
        capital = Decimal("10000.00")

    rows: list[dict] = []
    for e in tournament.entries.filter(paid=True).select_related("user"):
        st = entry_stats(e.user, tournament, market=market)
        if st["closed_trades"] < 1:
            continue
        pnl = st["realized_pnl"]
        win_rate = st["win_rate"]
        # win_rate stored 0–1; expose % for sorting/display consistency with main LB
        win_rate_pct = (win_rate * Decimal("100")).quantize(Decimal("0.01"))
        roi = (pnl / capital * Decimal("100")).quantize(Decimal("0.0001"))
        rows.append(
            {
                "username": e.user.username,
                "market": market,
                "realized_pnl": str(pnl),
                "roi_pct": str(roi),
                "win_rate": str(win_rate),
                "win_rate_pct": str(win_rate_pct),
                "closed_trades": st["closed_trades"],
                "winning_trades": st["winning_trades"],
                "starting_capital": str(capital),
            }
        )

    rows.sort(
        key=lambda r: (
            Decimal(r["roi_pct"]),
            Decimal(r["win_rate_pct"]),
            r["closed_trades"],
            Decimal(r["realized_pnl"]),
            r["username"],
        ),
        reverse=True,
    )
    for i, r in enumerate(rows, start=1):
        r["rank"] = i
    return rows


def tournament_boards(tournament: Tournament) -> dict[str, list[dict]]:
    return {
        "spot": tournament_market_board(tournament, "spot"),
        "futures": tournament_market_board(tournament, "futures"),
    }


def compute_prize_amounts(n_entrants: int, pool: Decimal) -> dict[int, Decimal]:
    """
    Rank -> prize.
    1st 35%, 2nd 30%, 3rd 25%, ranks 4..ceil(10% of N) share 10% equally.
    Top 3 do not take from the 10% pool.
    """
    if n_entrants < 1 or pool <= 0:
        return {}
    prizes: dict[int, Decimal] = {}
    if n_entrants >= 1:
        prizes[1] = (pool * Decimal("0.35")).quantize(Decimal("0.01"))
    if n_entrants >= 2:
        prizes[2] = (pool * Decimal("0.30")).quantize(Decimal("0.01"))
    if n_entrants >= 3:
        prizes[3] = (pool * Decimal("0.25")).quantize(Decimal("0.01"))

    top10 = max(1, math.ceil(n_entrants * 0.10))
    # bonus seats: ranks 4 .. top10 (inclusive), only if top10 > 3
    bonus_ranks = [r for r in range(4, top10 + 1) if r <= n_entrants]
    if bonus_ranks:
        slice_amt = (pool * Decimal("0.10")).quantize(Decimal("0.01"))
        each = (slice_amt / Decimal(len(bonus_ranks))).quantize(Decimal("0.01"))
        for r in bonus_ranks:
            prizes[r] = each
    return prizes


def _force_close_open_tournament_positions(tournament: Tournament) -> None:
    """Mark-to-market any still-open tournament positions before ranking."""
    from trading.prices import get_mark_price
    from trading.services import close_position_at

    open_pos = list(
        Position.objects.select_for_update()
        .filter(tournament=tournament, status=Position.Status.OPEN)
        .order_by("id")
    )
    for pos in open_pos:
        try:
            px = get_mark_price(pos.market, pos.symbol)
        except Exception:
            px = pos.entry_price
        close_position_at(pos, px, reason="tournament-end", notify=False)


def settle_tournament(tournament: Tournament) -> Tournament:
    with transaction.atomic():
        t = Tournament.objects.select_for_update().get(pk=tournament.pk)
        if t.settled_at is not None:
            return t
        t.refresh_status(save=False)
        if t.status != Tournament.Status.ENDED:
            t.status = Tournament.Status.ENDED

        _force_close_open_tournament_positions(t)

        # Cancel resting tournament orders and refund reserved margin
        from trading.models import PaperOrder
        from trading.services import cancel_order

        for order in PaperOrder.objects.filter(
            tournament=t, status=PaperOrder.Status.OPEN
        ):
            try:
                cancel_order(order.user, order.pk)
            except Exception:
                pass

        entries = list(
            TournamentEntry.objects.select_for_update()
            .filter(tournament=t, paid=True)
            .select_related("user")
        )
        scored = []
        for e in entries:
            st = entry_stats(e.user, t)
            e.realized_pnl = st["realized_pnl"]
            e.win_rate = st["win_rate"]
            e.closed_trades = st["closed_trades"]
            e.winning_trades = st["winning_trades"]
            scored.append(e)

        scored.sort(
            key=lambda e: (
                e.realized_pnl if e.realized_pnl is not None else Decimal("-999999"),
                e.win_rate if e.win_rate is not None else Decimal("0"),
            ),
            reverse=True,
        )

        n = len(scored)
        gross = (t.entry_fee * n).quantize(Decimal("0.01"))
        pool = (gross * (t.prize_pool_pct / Decimal("100"))).quantize(
            Decimal("0.01")
        )
        prize_map = compute_prize_amounts(n, pool)

        for i, e in enumerate(scored, start=1):
            e.rank = i
            e.prize_amount = prize_map.get(i, Decimal("0.00"))
            e.save(
                update_fields=[
                    "realized_pnl",
                    "win_rate",
                    "closed_trades",
                    "winning_trades",
                    "rank",
                    "prize_amount",
                ]
            )

        t.settled_at = timezone.now()
        t.status = Tournament.Status.ENDED
        t.save(update_fields=["settled_at", "status", "updated_at"])
        return t


def live_tournament_for_user(user) -> Tournament | None:
    sync_tournament_statuses()
    entry = (
        TournamentEntry.objects.filter(
            user=user,
            paid=True,
            tournament__status=Tournament.Status.LIVE,
        )
        .select_related("tournament")
        .first()
    )
    return entry.tournament if entry else None


def is_participant_in_live(user_id: int) -> bool:
    return TournamentEntry.objects.filter(
        user_id=user_id,
        paid=True,
        tournament__status=Tournament.Status.LIVE,
    ).exists()


def privacy_blocks_trader_view(*, viewer, target_trader) -> str | None:
    """
    While a tournament is live:
    - Participants cannot view other participants' profiles/history.
    Returns error message or None.
    """
    sync_tournament_statuses()
    live = Tournament.objects.filter(status=Tournament.Status.LIVE).first()
    if not live:
        return None
    target_in = TournamentEntry.objects.filter(
        tournament=live, user=target_trader, paid=True
    ).exists()
    if not target_in:
        return None
    viewer_in = TournamentEntry.objects.filter(
        tournament=live, user=viewer, paid=True
    ).exists()
    # Admin can always view
    if getattr(viewer, "role", None) == "admin":
        return None
    # Anyone who is not the target: hide other participants during live
    if viewer.id != target_trader.id and target_in:
        if viewer_in:
            return (
                "Tournament privacy: you cannot view other participants "
                "while the tournament is live."
            )
        return (
            "Tournament privacy: this trader's activity is hidden "
            "until the tournament ends."
        )
    return None
