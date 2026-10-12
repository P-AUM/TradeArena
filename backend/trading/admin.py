from django.contrib import admin

from .models import Position, Wallet


@admin.register(Wallet)
class WalletAdmin(admin.ModelAdmin):
    list_display = ("user", "market", "balance", "starting_balance", "updated_at")
    list_filter = ("market",)


@admin.register(Position)
class PositionAdmin(admin.ModelAdmin):
    list_display = (
        "user",
        "market",
        "symbol",
        "side",
        "notional",
        "status",
        "realized_pnl",
        "opened_at",
    )
    list_filter = ("market", "status", "side")
