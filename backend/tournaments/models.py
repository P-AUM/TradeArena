from decimal import Decimal

from django.conf import settings
from django.db import models
from django.utils import timezone


class Tournament(models.Model):
    class Status(models.TextChoices):
        SCHEDULED = "scheduled", "Scheduled"  # open for join until start
        LIVE = "live", "Live"
        ENDED = "ended", "Ended"
        CANCELLED = "cancelled", "Cancelled"

    name = models.CharField(max_length=120)
    max_participants = models.PositiveIntegerField()
    entry_fee = models.DecimalField(max_digits=12, decimal_places=2)
    start_at = models.DateTimeField()
    end_at = models.DateTimeField()
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.SCHEDULED
    )
    prize_pool_pct = models.DecimalField(
        max_digits=5, decimal_places=2, default=Decimal("85.00")
    )
    starting_capital = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("10000.00")
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="tournaments_created",
    )
    settled_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-start_at"]

    def __str__(self) -> str:
        return f"{self.name} ({self.status})"

    @property
    def duration_seconds(self) -> float:
        return max(0.0, (self.end_at - self.start_at).total_seconds())

    def refresh_status(self, *, save: bool = True) -> str:
        """Derive status from clock (unless cancelled)."""
        if self.status == self.Status.CANCELLED:
            return self.status
        now = timezone.now()
        if now < self.start_at:
            new = self.Status.SCHEDULED
        elif now < self.end_at:
            new = self.Status.LIVE
        else:
            new = self.Status.ENDED
        if new != self.status:
            self.status = new
            if save:
                self.save(update_fields=["status", "updated_at"])
        return self.status


class TournamentEntry(models.Model):
    tournament = models.ForeignKey(
        Tournament, on_delete=models.CASCADE, related_name="entries"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="tournament_entries",
    )
    # Payment stub — real gateway later
    paid = models.BooleanField(default=False)
    paid_at = models.DateTimeField(null=True, blank=True)
    joined_at = models.DateTimeField(auto_now_add=True)
    # Settlement snapshot
    realized_pnl = models.DecimalField(
        max_digits=14, decimal_places=2, null=True, blank=True
    )
    win_rate = models.DecimalField(
        max_digits=7, decimal_places=4, null=True, blank=True
    )
    closed_trades = models.PositiveIntegerField(default=0)
    winning_trades = models.PositiveIntegerField(default=0)
    rank = models.PositiveIntegerField(null=True, blank=True)
    prize_amount = models.DecimalField(
        max_digits=14, decimal_places=2, null=True, blank=True
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["tournament", "user"],
                name="unique_tournament_entry",
            )
        ]
        ordering = ["rank", "joined_at"]

    def __str__(self) -> str:
        return f"{self.user_id} @ {self.tournament_id}"


class TournamentWallet(models.Model):
    """Isolated crypto wallets (spot + futures) for one tournament entry."""

    class Market(models.TextChoices):
        SPOT = "spot", "Spot"
        FUTURES = "futures", "Futures"

    tournament = models.ForeignKey(
        Tournament, on_delete=models.CASCADE, related_name="wallets"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="tournament_wallets",
    )
    market = models.CharField(max_length=20, choices=Market.choices)
    balance = models.DecimalField(max_digits=14, decimal_places=2, default=Decimal("0"))
    starting_balance = models.DecimalField(
        max_digits=14, decimal_places=2, default=Decimal("10000.00")
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["tournament", "user", "market"],
                name="unique_tournament_wallet",
            )
        ]

    def __str__(self) -> str:
        return f"T{self.tournament_id} U{self.user_id} {self.market} {self.balance}"
