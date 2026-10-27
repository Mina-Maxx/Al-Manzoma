from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt

from app.config import Settings


class JwtVerificationError(Exception):
    """Raised when a token cannot be trusted. Message is safe (no token)."""


KeyResolver = Callable[[str], Any]


class JwtVerifier:
    """Verifies Supabase-issued JWTs.

    The signing key is resolved via ``key_resolver`` (normally a cached JWKS
    client). Issuer and audience are enforced. The verifier NEVER reads
    authorization data (company, role) from claims; it only returns them.
    """

    def __init__(
        self,
        key_resolver: KeyResolver,
        algorithms: list[str],
        issuer: str,
        audience: str,
    ) -> None:
        self._key_resolver = key_resolver
        self._algorithms = algorithms
        self._issuer = issuer
        self._audience = audience

    def verify(self, token: str) -> dict:
        try:
            key = self._key_resolver(token)
        except JwtVerificationError:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            raise JwtVerificationError("unable to resolve signing key") from exc

        try:
            claims = jwt.decode(
                token,
                key,
                algorithms=self._algorithms,
                audience=self._audience,
                issuer=self._issuer,
                options={"require": ["exp", "sub"]},
            )
        except jwt.PyJWTError as exc:
            raise JwtVerificationError(str(exc)) from exc
        return claims


def build_jwt_verifier(settings: Settings) -> JwtVerifier:
    if not settings.supabase_url:
        # Deferred failure: importing the app must not require Supabase config,
        # but every verification attempt is rejected until it is configured.
        def _missing(token: str):
            raise JwtVerificationError("SUPABASE_URL is not configured")

        return JwtVerifier(
            key_resolver=_missing,
            algorithms=settings.jwt_algorithms,
            issuer=settings.jwt_issuer,
            audience=settings.supabase_jwt_audience,
        )

    from jwt import PyJWKClient

    client = PyJWKClient(
        settings.jwks_url,
        cache_keys=True,
        lifespan=settings.jwks_cache_ttl_seconds,
    )

    def resolver(token: str) -> Any:
        return client.get_signing_key_from_jwt(token).key

    return JwtVerifier(
        key_resolver=resolver,
        algorithms=settings.jwt_algorithms,
        issuer=settings.jwt_issuer,
        audience=settings.supabase_jwt_audience,
    )


def build_dev_verifier(settings: Settings) -> JwtVerifier:
    """Local-development verifier. Only ever selected when dev auth is active.

    Signs and verifies HS256 tokens with a local secret. This is NOT the
    production path (Supabase JWKS / RS256) and is disabled in production.
    """
    return JwtVerifier(
        key_resolver=lambda token: settings.dev_jwt_secret,
        algorithms=["HS256"],
        issuer=settings.dev_jwt_issuer,
        audience=settings.dev_jwt_audience,
    )


def sign_dev_token(settings: Settings, sub: str, expires_in: int = 3600) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": sub,
        "iss": settings.dev_jwt_issuer,
        "aud": settings.dev_jwt_audience,
        "iat": now,
        "exp": now + timedelta(seconds=expires_in),
    }
    return jwt.encode(payload, settings.dev_jwt_secret, algorithm="HS256")
