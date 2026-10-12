"""Send mail via Gmail API (OAuth2 refresh token)."""

from __future__ import annotations

import base64
from email.mime.text import MIMEText

from django.conf import settings


GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"


def gmail_api_configured() -> bool:
    return bool(
        getattr(settings, "GMAIL_CLIENT_ID", "")
        and getattr(settings, "GMAIL_CLIENT_SECRET", "")
        and getattr(settings, "GMAIL_REFRESH_TOKEN", "")
    )


def _credentials():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    creds = Credentials(
        token=None,
        refresh_token=settings.GMAIL_REFRESH_TOKEN,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=settings.GMAIL_CLIENT_ID,
        client_secret=settings.GMAIL_CLIENT_SECRET,
        scopes=[GMAIL_SEND_SCOPE],
    )
    if not creds.valid:
        creds.refresh(Request())
    return creds


def send_via_gmail_api(*, to: str, subject: str, body: str) -> None:
    """Send a plain-text email as the OAuth-connected Gmail user."""
    from googleapiclient.discovery import build

    if not gmail_api_configured():
        raise RuntimeError(
            "Gmail API not configured. Set GMAIL_CLIENT_ID, "
            "GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN in backend/.env"
        )

    creds = _credentials()
    service = build("gmail", "v1", credentials=creds, cache_discovery=False)

    message = MIMEText(body, "plain", "utf-8")
    message["to"] = to
    message["subject"] = subject
    # From must be the authorized mailbox (or an alias on that account)
    from_addr = getattr(settings, "GMAIL_SENDER", "") or settings.DEFAULT_FROM_EMAIL
    message["from"] = from_addr

    raw = base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")
    service.users().messages().send(userId="me", body={"raw": raw}).execute()
