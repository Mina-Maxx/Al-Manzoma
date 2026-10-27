from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+psycopg://quarryvault:quarryvault@localhost:55432/quarryvault_test",
)
SUPABASE_TEST_URL = "https://test.supabase.co"
SUPABASE_AUDIENCE = "authenticated"


@pytest.fixture(scope="session")
def _settings(_storage_root):
    from app.config import Settings

    return Settings(
        _env_file=None,
        app_env="test",
        database_url=TEST_DATABASE_URL,
        supabase_url=SUPABASE_TEST_URL,
        supabase_jwt_audience=SUPABASE_AUDIENCE,
        max_file_size_bytes=2 * 1024 * 1024,
        default_company_quota_bytes=5 * 1024 * 1024 * 1024,
        default_company_max_users=10,
        storage_backend="local",
        storage_local_root=str(_storage_root),
    )


@pytest.fixture(scope="session")
def engine():
    eng = create_engine(TEST_DATABASE_URL, pool_pre_ping=True, future=True)
    try:
        with eng.connect() as conn:
            conn.execution_options(isolation_level="AUTOCOMMIT")
            conn.execute(text("SELECT 1"))
    except Exception as exc:  # pragma: no cover
        pytest.exit(
            f"Cannot reach TEST_DATABASE_URL ({TEST_DATABASE_URL}): {exc}. "
            "Start Postgres and retry; concurrency tests must not be skipped.",
            returncode=1,
        )
    return eng


@pytest.fixture(scope="session")
def _database(engine):
    with engine.connect() as conn:
        conn.execution_options(isolation_level="AUTOCOMMIT")
        conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))

    cfg = AlembicConfig(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    os.environ["ALEMBIC_DATABASE_URL"] = TEST_DATABASE_URL
    command.upgrade(cfg, "head")
    return engine


@pytest.fixture(scope="session")
def _storage_root(tmp_path_factory):
    return tmp_path_factory.mktemp("qv_storage")


@pytest.fixture(scope="session")
def settings(_settings, _database):
    return _settings


@pytest.fixture(scope="session")
def session_factory(engine, _database):
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


@pytest.fixture(autouse=True)
def _clean_db(engine, _database):
    from app.models import Base
    from app.services.owner_registry import active_owners

    # The active-owner registry is process-global; reset it so no test can see
    # (or be affected by) a previous test's in-flight owners.
    active_owners.clear()

    table_names = [
        t.name for t in Base.metadata.sorted_tables if t.name != "alembic_version"
    ]
    with engine.connect() as conn:
        conn.execution_options(isolation_level="AUTOCOMMIT")
        conn.execute(
            text(f"TRUNCATE TABLE {', '.join(table_names)} RESTART IDENTITY CASCADE")
        )
    yield
    active_owners.clear()


@pytest.fixture(scope="session")
def rsa_keys():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_key = private_key.public_key()
    return private_pem, public_key


@pytest.fixture(scope="session")
def verifier(settings, rsa_keys):
    from app.security.jwt import JwtVerifier

    _, public_key = rsa_keys
    return JwtVerifier(
        key_resolver=lambda token: public_key,
        algorithms=["RS256"],
        issuer=settings.jwt_issuer,
        audience=SUPABASE_AUDIENCE,
    )


@pytest.fixture
def make_token(settings, rsa_keys):
    private_pem, _ = rsa_keys

    def _make(sub: str, *, expires_in: int = 3600) -> str:
        payload = {
            "sub": sub,
            "aud": SUPABASE_AUDIENCE,
            "iss": settings.jwt_issuer,
            "exp": datetime.now(timezone.utc) + timedelta(seconds=expires_in),
            "iat": datetime.now(timezone.utc),
        }
        return jwt.encode(payload, private_pem, algorithm="RS256")

    return _make


@pytest.fixture
def storage(settings, _storage_root):
    from app.storage.local import LocalDiskStorage

    root = _storage_root / uuid.uuid4().hex
    return LocalDiskStorage(root)


@pytest.fixture
def app(settings, session_factory, storage, verifier):
    from app.main import create_app

    return create_app(
        settings=settings,
        session_factory=session_factory,
        storage=storage,
        verifier=verifier,
    )


@pytest.fixture
def client(app):
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def db(session_factory):
    session = session_factory()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def auth_header(make_token):
    def _header(sub: str) -> dict:
        return {"Authorization": f"Bearer {make_token(sub)}"}

    return _header
