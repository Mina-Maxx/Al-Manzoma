from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import AuditResult, Company, CompanyStatus, Document, DocumentStatus, User, UserStatus
from app.schemas import (
    AuditEventOut,
    AuditListResponse,
    CompanyCreate,
    CompanySummary,
    GlobalUserOut,
    OperationalAlertOut,
    PlatformOverviewOut,
)
from app.security.context import PlatformAdminContext
from app.security.deps import (
    get_audit,
    get_db,
    get_platform_admin,
    get_settings,
    get_storage,
)
from app.services import platform_admin as service
from app.services import platform_analytics as analytics_service
from app.services.audit import AuditService
from app.storage.base import Storage, StorageNotFound, StorageUnavailable

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


class UserStatusUpdate(BaseModel):
    status: str  # "active" or "disabled"


@router.get("/overview", response_model=PlatformOverviewOut)
def platform_overview(
    days: int = Query(30, ge=1, le=365),
    ctx: PlatformAdminContext = Depends(get_platform_admin),
    db: Session = Depends(get_db),
    storage: Storage = Depends(get_storage),
    settings: Settings = Depends(get_settings),
) -> PlatformOverviewOut:
    """Return platform-wide operational KPIs, growth trends and system health."""
    data = analytics_service.get_platform_overview(
        db, storage, settings, days=days
    )
    return PlatformOverviewOut(**data)


@router.get("/companies", response_model=list[CompanySummary])
def list_companies(
    status_filter: str | None = Query(None, alias="status"),
    ctx: PlatformAdminContext = Depends(get_platform_admin),
    db: Session = Depends(get_db),
) -> list[CompanySummary]:
    """Dynamically list all registered companies/offices on the platform."""
    all_companies = service.list_companies(db)
    if status_filter:
        all_companies = [
            r for r in all_companies if r["company"].status.value == status_filter
        ]
    return [_summary(row) for row in all_companies]


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
    """Create a new office/company. It automatically appears in global visibility."""
    company = service.create_company(
        db, name=body.name, quota_bytes=body.quota_bytes, max_users=body.max_users
    )
    audit.record(
        action="platform.company.create",
        result=AuditResult.success,
        target_type="company",
        target_id=company.id,
        meta={"admin_id": str(ctx.admin_id), "name": company.name},
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
    """Suspend an office. Its users are immediately denied access."""
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
    """Reactivate a suspended office."""
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


@router.get("/users", response_model=list[GlobalUserOut])
def list_global_users(
    company_id: uuid.UUID | None = Query(None),
    status_filter: str | None = Query(None, alias="status"),
    search: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    ctx: PlatformAdminContext = Depends(get_platform_admin),
    db: Session = Depends(get_db),
) -> list[GlobalUserOut]:
    """List all accounts across all offices with search and pagination."""
    _, users = analytics_service.list_global_users(
        db,
        company_id=company_id,
        status=status_filter,
        search=search,
        limit=limit,
        offset=offset,
    )
    return [GlobalUserOut(**u) for u in users]


@router.post("/users/{user_id}/status")
def update_user_status(
    user_id: uuid.UUID,
    body: UserStatusUpdate,
    request: Request,
    ctx: PlatformAdminContext = Depends(get_platform_admin),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> dict[str, Any]:
    """Enable or disable any user account globally."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="user not found"
        )
    target_status = (
        UserStatus.active if body.status == "active" else UserStatus.disabled
    )
    user.status = target_status
    db.commit()

    audit.record(
        action="platform.user.status_update",
        result=AuditResult.success,
        target_type="user",
        target_id=user.id,
        meta={"new_status": target_status.value, "admin_id": str(ctx.admin_id)},
        request=request,
    )
    return {"id": str(user.id), "status": user.status.value}


@router.get("/audit", response_model=AuditListResponse)
def list_audit(
    company_id: uuid.UUID | None = Query(None),
    action: str | None = Query(None),
    result: str | None = Query(None),
    search: str | None = Query(None),
    date_from: datetime | None = Query(None),
    date_to: datetime | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    ctx: PlatformAdminContext = Depends(get_platform_admin),
    db: Session = Depends(get_db),
) -> AuditListResponse:
    """Query platform-wide audit history with granular filters."""
    total, items = analytics_service.list_audit_events(
        db,
        company_id=company_id,
        action=action,
        result=result,
        search=search,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
        offset=offset,
    )
    return AuditListResponse(
        total=total,
        items=[AuditEventOut(**i) for i in items],
    )


@router.get("/alerts", response_model=list[OperationalAlertOut])
def get_alerts(
    company_id: uuid.UUID | None = Query(None),
    ctx: PlatformAdminContext = Depends(get_platform_admin),
    db: Session = Depends(get_db),
) -> list[OperationalAlertOut]:
    """Retrieve active operational alerts regarding storage, quota and failures."""
    alerts = analytics_service.get_operational_alerts(db, company_id=company_id)
    return [OperationalAlertOut(**a) for a in alerts]


@router.get("/export/{export_type}")
def export_platform_data(
    export_type: str,
    request: Request,
    company_id: uuid.UUID | None = Query(None),
    ctx: PlatformAdminContext = Depends(get_platform_admin),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> Response:
    """Generate safe, injection-sanitized CSV exports for authorized entities."""
    now_str = datetime.now().strftime("%Y%m%d_%H%M%S")

    if export_type == "companies":
        companies = service.list_companies(db)
        headers = ["ID", "Name", "Status", "Quota Bytes", "Max Users", "Used Bytes", "Users Count"]
        rows = [
            [
                str(r["company"].id),
                r["company"].name,
                r["company"].status.value,
                r["company"].quota_bytes,
                r["company"].max_users,
                r["used_bytes"],
                r["user_count"],
            ]
            for r in companies
        ]
        filename = f"quarryvault_offices_{now_str}.csv"

    elif export_type == "users":
        _, users = analytics_service.list_global_users(db, company_id=company_id, limit=1000)
        headers = ["User ID", "Email", "Full Name", "Status", "Role", "Company ID", "Company Name", "Created At"]
        rows = [
            [
                str(u["id"]),
                u["email"] or "",
                u["full_name"] or "",
                u["status"],
                u["role"],
                str(u["company_id"]) if u["company_id"] else "",
                u["company_name"] or "",
                str(u["created_at"]),
            ]
            for u in users
        ]
        filename = f"quarryvault_users_{now_str}.csv"

    elif export_type == "audit":
        _, events = analytics_service.list_audit_events(db, company_id=company_id, limit=1000)
        headers = ["Timestamp", "Action", "Result", "Company Name", "Actor Email", "Target Type", "Target ID", "IP"]
        rows = [
            [
                str(e["created_at"]),
                e["action"],
                e["result"],
                e["company_name"] or "",
                e["actor_email"] or "",
                e["target_type"] or "",
                e["target_id"] or "",
                e["ip"] or "",
            ]
            for e in events
        ]
        filename = f"quarryvault_audit_{now_str}.csv"

    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unknown export type '{export_type}'",
        )

    csv_content = analytics_service.build_csv(headers, rows)

    audit.record(
        action=f"platform.export.{export_type}",
        result=AuditResult.success,
        meta={"admin_id": str(ctx.admin_id), "row_count": len(rows)},
        request=request,
    )

    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/cross-office-access/{company_id}/document/{document_id}")
def privileged_cross_office_document_access(
    company_id: uuid.UUID,
    document_id: uuid.UUID,
    request: Request,
    ctx: PlatformAdminContext = Depends(get_platform_admin),
    db: Session = Depends(get_db),
    storage: Storage = Depends(get_storage),
    audit: AuditService = Depends(get_audit),
):
    """Privileged document access for Platform Admin. Explicitly audited and logged."""
    doc = db.execute(
        select(Document).where(
            Document.id == document_id,
            Document.company_id == company_id,
        )
    ).scalar_one_or_none()

    if doc is None or doc.status != DocumentStatus.available or doc.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="document not found"
        )

    try:
        stream = storage.open(doc.storage_ref)
    except (StorageNotFound, StorageUnavailable) as exc:
        audit.record(
            action="platform.cross_office_content_access",
            result=AuditResult.failure,
            company_id=company_id,
            target_type="document",
            target_id=doc.id,
            meta={"admin_id": str(ctx.admin_id), "error": type(exc).__name__},
            request=request,
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="document file unavailable"
        )

    # Audited sensitive cross-office content access
    audit.record(
        action="platform.cross_office_content_access",
        result=AuditResult.success,
        company_id=company_id,
        target_type="document",
        target_id=doc.id,
        meta={
            "admin_id": str(ctx.admin_id),
            "admin_email": ctx.admin.email,
            "filename": doc.original_filename,
            "size_bytes": doc.size_bytes,
        },
        request=request,
    )

    return StreamingResponse(
        stream,
        media_type=doc.mime_type,
        headers={"Content-Disposition": f'inline; filename="{doc.original_filename}"'},
    )
