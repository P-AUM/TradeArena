import secrets
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.mail import send_mail
from django.utils import timezone

from .gmail_api import gmail_api_configured, send_via_gmail_api
from .graph_mail import graph_configured, send_via_graph
from .models import PasswordResetCode
from .resend_mail import resend_configured, send_via_resend

User = get_user_model()

CODE_TTL_MINUTES = 15


def create_reset_code(user: User) -> PasswordResetCode:
    PasswordResetCode.objects.filter(user=user, used_at__isnull=True).update(
        used_at=timezone.now()
    )
    code = f"{secrets.randbelow(1_000_000):06d}"
    return PasswordResetCode.objects.create(
        user=user,
        code=code,
        expires_at=timezone.now() + timedelta(minutes=CODE_TTL_MINUTES),
    )


def _smtp_usable() -> bool:
    host = (getattr(settings, "EMAIL_HOST", "") or "").strip()
    password = (getattr(settings, "EMAIL_HOST_PASSWORD", "") or "").strip()
    if not host or not password:
        return False
    if password.startswith("PASTE_"):
        return False
    return True


def send_reset_code_email(user: User, code: str) -> None:
    subject = "TradeArena password reset code"
    message = (
        f"Hi {user.username},\n\n"
        f"Your TradeArena password reset code is: {code}\n\n"
        f"This code expires in {CODE_TTL_MINUTES} minutes.\n"
        f"If you did not request this, you can ignore this email.\n"
    )

    # 1) Gmail API — can send to any recipient once OAuth is set up
    if gmail_api_configured():
        send_via_gmail_api(to=user.email, subject=subject, body=message)
        return

    # 2) Resend (free tier: only your Resend signup email unless domain verified)
    if resend_configured():
        send_via_resend(to=user.email, subject=subject, body=message)
        return

    # 3) Microsoft Graph (Outlook / Microsoft 365)
    if graph_configured():
        send_via_graph(to=user.email, subject=subject, body=message)
        return

    # 4) SMTP
    if _smtp_usable():
        send_mail(
            subject=subject,
            message=message,
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[user.email],
            fail_silently=False,
        )
        return

    raise RuntimeError(
        "No email provider configured. Set Gmail OAuth "
        "(python manage.py gmail_oauth_setup), or RESEND_API_KEY / Graph / SMTP."
    )
