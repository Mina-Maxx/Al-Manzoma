"""Development seed data. Never run against production.

Creates one company, two users, two quarries and explicit permissions. Uses
fake auth user ids only; no real secrets.

Usage:
    python scripts/seed_dev.py

Auth user ids created here must match real Supabase users for end-to-end runs.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.db import build_engine, build_session_factory  # noqa: E402
from app.models import (  # noqa: E402
    Company,
    Membership,
    MembershipRole,
    Quarry,
    QuarryPermission,
    User,
)

COMPANY_NAME = "Demo Quarry Co"
ADMIN_SUB = "dev-company-admin"
EMPLOYEE_SUB = "dev-employee"


def main() -> int:
    settings = get_settings()
    engine = build_engine(settings.database_url)
    Session = build_session_factory(engine)

    with Session() as db:
        existing = db.execute(
            select(Company).where(Company.name == COMPANY_NAME)
        ).scalar_one_or_none()
        if existing is not None:
            print(f"Seed already present (company id={existing.id}). Nothing to do.")
            return 0

        company = Company(
            name=COMPANY_NAME,
            quota_bytes=settings.default_company_quota_bytes,
            max_users=settings.default_company_max_users,
        )
        db.add(company)
        db.flush()

        admin = User(
            auth_user_id=ADMIN_SUB, email="admin@example.com", full_name="Dev Admin"
        )
        employee = User(
            auth_user_id=EMPLOYEE_SUB,
            email="employee@example.com",
            full_name="Dev Employee",
        )
        db.add_all([admin, employee])
        db.flush()

        db.add_all(
            [
                Membership(
                    user_id=admin.id,
                    company_id=company.id,
                    role=MembershipRole.company_admin,
                ),
                Membership(
                    user_id=employee.id,
                    company_id=company.id,
                    role=MembershipRole.employee,
                ),
            ]
        )

        quarry_a = Quarry(company_id=company.id, name="North Pit")
        quarry_b = Quarry(company_id=company.id, name="South Pit")
        db.add_all([quarry_a, quarry_b])
        db.flush()

        db.add_all(
            [
                QuarryPermission(
                    user_id=admin.id,
                    quarry_id=quarry_a.id,
                    can_view=True,
                    can_upload=True,
                    can_download=True,
                ),
                QuarryPermission(
                    user_id=admin.id,
                    quarry_id=quarry_b.id,
                    can_view=True,
                    can_upload=True,
                    can_download=True,
                ),
                QuarryPermission(
                    user_id=employee.id,
                    quarry_id=quarry_a.id,
                    can_view=True,
                    can_upload=True,
                    can_download=False,
                ),
            ]
        )
        db.commit()

        print("Seed complete.")
        print(f"  company id : {company.id}")
        print(f"  quarry A id: {quarry_a.id}")
        print(f"  quarry B id: {quarry_b.id}")
        print(f"  admin sub  : {ADMIN_SUB}")
        print(f"  employee   : {EMPLOYEE_SUB}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
