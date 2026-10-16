from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from trading.models import Position
from trading.serializers import PositionSerializer
from trading.services import try_fill_open_orders

from .models import Tournament, TournamentEntry, TournamentWallet
from .serializers import (
    CreateTournamentSerializer,
    TournamentEntrySerializer,
    TournamentSerializer,
    TournamentWalletSerializer,
)
from .services import (
    entry_stats,
    join_tournament,
    settle_tournament,
    sync_tournament_statuses,
)


class IsAdminRole(permissions.BasePermission):
    def has_permission(self, request, view):
        u = request.user
        return bool(u and u.is_authenticated and u.role == "admin")


class IsTraderRole(permissions.BasePermission):
    def has_permission(self, request, view):
        u = request.user
        return bool(u and u.is_authenticated and u.role == "trader")


class TournamentListCreateView(APIView):
    def get_permissions(self):
        if self.request.method == "POST":
            return [IsAdminRole()]
        return [permissions.IsAuthenticated()]

    def get(self, request):
        sync_tournament_statuses()
        qs = Tournament.objects.exclude(status=Tournament.Status.CANCELLED)
        return Response(
            TournamentSerializer(qs, many=True, context={"request": request}).data
        )

    def post(self, request):
        ser = CreateTournamentSerializer(
            data=request.data, context={"request": request}
        )
        ser.is_valid(raise_exception=True)
        t = ser.save()
        return Response(
            TournamentSerializer(t, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )


class TournamentDetailView(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request, pk: int):
        sync_tournament_statuses()
        try:
            t = Tournament.objects.get(pk=pk)
        except Tournament.DoesNotExist:
            return Response({"detail": "Not found."}, status=404)
        t.refresh_status(save=True)
        data = TournamentSerializer(t, context={"request": request}).data
        # Public leaderboard only after ended; admin always gets standings via separate endpoint
        if t.status == Tournament.Status.ENDED:
            entries = t.entries.filter(paid=True).order_by("rank", "id")
            data["leaderboard"] = TournamentEntrySerializer(entries, many=True).data
        return Response(data)


class TournamentJoinView(APIView):
    permission_classes = (IsTraderRole,)

    def post(self, request, pk: int):
        sync_tournament_statuses()
        try:
            entry = join_tournament(request.user, pk)
        except Tournament.DoesNotExist:
            return Response({"detail": "Not found."}, status=404)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=400)
        return Response(
            {
                "detail": "Joined (payment stub). Tournament wallet funded.",
                "entry": TournamentEntrySerializer(entry).data,
            },
            status=201,
        )


class TournamentMyWalletsView(APIView):
    permission_classes = (IsTraderRole,)

    def get(self, request, pk: int):
        sync_tournament_statuses()
        if not TournamentEntry.objects.filter(
            tournament_id=pk, user=request.user, paid=True
        ).exists():
            return Response({"detail": "Not an entrant."}, status=403)
        wallets = TournamentWallet.objects.filter(
            tournament_id=pk, user=request.user
        )
        return Response(TournamentWalletSerializer(wallets, many=True).data)


class TournamentMyPositionsView(APIView):
    permission_classes = (IsTraderRole,)

    def get(self, request, pk: int):
        sync_tournament_statuses()
        if not TournamentEntry.objects.filter(
            tournament_id=pk, user=request.user, paid=True
        ).exists():
            return Response({"detail": "Not an entrant."}, status=403)
        try_fill_open_orders(request.user)
        status_filter = request.query_params.get("status", "open")
        qs = Position.objects.filter(user=request.user, tournament_id=pk)
        if status_filter in ("open", "closed"):
            qs = qs.filter(status=status_filter)
        return Response(PositionSerializer(qs, many=True).data)


class TournamentAdminStandingsView(APIView):
    """Live scoreboard — admin only."""

    permission_classes = (IsAdminRole,)

    def get(self, request, pk: int):
        sync_tournament_statuses()
        try:
            t = Tournament.objects.get(pk=pk)
        except Tournament.DoesNotExist:
            return Response({"detail": "Not found."}, status=404)
        t.refresh_status(save=True)
        rows = []
        for e in t.entries.filter(paid=True).select_related("user"):
            st = entry_stats(e.user, t)
            rows.append(
                {
                    "username": e.user.username,
                    "realized_pnl": str(st["realized_pnl"]),
                    "win_rate": str(st["win_rate"]),
                    "closed_trades": st["closed_trades"],
                }
            )
        rows.sort(
            key=lambda r: (float(r["realized_pnl"]), float(r["win_rate"])),
            reverse=True,
        )
        for i, r in enumerate(rows, start=1):
            r["rank"] = i
        return Response(
            {
                "tournament_id": t.id,
                "status": t.status,
                "standings": rows,
            }
        )


class TournamentSettleView(APIView):
    permission_classes = (IsAdminRole,)

    def post(self, request, pk: int):
        sync_tournament_statuses()
        try:
            t = Tournament.objects.get(pk=pk)
        except Tournament.DoesNotExist:
            return Response({"detail": "Not found."}, status=404)
        if timezone_now_before_end(t):
            return Response(
                {"detail": "Tournament has not ended yet."}, status=400
            )
        t = settle_tournament(t)
        return Response(TournamentSerializer(t, context={"request": request}).data)


def timezone_now_before_end(t: Tournament) -> bool:
    from django.utils import timezone

    return timezone.now() < t.end_at


class TournamentPublicTradesView(APIView):
    """After tournament ends — anyone authenticated can view entrant trades."""

    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request, pk: int):
        sync_tournament_statuses()
        try:
            t = Tournament.objects.get(pk=pk)
        except Tournament.DoesNotExist:
            return Response({"detail": "Not found."}, status=404)
        t.refresh_status(save=True)
        if t.status != Tournament.Status.ENDED and request.user.role != "admin":
            return Response(
                {"detail": "Tournament trades are private until the event ends."},
                status=403,
            )
        username = request.query_params.get("username")
        qs = Position.objects.filter(tournament=t).select_related("user")
        if username:
            qs = qs.filter(user__username__iexact=username)
        # Group lightly: return flat list with username
        out = []
        for p in qs.order_by("-opened_at")[:500]:
            row = PositionSerializer(p).data
            row["username"] = p.user.username
            out.append(row)
        return Response(out)
