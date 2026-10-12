"""Follow / following helpers."""

from __future__ import annotations

from django.contrib.auth import get_user_model

from .models import Follow

User = get_user_model()

LIST_CAP = 100


def serialize_user_brief(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
    }


def followers_count(user: User) -> int:
    if user.role != User.Role.TRADER:
        return 0
    return Follow.objects.filter(following=user).count()


def following_count(user: User) -> int:
    return Follow.objects.filter(follower=user).count()


def is_following(*, follower: User, target: User) -> bool:
    if not follower.is_authenticated:
        return False
    return Follow.objects.filter(follower=follower, following=target).exists()


def list_followers(user: User, *, limit: int = LIST_CAP) -> list[dict]:
    if user.role != User.Role.TRADER:
        return []
    qs = (
        Follow.objects.filter(following=user)
        .select_related("follower")
        .order_by("-created_at")[:limit]
    )
    return [
        {**serialize_user_brief(f.follower), "followed_at": f.created_at.isoformat()}
        for f in qs
    ]


def list_following(user: User, *, limit: int = LIST_CAP) -> list[dict]:
    qs = (
        Follow.objects.filter(follower=user)
        .select_related("following")
        .order_by("-created_at")[:limit]
    )
    return [
        {**serialize_user_brief(f.following), "followed_at": f.created_at.isoformat()}
        for f in qs
    ]


def social_payload(user: User) -> dict:
    return {
        "followers_count": followers_count(user),
        "following_count": following_count(user),
        "followers": list_followers(user),
        "following": list_following(user),
    }
