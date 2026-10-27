from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.orm import Session

from app.models import AuditResult, MembershipRole, QuarryStatus, UserStatus
from app.schemas import (
    EmployeeOut,
    InviteRequest,
    PermissionOut,
    PermissionUpdate,
    PermissionsMatrixOut,
    QuarryAdminOut,
    QuarryName,
    UsageOut,
)
from app.security.context import AuthContext
from app.security.deps import (
    get_audit,
    get_db,
    get_identity,
    require_company_admin,
)
from app.services import company_admin as service
from app.services.audit import AuditService
from app.services.errors import RateLimited
from app.services.identity import IdentityProvider

router = APIRouter(prefix="/company", tags=["company"])


def _employee(row: dict) -> EmployeeOut:
    user = row["user"]
    return EmployeeOut(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        status=user.status.value,
        role=row["role"].value,
    )


def _check_invite_rate_limit(request: Request, ctx: AuthContext) -> None:
    limiter = request.app.state.invite_limiter
    if limiter is not None and not limiter.allow(
        f"invite:{ctx.company_id}:{ctx.user_id}"
    ):
        raise RateLimited("too many invitations; please slow down")


@router.get("/employees", response_model=list[EmployeeOut])
def list_employees(
    ctx: AuthContext = Depends(require_company_admin),
    db: Session = Depends(get_db),
) -> list[EmployeeOut]:
    return [_employee(row) for row in service.list_employees(db, ctx.company_id)]


@router.post(
    "/employees/invite",
    response_model=EmployeeOut,
    status_code=status.HTTP_201_CREATED,
)
def invite_employee(
    body: InviteRequest,
    request: Request,
    ctx: AuthContext = Depends(require_company_admin),
    db: Session = Depends(get_db),
    identity: IdentityProvider = Depends(get_identity),
    audit: AuditService = Depends(get_audit),
) -> EmployeeOut:
    _check_invite_rate_limit(request, ctx)
    row = service.invite_employee(
        db,
        identity,
        ctx.company_id,
        email=body.email,
        full_name=body.full_name,
    )
    audit.record(
        action="company.employee.invite",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="user",
        target_id=row["user"].id,
        request=request,
    )
    return _employee(row)


@router.post("/employees/{user_id}/disable", response_model=EmployeeOut)
def disable_employee(
    user_id: uuid.UUID,
    request: Request,
    ctx: AuthContext = Depends(require_company_admin),
    db: Session = Depends(get_db),
    identity: IdentityProvider = Depends(get_identity),
    audit: AuditService = Depends(get_audit),
) -> EmployeeOut:
    row = service.set_user_status(
        db, identity, ctx.company_id, user_id, UserStatus.inactive
    )
    audit.record(
        action="company.employee.disable",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="user",
        target_id=user_id,
        request=request,
    )
    return _employee(row)


@router.post("/employees/{user_id}/enable", response_model=EmployeeOut)
def enable_employee(
    user_id: uuid.UUID,
    request: Request,
    ctx: AuthContext = Depends(require_company_admin),
    db: Session = Depends(get_db),
    identity: IdentityProvider = Depends(get_identity),
    audit: AuditService = Depends(get_audit),
) -> EmployeeOut:
    row = service.set_user_status(
        db, identity, ctx.company_id, user_id, UserStatus.active
    )
    audit.record(
        action="company.employee.enable",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="user",
        target_id=user_id,
        request=request,
    )
    return _employee(row)


@router.get("/quarries", response_model=list[QuarryAdminOut])
def list_quarries(
    ctx: AuthContext = Depends(require_company_admin),
    db: Session = Depends(get_db),
) -> list[QuarryAdminOut]:
    return [
        QuarryAdminOut.model_validate(q)
        for q in service.list_quarries(db, ctx.company_id)
    ]


@router.post(
    "/quarries", response_model=QuarryAdminOut, status_code=status.HTTP_201_CREATED
)
def create_quarry(
    body: QuarryName,
    request: Request,
    ctx: AuthContext = Depends(require_company_admin),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> QuarryAdminOut:
    quarry = service.create_quarry(db, ctx.company_id, name=body.name)
    audit.record(
        action="company.quarry.create",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="quarry",
        target_id=quarry.id,
        request=request,
    )
    return QuarryAdminOut.model_validate(quarry)


@router.patch("/quarries/{quarry_id}", response_model=QuarryAdminOut)
def rename_quarry(
    quarry_id: uuid.UUID,
    body: QuarryName,
    request: Request,
    ctx: AuthContext = Depends(require_company_admin),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> QuarryAdminOut:
    quarry = service.rename_quarry(db, ctx.company_id, quarry_id, name=body.name)
    audit.record(
        action="company.quarry.rename",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="quarry",
        target_id=quarry_id,
        request=request,
    )
    return QuarryAdminOut.model_validate(quarry)


@router.post("/quarries/{quarry_id}/deactivate", response_model=QuarryAdminOut)
def deactivate_quarry(
    quarry_id: uuid.UUID,
    request: Request,
    ctx: AuthContext = Depends(require_company_admin),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> QuarryAdminOut:
    quarry = service.set_quarry_status(
        db, ctx.company_id, quarry_id, QuarryStatus.inactive
    )
    audit.record(
        action="company.quarry.deactivate",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="quarry",
        target_id=quarry_id,
        request=request,
    )
    return QuarryAdminOut.model_validate(quarry)


@router.post("/quarries/{quarry_id}/reactivate", response_model=QuarryAdminOut)
def reactivate_quarry(
    quarry_id: uuid.UUID,
    request: Request,
    ctx: AuthContext = Depends(require_company_admin),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> QuarryAdminOut:
    quarry = service.set_quarry_status(
        db, ctx.company_id, quarry_id, QuarryStatus.active
    )
    audit.record(
        action="company.quarry.reactivate",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="quarry",
        target_id=quarry_id,
        request=request,
    )
    return QuarryAdminOut.model_validate(quarry)


@router.put(
    "/quarries/{quarry_id}/permissions/{user_id}", response_model=PermissionOut
)
def set_permission(
    quarry_id: uuid.UUID,
    user_id: uuid.UUID,
    body: PermissionUpdate,
    request: Request,
    ctx: AuthContext = Depends(require_company_admin),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> PermissionOut:
    perm = service.set_permission(
        db,
        ctx.company_id,
        quarry_id,
        user_id,
        can_view=body.can_view,
        can_upload=body.can_upload,
        can_download=body.can_download,
    )
    audit.record(
        action="company.permission.set",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="quarry_permission",
        target_id=f"{user_id}:{quarry_id}",
        meta={
            "can_view": body.can_view,
            "can_upload": body.can_upload,
            "can_download": body.can_download,
        },
        request=request,
    )
    return PermissionOut.model_validate(perm)


@router.get("/permissions", response_model=PermissionsMatrixOut)
def permissions_matrix(
    ctx: AuthContext = Depends(require_company_admin),
    db: Session = Depends(get_db),
) -> PermissionsMatrixOut:
    data = service.permissions_matrix(db, ctx.company_id)
    return PermissionsMatrixOut(
        members=[_employee(row) for row in data["members"]],
        quarries=[QuarryAdminOut.model_validate(q) for q in data["quarries"]],
        permissions=[
            PermissionOut.model_validate(p) for p in data["permissions"]
        ],
    )


@router.get("/usage", response_model=UsageOut)
def usage(
    ctx: AuthContext = Depends(require_company_admin),
    db: Session = Depends(get_db),
) -> UsageOut:
    data = service.company_usage(db, ctx.company_id)
    return UsageOut(**data)
