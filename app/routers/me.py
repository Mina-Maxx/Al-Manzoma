from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.models import AuditResult
from app.schemas import CompanyOut, MeResponse, UserOut
from app.security.context import AuthContext
from app.security.deps import get_auth_context, get_audit, get_db
from app.services.audit import AuditService
from app.services.quota import company_used_bytes

router = APIRouter(tags=["me"])


@router.get("/me", response_model=MeResponse)
def get_me(
    request: Request,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> MeResponse:
    used = company_used_bytes(db, ctx.company_id)
    audit.record(
        action="auth.me",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        request=request,
    )
    return MeResponse(
        user=UserOut.model_validate(ctx.user),
        company=CompanyOut(
            id=ctx.company.id,
            name=ctx.company.name,
            status=ctx.company.status.value,
            quota_bytes=ctx.company.quota_bytes,
            max_users=ctx.company.max_users,
            used_bytes=used,
        ),
        role=ctx.role.value,
    )
