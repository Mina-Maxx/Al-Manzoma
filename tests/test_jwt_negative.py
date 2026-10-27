from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.security.jwt import JwtVerificationError, JwtVerifier

AUDIENCE = "authenticated"
HMAC_SECRET = "an-hmac-secret-value-that-is-long-enough-1234"


def _other_private_pem() -> bytes:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


def _payload(settings, *, aud=AUDIENCE, iss=None, exp_seconds=60, sub="u") -> dict:
    now = datetime.now(timezone.utc)
    return {
        "sub": sub,
        "aud": aud,
        "iss": settings.jwt_issuer if iss is None else iss,
        "iat": now,
        "exp": now + timedelta(seconds=exp_seconds),
    }


@pytest.fixture
def local_verifier(settings, rsa_keys):
    _, public_key = rsa_keys
    return JwtVerifier(
        key_resolver=lambda token: public_key,
        algorithms=["RS256"],
        issuer=settings.jwt_issuer,
        audience=AUDIENCE,
    )


def _me(client, token: str):
    return client.get("/me", headers={"Authorization": f"Bearer {token}"})


# --- verifier-level: the expected error is JwtVerificationError ---


def test_invalid_signature_is_rejected_by_verifier(settings, local_verifier):
    token = jwt.encode(_payload(settings), _other_private_pem(), algorithm="RS256")
    with pytest.raises(JwtVerificationError):
        local_verifier.verify(token)


def test_wrong_issuer_is_rejected_by_verifier(settings, rsa_keys, local_verifier):
    private_pem, _ = rsa_keys
    token = jwt.encode(_payload(settings, iss="https://evil.example/auth/v1"), private_pem, algorithm="RS256")
    with pytest.raises(JwtVerificationError):
        local_verifier.verify(token)


def test_wrong_audience_is_rejected_by_verifier(settings, rsa_keys, local_verifier):
    private_pem, _ = rsa_keys
    token = jwt.encode(_payload(settings, aud="some-other-audience"), private_pem, algorithm="RS256")
    with pytest.raises(JwtVerificationError):
        local_verifier.verify(token)


def test_expired_token_is_rejected_by_verifier(settings, rsa_keys, local_verifier):
    private_pem, _ = rsa_keys
    token = jwt.encode(_payload(settings, exp_seconds=-30), private_pem, algorithm="RS256")
    with pytest.raises(JwtVerificationError):
        local_verifier.verify(token)


def test_disallowed_algorithm_is_rejected_by_verifier(settings, local_verifier):
    token = jwt.encode(_payload(settings), HMAC_SECRET, algorithm="HS256")
    with pytest.raises(JwtVerificationError):
        local_verifier.verify(token)


# --- application-level: the expected outcome is HTTP 401 ---


def test_invalid_signature_returns_401(client, settings):
    token = jwt.encode(_payload(settings), _other_private_pem(), algorithm="RS256")
    assert _me(client, token).status_code == 401


def test_wrong_issuer_returns_401(client, settings, rsa_keys):
    private_pem, _ = rsa_keys
    token = jwt.encode(_payload(settings, iss="https://evil.example/auth/v1"), private_pem, algorithm="RS256")
    assert _me(client, token).status_code == 401


def test_wrong_audience_returns_401(client, settings, rsa_keys):
    private_pem, _ = rsa_keys
    token = jwt.encode(_payload(settings, aud="some-other-audience"), private_pem, algorithm="RS256")
    assert _me(client, token).status_code == 401


def test_expired_token_returns_401(client, settings, rsa_keys):
    private_pem, _ = rsa_keys
    token = jwt.encode(_payload(settings, exp_seconds=-30), private_pem, algorithm="RS256")
    assert _me(client, token).status_code == 401


def test_disallowed_algorithm_returns_401(client, settings):
    token = jwt.encode(_payload(settings), HMAC_SECRET, algorithm="HS256")
    assert _me(client, token).status_code == 401
