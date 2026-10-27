"""Administrative helper: link an existing Supabase Auth user to a QuarryVault company.

This script allows an operator to link a Supabase-authenticated identity (UUID)
to a company as an employee or company admin, without requiring the backend to
hold a SUPABASE_SERVICE_ROLE_KEY.

Usage:
    python scripts/link_supabase_user.py \
        --company-id <company-uuid> \
        --auth-user-id <supabase-uuid> \
        --email employee@example.com \
        [--full-name "Full Name"] \
        [--role employee|company_admin]
"""
from __future__ import annotations

import argparse
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import func, select  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.db import build_engine, build_session_factory  # noqa: E402
from app.models import (  # noqa: E402
    Company,
    CompanyStatus,
    Membership,
    MembershipRole,
    PlatformAdmin,
    User,
    UserStatus,
)


def link_user(
    db,
    *,
    company_id: uuid.UUID,
    auth_user_id: str,
    email: str,
    full_name: str | None = None,
    role: MembershipRole = MembershipRole.employee,
) -> dict:
    cleaned_email = (email or "").strip().lower()
    clean_auth_id = (auth_user_id or "").strip()

    if not clean_auth_id:
        raise ValueError("auth_user_id is required")
    if not cleaned_email:
        raise ValueError("email is required")

    # 1. Company verification
    company = db.execute(
        select(Company).where(Company.id == company_id).with_for_update()
    ).scalar_one_or_none()
    if company is None:
        raise ValueError(f"Company {company_id} does not exist")
    if company.status != CompanyStatus.active:
        raise ValueError(f"Company {company_id} is not active ({company.status})")

    # 2. Quota verification
    member_count = db.execute(
        select(func.count(Membership.id)).where(Membership.company_id == company_id)
    ).scalar_one()
    if member_count >= company.max_users:
        raise ValueError(
            f"Company {company_id} has reached its user limit ({company.max_users})"
        )

    # 3. Check for conflicting platform admin
    if db.execute(
        select(PlatformAdmin).where(PlatformAdmin.auth_user_id == clean_auth_id)
    ).scalar_one_or_none() is not None:
        raise ValueError("This auth_user_id belongs to a platform administrator")

    if db.execute(
        select(PlatformAdmin).where(func.lower(PlatformAdmin.email) == cleaned_email)
    ).scalar_one_or_none() is not None:
        raise ValueError("This email belongs to a platform administrator")

    # 4. Check for existing user record
    existing_user_by_auth = db.execute(
        select(User).where(User.auth_user_id == clean_auth_id)
    ).scalar_one_or_none()
    if existing_user_by_auth is not None:
        if existing_user_by_auth.email.lower() != cleaned_email:
            raise ValueError(
                f"auth_user_id is already associated with email '{existing_user_by_auth.email}', cannot link to '{cleaned_email}'"
            )
        existing_mem = db.execute(
            select(Membership).where(Membership.user_id == existing_user_by_auth.id)
        ).scalar_one_or_none()
        if existing_mem is not None:
            raise ValueError(
                f"User with auth_user_id already belongs to company {existing_mem.company_id}"
            )
        user = existing_user_by_auth
    else:
        existing_user_by_email = db.execute(
            select(User).where(func.lower(User.email) == cleaned_email)
        ).scalar_one_or_none()
        if existing_user_by_email is not None:
            raise ValueError(f"User with email '{cleaned_email}' already exists in QuarryVault")

        user = User(
            auth_user_id=clean_auth_id,
            email=cleaned_email,
            full_name=full_name,
            status=UserStatus.active,
        )
        db.add(user)
        db.flush()

    try:
        membership = Membership(
            user_id=user.id,
            company_id=company.id,
            role=role,
        )
        db.add(membership)
        db.commit()
    except Exception:
        db.rollback()
        raise

    return {
        "user_id": str(user.id),
        "auth_user_id": user.auth_user_id,
        "email": user.email,
        "company_id": str(company.id),
        "company_name": company.name,
        "role": role.value,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python scripts/link_supabase_user.py",
        description="Link an external Supabase user UUID to a QuarryVault company.",
    )
    parser.add_argument("--company-id", required=True, type=uuid.UUID, help="Target company UUID")
    parser.add_argument("--auth-user-id", required=True, help="Supabase Auth User UUID (sub)")
    parser.add_argument("--email", required=True, help="User email address")
    parser.add_argument("--full-name", default=None, help="User full name (optional)")
    parser.add_argument(
        "--role",
        default="employee",
        choices=["employee", "company_admin"],
        help="Membership role (default: employee)",
    )
    args = parser.parse_args(argv)

    settings = get_settings()
    engine = build_engine(settings.database_url)
    Session = build_session_factory(engine)

    with Session() as db:
        try:
            result = link_user(
                db,
                company_id=args.company_id,
                auth_user_id=args.auth_user_id,
                email=args.email,
                full_name=args.full_name,
                role=MembershipRole(args.role),
            )
            print(f"Successfully provisioned user {result['email']} ({result['auth_user_id']}) in company '{result['company_name']}' with role '{result['role']}'.")
            return 0
        except ValueError as exc:
            print(f"Error provisioning user: {exc}", file=sys.stderr)
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
