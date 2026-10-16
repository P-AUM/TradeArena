from django.contrib import admin

from .models import Tournament, TournamentEntry, TournamentWallet


@admin.register(Tournament)
class TournamentAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "name",
        "status",
        "entry_fee",
        "max_participants",
        "start_at",
        "end_at",
    )
    list_filter = ("status",)


@admin.register(TournamentEntry)
class TournamentEntryAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "tournament",
        "user",
        "paid",
        "rank",
        "realized_pnl",
        "prize_amount",
    )


@admin.register(TournamentWallet)
class TournamentWalletAdmin(admin.ModelAdmin):
    list_display = ("id", "tournament", "user", "market", "balance")
