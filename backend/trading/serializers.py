from decimal import Decimal

from django.db import transaction
from rest_framework import serializers

from . import binance as bn
from .models import PaperOrder, Position, Wallet
from .prices import FOREX_BASE, get_fill_price
from .services import (
    add_to_position,
    clamp_leverage,
    close_position_at,
    place_order,
    trim_position,
    validate_sl_tp,
)


class WalletSerializer(serializers.ModelSerializer):
    class Meta:
        model = Wallet
        fields = ("id", "market", "balance", "starting_balance", "updated_at")
        read_only_fields = fields


class PositionSerializer(serializers.ModelSerializer):
    mark_price = serializers.SerializerMethodField()
    unrealized_pnl = serializers.SerializerMethodField()
    liquidation_price = serializers.SerializerMethodField()

    class Meta:
        model = Position
        fields = (
            "id",
            "market",
            "symbol",
            "side",
            "quantity",
            "entry_price",
            "notional",
            "leverage",
            "margin",
            "status",
            "exit_price",
            "realized_pnl",
            "stop_loss",
            "take_profit",
            "opened_at",
            "closed_at",
            "tournament",
            "mark_price",
            "unrealized_pnl",
            "liquidation_price",
        )
        read_only_fields = fields

    def get_mark_price(self, obj: Position):
        if obj.status != Position.Status.OPEN:
            return None
        try:
            from .prices import get_mark_price

            return str(get_mark_price(obj.market, obj.symbol))
        except Exception:
            return None

    def get_unrealized_pnl(self, obj: Position):
        if obj.status != Position.Status.OPEN:
            return None
        try:
            from .prices import get_mark_price

            mark = get_mark_price(obj.market, obj.symbol)
        except Exception:
            return None
        diff = mark - obj.entry_price
        if obj.side == Position.Side.SHORT:
            diff = -diff
        return str((diff * obj.quantity).quantize(Decimal("0.01")))

    def get_liquidation_price(self, obj: Position):
        if obj.status != Position.Status.OPEN:
            return None
        from .services import liquidation_price

        px = liquidation_price(obj.side, obj.entry_price, obj.leverage)
        return str(px) if px is not None else None


class PaperOrderSerializer(serializers.ModelSerializer):
    class Meta:
        model = PaperOrder
        fields = (
            "id",
            "market",
            "symbol",
            "side",
            "order_type",
            "notional",
            "leverage",
            "margin",
            "limit_price",
            "stop_loss",
            "take_profit",
            "status",
            "position",
            "created_at",
            "filled_at",
            "tournament",
        )
        read_only_fields = fields


class PlaceOrderSerializer(serializers.Serializer):
    market = serializers.ChoiceField(choices=Wallet.Market.choices)
    symbol = serializers.CharField(max_length=32)
    side = serializers.ChoiceField(choices=Position.Side.choices)
    order_type = serializers.ChoiceField(
        choices=PaperOrder.OrderType.choices, default=PaperOrder.OrderType.MARKET
    )
    notional = serializers.DecimalField(
        max_digits=14, decimal_places=2, min_value=Decimal("1")
    )
    leverage = serializers.IntegerField(required=False, default=1, min_value=1)
    limit_price = serializers.DecimalField(
        max_digits=18, decimal_places=8, required=False, allow_null=True
    )
    stop_loss = serializers.DecimalField(
        max_digits=18, decimal_places=8, required=False, allow_null=True
    )
    take_profit = serializers.DecimalField(
        max_digits=18, decimal_places=8, required=False, allow_null=True
    )
    tournament_id = serializers.IntegerField(required=False, allow_null=True)

    def validate(self, attrs):
        market = attrs["market"]
        symbol = attrs["symbol"].upper().replace("-", "").replace("/", "")
        attrs["symbol"] = symbol
        order_type = attrs.get("order_type", PaperOrder.OrderType.MARKET)
        limit_price = attrs.get("limit_price")
        attrs["leverage"] = clamp_leverage(market, attrs.get("leverage") or 1)
        sl = attrs.get("stop_loss")
        tp = attrs.get("take_profit")
        if sl is not None and sl <= 0:
            attrs["stop_loss"] = None
            sl = None
        if tp is not None and tp <= 0:
            attrs["take_profit"] = None
            tp = None

        if order_type == PaperOrder.OrderType.LIMIT:
            if limit_price is None or limit_price <= 0:
                raise serializers.ValidationError(
                    {"limit_price": "Limit orders require a positive limit_price."}
                )
        else:
            attrs["limit_price"] = None

        ref = attrs.get("limit_price")
        try:
            validate_sl_tp(attrs["side"], ref, sl, tp)
        except ValueError as exc:
            raise serializers.ValidationError({"detail": str(exc)}) from exc

        if market == "forex":
            if symbol not in FOREX_BASE:
                raise serializers.ValidationError(
                    {"symbol": f"Unsupported forex. Use: {', '.join(FOREX_BASE)}"}
                )
        else:
            try:
                found = bn.list_symbols(market, query=symbol, limit=5)
            except bn.BinanceUnavailable as exc:
                raise serializers.ValidationError(
                    {"detail": exc.public_message}
                ) from exc
            if not any(x["symbol"] == symbol for x in found):
                try:
                    bn.book_ticker(market, symbol)
                except bn.BinanceUnavailable as exc:
                    if exc.status_code == 400:
                        raise serializers.ValidationError(
                            {
                                "symbol": (
                                    f"Unknown Binance {market} symbol: {symbol}"
                                )
                            }
                        ) from exc
                    raise serializers.ValidationError(
                        {"detail": exc.public_message}
                    ) from exc
                except Exception as exc:
                    raise serializers.ValidationError(
                        {
                            "symbol": (
                                f"Unknown Binance {market} symbol: {symbol}"
                            )
                        }
                    ) from exc

        tid = attrs.get("tournament_id")
        if tid is not None:
            from tournaments.models import Tournament

            try:
                attrs["_tournament"] = Tournament.objects.get(pk=tid)
            except Tournament.DoesNotExist as exc:
                raise serializers.ValidationError(
                    {"tournament_id": "Tournament not found."}
                ) from exc
        else:
            attrs["_tournament"] = None
        return attrs

    def create(self, validated_data):
        user = self.context["request"].user
        tournament = validated_data.pop("_tournament", None)
        validated_data.pop("tournament_id", None)
        try:
            return place_order(
                user,
                market=validated_data["market"],
                symbol=validated_data["symbol"],
                side=validated_data["side"],
                order_type=validated_data["order_type"],
                notional=validated_data["notional"],
                leverage=validated_data["leverage"],
                limit_price=validated_data.get("limit_price"),
                stop_loss=validated_data.get("stop_loss"),
                take_profit=validated_data.get("take_profit"),
                tournament=tournament,
            )
        except ValueError as exc:
            raise serializers.ValidationError({"detail": str(exc)}) from exc


class UpdateProtectSerializer(serializers.Serializer):
    """Set or clear stop-loss / take-profit on an open position."""

    stop_loss = serializers.DecimalField(
        max_digits=18, decimal_places=8, required=False, allow_null=True
    )
    take_profit = serializers.DecimalField(
        max_digits=18, decimal_places=8, required=False, allow_null=True
    )

    def save(self, **kwargs):
        position: Position = self.context["position"]
        user = self.context["request"].user
        if position.user_id != user.id:
            raise serializers.ValidationError("Not your position.")
        if position.status != Position.Status.OPEN:
            raise serializers.ValidationError("Position is not open.")

        sl = self.validated_data.get("stop_loss", position.stop_loss)
        tp = self.validated_data.get("take_profit", position.take_profit)
        # Explicit null clears
        if "stop_loss" in self.validated_data:
            sl = self.validated_data["stop_loss"]
        if "take_profit" in self.validated_data:
            tp = self.validated_data["take_profit"]

        try:
            validate_sl_tp(position.side, position.entry_price, sl, tp)
        except ValueError as exc:
            raise serializers.ValidationError({"detail": str(exc)}) from exc

        position.stop_loss = sl
        position.take_profit = tp
        position.save(update_fields=["stop_loss", "take_profit"])
        return position


class OpenPositionSerializer(serializers.Serializer):
    market = serializers.ChoiceField(choices=Wallet.Market.choices)
    symbol = serializers.CharField(max_length=32)
    side = serializers.ChoiceField(choices=Position.Side.choices)
    notional = serializers.DecimalField(
        max_digits=14, decimal_places=2, min_value=Decimal("1")
    )
    leverage = serializers.IntegerField(required=False, default=1, min_value=1)

    def validate(self, attrs):
        ser = PlaceOrderSerializer(
            data={**attrs, "order_type": "market"},
            context=self.context,
        )
        ser.is_valid(raise_exception=True)
        self._place_data = ser.validated_data
        return attrs

    def create(self, validated_data):
        order = place_order(
            self.context["request"].user,
            market=self._place_data["market"],
            symbol=self._place_data["symbol"],
            side=self._place_data["side"],
            order_type=PaperOrder.OrderType.MARKET,
            notional=self._place_data["notional"],
            leverage=self._place_data["leverage"],
            limit_price=None,
        )
        if not order.position:
            raise serializers.ValidationError({"detail": "Market order did not fill."})
        return order.position


class ClosePositionSerializer(serializers.Serializer):
    def save(self, **kwargs):
        position: Position = self.context["position"]
        user = self.context["request"].user
        if position.user_id != user.id:
            raise serializers.ValidationError("Not your position.")
        if position.status != Position.Status.OPEN:
            raise serializers.ValidationError("Position already closed.")

        with transaction.atomic():
            position = Position.objects.select_for_update().get(pk=position.pk)
            if position.status != Position.Status.OPEN:
                raise serializers.ValidationError("Position already closed.")
            close_side = "short" if position.side == Position.Side.LONG else "long"
            try:
                exit_price = get_fill_price(
                    position.market, position.symbol, close_side
                )
            except Exception as exc:
                raise serializers.ValidationError(
                    {"detail": f"Could not get exit price: {exc}"}
                ) from exc
            return close_position_at(position, exit_price)


class AdjustPositionSerializer(serializers.Serializer):
    """Add to or trim an open position (USD notional)."""

    action = serializers.ChoiceField(choices=("add", "trim"))
    notional = serializers.DecimalField(
        max_digits=14, decimal_places=2, min_value=Decimal("1")
    )

    def save(self, **kwargs):
        position: Position = self.context["position"]
        user = self.context["request"].user
        if position.user_id != user.id:
            raise serializers.ValidationError("Not your position.")
        if position.status != Position.Status.OPEN:
            raise serializers.ValidationError("Position is not open.")

        action = self.validated_data["action"]
        notional = self.validated_data["notional"]
        try:
            if action == "add":
                return add_to_position(user, position.pk, notional)
            return trim_position(user, position.pk, notional)
        except Position.DoesNotExist as exc:
            raise serializers.ValidationError("Not found.") from exc
        except ValueError as exc:
            raise serializers.ValidationError({"detail": str(exc)}) from exc
