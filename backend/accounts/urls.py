from django.urls import path
from rest_framework_simplejwt.views import TokenRefreshView

from .views import (
    EmailTokenObtainPairView,
    FollowToggleView,
    ForgotPasswordView,
    MeSocialView,
    MeView,
    NotificationListView,
    NotificationMarkAllReadView,
    NotificationMarkReadView,
    ResetPasswordView,
    SignupView,
    UserFollowersView,
    UserFollowingView,
    VerifyResetCodeView,
)

urlpatterns = [
    path("signup/", SignupView.as_view(), name="signup"),
    path("login/", EmailTokenObtainPairView.as_view(), name="login"),
    path("token/refresh/", TokenRefreshView.as_view(), name="token_refresh"),
    path("me/", MeView.as_view(), name="me"),
    path("me/social/", MeSocialView.as_view(), name="me_social"),
    path("notifications/", NotificationListView.as_view(), name="notifications"),
    path(
        "notifications/read-all/",
        NotificationMarkAllReadView.as_view(),
        name="notifications_read_all",
    ),
    path(
        "notifications/<int:pk>/read/",
        NotificationMarkReadView.as_view(),
        name="notification_read",
    ),
    path("follow/<str:username>/", FollowToggleView.as_view(), name="follow_toggle"),
    path(
        "users/<str:username>/followers/",
        UserFollowersView.as_view(),
        name="user_followers",
    ),
    path(
        "users/<str:username>/following/",
        UserFollowingView.as_view(),
        name="user_following",
    ),
    path("forgot-password/", ForgotPasswordView.as_view(), name="forgot_password"),
    path("verify-reset-code/", VerifyResetCodeView.as_view(), name="verify_reset_code"),
    path("reset-password/", ResetPasswordView.as_view(), name="reset_password"),
]
