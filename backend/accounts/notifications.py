"""Create and list in-app notifications."""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.utils import timezone

from .models import Follow, Notification

User = get_user_model()

LIST_CAP = 50


def notify_user(
    user: User,
    *,
    kind: str,
    title: str,
    body: str,
    actor: User | None = None,
    href: str = "",
) -> Notification:
    return Notification.objects.create(
        user=user,
        actor=actor,
        kind=kind,
        title=title[:120],
        body=body[:280],
        href=href[:200],
    )


def notify_followers_of_trade(
    trader: User,
    *,
    kind: str,
    title: str,
    body: str,
) -> int:
    """Fan-out to everyone following this trader (not the trader themselves)."""
    follower_ids = list(
        Follow.objects.filter(following=trader).values_list("follower_id", flat=True)
    )
    if not follower_ids:
        return 0
    href = f"/traders/{trader.username}"
    Notification.objects.bulk_create(
        [
            Notification(
                user_id=fid,
                actor=trader,
                kind=kind,
                title=title[:120],
                body=body[:280],
                href=href,
            )
            for fid in follower_ids
        ]
    )
    return len(follower_ids)


def serialize_notification(n: Notification) -> dict:
    return {
        "id": n.id,
        "kind": n.kind,
        "title": n.title,
        "body": n.body,
        "href": n.href,
        "read": n.read_at is not None,
        "created_at": n.created_at.isoformat(),
        "actor": (
            {"id": n.actor_id, "username": n.actor.username}
            if n.actor_id and n.actor
            else None
        ),
    }


def list_notifications(user: User, *, unread_only: bool = False) -> list[dict]:
    qs = Notification.objects.filter(user=user).select_related("actor")
    if unread_only:
        qs = qs.filter(read_at__isnull=True)
    return [serialize_notification(n) for n in qs[:LIST_CAP]]


def unread_count(user: User) -> int:
    return Notification.objects.filter(user=user, read_at__isnull=True).count()


def mark_read(user: User, notification_id: int) -> bool:
    updated = Notification.objects.filter(
        user=user, pk=notification_id, read_at__isnull=True
    ).update(read_at=timezone.now())
    return updated > 0


def mark_all_read(user: User) -> int:
    return Notification.objects.filter(user=user, read_at__isnull=True).update(
        read_at=timezone.now()
    )
