from __future__ import annotations

from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

INSECURE_DEV_SECRET = "dev-insecure-secret-change-me"
MIN_DEV_SECRET_LENGTH = 32


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
        # Never echo field values (which may include secrets) in validation
        # errors that could end up in startup logs.
        hide_input_in_errors=True,
    )

    # Defaults to None on purpose: a missing APP_ENV must never be treated as
    # "development", so development auth can only ever be enabled by an explicit
    # APP_ENV=development.
    app_env: str | None = None
    database_url: str = "postgresql+psycopg://quarryvault:quarryvault@localhost:5432/quarryvault"

    supabase_url: str = ""
    supabase_jwt_audience: str = "authenticated"
    supabase_jwt_algorithms: str = "RS256,ES256"
    jwks_cache_ttl_seconds: int = 3600

    # Supabase service-role key. Backend-only, never logged, never sent to any
    # client. Required only for employee invitations (Admin API).
    supabase_service_role_key: str = ""

    max_file_size_bytes: int = 10 * 1024 * 1024
    default_company_quota_bytes: int = 5 * 1024 * 1024 * 1024
    default_company_max_users: int = 10

    # Stale-attempt recovery. A claim holds a lease for this long; only once the
    # lease has expired (and no process-local owner is still live) may a retry or
    # the reaper take the attempt over. This lease is a backstop, not a
    # cross-process liveness authority (see app/services/owner_registry.py).
    idempotency_lease_seconds: int = 300

    # The active-owner registry that guards idempotent uploads is process-local,
    # so the backend MUST run as a single worker in a single instance. The app
    # refuses to start when this is greater than 1 (see app/main.py).
    web_concurrency: int = 1

    # Rate limit for the employee-invitation endpoint (per company+actor, per
    # minute). In-process: valid because the backend is single-instance.
    invite_rate_limit_per_minute: int = 10

    storage_backend: str = "local"
    storage_local_root: str = "./.storage"

    gdrive_root_folder_name: str = "QuarryVault"
    gdrive_root_folder_id: str = ""
    gdrive_credentials_file: str = ""
    google_retry_max_attempts: int = 5
    google_retry_base_seconds: float = 0.5

    # Local development ONLY. Never active unless APP_ENV=development is set
    # explicitly, and always disabled when APP_ENV=production.
    dev_auth_enabled: bool = False
    dev_jwt_secret: str = INSECURE_DEV_SECRET
    dev_jwt_issuer: str = "quarryvault-dev"
    dev_jwt_audience: str = "quarryvault-dev"

    @property
    def dev_auth_active(self) -> bool:
        return self.dev_auth_enabled and (self.app_env or "").lower() == "development"

    @model_validator(mode="after")
    def _validate_dev_auth(self) -> Settings:
        if not self.dev_auth_active:
            return self
        secret = self.dev_jwt_secret or ""
        if secret == INSECURE_DEV_SECRET:
            raise ValueError(
                "DEV_AUTH_ENABLED is on in development but DEV_JWT_SECRET is "
                "still the insecure default. Set DEV_JWT_SECRET to a random "
                f"value of at least {MIN_DEV_SECRET_LENGTH} characters."
            )
        if len(secret) < MIN_DEV_SECRET_LENGTH:
            raise ValueError(
                "DEV_JWT_SECRET must be at least "
                f"{MIN_DEV_SECRET_LENGTH} characters when DEV_AUTH_ENABLED is on "
                "in development."
            )
        return self

    @property
    def jwks_url(self) -> str:
        return f"{self.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"

    @property
    def jwt_issuer(self) -> str:
        return f"{self.supabase_url.rstrip('/')}/auth/v1"

    @property
    def jwt_algorithms(self) -> list[str]:
        return [a.strip() for a in self.supabase_jwt_algorithms.split(",") if a.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
