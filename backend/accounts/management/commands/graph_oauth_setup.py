"""
One-time Microsoft Graph OAuth (device code) for personal Outlook / Hotmail.

Azure portal steps:
  1) https://entra.microsoft.com → App registrations → New registration
  2) Name: TradeArena
  3) Supported account types: "Personal Microsoft accounts only"
     (or "Accounts in any org + personal")
  4) Register → copy Application (client) ID into GRAPH_CLIENT_ID
  5) Authentication → Allow public client flows = Yes
  6) API permissions → Microsoft Graph → Delegated → Mail.Send
     (+ offline_access is requested by the script)
  7) (Optional) Certificates & secrets → New client secret → GRAPH_CLIENT_SECRET

Then run:
  python manage.py graph_oauth_setup

Sign in on the phone/PC with the Outlook account that should SEND OTPs.
Paste the printed GRAPH_REFRESH_TOKEN into backend/.env and restart Django.
"""

from django.conf import settings
from django.core.management.base import BaseCommand


SCOPES = ["https://graph.microsoft.com/Mail.Send", "offline_access"]


class Command(BaseCommand):
    help = "Authorize Microsoft Graph and print a refresh token for .env"

    def handle(self, *args, **options):
        client_id = getattr(settings, "GRAPH_CLIENT_ID", "") or ""
        client_secret = getattr(settings, "GRAPH_CLIENT_SECRET", "") or ""
        tenant = getattr(settings, "GRAPH_TENANT_ID", "") or "consumers"

        if not client_id:
            self.stderr.write(
                self.style.ERROR("Set GRAPH_CLIENT_ID in backend/.env first.")
            )
            return

        try:
            import msal
        except ImportError:
            self.stderr.write(
                self.style.ERROR("Missing package. Run: pip install msal")
            )
            return

        authority = f"https://login.microsoftonline.com/{tenant}"
        if client_secret:
            app = msal.ConfidentialClientApplication(
                client_id,
                authority=authority,
                client_credential=client_secret,
            )
        else:
            app = msal.PublicClientApplication(client_id, authority=authority)

        flow = app.initiate_device_flow(scopes=SCOPES)
        if "user_code" not in flow:
            self.stderr.write(
                self.style.ERROR(f"Device flow failed: {flow}")
            )
            return

        self.stdout.write(self.style.WARNING("\n" + flow["message"] + "\n"))
        result = app.acquire_token_by_device_flow(flow)

        if "refresh_token" not in result:
            self.stderr.write(
                self.style.ERROR(
                    f"No refresh_token. Error: "
                    f"{result.get('error_description') or result}"
                )
            )
            return

        self.stdout.write(self.style.SUCCESS("\nAdd these to backend/.env:\n"))
        self.stdout.write(f"GRAPH_TENANT_ID={tenant}")
        self.stdout.write(f"GRAPH_CLIENT_ID={client_id}")
        if client_secret:
            self.stdout.write(f"GRAPH_CLIENT_SECRET={client_secret}")
        self.stdout.write(f"GRAPH_REFRESH_TOKEN={result['refresh_token']}")
        account = (result.get("id_token_claims") or {}).get("preferred_username")
        if account:
            self.stdout.write(f"GRAPH_SENDER_EMAIL={account}")
            self.stdout.write(f"DEFAULT_FROM_EMAIL=TradeArena <{account}>")
        self.stdout.write(
            self.style.WARNING(
                "\nRestart Django after saving .env. OTP mail will send from that Outlook inbox."
            )
        )
