from __future__ import annotations

import uuid
import pytest
from sqlalchemy import select

from app.models import (
    Company,
    CompanyStatus,
    Membership,
    MembershipRole,
    PlatformAdmin,
    User,
    UserStatus,
)
from scripts.link_supabase_user import link_user


def test_link_user_success(db):
    company = Company(
        name="Test Company",
        quota_bytes=1000000,
        max_users=5,
        status=CompanyStatus.active,
    )
    db.add(company)
    db.commit()

    sub = str(uuid.uuid4())
    result = link_user(
        db,
        company_id=company.id,
        auth_user_id=sub,
        email="new_employee@example.com",
        full_name="New Employee",
        role=MembershipRole.employee,
    )

    assert result["auth_user_id"] == sub
    assert result["email"] == "new_employee@example.com"
    assert result["company_id"] == str(company.id)
    assert result["role"] == "employee"

    # Verify database state
    user = db.execute(select(User).where(User.auth_user_id == sub)).scalar_one()
    assert user.email == "new_employee@example.com"
    assert user.status == UserStatus.active

    mem = db.execute(select(Membership).where(Membership.user_id == user.id)).scalar_one()
    assert mem.company_id == company.id
    assert mem.role == MembershipRole.employee


def test_link_user_fails_if_company_missing(db):
    with pytest.raises(ValueError, match="does not exist"):
        link_user(
            db,
            company_id=uuid.uuid4(),
            auth_user_id=str(uuid.uuid4()),
            email="nobody@example.com",
        )


def test_link_user_fails_if_company_inactive(db):
    company = Company(
        name="Suspended Co",
        quota_bytes=1000000,
        max_users=5,
        status=CompanyStatus.suspended,
    )
    db.add(company)
    db.commit()

    with pytest.raises(ValueError, match="is not active"):
        link_user(
            db,
            company_id=company.id,
            auth_user_id=str(uuid.uuid4()),
            email="emp@example.com",
        )


def test_link_user_fails_if_max_users_reached(db):
    company = Company(
        name="Full Co",
        quota_bytes=1000000,
        max_users=1,
        status=CompanyStatus.active,
    )
    db.add(company)
    db.flush()

    user1 = User(auth_user_id=str(uuid.uuid4()), email="u1@example.com", status=UserStatus.active)
    db.add(user1)
    db.flush()
    db.add(Membership(user_id=user1.id, company_id=company.id, role=MembershipRole.company_admin))
    db.commit()

    with pytest.raises(ValueError, match="user limit"):
        link_user(
            db,
            company_id=company.id,
            auth_user_id=str(uuid.uuid4()),
            email="u2@example.com",
        )


def test_link_user_fails_if_platform_admin(db):
    sub = str(uuid.uuid4())
    admin = PlatformAdmin(auth_user_id=sub, email="pa@example.com", status=UserStatus.active)
    db.add(admin)

    company = Company(name="Some Co", quota_bytes=1000000, max_users=5, status=CompanyStatus.active)
    db.add(company)
    db.commit()

    with pytest.raises(ValueError, match="platform administrator"):
        link_user(
            db,
            company_id=company.id,
            auth_user_id=sub,
            email="pa@example.com",
        )


def test_link_user_fails_if_platform_admin_email_matches(db):
    admin = PlatformAdmin(auth_user_id=str(uuid.uuid4()), email="admin_pa@example.com", status=UserStatus.active)
    db.add(admin)

    company = Company(name="Co 1", quota_bytes=1000000, max_users=5, status=CompanyStatus.active)
    db.add(company)
    db.commit()

    with pytest.raises(ValueError, match="platform administrator"):
        link_user(
            db,
            company_id=company.id,
            auth_user_id=str(uuid.uuid4()),
            email="admin_pa@example.com",
        )


def test_link_user_fails_if_user_already_in_a_company(db):
    company1 = Company(name="Co A", quota_bytes=1000000, max_users=5, status=CompanyStatus.active)
    company2 = Company(name="Co B", quota_bytes=1000000, max_users=5, status=CompanyStatus.active)
    db.add_all([company1, company2])
    db.flush()

    sub = str(uuid.uuid4())
    user = User(auth_user_id=sub, email="user@coa.com", status=UserStatus.active)
    db.add(user)
    db.flush()
    db.add(Membership(user_id=user.id, company_id=company1.id, role=MembershipRole.employee))
    db.commit()

    with pytest.raises(ValueError, match="already belongs to company"):
        link_user(
            db,
            company_id=company2.id,
            auth_user_id=sub,
            email="user@coa.com",
        )


def test_link_user_fails_if_email_mismatch_for_existing_sub(db):
    company = Company(name="Co C", quota_bytes=1000000, max_users=5, status=CompanyStatus.active)
    db.add(company)
    db.flush()

    sub = str(uuid.uuid4())
    user = User(auth_user_id=sub, email="original@example.com", status=UserStatus.active)
    db.add(user)
    db.commit()

    with pytest.raises(ValueError, match="cannot link to"):
        link_user(
            db,
            company_id=company.id,
            auth_user_id=sub,
            email="different@example.com",
        )


def test_link_user_fails_if_duplicate_email_under_different_sub(db):
    company = Company(name="Co D", quota_bytes=1000000, max_users=5, status=CompanyStatus.active)
    db.add(company)
    db.flush()

    user = User(auth_user_id=str(uuid.uuid4()), email="taken@example.com", status=UserStatus.active)
    db.add(user)
    db.commit()

    with pytest.raises(ValueError, match="already exists"):
        link_user(
            db,
            company_id=company.id,
            auth_user_id=str(uuid.uuid4()),
            email="taken@example.com",
        )

