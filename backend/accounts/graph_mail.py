"""Send mail via Microsoft Graph API.

Supports:
  1) Delegated (personal Outlook / Hotmail) — GRAPH_REFRESH_TOKEN from
     `python manage.py graph_oauth_setup`
  2) App-only (Microsoft 365 work/school) — client credentials + GRAPH_SENDER_EMAIL
"""

from __future__ import annotations

import httpx
from django.conf import settings

GRAPH_SCOPE_DELEGATED = ["https://graph.microsoft.com/Mail.Send", "offline_access"]
GRAPH_SCOPE_APP = ["https://graph.microsoft.com/.default"]


def graph_configured() -> bool:
    client_id = getattr(settings, "GRAPH_CLIENT_ID", "").strip()
    if not client_id:
        return False
    # Delegated personal / work user
    if getattr(settings, "GRAPH_REFRESH_TOKEN", "").strip():
        return True
    # App-only (M365 mailbox)
    return bool(
        getattr(settings, "GRAPH_TENANT_ID", "").strip()
        and getattr(settings, "GRAPH_CLIENT_SECRET", "").strip()
        and getattr(settings, "GRAPH_SENDER_EMAIL", "").strip()
    )


def _authority() -> str:
    tenant = getattr(settings, "GRAPH_TENANT_ID", "").strip() or "consumers"
    return f"https://login.microsoftonline.com/{tenant}"


def _token_delegated() -> str:
    import msal

    client_id = settings.GRAPH_CLIENT_ID.strip()
    client_secret = getattr(settings, "GRAPH_CLIENT_SECRET", "").strip()
    refresh = settings.GRAPH_REFRESH_TOKEN.strip()

    if client_secret:
        app = msal.ConfidentialClientApplication(
            client_id,
            authority=_authority(),
            client_credential=client_secret,
        )
    else:
        app = msal.PublicClientApplication(client_id, authority=_authority())

    result = app.acquire_token_by_refresh_token(refresh, scopes=GRAPH_SCOPE_DELEGATED)
    if "access_token" not in result:
        raise RuntimeError(
            f"Graph delegated token failed: {result.get('error_description') or result}"
        )
    return result["access_token"]


def _token_app_only() -> str:
    import msal

    app = msal.ConfidentialClientApplication(
        settings.GRAPH_CLIENT_ID.strip(),
        authority=_authority(),
        client_credential=settings.GRAPH_CLIENT_SECRET.strip(),
    )
    result = app.acquire_token_for_client(scopes=GRAPH_SCOPE_APP)
    if "access_token" not in result:
        raise RuntimeError(
            f"Graph app token failed: {result.get('error_description') or result}"
        )
    return result["access_token"]


def _send_payload(to: str, subject: str, body: str) -> dict:
    return {
        "message": {
            "subject": subject,
            "body": {"contentType": "Text", "content": body},
            "toRecipients": [{"emailAddress": {"address": to}}],
        },
        "saveToSentItems": "true",
    }


def send_via_graph(*, to: str, subject: str, body: str) -> None:
    if not graph_configured():
        raise RuntimeError(
            "Microsoft Graph not configured. Set GRAPH_CLIENT_ID and either "
            "GRAPH_REFRESH_TOKEN (delegated) or GRAPH_TENANT_ID + "
            "GRAPH_CLIENT_SECRET + GRAPH_SENDER_EMAIL (app-only)."
        )

    if getattr(settings, "GRAPH_REFRESH_TOKEN", "").strip():
        token = _token_delegated()
        url = "https://graph.microsoft.com/v1.0/me/sendMail"
    else:
        token = _token_app_only()
        sender = settings.GRAPH_SENDER_EMAIL.strip()
        url = f"https://graph.microsoft.com/v1.0/users/{sender}/sendMail"

    resp = httpx.post(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json=_send_payload(to, subject, body),
        timeout=20.0,
    )
    # Graph sendMail returns 202 Accepted on success
    if resp.status_code not in (200, 202):
        raise RuntimeError(f"Graph sendMail error {resp.status_code}: {resp.text}")
