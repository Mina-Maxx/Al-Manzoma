from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import INSECURE_DEV_SECRET, Settings
from app.main import create_app

VALID_SECRET = "v" * 40
_ENV_KEYS = ("APP_ENV", "DEV_AUTH_ENABLED", "DEV_JWT_SECRET", "SUPABASE_URL")


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def _settings(**kwargs) -> Settings:
    return Settings(_env_file=None, **kwargs)


def _dev_token_paths(app) -> set[str]:
    return set(app.openapi().get("paths", {}))


def test_missing_app_env_does_not_enable_dev_auth():
    settings = _settings(dev_auth_enabled=True, dev_jwt_secret=VALID_SECRET)
    assert settings.app_env is None
    assert settings.dev_auth_active is False

    app = create_app(settings)
    assert "/dev/token" not in _dev_token_paths(app)
    with TestClient(app) as client:
        assert client.post("/dev/token", json={"sub": "x"}).status_code == 404


def test_dev_auth_disabled_by_default():
    settings = _settings(app_env="development")
    assert settings.dev_auth_enabled is False
    assert settings.dev_auth_active is False

    app = create_app(settings)
    assert "/dev/token" not in _dev_token_paths(app)


def test_production_ignores_dev_auth_enabled():
    settings = _settings(
        app_env="production", dev_auth_enabled=True, dev_jwt_secret=VALID_SECRET
    )
    assert settings.dev_auth_active is False

    app = create_app(settings)
    assert "/dev/token" not in _dev_token_paths(app)


def test_dev_token_cannot_issue_in_production():
    settings = _settings(
        app_env="production", dev_auth_enabled=True, dev_jwt_secret=VALID_SECRET
    )
    app = create_app(settings)
    with TestClient(app) as client:
        response = client.post("/dev/token", json={"sub": "x"})
    assert response.status_code == 404
    assert "access_token" not in response.text


def test_default_dev_secret_is_rejected():
    with pytest.raises(ValidationError) as exc:
        _settings(app_env="development", dev_auth_enabled=True)
    message = str(exc.value)
    assert "DEV_JWT_SECRET" in message
    assert INSECURE_DEV_SECRET not in message


def test_explicit_default_dev_secret_is_rejected():
    with pytest.raises(ValidationError):
        _settings(
            app_env="development",
            dev_auth_enabled=True,
            dev_jwt_secret=INSECURE_DEV_SECRET,
        )


def test_short_dev_secret_is_rejected():
    with pytest.raises(ValidationError) as exc:
        _settings(
            app_env="development",
            dev_auth_enabled=True,
            dev_jwt_secret="too-short-secret",
        )
    message = str(exc.value)
    assert "32" in message
    assert "too-short-secret" not in message


def test_explicit_valid_dev_config_works():
    settings = _settings(
        app_env="development", dev_auth_enabled=True, dev_jwt_secret=VALID_SECRET
    )
    assert settings.dev_auth_active is True

    app = create_app(settings)
    assert "/dev/token" in _dev_token_paths(app)
    with TestClient(app) as client:
        response = client.post("/dev/token", json={"sub": "someone"})
    assert response.status_code == 200
    token = response.json()["access_token"]
    claims = app.state.verifier.verify(token)
    assert claims["sub"] == "someone"
