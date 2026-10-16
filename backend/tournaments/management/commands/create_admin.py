from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

User = get_user_model()


class Command(BaseCommand):
    help = "Create or promote a TradeArena admin user (role=admin)."

    def add_arguments(self, parser):
        parser.add_argument("--username", required=True)
        parser.add_argument("--email", required=True)
        parser.add_argument("--password", required=True)

    def handle(self, *args, **options):
        username = options["username"].strip()
        email = options["email"].strip().lower()
        password = options["password"]
        if not username or not email or not password:
            raise CommandError("username, email, and password are required")

        by_user = User.objects.filter(username__iexact=username).first()
        by_email = User.objects.filter(email__iexact=email).first()

        if by_user and by_email and by_user.pk != by_email.pk:
            raise CommandError(
                f"Username '{username}' belongs to one account and email "
                f"'{email}' to another. Use matching credentials, or pick a "
                f"free email."
            )

        user = by_user or by_email
        if user:
            user.username = username
            user.email = email
            user.role = User.Role.ADMIN
            user.set_password(password)
            user.is_staff = True
            user.is_superuser = True  # required for Django /admin/ model access
            user.save()
            self.stdout.write(self.style.SUCCESS(f"Updated admin: {user.username}"))
            return

        user = User.objects.create_user(
            username=username,
            email=email,
            password=password,
            role=User.Role.ADMIN,
            is_staff=True,
            is_superuser=True,
        )
        self.stdout.write(self.style.SUCCESS(f"Created admin: {user.username}"))
