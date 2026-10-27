from __future__ import annotations

import sys

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.config import Settings, get_settings
from app.db import build_engine_from_settings, build_session_factory
from app.routers import (
    company_admin,
    dashboard,
    dev,
    documents,
    folders,
    health,
    me,
    platform,
    quarries,
)
from app.security.jwt import JwtVerifier, build_dev_verifier, build_jwt_verifier
from app.services.audit import AuditService
from app.services.errors import DomainError
from app.services.identity import IdentityProvider, build_identity_provider
from app.services.rate_limit import SlidingWindowRateLimiter
from app.storage import Storage, build_storage

MAX_WORKERS_MESSAGE = (
    "QuarryVault must run as a single worker in a single instance: the "
    "active-owner registry that protects idempotent uploads is process-local. "
    "Refusing to start because {workers} workers were configured. Set "
    "WEB_CONCURRENCY=1 and start uvicorn with --workers 1."
)


def _as_int(value: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _configured_worker_count(settings: Settings) -> int:
    """Best-effort worker count from config and the uvicorn command line.

    Uvicorn does not export a worker count, so the ``--workers`` flag is read
    from ``sys.argv`` (worker processes inherit the parent's argv). ``-w`` is
    included for gunicorn-style launchers.
    """
    counts = [settings.web_concurrency]
    argv = sys.argv
    for index, arg in enumerate(argv):
        if arg in ("--workers", "-w") and index + 1 < len(argv):
            counts.append(_as_int(argv[index + 1]))
        elif arg.startswith("--workers="):
            counts.append(_as_int(arg.split("=", 1)[1]))
    return max(counts)


def create_app(
    settings: Settings | None = None,
    *,
    session_factory=None,
    storage: Storage | None = None,
    verifier: JwtVerifier | None = None,
    audit: AuditService | None = None,
    identity: IdentityProvider | None = None,
) -> FastAPI:
    settings = settings or get_settings()

    workers = _configured_worker_count(settings)
    if workers > 1:
        raise RuntimeError(MAX_WORKERS_MESSAGE.format(workers=workers))

    app = FastAPI(title="QuarryVault", version="0.1.0")

    engine = None
    if session_factory is None:
        engine = build_engine_from_settings(settings)
        session_factory = build_session_factory(engine)

    app.state.settings = settings
    app.state.engine = engine
    app.state.session_factory = session_factory
    app.state.storage = storage or build_storage(settings)
    app.state.identity = identity or build_identity_provider(settings)
    app.state.invite_limiter = SlidingWindowRateLimiter(
        settings.invite_rate_limit_per_minute, 60.0
    )

    # Local development auth (HS256 + /dev/token) is selected only when no
    # verifier is injected and dev auth is explicitly active outside production.
    dev_mode = verifier is None and settings.dev_auth_active
    if verifier is None:
        verifier = (
            build_dev_verifier(settings) if dev_mode else build_jwt_verifier(settings)
        )
    app.state.verifier = verifier
    app.state.audit = audit or AuditService(session_factory)

    app.include_router(health.router)
    app.include_router(me.router)
    app.include_router(quarries.router)
    app.include_router(folders.router)
    app.include_router(documents.router)
    app.include_router(platform.router)
    app.include_router(company_admin.router)
    app.include_router(dashboard.router)
    dashboard.mount_static(app)
    if dev_mode:
        app.include_router(dev.router)

    @app.exception_handler(DomainError)
    async def _domain_error_handler(request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(status_code=exc.http_status, content={"detail": str(exc)})

    @app.middleware("http")
    async def _dashboard_security_headers(request: Request, call_next):
        """Strict headers for the dashboard only.

        The dashboard has no inline scripts/styles, so CSP can forbid them and
        still work. ``connect-src`` allows the API itself (``'self'``) plus the
        Supabase Auth origin.
        """
        response = await call_next(request)
        if request.url.path.startswith("/dashboard"):
            supabase_origin = (settings.supabase_url or "").rstrip("/")
            connect_src = "'self'" + (f" {supabase_origin}" if supabase_origin else "")
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; "
                "script-src 'self'; "
                "style-src 'self'; "
                "img-src 'self' data:; "
                "font-src 'self'; "
                f"connect-src {connect_src}; "
                "base-uri 'self'; "
                "form-action 'self'; "
                "frame-ancestors 'none'"
            )
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Referrer-Policy"] = "no-referrer"
            response.headers["X-Frame-Options"] = "DENY"
        return response

    return app


app = create_app()
