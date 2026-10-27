from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models import CompanyStatus, UserStatus
from app.security.jwt import (
    JwtVerificationError,
    JwtVerifier,
    build_dev_verifier,
    build_jwt_verifier,
    sign_dev_token,
)
from tests.factories import provision_user

AUDIENCE = "authenticated"
TEST_ISSUER = "https://tqwyzrbinkwxbiafbqbj.supabase.co/auth/v1"
TEST_URL = "https://tqwyzrbinkwxbiafbqbj.supabase.co"


def _generate_ec_pair():
    private_key = ec.generate_private_key(ec.SECP256R1())
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return private_pem, public_pem, private_key.public_key()


@pytest.fixture
def ec_keys():
    return _generate_ec_pair()


@pytest.fixture
def other_ec_keys():
    return _generate_ec_pair()


def _es256_payload(*, sub="test-sub-123", aud=AUDIENCE, iss=TEST_ISSUER, exp_seconds=3600):
    now = datetime.now(timezone.utc)
    return {
        "sub": sub,
        "aud": aud,
        "iss": iss,
        "iat": now,
        "exp": now + timedelta(seconds=exp_seconds),
    }


def _sign_es256(private_pem: bytes, payload: dict, kid: str = "supabase-key-1") -> str:
    return jwt.encode(payload, private_pem, algorithm="ES256", headers={"kid": kid})


def test_valid_es256_token_verifies(ec_keys):
    private_pem, public_pem, _ = ec_keys
    verifier = JwtVerifier(
        key_resolver=lambda t: public_pem,
        algorithms=["RS256", "ES256"],
        issuer=TEST_ISSUER,
        audience=AUDIENCE,
    )
    payload = _es256_payload(sub="emp-uuid-1")
    token = _sign_es256(private_pem, payload)
    claims = verifier.verify(token)
    assert claims["sub"] == "emp-uuid-1"
    assert claims["aud"] == AUDIENCE
    assert claims["iss"] == TEST_ISSUER


def test_invalid_signature_es256_rejected(ec_keys, other_ec_keys):
    _, other_pub, _ = ec_keys
    other_priv, _, _ = other_ec_keys
    verifier = JwtVerifier(
        key_resolver=lambda t: other_pub,
        algorithms=["RS256", "ES256"],
        issuer=TEST_ISSUER,
        audience=AUDIENCE,
    )
    token = _sign_es256(other_priv, _es256_payload())
    with pytest.raises(JwtVerificationError):
        verifier.verify(token)


def test_expired_es256_token_rejected(ec_keys):
    private_pem, public_pem, _ = ec_keys
    verifier = JwtVerifier(
        key_resolver=lambda t: public_pem,
        algorithms=["RS256", "ES256"],
        issuer=TEST_ISSUER,
        audience=AUDIENCE,
    )
    token = _sign_es256(private_pem, _es256_payload(exp_seconds=-60))
    with pytest.raises(JwtVerificationError) as exc_info:
        verifier.verify(token)
    assert "expired" in str(exc_info.value).lower()


def test_wrong_issuer_es256_rejected(ec_keys):
    private_pem, public_pem, _ = ec_keys
    verifier = JwtVerifier(
        key_resolver=lambda t: public_pem,
        algorithms=["RS256", "ES256"],
        issuer=TEST_ISSUER,
        audience=AUDIENCE,
    )
    token = _sign_es256(private_pem, _es256_payload(iss="https://evil.supabase.co/auth/v1"))
    with pytest.raises(JwtVerificationError) as exc_info:
        verifier.verify(token)
    assert "issuer" in str(exc_info.value).lower()


def test_wrong_audience_es256_rejected(ec_keys):
    private_pem, public_pem, _ = ec_keys
    verifier = JwtVerifier(
        key_resolver=lambda t: public_pem,
        algorithms=["RS256", "ES256"],
        issuer=TEST_ISSUER,
        audience=AUDIENCE,
    )
    token = _sign_es256(private_pem, _es256_payload(aud="wrong-aud"))
    with pytest.raises(JwtVerificationError) as exc_info:
        verifier.verify(token)
    assert "audience" in str(exc_info.value).lower()


def test_unknown_key_id_or_resolver_failure(ec_keys):
    private_pem, _, _ = ec_keys

    def _resolver_raises(token: str):
        raise JwtVerificationError("key ID unknown in JWKS")

    verifier = JwtVerifier(
        key_resolver=_resolver_raises,
        algorithms=["RS256", "ES256"],
        issuer=TEST_ISSUER,
        audience=AUDIENCE,
    )
    token = _sign_es256(private_pem, _es256_payload(), kid="unknown-kid")
    with pytest.raises(JwtVerificationError) as exc_info:
        verifier.verify(token)
    assert "key ID unknown" in str(exc_info.value)


def test_jwks_service_unavailable_fails_closed(ec_keys):
    private_pem, _, _ = ec_keys

    def _network_failure(token: str):
        raise ConnectionError("JWKS unreachable")

    verifier = JwtVerifier(
        key_resolver=_network_failure,
        algorithms=["RS256", "ES256"],
        issuer=TEST_ISSUER,
        audience=AUDIENCE,
    )
    token = _sign_es256(private_pem, _es256_payload())
    with pytest.raises(JwtVerificationError) as exc_info:
        verifier.verify(token)
    assert "unable to resolve signing key" in str(exc_info.value)


def test_missing_supabase_url_fails_closed():
    settings = Settings(
        _env_file=None,
        app_env="production",
        supabase_url="",
        sync_cursor_secret="x" * 40,
    )
    verifier = build_jwt_verifier(settings)
    with pytest.raises(JwtVerificationError) as exc_info:
        verifier.verify("any.token.here")
    assert "SUPABASE_URL is not configured" in str(exc_info.value)


def test_build_dev_verifier_raises_in_production():
    settings = Settings(
        _env_file=None,
        app_env="production",
        dev_auth_enabled=True,
        dev_jwt_secret="d" * 40,
        sync_cursor_secret="x" * 40,
    )
    with pytest.raises(RuntimeError) as exc_info:
        build_dev_verifier(settings)
    assert "cannot be created in production" in str(exc_info.value)


def test_dev_token_rejected_by_production_verifier(ec_keys):
    _, public_pem, _ = ec_keys
    prod_verifier = JwtVerifier(
        key_resolver=lambda t: public_pem,
        algorithms=["RS256", "ES256"],
        issuer=TEST_ISSUER,
        audience=AUDIENCE,
    )
    dev_settings = Settings(
        _env_file=None,
        app_env="development",
        dev_auth_enabled=True,
        dev_jwt_secret="v" * 40,
        sync_cursor_secret="s" * 40,
    )
    dev_token = sign_dev_token(dev_settings, sub="dev-user-1")

    # HS256 is not in ["RS256", "ES256"] -> Must raise JwtVerificationError
    with pytest.raises(JwtVerificationError):
        prod_verifier.verify(dev_token)


def test_end_to_end_supabase_es256_me_endpoint(ec_keys, db, session_factory, storage):
    private_pem, public_pem, _ = ec_keys
    sub = "supabase-employee-sub-42"
    user, company, _, _ = provision_user(db, auth_user_id=sub)

    prod_settings = Settings(
        _env_file=None,
        app_env="production",
        supabase_url=TEST_URL,
        sync_cursor_secret="s" * 40,
    )
    prod_verifier = JwtVerifier(
        key_resolver=lambda t: public_pem,
        algorithms=["RS256", "ES256"],
        issuer=TEST_ISSUER,
        audience=AUDIENCE,
    )

    app = create_app(
        prod_settings,
        session_factory=session_factory,
        storage=storage,
        verifier=prod_verifier,
    )

    with TestClient(app) as client:
        # 1. Valid ES256 token -> HTTP 200 with user profile
        valid_token = _sign_es256(private_pem, _es256_payload(sub=sub))
        resp = client.get("/me", headers={"Authorization": f"Bearer {valid_token}"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["user"]["id"] == str(user.id)
        assert data["user"]["email"] == user.email
        assert data["company"]["id"] == str(company.id)
        assert data["role"] == "employee"

        # 2. Unprovisioned Supabase account -> HTTP 403 Forbidden
        unprov_token = _sign_es256(private_pem, _es256_payload(sub="unprovisioned-uuid-99"))
        resp_unprov = client.get("/me", headers={"Authorization": f"Bearer {unprov_token}"})
        assert resp_unprov.status_code == 403
        assert "user not provisioned" in resp_unprov.json()["detail"]

        # 3. Inactive user -> HTTP 403 Forbidden
        user.status = UserStatus.inactive
        db.add(user)
        db.commit()
        resp_inactive = client.get("/me", headers={"Authorization": f"Bearer {valid_token}"})
        assert resp_inactive.status_code == 403
        assert "user is not active" in resp_inactive.json()["detail"]

        # 4. Reactivate user, suspend company -> HTTP 403 Forbidden
        user.status = UserStatus.active
        company.status = CompanyStatus.suspended
        db.add(user)
        db.add(company)
        db.commit()
        resp_susp = client.get("/me", headers={"Authorization": f"Bearer {valid_token}"})
        assert resp_susp.status_code == 403
        assert "company is not active" in resp_susp.json()["detail"]

        # 5. Dev token rejected by production app -> HTTP 401
        dev_settings = Settings(
            _env_file=None,
            app_env="development",
            dev_auth_enabled=True,
            dev_jwt_secret="d" * 40,
            sync_cursor_secret="s" * 40,
        )
        dev_token = sign_dev_token(dev_settings, sub=sub)
        resp_dev = client.get("/me", headers={"Authorization": f"Bearer {dev_token}"})
        assert resp_dev.status_code == 401


def test_supabase_cross_company_isolation(ec_keys, db, session_factory, storage):
    private_pem, public_pem, _ = ec_keys
    sub_a = "sub-company-a-employee"
    sub_b = "sub-company-b-employee"

    user_a, comp_a, quarry_a, _ = provision_user(db, auth_user_id=sub_a)
    user_b, comp_b, quarry_b, _ = provision_user(db, auth_user_id=sub_b)

    prod_settings = Settings(
        _env_file=None,
        app_env="production",
        supabase_url=TEST_URL,
        sync_cursor_secret="s" * 40,
    )
    prod_verifier = JwtVerifier(
        key_resolver=lambda t: public_pem,
        algorithms=["RS256", "ES256"],
        issuer=TEST_ISSUER,
        audience=AUDIENCE,
    )

    app = create_app(
        prod_settings,
        session_factory=session_factory,
        storage=storage,
        verifier=prod_verifier,
    )

    with TestClient(app) as client:
        token_a = _sign_es256(private_pem, _es256_payload(sub=sub_a))
        token_b = _sign_es256(private_pem, _es256_payload(sub=sub_b))

        # User A accessing their own quarry documents: 200 OK
        resp_own = client.get(
            f"/quarries/{quarry_a.id}/documents",
            headers={"Authorization": f"Bearer {token_a}"},
        )
        assert resp_own.status_code == 200

        # User A attempting to access Company B's quarry documents: 404 Not Found (tenant leak protection)
        resp_foreign = client.get(
            f"/quarries/{quarry_b.id}/documents",
            headers={"Authorization": f"Bearer {token_a}"},
        )
        assert resp_foreign.status_code == 404
        assert "quarry not found" in resp_foreign.json()["detail"]

        # User B attempting to access Company A's quarry documents: 404 Not Found
        resp_foreign_b = client.get(
            f"/quarries/{quarry_a.id}/documents",
            headers={"Authorization": f"Bearer {token_b}"},
        )
        assert resp_foreign_b.status_code == 404
        assert "quarry not found" in resp_foreign_b.json()["detail"]

        # Employee attempting company admin management endpoint: 403 Forbidden
        resp_admin = client.get(
            "/company/employees",
            headers={"Authorization": f"Bearer {token_a}"},
        )
        assert resp_admin.status_code == 403

