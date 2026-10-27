from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Company, CompanyStatus, CompanySyncState, Membership
from app.services.errors import Conflict, NotFound
from app.services.quota import company_used_bytes


def create_company(
    db: Session, *, name: str, quota_bytes: int, max_users: int
) -> Company:
    cleaned = (name or "").strip()
    if not cleaned:
        raise Conflict("company name is required")
    if quota_bytes <= 0:
        raise Conflict("quota_bytes must be positive")
    if max_users < 1:
        raise Conflict("max_users must be at least 1")

    existing = db.execute(
        select(Company).where(func.lower(Company.name) == cleaned.lower())
    ).scalar_one_or_none()
    if existing is not None:
        raise Conflict("a company with this name already exists")

    company = Company(
        name=cleaned,
        quota_bytes=quota_bytes,
        max_users=max_users,
        status=CompanyStatus.active,
    )
    db.add(company)
    db.flush()
    # A company must have a feed state before any business mutation can append.
    db.add(CompanySyncState(company_id=company.id))
    db.commit()
    db.refresh(company)
    return company


def list_companies(db: Session) -> list[dict]:
    """Every company with its storage usage and user count."""
    companies = db.execute(select(Company).order_by(Company.name.asc())).scalars().all()
    user_counts = dict(
        db.execute(
            select(Membership.company_id, func.count(Membership.id)).group_by(
                Membership.company_id
            )
        ).all()
    )
    return [
        {
            "company": company,
            "used_bytes": company_used_bytes(db, company.id),
            "user_count": int(user_counts.get(company.id, 0)),
        }
        for company in companies
    ]


def set_company_status(
    db: Session, company_id: uuid.UUID, status: CompanyStatus
) -> Company:
    company = db.get(Company, company_id)
    if company is None:
        raise NotFound("company not found")
    company.status = status
    db.add(company)
    db.commit()
    db.refresh(company)
    return company
