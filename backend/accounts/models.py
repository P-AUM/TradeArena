from django.contrib.auth.models import AbstractUser, UserManager as DjangoUserManager
from django.db import models
from django.utils import timezone


class UserManager(DjangoUserManager):
    """createsuperuser → TradeArena role=admin + Django staff/superuser."""

    def create_superuser(self, username, email=None, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        extra_fields["role"] = User.Role.ADMIN
        return super().create_superuser(username, email, password, **extra_fields)


class User(AbstractUser):
    class Role(models.TextChoices):
        TRADER = "trader", "Trader"
        VIEWER = "viewer", "Viewer"
        ADMIN = "admin", "Admin"

    email = models.EmailField(unique=True)
    role = models.CharField(
        max_length=20,
        choices=Role.choices,
        help_text="Locked at signup. Cannot be changed.",
    )

    objects = UserManager()

    # role is set automatically for createsuperuser; do not prompt for it
    REQUIRED_FIELDS = ["email"]

    def save(self, *args, **kwargs):
        # Keep project admin role aligned with Django superuser
        if self.is_superuser:
            self.role = self.Role.ADMIN
            self.is_staff = True
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return f"{self.username} ({self.role})"


class PasswordResetCode(models.Model):
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="password_reset_codes",
    )
    code = models.CharField(max_length=6)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    verified_at = models.DateTimeField(null=True, blank=True)
    used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def is_valid(self) -> bool:
        return self.used_at is None and timezone.now() <= self.expires_at

    def __str__(self) -> str:
        return f"Reset for {self.user.email} ({self.code})"


class Follow(models.Model):
    """Anyone may follow a trader. Viewers cannot be followed."""

    follower = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="following_set",
    )
    following = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="follower_set",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["follower", "following"],
                name="unique_follow_pair",
            ),
            models.CheckConstraint(
                condition=~models.Q(follower=models.F("following")),
                name="no_self_follow",
            ),
        ]
        ordering = ["-created_at"]

    def clean(self) -> None:
        from django.core.exceptions import ValidationError

        if self.follower_id and self.following_id:
            if self.follower_id == self.following_id:
                raise ValidationError("You cannot follow yourself.")
            if self.following.role != User.Role.TRADER:
                raise ValidationError("You can only follow traders.")

    def save(self, *args, **kwargs):
        self.full_clean()
        return super().save(*args, **kwargs)

    def __str__(self) -> str:
        return f"{self.follower_id} → {self.following_id}"


class Notification(models.Model):
    """In-app alert for a user (e.g. followed trader opened/closed)."""

    class Kind(models.TextChoices):
        TRADE_OPEN = "trade_open", "Trade opened"
        TRADE_CLOSE = "trade_close", "Trade closed"
        STOP_HIT = "stop_hit", "Stop-loss hit"
        TAKE_PROFIT_HIT = "take_profit_hit", "Take-profit hit"

    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="notifications",
    )
    actor = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="triggered_notifications",
        null=True,
        blank=True,
    )
    kind = models.CharField(max_length=32, choices=Kind.choices)
    title = models.CharField(max_length=120)
    body = models.CharField(max_length=280)
    href = models.CharField(max_length=200, blank=True, default="")
    read_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.user_id}: {self.kind} ({self.title})"
