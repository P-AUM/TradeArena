from django.contrib.auth import get_user_model
from rest_framework import serializers

User = get_user_model()


class SignupSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=8)

    class Meta:
        model = User
        fields = ("id", "username", "email", "password", "role")
        extra_kwargs = {
            # Custom uniqueness messages in validate()
            "username": {"validators": []},
            "email": {"validators": []},
        }

    def validate_role(self, value: str) -> str:
        allowed = {User.Role.TRADER, User.Role.VIEWER}
        if value not in allowed:
            raise serializers.ValidationError("Role must be 'trader' or 'viewer'.")
        return value

    def validate(self, attrs):
        username = (attrs.get("username") or "").strip()
        email = (attrs.get("email") or "").strip().lower()
        attrs["username"] = username
        attrs["email"] = email

        if not username:
            raise serializers.ValidationError(
                {"username": "username not available - try other"}
            )

        user_taken = User.objects.filter(username__iexact=username).exists()
        email_taken = User.objects.filter(email__iexact=email).exists()

        if user_taken and email_taken:
            raise serializers.ValidationError("user already exist")
        if user_taken:
            raise serializers.ValidationError(
                {"username": "username not available - try other"}
            )
        if email_taken:
            raise serializers.ValidationError({"email": "email already exist"})
        return attrs

    def create(self, validated_data):
        return User.objects.create_user(
            username=validated_data["username"],
            email=validated_data["email"],
            password=validated_data["password"],
            role=validated_data["role"],
        )


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ("id", "username", "email", "role", "date_joined")
        read_only_fields = fields


class ForgotPasswordSerializer(serializers.Serializer):
    email = serializers.EmailField()


class VerifyResetCodeSerializer(serializers.Serializer):
    email = serializers.EmailField()
    code = serializers.CharField(min_length=6, max_length=6)


class ResetPasswordSerializer(serializers.Serializer):
    email = serializers.EmailField()
    code = serializers.CharField(min_length=6, max_length=6)
    new_password = serializers.CharField(min_length=8, write_only=True)
