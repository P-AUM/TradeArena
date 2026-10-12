from decimal import Decimal

from django.conf import settings
from django.db import models


class Wallet(models.Model):
    class Market(models.TextChoices):
        SPOT = "spot", "Spot"
        FUTURES = "futures", "Futures"
        FOREX = "forex", "Forex"

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="wallets",
    )
    market = models.CharField(max_length=20, choices=Market.choices)
    balance = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    starting_balance = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("10000.00")
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ("user", "market")

    def __str__(self) -> str:
        return f"{self.user_id} {self.market} {self.balance}"


class Position(models.Model):
    class Side(models.TextChoices):
        LONG = "long", "Long"
        SHORT = "short", "Short"

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        CLOSED = "closed", "Closed"

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="positions",
    )
    market = models.CharField(max_length=20, choices=Wallet.Market.choices)
    symbol = models.CharField(max_length=32)  # Binance style e.g. BTCUSDT
    side = models.CharField(max_length=10, choices=Side.choices)
    quantity = models.DecimalField(max_digits=18, decimal_places=8)
    entry_price = models.DecimalField(max_digits=18, decimal_places=8)
    notional = models.DecimalField(max_digits=14, decimal_places=2)
    leverage = models.PositiveSmallIntegerField(default=1)
    margin = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    status = models.CharField(
        max_length=10, choices=Status.choices, default=Status.OPEN
    )
    exit_price = models.DecimalField(
        max_digits=18, decimal_places=8, null=True, blank=True
    )
    realized_pnl = models.DecimalField(
        max_digits=14, decimal_places=2, null=True, blank=True
    )
    stop_loss = models.DecimalField(
        max_digits=18, decimal_places=8, null=True, blank=True
    )
    take_profit = models.DecimalField(
        max_digits=18, decimal_places=8, null=True, blank=True
    )
    opened_at = models.DateTimeField(auto_now_add=True)
    closed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-opened_at"]

    def __str__(self) -> str:
        return f"{self.user_id} {self.side} {self.symbol} ({self.status})"


class PaperOrder(models.Model):
    """Paper market (taker) or limit (maker) order."""

    class OrderType(models.TextChoices):
        MARKET = "market", "Market"
        LIMIT = "limit", "Limit"

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        FILLED = "filled", "Filled"
        CANCELLED = "cancelled", "Cancelled"

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="paper_orders",
    )
    market = models.CharField(max_length=20, choices=Wallet.Market.choices)
    symbol = models.CharField(max_length=32)
    side = models.CharField(max_length=10, choices=Position.Side.choices)
    order_type = models.CharField(max_length=10, choices=OrderType.choices)
    notional = models.DecimalField(max_digits=14, decimal_places=2)
    leverage = models.PositiveSmallIntegerField(default=1)
    margin = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    limit_price = models.DecimalField(
        max_digits=18, decimal_places=8, null=True, blank=True
    )
    stop_loss = models.DecimalField(
        max_digits=18, decimal_places=8, null=True, blank=True
    )
    take_profit = models.DecimalField(
        max_digits=18, decimal_places=8, null=True, blank=True
    )
    status = models.CharField(
        max_length=12, choices=Status.choices, default=Status.OPEN
    )
    position = models.ForeignKey(
        Position,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="source_orders",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    filled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.user_id} {self.order_type} {self.side} {self.symbol}"
