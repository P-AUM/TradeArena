from django.urls import path

from .views import (
    TournamentAdminStandingsView,
    TournamentDetailView,
    TournamentJoinView,
    TournamentListCreateView,
    TournamentMyPositionsView,
    TournamentMyView,
    TournamentMyWalletsView,
    TournamentPublicTradesView,
    TournamentSettleView,
)

urlpatterns = [
    path("", TournamentListCreateView.as_view()),
    path("<int:pk>/", TournamentDetailView.as_view()),
    path("<int:pk>/join/", TournamentJoinView.as_view()),
    path("<int:pk>/me/", TournamentMyView.as_view()),
    path("<int:pk>/wallets/", TournamentMyWalletsView.as_view()),
    path("<int:pk>/positions/", TournamentMyPositionsView.as_view()),
    path("<int:pk>/standings/", TournamentAdminStandingsView.as_view()),
    path("<int:pk>/settle/", TournamentSettleView.as_view()),
    path("<int:pk>/trades/", TournamentPublicTradesView.as_view()),
]
