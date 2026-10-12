"""
One-time OAuth helper: get a Gmail API refresh token for sending OTP mail.

Prereqs (Google Cloud Console):
  1. Create a project
  2. Enable "Gmail API"
  3. Configure OAuth consent screen (External / Testing is fine for personal use)
  4. Create OAuth client ID → Application type: Desktop app
  5. Copy Client ID + Client Secret into backend/.env

Then run:
  python manage.py gmail_oauth_setup

It prints a GMAIL_REFRESH_TOKEN — paste that into .env and restart the server.
"""

from django.conf import settings
from django.core.management.base import BaseCommand


SCOPES = ["https://www.googleapis.com/auth/gmail.send"]


class Command(BaseCommand):
    help = "Authorize Gmail API and print a refresh token for .env"

    def handle(self, *args, **options):
        client_id = getattr(settings, "GMAIL_CLIENT_ID", "") or ""
        client_secret = getattr(settings, "GMAIL_CLIENT_SECRET", "") or ""

        if not client_id or not client_secret:
            self.stderr.write(
                self.style.ERROR(
                    "Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in backend/.env first."
                )
            )
            return

        try:
            from google_auth_oauthlib.flow import InstalledAppFlow
        except ImportError:
            self.stderr.write(
                self.style.ERROR(
                    "Missing packages. Run: pip install google-api-python-client "
                    "google-auth-httplib2 google-auth-oauthlib"
                )
            )
            return

        client_config = {
            "installed": {
                "client_id": client_id,
                "client_secret": client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": ["http://localhost"],
            }
        }

        self.stdout.write(
            "\nIMPORTANT (avoids Google verify / login blocks):\n"
            "  - Consent screen must be External + Testing\n"
            "  - The Gmail you sign in with MUST be listed under Test users\n"
            "  - Use a Desktop OAuth client (not Web)\n"
            "  - If you authorized before: "
            "https://myaccount.google.com/permissions -> remove this app, then retry\n\n"
            "A browser window will open. Sign in with the Gmail that should SEND "
            "TradeArena OTP emails, then allow gmail.send.\n"
        )

        flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
        # Fixed port is easier if Google Cloud redirect ever needs listing
        creds = flow.run_local_server(
            port=8090, prompt="consent", access_type="offline"
        )

        if not creds.refresh_token:
            self.stderr.write(
                self.style.ERROR(
                    "No refresh_token returned. Revoke prior access at "
                    "https://myaccount.google.com/permissions then run again."
                )
            )
            return

        self.stdout.write(self.style.SUCCESS("\nAdd these to backend/.env:\n"))
        self.stdout.write(f"GMAIL_CLIENT_ID={client_id}")
        self.stdout.write(f"GMAIL_CLIENT_SECRET={client_secret}")
        self.stdout.write(f"GMAIL_REFRESH_TOKEN={creds.refresh_token}")
        self.stdout.write(
            "GMAIL_SENDER=TradeArena <your-gmail@gmail.com>\n"
            "DEFAULT_FROM_EMAIL=TradeArena <your-gmail@gmail.com>\n"
        )
        self.stdout.write(
            self.style.WARNING(
                "Restart the Django server after saving .env. "
                "OTP emails will send from that Gmail inbox."
            )
        )
