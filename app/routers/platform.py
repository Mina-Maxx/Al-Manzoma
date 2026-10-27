from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.orm import Session

from app.models import AuditResult, Company, CompanyStatus
from app.schemas import CompanyCreate, CompanySummary
from app.security.context import PlatformAdminContext
from app.security.deps import get_audit, get_db, get_platform_admin
from app.services import platform_admin as service
from app.services.audit import AuditService

router = APIRouter(prefix="/platform", tags=["platform"])


def _summary(row: dict) -> CompanySummary:
    company: Company = row["company"]
    return CompanySummary(
        id=company.id,
        name=company.name,
        status=company.status.value,
        quota_bytes=company.quota_bytes,
        max_users=company.max_users,
        used_bytes=row["used_bytes"],
        user_count=row["user_count"],
    )


@router.get("/companies", response_model=list[CompanySummary])
def list_companies(
    ctx: PlatformAdminContext = Depends(get_platform_admin),
    db: Session = Depends(get_db),
) -> list[CompanySummary]:
    return [_summary(row) for row in service.list_companies(db)]


@router.post(
    "/companies", response_model=CompanySummary, status_code=status.HTTP_201_CREATED
)
def create_company(
    body: CompanyCreate,
    request: Request,
    ctx: PlatformAdminContext = Depends(get_platform_admin),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> CompanySummary:
    company = service.create_company(
        db, name=body.name, quota_bytes=body.quota_bytes, max_users=body.max_users
    )
    audit.record(
        action="platform.company.create",
        result=AuditResult.success,
        target_type="company",
        target_id=company.id,
        meta={"admin_id": str(ctx.admin_id)},
        request=request,
    )
    return _summary(
        {"company": company, "used_bytes": 0, "user_count": 0}
    )


@router.post("/companies/{company_id}/suspend", response_model=CompanySummary)
def suspend_company(
    company_id: uuid.UUID,
    request: Request,
    ctx: PlatformAdminContext = Depends(get_platform_admin),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> CompanySummary:
    company = service.set_company_status(db, company_id, CompanyStatus.suspended)
    audit.record(
        action="platform.company.suspend",
        result=AuditResult.success,
        target_type="company",
        target_id=company.id,
        meta={"admin_id": str(ctx.admin_id)},
        request=request,
    )
    row = next(
        (r for r in service.list_companies(db) if r["company"].id == company.id), None
    )
    return _summary(row or {"company": company, "used_bytes": 0, "user_count": 0})


@router.post("/companies/{company_id}/reactivate", response_model=CompanySummary)
def reactivate_company(
    company_id: uuid.UUID,
    request: Request,
    ctx: PlatformAdminContext = Depends(get_platform_admin),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> CompanySummary:
    company = service.set_company_status(db, company_id, CompanyStatus.active)
    audit.record(
        action="platform.company.reactivate",
        result=AuditResult.success,
        target_type="company",
        target_id=company.id,
        meta={"admin_id": str(ctx.admin_id)},
        request=request,
    )
    row = next(
        (r for r in service.list_companies(db) if r["company"].id == company.id), None
    )
    return _summary(row or {"company": company, "used_bytes": 0, "user_count": 0})
