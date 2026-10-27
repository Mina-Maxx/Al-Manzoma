from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    AuditResult,
    MembershipRole,
    Quarry,
    QuarryPermission,
    QuarryStatus,
)
from app.schemas import QuarryName, QuarryOut, QuarryPermissionOut
from app.security.context import AuthContext
from app.security.deps import get_audit, get_auth_context, get_db
from app.services import company_admin as service
from app.services.audit import AuditService

router = APIRouter(tags=["quarries"])


@router.get("/quarries", response_model=list[QuarryOut])
def list_quarries(
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> list[QuarryOut]:
    if ctx.role == MembershipRole.company_admin:
        active_quarries = db.execute(
            select(Quarry)
            .where(
                Quarry.company_id == ctx.company_id,
                Quarry.status == QuarryStatus.active,
            )
            .order_by(Quarry.name.asc())
        ).scalars().all()
        return [
            QuarryOut(
                id=quarry.id,
                name=quarry.name,
                status=quarry.status.value,
                permissions=QuarryPermissionOut(
                    can_view=True,
                    can_upload=True,
                    can_download=True,
                ),
            )
            for quarry in active_quarries
        ]

    rows = db.execute(
        select(Quarry, QuarryPermission)
        .join(QuarryPermission, QuarryPermission.quarry_id == Quarry.id)
        .where(
            Quarry.company_id == ctx.company_id,
            Quarry.status == QuarryStatus.active,
            QuarryPermission.user_id == ctx.user_id,
            QuarryPermission.can_view.is_(True),
        )
        .order_by(Quarry.name.asc())
    ).all()
    return [
        QuarryOut(
            id=quarry.id,
            name=quarry.name,
            status=quarry.status.value,
            permissions=QuarryPermissionOut(
                can_view=perm.can_view,
                can_upload=perm.can_upload,
                can_download=perm.can_download,
            ),
        )
        for quarry, perm in rows
    ]


@router.post(
    "/quarries",
    response_model=QuarryOut,
    status_code=status.HTTP_201_CREATED,
)
def create_quarry(
    body: QuarryName,
    request: Request,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> QuarryOut:
    cleaned = (body.name or "").strip()
    if not cleaned:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="quarry name is required",
        )
    quarry = service.create_quarry(db, ctx.company_id, name=cleaned)
    audit.record(
        action="quarry.create",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="quarry",
        target_id=quarry.id,
        meta={"name": quarry.name},
        request=request,
    )
    perm = db.execute(
        select(QuarryPermission).where(
            QuarryPermission.user_id == ctx.user_id,
            QuarryPermission.quarry_id == quarry.id,
        )
    ).scalar_one_or_none()
    can_view = perm.can_view if perm else True
    can_upload = perm.can_upload if perm else False
    can_download = perm.can_download if perm else False

    return QuarryOut(
        id=quarry.id,
        name=quarry.name,
        status=quarry.status.value,
        permissions=QuarryPermissionOut(
            can_view=can_view,
            can_upload=can_upload,
            can_download=can_download,
        ),
    )
