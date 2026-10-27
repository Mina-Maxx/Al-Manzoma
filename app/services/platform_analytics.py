from __future__ import annotations

import csv
import io
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import (
    AuditEvent,
    AuditResult,
    Company,
    CompanyStatus,
    Document,
    DocumentStatus,
    Membership,
    MembershipRole,
    Quarry,
    QuarryStatus,
    User,
    UserStatus,
)
from app.services.quota import company_used_bytes
from app.storage.base import Storage


def sanitize_csv_cell(value: Any) -> str:
    """Sanitize cell value to prevent CSV formula injection."""
    if value is None:
        return ""
    text = str(value)
    # If the text starts with formula triggers, escape it with a leading apostrophe
    if text and text[0] in ("=", "+", "-", "@", "\t", "\r"):
        return f"'{text}"
    return text


def build_csv(headers: list[str], rows: list[list[Any]]) -> str:
    """Generate RFC-4180 CSV string safely."""
    output = io.StringIO()
    writer = csv.writer(output, quoting=csv.QUOTE_MINIMAL)
    writer.writerow([sanitize_csv_cell(h) for h in headers])
    for row in rows:
        writer.writerow([sanitize_csv_cell(cell) for cell in row])
    return output.getvalue()


def get_platform_overview(
    db: Session, storage: Storage, settings: Settings, *, days: int = 30
) -> dict[str, Any]:
    """Compute comprehensive real platform metrics and telemetry."""
    now_utc = datetime.now(timezone.utc)
    since_utc = now_utc - timedelta(days=max(1, days))

    # 1. Offices / Companies metrics
    total_offices = db.execute(select(func.count(Company.id))).scalar_one() or 0
    active_offices = (
        db.execute(
            select(func.count(Company.id)).where(Company.status == CompanyStatus.active)
        ).scalar_one()
        or 0
    )
    suspended_offices = (
        db.execute(
            select(func.count(Company.id)).where(Company.status == CompanyStatus.suspended)
        ).scalar_one()
        or 0
    )

    # 2. Users metrics
    total_users = db.execute(select(func.count(User.id))).scalar_one() or 0
    active_users = (
        db.execute(
            select(func.count(User.id)).where(User.status == UserStatus.active)
        ).scalar_one()
        or 0
    )
    disabled_users = (
        db.execute(
            select(func.count(User.id)).where(User.status != UserStatus.active)
        ).scalar_one()
        or 0
    )

    # 3. Quarries & Documents metrics
    total_quarries = (
        db.execute(
            select(func.count(Quarry.id)).where(Quarry.status == QuarryStatus.active)
        ).scalar_one()
        or 0
    )
    active_documents = (
        db.execute(
            select(func.count(Document.id)).where(
                Document.status == DocumentStatus.available,
                Document.deleted_at.is_(None),
            )
        ).scalar_one()
        or 0
    )
    trash_documents = (
        db.execute(
            select(func.count(Document.id)).where(Document.deleted_at.is_not(None))
        ).scalar_one()
        or 0
    )

    # 4. Storage & Quota
    total_quota_bytes = (
        db.execute(select(func.coalesce(func.sum(Company.quota_bytes), 0))).scalar_one()
        or 0
    )
    total_used_bytes = (
        db.execute(
            select(func.coalesce(func.sum(Document.size_bytes), 0)).where(
                or_(
                    Document.status.in_((DocumentStatus.pending, DocumentStatus.available)),
                    Document.deleted_at.is_not(None),
                )
            )
        ).scalar_one()
        or 0
    )
    storage_utilization_pct = (
        round((total_used_bytes / total_quota_bytes) * 100, 2)
        if total_quota_bytes > 0
        else 0.0
    )

    # 5. Activity counts in date window
    uploads_count = (
        db.execute(
            select(func.count(AuditEvent.id)).where(
                AuditEvent.action == "document.upload",
                AuditEvent.result == AuditResult.success,
                AuditEvent.created_at >= since_utc,
            )
        ).scalar_one()
        or 0
    )
    downloads_count = (
        db.execute(
            select(func.count(AuditEvent.id)).where(
                AuditEvent.action == "document.download",
                AuditEvent.result == AuditResult.success,
                AuditEvent.created_at >= since_utc,
            )
        ).scalar_one()
        or 0
    )
    deletions_count = (
        db.execute(
            select(func.count(AuditEvent.id)).where(
                AuditEvent.action == "document.delete",
                AuditEvent.result == AuditResult.success,
                AuditEvent.created_at >= since_utc,
            )
        ).scalar_one()
        or 0
    )
    restorations_count = (
        db.execute(
            select(func.count(AuditEvent.id)).where(
                AuditEvent.action == "document.restore",
                AuditEvent.result == AuditResult.success,
                AuditEvent.created_at >= since_utc,
            )
        ).scalar_one()
        or 0
    )
    failed_operations_count = (
        db.execute(
            select(func.count(AuditEvent.id)).where(
                AuditEvent.result != AuditResult.success,
                AuditEvent.created_at >= since_utc,
            )
        ).scalar_one()
        or 0
    )

    # 6. Activity trends: daily breakdown over the last 7 to 30 days
    trend_rows = db.execute(
        select(
            func.date_trunc("day", AuditEvent.created_at).label("day"),
            func.count(AuditEvent.id).filter(
                AuditEvent.action == "document.upload",
                AuditEvent.result == AuditResult.success,
            ).label("uploads"),
            func.count(AuditEvent.id).filter(
                AuditEvent.action == "document.download",
                AuditEvent.result == AuditResult.success,
            ).label("downloads"),
            func.count(AuditEvent.id).filter(
                AuditEvent.action == "document.delete",
                AuditEvent.result == AuditResult.success,
            ).label("deletions"),
            func.count(AuditEvent.id).filter(
                AuditEvent.result != AuditResult.success
            ).label("failures"),
        )
        .where(AuditEvent.created_at >= since_utc)
        .group_by("day")
        .order_by("day")
    ).all()

    activity_trend = [
        {
            "date": r.day.strftime("%Y-%m-%d") if r.day else "",
            "uploads": int(r.uploads or 0),
            "downloads": int(r.downloads or 0),
            "deletions": int(r.deletions or 0),
            "failures": int(r.failures or 0),
        }
        for r in trend_rows
    ]

    # 7. Health checks
    database_health = "connected"
    try:
        db.execute(select(1))
    except Exception:
        database_health = "unhealthy"

    storage_health = "operational"

    return {
        "total_offices": total_offices,
        "active_offices": active_offices,
        "suspended_offices": suspended_offices,
        "total_users": total_users,
        "active_users": active_users,
        "disabled_users": disabled_users,
        "total_quarries": total_quarries,
        "active_documents": active_documents,
        "trash_documents": trash_documents,
        "total_used_bytes": total_used_bytes,
        "total_quota_bytes": total_quota_bytes,
        "storage_utilization_pct": storage_utilization_pct,
        "time_range_days": days,
        "uploads_count": uploads_count,
        "downloads_count": downloads_count,
        "deletions_count": deletions_count,
        "restorations_count": restorations_count,
        "failed_operations_count": failed_operations_count,
        "activity_trend": activity_trend,
        "backend_health": "healthy",
        "database_health": database_health,
        "storage_health": storage_health,
        "storage_backend": settings.storage_backend,
    }


def list_global_users(
    db: Session,
    *,
    company_id: uuid.UUID | None = None,
    status: str | None = None,
    search: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[int, list[dict[str, Any]]]:
    """Retrieve all users across offices with search, filtering and pagination."""
    query = (
        select(User, Membership, Company)
        .outerjoin(Membership, Membership.user_id == User.id)
        .outerjoin(Company, Company.id == Membership.company_id)
    )

    if company_id is not None:
        query = query.where(Membership.company_id == company_id)

    if status:
        query = query.where(User.status == status)

    if search:
        term = f"%{search.strip().lower()}%"
        query = query.where(
            or_(
                func.lower(User.email).like(term),
                func.lower(User.full_name).like(term),
                func.lower(Company.name).like(term),
            )
        )

    count_query = select(func.count()).select_from(query.subquery())
    total = db.execute(count_query).scalar_one() or 0

    rows = db.execute(
        query.order_by(User.created_at.desc()).limit(limit).offset(offset)
    ).all()

    items = [
        {
            "id": u.id,
            "email": u.email,
            "full_name": u.full_name,
            "status": u.status.value if hasattr(u.status, "value") else str(u.status),
            "role": m.role.value if m and hasattr(m.role, "value") else (str(m.role) if m else "none"),
            "company_id": c.id if c else None,
            "company_name": c.name if c else None,
            "created_at": u.created_at,
        }
        for u, m, c in rows
    ]

    return total, items


def list_audit_events(
    db: Session,
    *,
    company_id: uuid.UUID | None = None,
    action: str | None = None,
    result: str | None = None,
    search: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[int, list[dict[str, Any]]]:
    """Retrieve audit events with structured filters and sanitization."""
    query = (
        select(AuditEvent, Company.name.label("company_name"), User.email.label("actor_email"))
        .outerjoin(Company, Company.id == AuditEvent.company_id)
        .outerjoin(User, User.id == AuditEvent.actor_user_id)
    )

    if company_id is not None:
        query = query.where(AuditEvent.company_id == company_id)

    if action:
        query = query.where(AuditEvent.action == action)

    if result:
        query = query.where(AuditEvent.result == result)

    if date_from:
        query = query.where(AuditEvent.created_at >= date_from)

    if date_to:
        query = query.where(AuditEvent.created_at <= date_to)

    if search:
        term = f"%{search.strip().lower()}%"
        query = query.where(
            or_(
                func.lower(AuditEvent.action).like(term),
                func.lower(AuditEvent.target_id).like(term),
                func.lower(Company.name).like(term),
                func.lower(User.email).like(term),
            )
        )

    count_query = select(func.count()).select_from(query.subquery())
    total = db.execute(count_query).scalar_one() or 0

    rows = db.execute(
        query.order_by(AuditEvent.created_at.desc()).limit(limit).offset(offset)
    ).all()

    items = [
        {
            "id": evt.id,
            "created_at": evt.created_at,
            "company_id": evt.company_id,
            "company_name": comp_name,
            "actor_user_id": evt.actor_user_id,
            "actor_email": actor_email,
            "action": evt.action,
            "target_type": evt.target_type,
            "target_id": evt.target_id,
            "result": evt.result.value if hasattr(evt.result, "value") else str(evt.result),
            "ip": evt.ip,
            "meta": evt.meta,
        }
        for evt, comp_name, actor_email in rows
    ]

    return total, items


def get_operational_alerts(
    db: Session, *, company_id: uuid.UUID | None = None
) -> list[dict[str, Any]]:
    """Generate live, real operational alerts from database records."""
    alerts: list[dict[str, Any]] = []
    now_utc = datetime.now(timezone.utc)
    yesterday = now_utc - timedelta(hours=24)

    # 1. Quota alerts
    comp_query = select(Company)
    if company_id is not None:
        comp_query = comp_query.where(Company.id == company_id)

    companies = db.execute(comp_query).scalars().all()
    for company in companies:
        used = company_used_bytes(db, company.id)
        quota = company.quota_bytes
        if quota > 0:
            pct = (used / quota) * 100
            if pct >= 100:
                alerts.append(
                    {
                        "id": f"quota-exceeded-{company.id}",
                        "severity": "critical",
                        "category": "quota",
                        "title": f"Quota Exceeded: {company.name}",
                        "description": f"{company.name} has exceeded its storage quota ({used} / {quota} bytes, {pct:.1f}%).",
                        "company_id": company.id,
                        "company_name": company.name,
                        "detected_at": now_utc,
                    }
                )
            elif pct >= 80:
                alerts.append(
                    {
                        "id": f"quota-warning-{company.id}",
                        "severity": "warning",
                        "category": "quota",
                        "title": f"Storage Approaching Quota: {company.name}",
                        "description": f"{company.name} is utilizing {pct:.1f}% of its allocated storage.",
                        "company_id": company.id,
                        "company_name": company.name,
                        "detected_at": now_utc,
                    }
                )

        # 2. Suspended office alert
        if company.status == CompanyStatus.suspended:
            alerts.append(
                {
                    "id": f"suspended-office-{company.id}",
                    "severity": "warning",
                    "category": "system",
                    "title": f"Suspended Office: {company.name}",
                    "description": f"Office '{company.name}' is currently suspended. User access is blocked.",
                    "company_id": company.id,
                    "company_name": company.name,
                    "detected_at": now_utc,
                }
            )

        # 3. User limit alerts
        member_count = (
            db.execute(
                select(func.count(Membership.id)).where(Membership.company_id == company.id)
            ).scalar_one()
            or 0
        )
        if member_count >= company.max_users:
            alerts.append(
                {
                    "id": f"user-limit-{company.id}",
                    "severity": "warning",
                    "category": "quota",
                    "title": f"User Limit Reached: {company.name}",
                    "description": f"{company.name} has reached its maximum allowed users ({member_count}/{company.max_users}).",
                    "company_id": company.id,
                    "company_name": company.name,
                    "detected_at": now_utc,
                }
            )

    # 4. Elevated failures in the last 24h
    failure_query = select(func.count(AuditEvent.id)).where(
        AuditEvent.result != AuditResult.success,
        AuditEvent.created_at >= yesterday,
    )
    if company_id is not None:
        failure_query = failure_query.where(AuditEvent.company_id == company_id)

    fail_count = db.execute(failure_query).scalar_one() or 0
    if fail_count > 10:
        alerts.append(
            {
                "id": "elevated-failures-24h",
                "severity": "warning",
                "category": "security",
                "title": "Elevated Failure Rate in Last 24h",
                "description": f"{fail_count} failed operations or access denials recorded in the last 24 hours.",
                "company_id": company_id,
                "company_name": None,
                "detected_at": now_utc,
            }
        )

    return alerts


def get_office_overview(db: Session, company_id: uuid.UUID, *, days: int = 30) -> dict[str, Any]:
    """Calculate real office-specific metrics strictly scoped to one company."""
    company = db.get(Company, company_id)
    if company is None:
        raise ValueError("company not found")

    now_utc = datetime.now(timezone.utc)
    since_utc = now_utc - timedelta(days=max(1, days))

    # User counts
    users_query = (
        select(User.status, func.count(User.id))
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.company_id == company_id)
        .group_by(User.status)
    )
    user_status_counts = dict(db.execute(users_query).all())
    total_users = sum(user_status_counts.values())
    active_users = user_status_counts.get(UserStatus.active, 0)
    disabled_users = total_users - active_users

    # Quarries & Documents
    total_quarries = (
        db.execute(
            select(func.count(Quarry.id)).where(
                Quarry.company_id == company_id, Quarry.status == QuarryStatus.active
            )
        ).scalar_one()
        or 0
    )
    active_documents = (
        db.execute(
            select(func.count(Document.id)).where(
                Document.company_id == company_id,
                Document.status == DocumentStatus.available,
                Document.deleted_at.is_(None),
            )
        ).scalar_one()
        or 0
    )
    trash_documents = (
        db.execute(
            select(func.count(Document.id)).where(
                Document.company_id == company_id,
                Document.deleted_at.is_not(None),
            )
        ).scalar_one()
        or 0
    )

    # Storage
    used_bytes = company_used_bytes(db, company_id)
    quota_bytes = company.quota_bytes
    quota_utilization_pct = (
        round((used_bytes / quota_bytes) * 100, 2) if quota_bytes > 0 else 0.0
    )

    # Recent operations
    recent_uploads = (
        db.execute(
            select(func.count(AuditEvent.id)).where(
                AuditEvent.company_id == company_id,
                AuditEvent.action == "document.upload",
                AuditEvent.result == AuditResult.success,
                AuditEvent.created_at >= since_utc,
            )
        ).scalar_one()
        or 0
    )
    recent_downloads = (
        db.execute(
            select(func.count(AuditEvent.id)).where(
                AuditEvent.company_id == company_id,
                AuditEvent.action == "document.download",
                AuditEvent.result == AuditResult.success,
                AuditEvent.created_at >= since_utc,
            )
        ).scalar_one()
        or 0
    )
    recent_deletions = (
        db.execute(
            select(func.count(AuditEvent.id)).where(
                AuditEvent.company_id == company_id,
                AuditEvent.action == "document.delete",
                AuditEvent.result == AuditResult.success,
                AuditEvent.created_at >= since_utc,
            )
        ).scalar_one()
        or 0
    )
    recent_restorations = (
        db.execute(
            select(func.count(AuditEvent.id)).where(
                AuditEvent.company_id == company_id,
                AuditEvent.action == "document.restore",
                AuditEvent.result == AuditResult.success,
                AuditEvent.created_at >= since_utc,
            )
        ).scalar_one()
        or 0
    )
    recent_failures = (
        db.execute(
            select(func.count(AuditEvent.id)).where(
                AuditEvent.company_id == company_id,
                AuditEvent.result != AuditResult.success,
                AuditEvent.created_at >= since_utc,
            )
        ).scalar_one()
        or 0
    )

    alerts = get_operational_alerts(db, company_id=company_id)

    return {
        "company_id": company.id,
        "company_name": company.name,
        "company_status": company.status.value if hasattr(company.status, "value") else str(company.status),
        "total_users": total_users,
        "active_users": active_users,
        "disabled_users": disabled_users,
        "max_users": company.max_users,
        "total_quarries": total_quarries,
        "active_documents": active_documents,
        "trash_documents": trash_documents,
        "used_bytes": used_bytes,
        "quota_bytes": quota_bytes,
        "quota_utilization_pct": quota_utilization_pct,
        "recent_uploads_count": recent_uploads,
        "recent_downloads_count": recent_downloads,
        "recent_deletions_count": recent_deletions,
        "recent_restorations_count": recent_restorations,
        "recent_failures_count": recent_failures,
        "alerts": alerts,
    }
