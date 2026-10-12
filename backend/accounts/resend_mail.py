"""Send mail via Resend HTTP API (no Google login required)."""

from __future__ import annotations

import httpx
from django.conf import settings


def resend_configured() -> bool:
    return bool(getattr(settings, "RESEND_API_KEY", "").strip())


def send_via_resend(*, to: str, subject: str, body: str) -> None:
    api_key = settings.RESEND_API_KEY.strip()
    if not api_key:
        raise RuntimeError("RESEND_API_KEY is not set")

    from_addr = (
        getattr(settings, "RESEND_FROM_EMAIL", "").strip()
        or settings.DEFAULT_FROM_EMAIL
    )

    resp = httpx.post(
        "https://api.resend.com/emails",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "from": from_addr,
            "to": [to],
            "subject": subject,
            "text": body,
        },
        timeout=20.0,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"Resend error {resp.status_code}: {resp.text}")
