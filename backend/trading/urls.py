from django.urls import path

from .views import (
    LeaderboardView,
    OrderBookView,
    OrderCancelView,
    OrderListCreateView,
    PositionAdjustView,
    PositionCloseView,
    PositionListCreateView,
    PositionProtectView,
    QuotesView,
    RecentTradesView,
    SymbolSearchView,
    TickerView,
    TraderHistoryView,
    TraderListView,
    WalletListView,
)

urlpatterns = [
    path("wallets/", WalletListView.as_view()),
    path("quotes/", QuotesView.as_view()),
    path("symbols/", SymbolSearchView.as_view()),
    path("orderbook/", OrderBookView.as_view()),
    path("trades/", RecentTradesView.as_view()),
    path("ticker/", TickerView.as_view()),
    path("leaderboard/", LeaderboardView.as_view()),
    path("traders/", TraderListView.as_view()),
    path("traders/<str:username>/", TraderHistoryView.as_view()),
    path("orders/", OrderListCreateView.as_view()),
    path("orders/<int:pk>/cancel/", OrderCancelView.as_view()),
    path("positions/", PositionListCreateView.as_view()),
    path("positions/<int:pk>/close/", PositionCloseView.as_view()),
    path("positions/<int:pk>/adjust/", PositionAdjustView.as_view()),
    path("positions/<int:pk>/protect/", PositionProtectView.as_view()),
]
