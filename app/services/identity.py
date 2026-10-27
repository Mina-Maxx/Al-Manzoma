from __future__ import annotations

from abc import ABC, abstractmethod

import httpx

from app.config import Settings


class IdentityError(Exception):
    """Identity-provider failure. Message is always safe (no key, no token)."""


class IdentityAlreadyExists(IdentityError):
    """The email already has an identity at the provider."""


class IdentityProvider(ABC):
    """Swappable identity backend (Supabase today; anything else later)."""

    @abstractmethod
    def invite_user(self, *, email: str, full_name: str | None = None) -> str:
        """Create an identity for ``email`` and return its auth user id."""

    @abstractmethod
    def disable_user(self, auth_user_id: str) -> None:
        """Prevent ``auth_user_id`` from authenticating."""

    @abstractmethod
    def enable_user(self, auth_user_id: str) -> None:
        """Reverse :meth:`disable_user`."""


class UnconfiguredIdentityProvider(IdentityProvider):
    """Starts the app without Admin API config; every call fails safely.

    Mirrors the deferred-failure behaviour of the JWT verifier: importing the
    app must not require Supabase Admin credentials.
    """

    def invite_user(self, *, email: str, full_name: str | None = None) -> str:
        raise IdentityError("identity provider is not configured")

    def disable_user(self, auth_user_id: str) -> None:
        raise IdentityError("identity provider is not configured")

    def enable_user(self, auth_user_id: str) -> None:
        raise IdentityError("identity provider is not configured")


class SupabaseIdentityProvider(IdentityProvider):
    """Supabase Admin API. The service-role key never leaves the backend."""

    _BAN_FOREVER = "876000h"  # ~100 years; Supabase "ban" is its disable.

    def __init__(self, settings: Settings, *, timeout: float = 10.0) -> None:
        if not settings.supabase_url or not settings.supabase_service_role_key:
            raise IdentityError("Supabase Admin API is not configured")
        self._base = settings.supabase_url.rstrip("/")
        self._key = settings.supabase_service_role_key
        self._invite_redirect = settings.invite_redirect_url
        self._timeout = timeout

    def _headers(self) -> dict[str, str]:
        return {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Content-Type": "application/json",
        }

    def invite_user(self, *, email: str, full_name: str | None = None) -> str:
        # Use the *invite* endpoint (not admin/users) so Supabase actually sends
        # an invitation email whose link returns to the dashboard to set a
        # password. ``redirect_to`` must be allow-listed in Supabase.
        body: dict = {"email": email, "redirect_to": self._invite_redirect}
        if full_name:
            body["data"] = {"full_name": full_name}
        try:
            with httpx.Client(timeout=self._timeout) as client:
                response = client.post(
                    f"{self._base}/auth/v1/invite",
                    headers=self._headers(),
                    json=body,
                )
        except httpx.HTTPError as exc:
            raise IdentityError("identity provider unavailable") from exc
        if response.status_code in (409, 422):
            raise IdentityAlreadyExists("email already registered")
        if response.status_code >= 400:
            raise IdentityError(
                f"identity provider error ({response.status_code})"
            )
        auth_user_id = response.json().get("id")
        if not auth_user_id:
            raise IdentityError("identity provider returned no id")
        return str(auth_user_id)

    def _update(self, auth_user_id: str, body: dict) -> None:
        try:
            with httpx.Client(timeout=self._timeout) as client:
                response = client.put(
                    f"{self._base}/auth/v1/admin/users/{auth_user_id}",
                    headers=self._headers(),
                    json=body,
                )
        except httpx.HTTPError as exc:
            raise IdentityError("identity provider unavailable") from exc
        if response.status_code >= 400:
            raise IdentityError(f"identity provider error ({response.status_code})")

    def disable_user(self, auth_user_id: str) -> None:
        self._update(auth_user_id, {"ban_duration": self._BAN_FOREVER})

    def enable_user(self, auth_user_id: str) -> None:
        self._update(auth_user_id, {"ban_duration": "none"})


def build_identity_provider(settings: Settings) -> IdentityProvider:
    if settings.supabase_url and settings.supabase_service_role_key:
        return SupabaseIdentityProvider(settings)
    return UnconfiguredIdentityProvider()
