from __future__ import annotations

import logging
import secrets
import threading
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.mail import EmailMessage
from django.db import close_old_connections
from django.utils import timezone

from .models import PasswordResetCode

logger = logging.getLogger(__name__)

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


def smtp_configured() -> bool:
    host = (getattr(settings, "EMAIL_HOST", "") or "").strip()
    password = (getattr(settings, "EMAIL_HOST_PASSWORD", "") or "").strip()
    if not host or not password:
        return False
    if password.startswith("PASTE_"):
        return False
    return True


def send_reset_code_email_async(user: User, code: str) -> None:
    """Send via SMTP in a thread so the HTTP response is not blocked."""
    username = user.username
    email = user.email

    def _run() -> None:
        close_old_connections()
        try:
            send_reset_code_email(username, email, code)
        except Exception:
            logger.exception("Failed to send password reset email to %s", email)
        finally:
            close_old_connections()

    threading.Thread(target=_run, daemon=True, name="ta-reset-email").start()


def _from_header() -> str:
    """Use DEFAULT_FROM_EMAIL as the visible From — never EMAIL_HOST_USER.

    EMAIL_HOST_USER is only the SMTP login. Gmail SMTP still rewrites From to
    the login mailbox unless DEFAULT_FROM_EMAIL is that Gmail address (or a
    verified Gmail 'Send mail as' alias). Other SMTP hosts (Mailjet, domain
    mail) show this header when the sender is verified.
    """
    raw = (getattr(settings, "DEFAULT_FROM_EMAIL", "") or "").strip()
    if not raw:
        raise RuntimeError("DEFAULT_FROM_EMAIL is not set in backend/.env")
    if "<" in raw:
        return raw
    return f"TradeArena <{raw}>"


def send_reset_code_email(username: str, email: str, code: str) -> None:
    if not smtp_configured():
        raise RuntimeError(
            "SMTP is not configured. Set EMAIL_HOST, EMAIL_HOST_USER, "
            "and EMAIL_HOST_PASSWORD in backend/.env"
        )

    from_header = _from_header()
    msg = EmailMessage(
        subject="TradeArena password reset code",
        body=(
            f"Hi {username},\n\n"
            f"Your TradeArena password reset code is: {code}\n\n"
            f"This code expires in {CODE_TTL_MINUTES} minutes.\n"
            f"If you did not request this, you can ignore this email.\n"
        ),
        from_email=from_header,
        to=[email],
        headers={
            "From": from_header,
            "Reply-To": from_header,
            "Sender": from_header,
        },
    )
    msg.send(fail_silently=False)
