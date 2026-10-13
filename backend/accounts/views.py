from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.views import TokenObtainPairView
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from .email_reset import (
    create_reset_code,
    send_reset_code_email_async,
    smtp_configured,
)
from .models import Follow, PasswordResetCode
from .serializers import (
    ForgotPasswordSerializer,
    ResetPasswordSerializer,
    SignupSerializer,
    UserSerializer,
    VerifyResetCodeSerializer,
)
from . import notifications as notif_helpers
from . import social as social_helpers

User = get_user_model()


def _find_reset(email: str, code: str) -> PasswordResetCode | None:
    try:
        user = User.objects.get(email__iexact=email)
    except User.DoesNotExist:
        return None
    return (
        PasswordResetCode.objects.filter(user=user, code=code, used_at__isnull=True)
        .order_by("-created_at")
        .first()
    )


class EmailTokenObtainPairSerializer(TokenObtainPairSerializer):
    """Allow login with email or username in the 'username' field."""

    def validate(self, attrs):
        login = attrs.get("username", "").strip()
        if "@" in login:
            try:
                user = User.objects.get(email__iexact=login)
                attrs["username"] = user.username
            except User.DoesNotExist:
                pass
        data = super().validate(attrs)
        data["user"] = UserSerializer(self.user).data
        return data


class EmailTokenObtainPairView(TokenObtainPairView):
    serializer_class = EmailTokenObtainPairSerializer


class SignupView(generics.CreateAPIView):
    serializer_class = SignupSerializer
    permission_classes = (permissions.AllowAny,)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        if user.role == User.Role.TRADER:
            from trading.services import ensure_wallets

            ensure_wallets(user)
        refresh = EmailTokenObtainPairSerializer.get_token(user)
        return Response(
            {
                "user": UserSerializer(user).data,
                "refresh": str(refresh),
                "access": str(refresh.access_token),
            },
            status=status.HTTP_201_CREATED,
        )


class MeView(APIView):
    def get(self, request):
        return Response(UserSerializer(request.user).data)


class MeSocialView(APIView):
    """Current user's followers + following lists and counts."""

    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request):
        return Response(social_helpers.social_payload(request.user))


class NotificationListView(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request):
        unread_only = request.query_params.get("unread") in ("1", "true", "yes")
        return Response(
            {
                "unread_count": notif_helpers.unread_count(request.user),
                "results": notif_helpers.list_notifications(
                    request.user, unread_only=unread_only
                ),
            }
        )


class NotificationMarkReadView(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def post(self, request, pk: int):
        ok = notif_helpers.mark_read(request.user, pk)
        if not ok:
            return Response(
                {"detail": "Not found or already read."},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response({"detail": "Marked read."})


class NotificationMarkAllReadView(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def post(self, request):
        n = notif_helpers.mark_all_read(request.user)
        return Response({"detail": "All marked read.", "count": n})


class FollowToggleView(APIView):
    """POST follow / DELETE unfollow a trader by username."""

    permission_classes = (permissions.IsAuthenticated,)

    def post(self, request, username: str):
        try:
            target = User.objects.get(username__iexact=username)
        except User.DoesNotExist:
            return Response(
                {"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND
            )

        if target.id == request.user.id:
            return Response(
                {"detail": "You cannot follow yourself."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if target.role != User.Role.TRADER:
            return Response(
                {"detail": "You can only follow traders."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if Follow.objects.filter(follower=request.user, following=target).exists():
            return Response(
                {"detail": "Already following."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        Follow.objects.create(follower=request.user, following=target)
        return Response(
            {
                "detail": f"Now following @{target.username}.",
                "is_following": True,
                "followers_count": social_helpers.followers_count(target),
                "following_count": social_helpers.following_count(request.user),
            },
            status=status.HTTP_201_CREATED,
        )

    def delete(self, request, username: str):
        try:
            target = User.objects.get(username__iexact=username)
        except User.DoesNotExist:
            return Response(
                {"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND
            )

        deleted, _ = Follow.objects.filter(
            follower=request.user, following=target
        ).delete()
        return Response(
            {
                "detail": (
                    f"Unfollowed @{target.username}."
                    if deleted
                    else f"You were not following @{target.username}."
                ),
                "is_following": False,
                "followers_count": social_helpers.followers_count(target),
                "following_count": social_helpers.following_count(request.user),
            },
            status=status.HTTP_200_OK,
        )


class UserFollowersView(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request, username: str):
        try:
            user = User.objects.get(username__iexact=username)
        except User.DoesNotExist:
            return Response(
                {"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND
            )
        return Response(
            {
                "username": user.username,
                "role": user.role,
                "count": social_helpers.followers_count(user),
                "results": social_helpers.list_followers(user),
            }
        )


class UserFollowingView(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request, username: str):
        try:
            user = User.objects.get(username__iexact=username)
        except User.DoesNotExist:
            return Response(
                {"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND
            )
        return Response(
            {
                "username": user.username,
                "role": user.role,
                "count": social_helpers.following_count(user),
                "results": social_helpers.list_following(user),
            }
        )


class ForgotPasswordView(APIView):
    permission_classes = (permissions.AllowAny,)

    def post(self, request):
        from django.conf import settings

        serializer = ForgotPasswordSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"].strip().lower()

        try:
            user = User.objects.get(email__iexact=email)
        except User.DoesNotExist:
            return Response(
                {"detail": "Email not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        reset = create_reset_code(user)
        configured = smtp_configured()
        if not configured and not settings.DEBUG:
            return Response(
                {
                    "detail": (
                        "Could not send email. Set EMAIL_HOST, EMAIL_HOST_USER, "
                        "and EMAIL_HOST_PASSWORD in backend/.env"
                    )
                },
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        if configured:
            send_reset_code_email_async(user, reset.code)

        payload = {
            "detail": "A verification code has been sent to your email.",
        }
        # Show OTP on screen in DEBUG when mail is not configured, or EMAIL_SHOW_DEV_OTP=true
        show_dev = settings.DEBUG and (
            not configured or getattr(settings, "EMAIL_SHOW_DEV_OTP", False)
        )
        if show_dev:
            payload["dev_code"] = reset.code
            payload["detail"] = (
                "Temporary: use the code shown on screen."
                if not configured
                else "Code sent. Temporary: also shown on screen."
            )
        return Response(payload, status=status.HTTP_200_OK)


class VerifyResetCodeView(APIView):
    """Step 1 after email: verify OTP before allowing password change."""

    permission_classes = (permissions.AllowAny,)

    def post(self, request):
        serializer = VerifyResetCodeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"].strip().lower()
        code = serializer.validated_data["code"].strip()

        reset = _find_reset(email, code)
        if not reset or not reset.is_valid():
            return Response(
                {"detail": "Invalid or expired verification code."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        reset.verified_at = timezone.now()
        reset.save(update_fields=["verified_at"])
        return Response(
            {"detail": "Code verified. You can set a new password now."},
            status=status.HTTP_200_OK,
        )


class ResetPasswordView(APIView):
    """Step 2: only works after OTP was verified."""

    permission_classes = (permissions.AllowAny,)

    def post(self, request):
        serializer = ResetPasswordSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"].strip().lower()
        code = serializer.validated_data["code"].strip()
        new_password = serializer.validated_data["new_password"]

        reset = _find_reset(email, code)
        if not reset or not reset.is_valid():
            return Response(
                {"detail": "Invalid or expired verification code."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not reset.verified_at:
            return Response(
                {"detail": "Verify the code before setting a new password."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        user = reset.user
        user.set_password(new_password)
        user.save(update_fields=["password"])
        reset.used_at = timezone.now()
        reset.save(update_fields=["used_at"])

        return Response(
            {"detail": "Password updated. You can log in with your new password."},
            status=status.HTTP_200_OK,
        )
