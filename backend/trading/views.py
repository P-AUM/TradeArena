from django.db.models import Count, Q, Sum
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.models import User
from accounts import social as social_helpers
from . import binance as bn
from .leaderboard import VALID_METRICS, VALID_PERIODS, build_leaderboard
from .models import PaperOrder, Position
from .prices import get_all_quotes
from .serializers import (
    AdjustPositionSerializer,
    ClosePositionSerializer,
    OpenPositionSerializer,
    PaperOrderSerializer,
    PlaceOrderSerializer,
    PositionSerializer,
    UpdateProtectSerializer,
    WalletSerializer,
)
from .services import cancel_order, ensure_wallets, try_fill_open_orders


class IsTrader(permissions.BasePermission):
    def has_permission(self, request, view):
        return bool(
            request.user
            and request.user.is_authenticated
            and getattr(request.user, "role", None) == User.Role.TRADER
        )


class LeaderboardView(APIView):
    """Rank traders by PnL, ROI, or win rate for daily / weekly / all-time."""

    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request):
        period = (request.query_params.get("period") or "all_time").strip().lower()
        metric = (request.query_params.get("metric") or "pnl").strip().lower()
        if period not in VALID_PERIODS:
            return Response(
                {"detail": f"Invalid period. Use one of: {', '.join(VALID_PERIODS)}"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if metric not in VALID_METRICS:
            return Response(
                {"detail": f"Invalid metric. Use one of: {', '.join(VALID_METRICS)}"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            limit = int(request.query_params.get("limit") or 100)
        except ValueError:
            limit = 100
        limit = max(1, min(limit, 200))
        return Response(build_leaderboard(period=period, metric=metric, limit=limit))


class TraderListView(APIView):
    """Any logged-in user (trader or viewer) can browse traders."""

    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request):
        qs = (
            User.objects.filter(role=User.Role.TRADER)
            .annotate(
                open_count=Count(
                    "positions",
                    filter=Q(positions__status=Position.Status.OPEN),
                ),
                closed_count=Count(
                    "positions",
                    filter=Q(positions__status=Position.Status.CLOSED),
                ),
                realized_pnl=Sum(
                    "positions__realized_pnl",
                    filter=Q(positions__status=Position.Status.CLOSED),
                ),
            )
            .order_by("username")
        )
        q = request.query_params.get("q", "").strip()
        if q:
            qs = qs.filter(username__icontains=q)

        out = []
        for u in qs[:100]:
            out.append(
                {
                    "id": u.id,
                    "username": u.username,
                    "open_positions": u.open_count,
                    "closed_trades": u.closed_count,
                    "realized_pnl": str(u.realized_pnl or 0),
                    "followers_count": social_helpers.followers_count(u),
                }
            )
        return Response(out)


class TraderHistoryView(APIView):
    """Full trade history for one trader — visible to traders and viewers."""

    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request, username: str):
        try:
            trader = User.objects.get(
                username__iexact=username, role=User.Role.TRADER
            )
        except User.DoesNotExist:
            return Response(
                {"detail": "Trader not found."}, status=status.HTTP_404_NOT_FOUND
            )

        # Refresh fills/liq for that trader when anyone views them
        try_fill_open_orders(trader)

        open_qs = Position.objects.filter(
            user=trader, status=Position.Status.OPEN
        )
        closed_qs = Position.objects.filter(
            user=trader, status=Position.Status.CLOSED
        )
        realized = closed_qs.aggregate(s=Sum("realized_pnl"))["s"] or 0

        return Response(
            {
                "trader": {
                    "id": trader.id,
                    "username": trader.username,
                    "open_positions": open_qs.count(),
                    "closed_trades": closed_qs.count(),
                    "realized_pnl": str(realized),
                    "followers_count": social_helpers.followers_count(trader),
                    "following_count": social_helpers.following_count(trader),
                    "is_following": social_helpers.is_following(
                        follower=request.user, target=trader
                    ),
                },
                "open": PositionSerializer(open_qs, many=True).data,
                "closed": PositionSerializer(closed_qs, many=True).data,
            }
        )


class WalletListView(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request):
        if request.user.role != User.Role.TRADER:
            return Response(
                {"detail": "Wallets are for traders only."},
                status=status.HTTP_403_FORBIDDEN,
            )
        # SL/TP/limit fills run on positions GET (avoid triple-check every poll)
        wallets = ensure_wallets(request.user)
        return Response(WalletSerializer(wallets, many=True).data)


class QuotesView(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request):
        market = request.query_params.get("market")
        return Response(get_all_quotes(market))


class SymbolSearchView(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request):
        market = request.query_params.get("market", "spot")
        if market not in ("spot", "futures"):
            return Response(
                {"detail": "market must be spot or futures"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        q = request.query_params.get("q", "")
        limit = min(int(request.query_params.get("limit", 40)), 100)
        try:
            return Response(bn.list_symbols(market, q, limit))
        except Exception as exc:
            return Response(
                {"detail": str(exc)}, status=status.HTTP_502_BAD_GATEWAY
            )


class OrderBookView(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request):
        market = request.query_params.get("market", "spot")
        symbol = request.query_params.get("symbol", "BTCUSDT")
        limit = min(int(request.query_params.get("limit", 20)), 100)
        if market not in ("spot", "futures"):
            return Response({"detail": "spot or futures only"}, status=400)
        try:
            return Response(bn.depth(market, symbol, limit))
        except Exception as exc:
            return Response({"detail": str(exc)}, status=502)


class RecentTradesView(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request):
        market = request.query_params.get("market", "spot")
        symbol = request.query_params.get("symbol", "BTCUSDT")
        limit = min(int(request.query_params.get("limit", 40)), 100)
        if market not in ("spot", "futures"):
            return Response({"detail": "spot or futures only"}, status=400)
        try:
            return Response(bn.recent_trades(market, symbol, limit))
        except Exception as exc:
            return Response({"detail": str(exc)}, status=502)


class TickerView(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request):
        market = request.query_params.get("market", "spot")
        symbol = request.query_params.get("symbol", "BTCUSDT")
        if market not in ("spot", "futures"):
            return Response({"detail": "spot or futures only"}, status=400)
        try:
            return Response(bn.ticker_24h(market, symbol))
        except Exception as exc:
            return Response({"detail": str(exc)}, status=502)


class OrderListCreateView(APIView):
    permission_classes = (IsTrader,)

    def get(self, request):
        ensure_wallets(request.user)
        # Fills/SL checked on positions GET
        status_filter = request.query_params.get("status", "open")
        qs = PaperOrder.objects.filter(user=request.user)
        if status_filter in ("open", "filled", "cancelled"):
            qs = qs.filter(status=status_filter)
        return Response(PaperOrderSerializer(qs, many=True).data)

    def post(self, request):
        ensure_wallets(request.user)
        serializer = PlaceOrderSerializer(
            data=request.data, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)
        order = serializer.save()
        return Response(
            PaperOrderSerializer(order).data, status=status.HTTP_201_CREATED
        )


class OrderCancelView(APIView):
    permission_classes = (IsTrader,)

    def post(self, request, pk: int):
        try:
            order = cancel_order(request.user, pk)
        except PaperOrder.DoesNotExist:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(PaperOrderSerializer(order).data)


class PositionListCreateView(APIView):
    permission_classes = (IsTrader,)

    def get(self, request):
        ensure_wallets(request.user)
        try_fill_open_orders(request.user)
        status_filter = request.query_params.get("status", "open")
        qs = Position.objects.filter(user=request.user)
        if status_filter in ("open", "closed"):
            qs = qs.filter(status=status_filter)
        return Response(PositionSerializer(qs, many=True).data)

    def post(self, request):
        ensure_wallets(request.user)
        serializer = OpenPositionSerializer(
            data=request.data, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)
        position = serializer.save()
        return Response(
            PositionSerializer(position).data, status=status.HTTP_201_CREATED
        )


class PositionCloseView(APIView):
    permission_classes = (IsTrader,)

    def post(self, request, pk: int):
        try:
            position = Position.objects.get(pk=pk, user=request.user)
        except Position.DoesNotExist:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        serializer = ClosePositionSerializer(
            data={}, context={"request": request, "position": position}
        )
        serializer.is_valid(raise_exception=True)
        closed = serializer.save()
        return Response(PositionSerializer(closed).data)


class PositionAdjustView(APIView):
    """Add size or trim (partial close) an open position."""

    permission_classes = (IsTrader,)

    def post(self, request, pk: int):
        try:
            position = Position.objects.get(pk=pk, user=request.user)
        except Position.DoesNotExist:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        serializer = AdjustPositionSerializer(
            data=request.data,
            context={"request": request, "position": position},
        )
        serializer.is_valid(raise_exception=True)
        updated = serializer.save()
        return Response(PositionSerializer(updated).data)


class PositionProtectView(APIView):
    """Update stop-loss / take-profit on an open position."""

    permission_classes = (IsTrader,)

    def patch(self, request, pk: int):
        try:
            position = Position.objects.get(pk=pk, user=request.user)
        except Position.DoesNotExist:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        serializer = UpdateProtectSerializer(
            data=request.data,
            context={"request": request, "position": position},
        )
        serializer.is_valid(raise_exception=True)
        updated = serializer.save()
        return Response(PositionSerializer(updated).data)
