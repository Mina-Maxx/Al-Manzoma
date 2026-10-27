from __future__ import annotations

import pytest

from app.config import Settings
from app.services import identity as identity_mod
from app.services.identity import (
    IdentityAlreadyExists,
    IdentityError,
    SupabaseIdentityProvider,
    UnconfiguredIdentityProvider,
    build_identity_provider,
)


def _settings(**kwargs) -> Settings:
    return Settings(_env_file=None, app_env="test", **kwargs)


class _Resp:
    def __init__(self, status_code: int, payload: dict | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {}

    def json(self) -> dict:
        return self._payload


class _Client:
    """Stand-in for httpx.Client; records the last request."""

    last: tuple | None = None
    post_status = 200
    post_payload: dict = {}
    put_status = 200
    put_payload: dict = {}

    def __init__(self, *args, **kwargs) -> None:
        pass

    def __enter__(self) -> "_Client":
        return self

    def __exit__(self, *args) -> bool:
        return False

    def post(self, url, headers=None, json=None) -> _Resp:
        _Client.last = ("post", url, headers, json)
        return _Resp(_Client.post_status, _Client.post_payload)

    def put(self, url, headers=None, json=None) -> _Resp:
        _Client.last = ("put", url, headers, json)
        return _Resp(_Client.put_status, _Client.put_payload)


def test_unconfigured_provider_fails_safely():
    provider = build_identity_provider(_settings())
    assert isinstance(provider, UnconfiguredIdentityProvider)
    with pytest.raises(IdentityError):
        provider.invite_user(email="a@example.com")


def test_supabase_provider_needs_key():
    with pytest.raises(IdentityError):
        SupabaseIdentityProvider(_settings(supabase_url="https://x.supabase.co"))


def test_supabase_invite_parses_id(monkeypatch):
    provider = SupabaseIdentityProvider(
        _settings(
            supabase_url="https://x.supabase.co",
            supabase_service_role_key="secret-key-value",
        )
    )
    _Client.post_status = 200
    _Client.post_payload = {"id": "abc-123"}
    monkeypatch.setattr(identity_mod.httpx, "Client", _Client)

    assert provider.invite_user(email="a@example.com", full_name="A") == "abc-123"

    method, url, headers, body = _Client.last
    assert method == "post"
    assert url.endswith("/auth/v1/invite")
    assert headers["apikey"] == "secret-key-value"
    assert body["email"] == "a@example.com"
    assert body["data"] == {"full_name": "A"}
    assert body["redirect_to"].endswith("/dashboard/accept-invite")


def test_supabase_invite_duplicate_email(monkeypatch):
    provider = SupabaseIdentityProvider(
        _settings(
            supabase_url="https://x.supabase.co",
            supabase_service_role_key="secret-key-value",
        )
    )
    _Client.post_status = 409
    monkeypatch.setattr(identity_mod.httpx, "Client", _Client)

    with pytest.raises(IdentityAlreadyExists):
        provider.invite_user(email="a@example.com")


def test_supabase_invite_provider_error(monkeypatch):
    provider = SupabaseIdentityProvider(
        _settings(
            supabase_url="https://x.supabase.co",
            supabase_service_role_key="secret-key-value",
        )
    )
    _Client.post_status = 500
    monkeypatch.setattr(identity_mod.httpx, "Client", _Client)

    with pytest.raises(IdentityError):
        provider.invite_user(email="a@example.com")


def test_supabase_disable_and_enable(monkeypatch):
    provider = SupabaseIdentityProvider(
        _settings(
            supabase_url="https://x.supabase.co",
            supabase_service_role_key="secret-key-value",
        )
    )
    monkeypatch.setattr(identity_mod.httpx, "Client", _Client)

    _Client.put_status = 200
    provider.disable_user("abc")
    method, url, _headers, body = _Client.last
    assert method == "put"
    assert url.endswith("/auth/v1/admin/users/abc")
    assert body == {"ban_duration": "876000h"}

    provider.enable_user("abc")
    assert _Client.last[3] == {"ban_duration": "none"}
