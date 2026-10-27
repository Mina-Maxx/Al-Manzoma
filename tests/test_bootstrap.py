from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models import (
    Company,
    CompanySyncState,
    Membership,
    MembershipRole,
    PlatformAdmin,
    User,
)
from scripts import bootstrap
from tests.factories import make_company, make_membership, make_platform_admin, make_user
from tests.fakes import FakeIdentityProvider


def _identity() -> FakeIdentityProvider:
    return FakeIdentityProvider()


def _company(name: str = "Acme Quarry") -> dict:
    return {"name": name, "quota_bytes": 1000, "max_users": 3}


def test_bootstrap_creates_records_via_identity(db):
    identity = _identity()

    result = bootstrap.run(
        db,
        identity,
        platform_admin={"email": "root@example.com"},
        company=_company(),
        company_admin={"email": "owner@example.com"},
    )

    db.expire_all()
    admin = db.get(PlatformAdmin, result["platform_admin_id"])
    assert admin.auth_user_id == "auth-root@example.com"
    assert db.get(Company, result["company_id"]).name == "Acme Quarry"
    state = db.get(CompanySyncState, result["company_id"])
    assert state is not None
    assert state.last_seq == 0
    membership = db.execute(
        select(Membership).where(Membership.company_id == result["company_id"])
    ).scalar_one()
    assert membership.role == MembershipRole.company_admin
    assert identity.invited["owner@example.com"] == "auth-owner@example.com"


def test_bootstrap_with_auth_user_ids_skips_provider(db):
    identity = _identity()

    result = bootstrap.run(
        db,
        identity,
        platform_admin={"auth_user_id": "pa-existing"},
        company=_company(),
        company_admin={"auth_user_id": "ca-existing"},
    )

    assert identity.invited == {}
    db.expire_all()
    assert db.get(User, result["company_admin_user_id"]).auth_user_id == "ca-existing"


def test_bootstrap_refuses_company_admin_that_is_platform_admin(db):
    make_platform_admin(db, auth_user_id="shared")
    with pytest.raises(bootstrap.BootstrapError):
        bootstrap.run(
            db,
            _identity(),
            platform_admin={"auth_user_id": "pa-new"},
            company=_company(),
            company_admin={"auth_user_id": "shared"},
        )


def test_bootstrap_refuses_platform_admin_with_membership(db):
    company = make_company(db)
    user = make_user(db, auth_user_id="member")
    make_membership(db, user, company, role=MembershipRole.employee)
    with pytest.raises(bootstrap.BootstrapError):
        bootstrap.run(
            db,
            _identity(),
            platform_admin={"auth_user_id": "member"},
            company=_company(),
            company_admin={"auth_user_id": "ca-x"},
        )


def test_bootstrap_refuses_same_identity(db):
    with pytest.raises(bootstrap.BootstrapError):
        bootstrap.run(
            db,
            _identity(),
            platform_admin={"auth_user_id": "same"},
            company=_company(),
            company_admin={"auth_user_id": "same"},
        )


def test_bootstrap_refuses_duplicate_company(db):
    bootstrap.run(
        db,
        _identity(),
        platform_admin={"auth_user_id": "pa1"},
        company=_company("Dup Co"),
        company_admin={"auth_user_id": "ca1"},
    )
    with pytest.raises(bootstrap.BootstrapError):
        bootstrap.run(
            db,
            _identity(),
            platform_admin={"auth_user_id": "pa2"},
            company=_company("dup co"),
            company_admin={"auth_user_id": "ca2"},
        )
