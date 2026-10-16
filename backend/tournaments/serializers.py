from decimal import Decimal

from django.utils import timezone
from rest_framework import serializers

from .models import Tournament, TournamentEntry, TournamentWallet
from .services import create_tournament


class TournamentSerializer(serializers.ModelSerializer):
    entrant_count = serializers.SerializerMethodField()
    duration_seconds = serializers.SerializerMethodField()
    i_joined = serializers.SerializerMethodField()
    prize_pool_estimate = serializers.SerializerMethodField()

    class Meta:
        model = Tournament
        fields = (
            "id",
            "name",
            "max_participants",
            "entry_fee",
            "start_at",
            "end_at",
            "status",
            "prize_pool_pct",
            "starting_capital",
            "entrant_count",
            "duration_seconds",
            "i_joined",
            "prize_pool_estimate",
            "settled_at",
            "created_at",
        )

    def get_entrant_count(self, obj: Tournament) -> int:
        return obj.entries.filter(paid=True).count()

    def get_duration_seconds(self, obj: Tournament) -> float:
        return obj.duration_seconds

    def get_i_joined(self, obj: Tournament) -> bool:
        req = self.context.get("request")
        if not req or not req.user.is_authenticated:
            return False
        return obj.entries.filter(user=req.user, paid=True).exists()

    def get_prize_pool_estimate(self, obj: Tournament) -> str:
        n = obj.entries.filter(paid=True).count()
        pool = (obj.entry_fee * n * (obj.prize_pool_pct / Decimal("100"))).quantize(
            Decimal("0.01")
        )
        return str(pool)


class CreateTournamentSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120)
    max_participants = serializers.IntegerField(min_value=2)
    entry_fee = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=0)
    start_at = serializers.DateTimeField()
    end_at = serializers.DateTimeField()

    def create(self, validated_data):
        try:
            return create_tournament(admin=self.context["request"].user, **validated_data)
        except ValueError as exc:
            raise serializers.ValidationError({"detail": str(exc)}) from exc


class TournamentEntrySerializer(serializers.ModelSerializer):
    username = serializers.CharField(source="user.username", read_only=True)

    class Meta:
        model = TournamentEntry
        fields = (
            "id",
            "username",
            "paid",
            "joined_at",
            "realized_pnl",
            "win_rate",
            "closed_trades",
            "winning_trades",
            "rank",
            "prize_amount",
        )


class TournamentWalletSerializer(serializers.ModelSerializer):
    class Meta:
        model = TournamentWallet
        fields = (
            "id",
            "market",
            "balance",
            "starting_balance",
            "updated_at",
        )


class LiveStandingSerializer(serializers.Serializer):
    username = serializers.CharField()
    realized_pnl = serializers.DecimalField(max_digits=14, decimal_places=2)
    win_rate = serializers.DecimalField(max_digits=7, decimal_places=4)
    closed_trades = serializers.IntegerField()
    rank = serializers.IntegerField()
