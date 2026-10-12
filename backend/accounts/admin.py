from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin

from .models import Follow, Notification, PasswordResetCode, User


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    list_display = ("username", "email", "role", "is_staff", "date_joined")
    list_filter = ("role", "is_staff", "is_superuser")
    fieldsets = DjangoUserAdmin.fieldsets + (
        ("TradeArena", {"fields": ("role",)}),
    )
    add_fieldsets = DjangoUserAdmin.add_fieldsets + (
        ("TradeArena", {"fields": ("role",)}),
    )

    def get_readonly_fields(self, request, obj=None):
        if obj:
            return ("role",)
        return ()


@admin.register(PasswordResetCode)
class PasswordResetCodeAdmin(admin.ModelAdmin):
    list_display = ("user", "code", "created_at", "expires_at", "verified_at", "used_at")
    list_filter = ("used_at",)
    search_fields = ("user__email", "user__username", "code")
    readonly_fields = ("user", "code", "created_at", "expires_at", "verified_at", "used_at")


@admin.register(Follow)
class FollowAdmin(admin.ModelAdmin):
    list_display = ("follower", "following", "created_at")
    search_fields = ("follower__username", "following__username")
    readonly_fields = ("created_at",)


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ("user", "kind", "title", "read_at", "created_at")
    list_filter = ("kind",)
    search_fields = ("user__username", "title", "body")
    readonly_fields = ("created_at",)
