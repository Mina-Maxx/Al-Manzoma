"""Production bootstrap: first platform_admin, first company, first company_admin.

Run once, manually, on a fresh deployment. It is NOT a development seed and it
contains no secrets: the Supabase Admin key is read from the environment only.

Identity is resolved either from an existing account (``--auth-user-id``) or by
inviting an email through the configured IdentityProvider (``--email``).

Usage:
    python scripts/bootstrap.py \
        --platform-admin-email root@example.com \
        --company-name "Acme Quarry" \
        --company-admin-email owner@example.com

    python scripts/bootstrap.py \
        --platform-admin-auth-user-id <supabase-uuid> \
        --company-name "Acme Quarry" \
        --company-admin-auth-user-id <supabase-uuid>
"""
from __future__ import annotations

import argparse
import sys
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
from app.services.identity import (  # noqa: E402
    IdentityError,
    IdentityProvider,
    build_identity_provider,
)


class BootstrapError(Exception):
    """A safe, expected bootstrap failure."""


def _resolve_auth_id(
    identity: IdentityProvider,
    *,
    email: str | None,
    auth_user_id: str | None,
    label: str,
    full_name: str | None = None,
) -> str:
    if auth_user_id:
        return auth_user_id
    if not email:
        raise BootstrapError(f"{label}: provide an --email or an --auth-user-id")
    try:
        return identity.invite_user(email=email, full_name=full_name)
    except IdentityError as exc:
        raise BootstrapError(f"{label}: identity invite failed ({exc})")


def run(
    db,
    identity: IdentityProvider,
    *,
    platform_admin: dict,
    company: dict,
    company_admin: dict,
) -> dict:
    """Create the three records atomically, refusing ambiguous identities."""
    pa_auth = _resolve_auth_id(
        identity,
        email=platform_admin.get("email"),
        auth_user_id=platform_admin.get("auth_user_id"),
        label="platform admin",
        full_name=platform_admin.get("full_name"),
    )
    ca_auth = _resolve_auth_id(
        identity,
        email=company_admin.get("email"),
        auth_user_id=company_admin.get("auth_user_id"),
        label="company admin",
        full_name=company_admin.get("full_name"),
    )

    if pa_auth == ca_auth:
        raise BootstrapError("platform admin and company admin must be different")

    existing_pa = db.execute(
        select(PlatformAdmin).where(PlatformAdmin.auth_user_id == pa_auth)
    ).scalar_one_or_none()
    if existing_pa is not None:
        raise BootstrapError("a platform admin with this identity already exists")

    # An identity must not be both a platform admin and a company member.
    if db.execute(
        select(PlatformAdmin).where(PlatformAdmin.auth_user_id == ca_auth)
    ).scalar_one_or_none() is not None:
        raise BootstrapError("the company admin identity is already a platform admin")

    pa_user = db.execute(
        select(User).where(User.auth_user_id == pa_auth)
    ).scalar_one_or_none()
    if pa_user is not None and db.execute(
        select(Membership).where(Membership.user_id == pa_user.id)
    ).scalar_one_or_none() is not None:
        raise BootstrapError("the platform admin identity already belongs to a company")

    if db.execute(
        select(Company).where(func.lower(Company.name) == company["name"].lower())
    ).scalar_one_or_none() is not None:
        raise BootstrapError("a company with this name already exists")

    ca_user = db.execute(
        select(User).where(User.auth_user_id == ca_auth)
    ).scalar_one_or_none()
    if ca_user is not None and db.execute(
        select(Membership).where(Membership.user_id == ca_user.id)
    ).scalar_one_or_none() is not None:
        raise BootstrapError("the company admin identity already belongs to a company")

    admin = PlatformAdmin(
        auth_user_id=pa_auth,
        email=platform_admin.get("email"),
        full_name=platform_admin.get("full_name"),
        status=UserStatus.active,
    )
    db.add(admin)

    new_company = Company(
        name=company["name"],
        quota_bytes=company["quota_bytes"],
        max_users=company["max_users"],
        status=CompanyStatus.active,
    )
    db.add(new_company)
    db.flush()

    if ca_user is None:
        ca_user = User(
            auth_user_id=ca_auth,
            email=company_admin.get("email"),
            full_name=company_admin.get("full_name"),
            status=UserStatus.active,
        )
        db.add(ca_user)
        db.flush()

    db.add(
        Membership(
            user_id=ca_user.id,
            company_id=new_company.id,
            role=MembershipRole.company_admin,
        )
    )
    db.commit()

    return {
        "platform_admin_id": admin.id,
        "company_id": new_company.id,
        "company_admin_user_id": ca_user.id,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python scripts/bootstrap.py",
        description="Create the first platform admin, company and company admin.",
    )
    parser.add_argument("--platform-admin-email")
    parser.add_argument("--platform-admin-auth-user-id")
    parser.add_argument("--platform-admin-name")
    parser.add_argument("--company-name", required=True)
    parser.add_argument("--quota-bytes", type=int, default=None)
    parser.add_argument("--max-users", type=int, default=None)
    parser.add_argument("--company-admin-email")
    parser.add_argument("--company-admin-auth-user-id")
    parser.add_argument("--company-admin-name")
    args = parser.parse_args(argv)

    settings = get_settings()
    identity = build_identity_provider(settings)
    engine = build_engine(settings.database_url)
    Session = build_session_factory(engine)

    try:
        with Session() as db:
            result = run(
                db,
                identity,
                platform_admin={
                    "email": args.platform_admin_email,
                    "auth_user_id": args.platform_admin_auth_user_id,
                    "full_name": args.platform_admin_name,
                },
                company={
                    "name": args.company_name,
                    "quota_bytes": args.quota_bytes
                    or settings.default_company_quota_bytes,
                    "max_users": args.max_users or settings.default_company_max_users,
                },
                company_admin={
                    "email": args.company_admin_email,
                    "auth_user_id": args.company_admin_auth_user_id,
                    "full_name": args.company_admin_name,
                },
            )
    except BootstrapError as exc:
        print(f"bootstrap failed: {exc}")
        return 1

    print("Bootstrap complete.")
    print(f"  platform admin id: {result['platform_admin_id']}")
    print(f"  company id       : {result['company_id']}")
    print(f"  company admin id : {result['company_admin_user_id']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
