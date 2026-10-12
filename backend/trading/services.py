from decimal import Decimal

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from . import binance as bn
from .models import PaperOrder, Position, Wallet
from .prices import get_fill_price, get_mark_price

User = get_user_model()

STARTING_BALANCE = Decimal(
    str(getattr(settings, "PAPER_STARTING_BALANCE", "10000.00"))
)

# Max leverage by market (spot is cash = 1x only)
MAX_LEVERAGE = {
    "spot": 1,
    "futures": 40,
    "forex": 50,
}


def clamp_leverage(market: str, leverage: int) -> int:
    max_lev = MAX_LEVERAGE.get(market, 1)
    lev = int(leverage or 1)
    if lev < 1:
        lev = 1
    if lev > max_lev:
        lev = max_lev
    return lev


def calc_margin(notional: Decimal, leverage: int) -> Decimal:
    lev = Decimal(leverage)
    return (notional / lev).quantize(Decimal("0.01"))


def liquidation_price(
    side: str, entry: Decimal, leverage: int
) -> Decimal | None:
    """
    Approx liq when unrealized loss == margin.
    Long:  entry * (1 - 1/lev)
    Short: entry * (1 + 1/lev)
    Spot / 1x: no forced liq price (full notional is margin).
    """
    lev = int(leverage or 1)
    if lev <= 1:
        return None
    frac = Decimal("1") / Decimal(lev)
    if side == Position.Side.LONG:
        px = entry * (Decimal("1") - frac)
    else:
        px = entry * (Decimal("1") + frac)
    if px <= 0:
        return Decimal("0")
    return px.quantize(Decimal("0.00000001"))


def ensure_wallets(user: User) -> list[Wallet]:
    for market, _ in Wallet.Market.choices:
        Wallet.objects.get_or_create(
            user=user,
            market=market,
            defaults={
                "balance": STARTING_BALANCE,
                "starting_balance": STARTING_BALANCE,
            },
        )
    legacy = Wallet.objects.filter(user=user, market="crypto").first()
    if legacy:
        spot, _ = Wallet.objects.get_or_create(
            user=user,
            market=Wallet.Market.SPOT,
            defaults={
                "balance": legacy.balance,
                "starting_balance": legacy.starting_balance,
            },
        )
        if spot.balance == STARTING_BALANCE and legacy.balance != STARTING_BALANCE:
            spot.balance = legacy.balance
            spot.save(update_fields=["balance", "updated_at"])
        legacy.delete()
    return list(Wallet.objects.filter(user=user).order_by("market"))


def validate_sl_tp(
    side: str,
    entry: Decimal | None,
    stop_loss: Decimal | None,
    take_profit: Decimal | None,
) -> None:
    """Raise ValueError if SL/TP are on the wrong side of entry (when known)."""
    if stop_loss is not None and stop_loss <= 0:
        raise ValueError("Stop-loss must be positive.")
    if take_profit is not None and take_profit <= 0:
        raise ValueError("Take-profit must be positive.")
    if entry is None or entry <= 0:
        return
    if side == Position.Side.LONG:
        if stop_loss is not None and stop_loss >= entry:
            raise ValueError("Long stop-loss must be below entry.")
        if take_profit is not None and take_profit <= entry:
            raise ValueError("Long take-profit must be above entry.")
    else:
        if stop_loss is not None and stop_loss <= entry:
            raise ValueError("Short stop-loss must be above entry.")
        if take_profit is not None and take_profit >= entry:
            raise ValueError("Short take-profit must be below entry.")


def _open_position(
    user,
    market: str,
    symbol: str,
    side: str,
    notional: Decimal,
    price: Decimal,
    leverage: int,
    margin: Decimal,
    stop_loss: Decimal | None = None,
    take_profit: Decimal | None = None,
) -> Position:
    validate_sl_tp(side, price, stop_loss, take_profit)
    quantity = (notional / price).quantize(Decimal("0.00000001"))
    return Position.objects.create(
        user=user,
        market=market,
        symbol=symbol,
        side=side,
        quantity=quantity,
        entry_price=price,
        notional=notional,
        leverage=leverage,
        margin=margin,
        stop_loss=stop_loss,
        take_profit=take_profit,
        status=Position.Status.OPEN,
    )


def fill_order_now(order: PaperOrder, price: Decimal) -> PaperOrder:
    """Consume reserved margin already deducted; open position at price."""
    position = _open_position(
        order.user,
        order.market,
        order.symbol,
        order.side,
        order.notional,
        price,
        order.leverage,
        order.margin,
        stop_loss=order.stop_loss,
        take_profit=order.take_profit,
    )
    order.status = PaperOrder.Status.FILLED
    order.position = position
    order.filled_at = timezone.now()
    order.save(update_fields=["status", "position", "filled_at"])
    _notify_open(order.user, position)
    return order


def _notify_open(user, position: Position) -> None:
    from accounts.notifications import notify_followers_of_trade
    from accounts.models import Notification

    notify_followers_of_trade(
        user,
        kind=Notification.Kind.TRADE_OPEN,
        title=f"@{user.username} opened {position.side}",
        body=(
            f"{position.side.upper()} {position.symbol} - "
            f"${position.notional} @ {position.entry_price} ({position.leverage}x)"
        ),
    )


def _notify_close(
    user,
    position: Position,
    *,
    reason: str = "closed",
) -> None:
    from accounts.notifications import notify_followers_of_trade, notify_user
    from accounts.models import Notification

    pnl = position.realized_pnl or Decimal("0")
    sign = "+" if pnl >= 0 else ""
    body = (
        f"{position.side.upper()} {position.symbol} - "
        f"PnL {sign}{pnl} - exit {position.exit_price} ({reason})"
    )
    kind = Notification.Kind.TRADE_CLOSE
    if reason == "stop-loss":
        kind = Notification.Kind.STOP_HIT
    elif reason == "take-profit":
        kind = Notification.Kind.TAKE_PROFIT_HIT

    notify_followers_of_trade(
        user,
        kind=kind,
        title=f"@{user.username} {reason}",
        body=body,
    )
    # Also notify the trader themselves for SL/TP hits
    if reason in ("stop-loss", "take-profit"):
        notify_user(
            user,
            kind=kind,
            title=f"Your {reason} hit",
            body=body,
            actor=user,
            href=f"/traders/{user.username}",
        )


def close_position_at(
    position: Position,
    exit_price: Decimal,
    *,
    reason: str = "closed",
    notify: bool = True,
) -> Position:
    """Return margin + PnL to wallet and mark closed. Caller holds locks."""
    wallet = Wallet.objects.select_for_update().get(
        user_id=position.user_id, market=position.market
    )
    diff = exit_price - position.entry_price
    if position.side == Position.Side.SHORT:
        diff = -diff
    realized = (diff * position.quantity).quantize(Decimal("0.01"))
    margin = position.margin if position.margin > 0 else position.notional
    proceeds = (margin + realized).quantize(Decimal("0.01"))
    if proceeds < 0:
        proceeds = Decimal("0.00")

    wallet.balance = (wallet.balance + proceeds).quantize(Decimal("0.01"))
    wallet.save(update_fields=["balance", "updated_at"])

    position.status = Position.Status.CLOSED
    position.exit_price = exit_price
    position.realized_pnl = realized
    position.closed_at = timezone.now()
    position.save(
        update_fields=["status", "exit_price", "realized_pnl", "closed_at"]
    )
    if notify:
        try:
            _notify_close(position.user, position, reason=reason)
        except Exception:
            pass
    return position


def add_to_position(user, position_id: int, extra_notional: Decimal) -> Position:
    """Increase size at live bid/ask; weighted-average entry. Same leverage."""
    if extra_notional < Decimal("1"):
        raise ValueError("Add size must be at least $1.")

    with transaction.atomic():
        position = Position.objects.select_for_update().get(
            pk=position_id, user=user
        )
        if position.status != Position.Status.OPEN:
            raise ValueError("Position is not open.")

        lev = int(position.leverage or 1)
        extra_margin = calc_margin(extra_notional, lev)
        wallet = Wallet.objects.select_for_update().get(
            user=user, market=position.market
        )
        if wallet.balance < extra_margin:
            raise ValueError(
                f"Insufficient balance for margin {extra_margin} "
                f"(available {wallet.balance})."
            )

        fill = get_fill_price(position.market, position.symbol, position.side)
        add_qty = (extra_notional / fill).quantize(Decimal("0.00000001"))
        if add_qty <= 0:
            raise ValueError("Invalid add size at current price.")

        old_qty = position.quantity
        new_qty = old_qty + add_qty
        # Weighted average entry
        new_entry = (
            (position.entry_price * old_qty) + (fill * add_qty)
        ) / new_qty
        new_entry = new_entry.quantize(Decimal("0.00000001"))

        wallet.balance = (wallet.balance - extra_margin).quantize(Decimal("0.01"))
        wallet.save(update_fields=["balance", "updated_at"])

        position.quantity = new_qty
        position.entry_price = new_entry
        position.notional = (position.notional + extra_notional).quantize(
            Decimal("0.01")
        )
        position.margin = (position.margin + extra_margin).quantize(Decimal("0.01"))
        position.save(
            update_fields=[
                "quantity",
                "entry_price",
                "notional",
                "margin",
            ]
        )
        return position


def trim_position(user, position_id: int, reduce_notional: Decimal) -> Position:
    """Reduce size at live exit price; return proportional margin + PnL."""
    if reduce_notional < Decimal("1"):
        raise ValueError("Trim size must be at least $1.")

    with transaction.atomic():
        position = Position.objects.select_for_update().get(
            pk=position_id, user=user
        )
        if position.status != Position.Status.OPEN:
            raise ValueError("Position is not open.")

        if reduce_notional >= position.notional:
            close_side = (
                "short" if position.side == Position.Side.LONG else "long"
            )
            exit_px = get_fill_price(
                position.market, position.symbol, close_side
            )
            return close_position_at(position, exit_px)

        remaining = (position.notional - reduce_notional).quantize(Decimal("0.01"))
        if remaining < Decimal("1"):
            # Dust left — full close
            close_side = (
                "short" if position.side == Position.Side.LONG else "long"
            )
            exit_px = get_fill_price(
                position.market, position.symbol, close_side
            )
            return close_position_at(position, exit_px)

        frac = reduce_notional / position.notional
        qty_close = (position.quantity * frac).quantize(Decimal("0.00000001"))
        margin_release = (position.margin * frac).quantize(Decimal("0.01"))

        close_side = "short" if position.side == Position.Side.LONG else "long"
        exit_px = get_fill_price(position.market, position.symbol, close_side)
        diff = exit_px - position.entry_price
        if position.side == Position.Side.SHORT:
            diff = -diff
        realized = (diff * qty_close).quantize(Decimal("0.01"))
        proceeds = (margin_release + realized).quantize(Decimal("0.01"))
        if proceeds < 0:
            proceeds = Decimal("0.00")

        wallet = Wallet.objects.select_for_update().get(
            user=user, market=position.market
        )
        wallet.balance = (wallet.balance + proceeds).quantize(Decimal("0.01"))
        wallet.save(update_fields=["balance", "updated_at"])

        position.quantity = (position.quantity - qty_close).quantize(
            Decimal("0.00000001")
        )
        position.notional = remaining
        position.margin = (position.margin - margin_release).quantize(
            Decimal("0.01")
        )
        if position.margin < 0:
            position.margin = Decimal("0.00")
        position.save(update_fields=["quantity", "notional", "margin"])
        return position


def try_stop_take_profit(user) -> int:
    """Close open positions when mark hits stop-loss or take-profit."""
    closed = 0
    for pos in Position.objects.filter(
        user=user, status=Position.Status.OPEN
    ).exclude(stop_loss__isnull=True, take_profit__isnull=True):
        if pos.stop_loss is None and pos.take_profit is None:
            continue
        try:
            mark = get_mark_price(pos.market, pos.symbol)
        except Exception:
            continue

        reason = None
        exit_px = mark
        if pos.side == Position.Side.LONG:
            if pos.stop_loss is not None and mark <= pos.stop_loss:
                reason = "stop-loss"
                exit_px = pos.stop_loss
            elif pos.take_profit is not None and mark >= pos.take_profit:
                reason = "take-profit"
                exit_px = pos.take_profit
        else:
            if pos.stop_loss is not None and mark >= pos.stop_loss:
                reason = "stop-loss"
                exit_px = pos.stop_loss
            elif pos.take_profit is not None and mark <= pos.take_profit:
                reason = "take-profit"
                exit_px = pos.take_profit

        if not reason:
            continue

        with transaction.atomic():
            locked = (
                Position.objects.select_for_update()
                .filter(pk=pos.pk, status=Position.Status.OPEN)
                .first()
            )
            if not locked:
                continue
            close_side = (
                "short" if locked.side == Position.Side.LONG else "long"
            )
            try:
                # Prefer live exit; fall back to trigger price
                live = get_fill_price(locked.market, locked.symbol, close_side)
                # For SL/TP paper fill, use the more conservative of trigger vs live
                if reason == "stop-loss":
                    if locked.side == Position.Side.LONG:
                        exit_px = min(live, exit_px)
                    else:
                        exit_px = max(live, exit_px)
                else:
                    if locked.side == Position.Side.LONG:
                        exit_px = max(live, exit_px)
                    else:
                        exit_px = min(live, exit_px)
            except Exception:
                pass
            close_position_at(locked, exit_px, reason=reason)
            closed += 1
    return closed


def try_liquidate_positions(user) -> int:
    """Force-close when unrealized loss >= margin (paper liquidation)."""
    closed = 0
    for pos in Position.objects.filter(user=user, status=Position.Status.OPEN):
        try:
            mark = get_mark_price(pos.market, pos.symbol)
        except Exception:
            continue
        diff = mark - pos.entry_price
        if pos.side == Position.Side.SHORT:
            diff = -diff
        upnl = (diff * pos.quantity).quantize(Decimal("0.01"))
        margin = pos.margin if pos.margin > 0 else pos.notional
        if upnl <= -margin:
            with transaction.atomic():
                locked = (
                    Position.objects.select_for_update()
                    .filter(pk=pos.pk, status=Position.Status.OPEN)
                    .first()
                )
                if not locked:
                    continue
                close_side = (
                    "short" if locked.side == Position.Side.LONG else "long"
                )
                try:
                    exit_px = get_fill_price(
                        locked.market, locked.symbol, close_side
                    )
                except Exception:
                    exit_px = mark
                close_position_at(locked, exit_px, reason="liquidation")
                closed += 1
    return closed


def try_fill_open_orders(user) -> int:
    """Fill resting limit (maker) orders when mark crosses limit."""
    filled = 0
    orders = list(
        PaperOrder.objects.filter(user=user, status=PaperOrder.Status.OPEN).order_by(
            "created_at"
        )
    )
    for order in orders:
        try:
            mark = get_mark_price(order.market, order.symbol)
        except Exception:
            continue
        if order.limit_price is None:
            continue
        hit = False
        fill_px = order.limit_price
        if order.side == Position.Side.LONG and mark <= order.limit_price:
            hit = True
        elif order.side == Position.Side.SHORT and mark >= order.limit_price:
            hit = True
        if hit:
            with transaction.atomic():
                locked = (
                    PaperOrder.objects.select_for_update()
                    .filter(pk=order.pk, status=PaperOrder.Status.OPEN)
                    .first()
                )
                if not locked:
                    continue
                fill_order_now(locked, fill_px)
                filled += 1
    try_stop_take_profit(user)
    try_liquidate_positions(user)
    return filled


def place_order(
    user,
    *,
    market: str,
    symbol: str,
    side: str,
    order_type: str,
    notional: Decimal,
    leverage: int = 1,
    limit_price: Decimal | None = None,
    stop_loss: Decimal | None = None,
    take_profit: Decimal | None = None,
) -> PaperOrder:
    lev = clamp_leverage(market, leverage)
    margin = calc_margin(notional, lev)
    # Soft validate vs limit or leave entry check to fill
    ref = limit_price
    if ref is not None:
        validate_sl_tp(side, ref, stop_loss, take_profit)

    with transaction.atomic():
        wallet = Wallet.objects.select_for_update().get(user=user, market=market)
        if wallet.balance < margin:
            raise ValueError(
                f"Insufficient {market} balance for margin {margin} "
                f"(available {wallet.balance}, size {notional} @ {lev}x)."
            )

        # Reserve margin only (not full notional)
        wallet.balance = (wallet.balance - margin).quantize(Decimal("0.01"))
        wallet.save(update_fields=["balance", "updated_at"])

        order = PaperOrder.objects.create(
            user=user,
            market=market,
            symbol=symbol,
            side=side,
            order_type=order_type,
            notional=notional,
            leverage=lev,
            margin=margin,
            limit_price=limit_price,
            stop_loss=stop_loss,
            take_profit=take_profit,
            status=PaperOrder.Status.OPEN,
        )

        if order_type == PaperOrder.OrderType.MARKET:
            price = get_fill_price(market, symbol, side)
            return fill_order_now(order, price)

        assert limit_price is not None
        if market in ("spot", "futures"):
            book = bn.book_ticker(market, symbol)
            ask, bid = book["ask"], book["bid"]
        else:
            mid = get_mark_price(market, symbol)
            ask = mid * Decimal("1.00005")
            bid = mid * Decimal("0.99995")

        marketable = (
            side == Position.Side.LONG and limit_price >= ask
        ) or (side == Position.Side.SHORT and limit_price <= bid)

        if marketable:
            price = ask if side == Position.Side.LONG else bid
            return fill_order_now(order, price)

        return order


def cancel_order(user, order_id: int) -> PaperOrder:
    with transaction.atomic():
        order = PaperOrder.objects.select_for_update().get(pk=order_id, user=user)
        if order.status != PaperOrder.Status.OPEN:
            raise ValueError("Order is not open.")
        wallet = Wallet.objects.select_for_update().get(
            user=user, market=order.market
        )
        refund = order.margin if order.margin > 0 else order.notional
        wallet.balance = (wallet.balance + refund).quantize(Decimal("0.01"))
        wallet.save(update_fields=["balance", "updated_at"])
        order.status = PaperOrder.Status.CANCELLED
        order.save(update_fields=["status"])
        return order
