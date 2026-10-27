from __future__ import annotations

import uuid
from collections.abc import Iterator

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import (
    AuditResult,
    Company,
    CompanyStatus,
    Document,
    DocumentStatus,
    IdempotencyKey,
    Membership,
    MembershipRole,
    PlatformAdmin,
    Quarry,
    QuarryPermission,
    QuarryStatus,
    User,
    UserStatus,
)
from app.security.context import AuthContext, PlatformAdminContext
from app.security.jwt import JwtVerificationError, JwtVerifier
from app.services.audit import AuditService
from app.services.identity import IdentityProvider
from app.storage.base import Storage

_bearer = HTTPBearer(auto_error=False)


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_session_factory(request: Request):
    return request.app.state.session_factory


def get_db(request: Request) -> Iterator[Session]:
    session = request.app.state.session_factory()
    try:
        yield session
    finally:
        session.close()


def get_verifier(request: Request) -> JwtVerifier:
    return request.app.state.verifier


def get_audit(request: Request) -> AuditService:
    return request.app.state.audit


def get_storage(request: Request) -> Storage:
    return request.app.state.storage


def get_identity(request: Request) -> IdentityProvider:
    return request.app.state.identity


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid or missing credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _forbidden(detail: str = "forbidden") -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


def _verify_claims(
    credentials: HTTPAuthorizationCredentials | None,
    verifier: JwtVerifier,
    audit: AuditService,
    request: Request,
) -> dict:
    if credentials is None or not credentials.credentials:
        raise _unauthorized()
    try:
        return verifier.verify(credentials.credentials)
    except JwtVerificationError:
        audit.record(action="auth.verify", result=AuditResult.denied, request=request)
        raise _unauthorized()


def get_auth_context(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
    verifier: JwtVerifier = Depends(get_verifier),
    audit: AuditService = Depends(get_audit),
) -> AuthContext:
    if credentials is None or not credentials.credentials:
        raise _unauthorized()

    try:
        claims = verifier.verify(credentials.credentials)
    except JwtVerificationError:
        audit.record(action="auth.verify", result=AuditResult.denied, request=request)
        raise _unauthorized()

    sub = claims.get("sub")
    if not sub:
        audit.record(action="auth.verify", result=AuditResult.denied, request=request)
        raise _unauthorized()

    user = db.execute(
        select(User).where(User.auth_user_id == str(sub))
    ).scalar_one_or_none()
    if user is None:
        audit.record(action="auth.user_lookup", result=AuditResult.denied, request=request)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="user not provisioned")

    # Status is read fresh from the database on every request: no caching.
    if user.status != UserStatus.active:
        audit.record(
            action="auth.inactive_user",
            result=AuditResult.denied,
            actor_user_id=user.id,
            request=request,
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="user is not active")

    membership = db.execute(
        select(Membership).where(Membership.user_id == user.id)
    ).scalars().first()
    if membership is None:
        audit.record(
            action="auth.membership_lookup",
            result=AuditResult.denied,
            actor_user_id=user.id,
            request=request,
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no company membership")

    company = db.get(Company, membership.company_id)
    if company is None or company.status != CompanyStatus.active:
        audit.record(
            action="auth.suspended_company",
            result=AuditResult.denied,
            company_id=membership.company_id,
            actor_user_id=user.id,
            request=request,
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="company is not active")

    return AuthContext(user=user, company=company, membership=membership, claims=claims)


def get_platform_admin(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
    verifier: JwtVerifier = Depends(get_verifier),
    audit: AuditService = Depends(get_audit),
) -> PlatformAdminContext:
    """Resolve a platform operator. Never consults memberships."""
    claims = _verify_claims(credentials, verifier, audit, request)
    sub = claims.get("sub")
    if not sub:
        audit.record(action="auth.verify", result=AuditResult.denied, request=request)
        raise _unauthorized()

    admin = db.execute(
        select(PlatformAdmin).where(PlatformAdmin.auth_user_id == str(sub))
    ).scalar_one_or_none()
    if admin is None or admin.status != UserStatus.active:
        audit.record(
            action="platform_admin.lookup",
            result=AuditResult.denied,
            target_type="platform_admin",
            request=request,
        )
        raise _forbidden("not a platform administrator")

    return PlatformAdminContext(admin=admin, claims=claims)


def require_company_admin(
    ctx: AuthContext = Depends(get_auth_context),
) -> AuthContext:
    """Only a company_admin may reach company management endpoints."""
    if ctx.role != MembershipRole.company_admin:
        raise _forbidden("company administrator role required")
    return ctx


def _load_quarry_in_company(
    db: Session, company_id: uuid.UUID, quarry_id: uuid.UUID
) -> Quarry:
    quarry = db.get(Quarry, quarry_id)
    # Cross-tenant access is indistinguishable from a missing resource. An
    # inactive quarry is also treated as missing so its documents are neither
    # listed nor downloadable.
    if (
        quarry is None
        or quarry.company_id != company_id
        or quarry.status != QuarryStatus.active
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="quarry not found")
    return quarry


def require_quarry_permission(permission: str):
    """Dependency factory: authorize one permission on the {quarry_id} path."""

    def dependency(
        request: Request,
        quarry_id: uuid.UUID,
        ctx: AuthContext = Depends(get_auth_context),
        db: Session = Depends(get_db),
        audit: AuditService = Depends(get_audit),
    ) -> Quarry:
        quarry = _load_quarry_in_company(db, ctx.company_id, quarry_id)
        perm = db.execute(
            select(QuarryPermission).where(
                QuarryPermission.user_id == ctx.user_id,
                QuarryPermission.quarry_id == quarry.id,
            )
        ).scalar_one_or_none()
        allowed = bool(perm is not None and getattr(perm, permission, False))
        if not allowed:
            audit.record(
                action=f"quarry.{permission}",
                result=AuditResult.denied,
                company_id=ctx.company_id,
                actor_user_id=ctx.user_id,
                target_type="quarry",
                target_id=quarry.id,
                request=request,
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="permission denied"
            )
        return quarry

    return dependency


def get_download_document(
    request: Request,
    document_id: uuid.UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> Document:
    document = db.get(Document, document_id)
    # A document id from another company must return 404, never 403.
    if (
        document is None
        or document.company_id != ctx.company_id
        or document.status != DocumentStatus.available
    ):
        audit.record(
            action="document.download",
            result=AuditResult.denied,
            company_id=ctx.company_id,
            actor_user_id=ctx.user_id,
            target_type="document",
            target_id=document_id,
            request=request,
        )
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")

    quarry = db.get(Quarry, document.quarry_id)
    if quarry is None or quarry.status != QuarryStatus.active:
        # A document in a deactivated quarry is not downloadable.
        audit.record(
            action="document.download",
            result=AuditResult.denied,
            company_id=ctx.company_id,
            actor_user_id=ctx.user_id,
            target_type="document",
            target_id=document_id,
            request=request,
        )
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")

    perm = db.execute(
        select(QuarryPermission).where(
            QuarryPermission.user_id == ctx.user_id,
            QuarryPermission.quarry_id == document.quarry_id,
        )
    ).scalar_one_or_none()
    if perm is None or not perm.can_download:
        audit.record(
            action="quarry.can_download",
            result=AuditResult.denied,
            company_id=ctx.company_id,
            actor_user_id=ctx.user_id,
            target_type="document",
            target_id=document.id,
            request=request,
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="permission denied")

    return document
