from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.main import create_app
from app.models import Membership, MembershipRole, User
from app.services.identity import UnconfiguredIdentityProvider, build_identity_provider
from tests.factories import (
    make_company,
    make_document,
    make_membership,
    make_quarry,
    make_user,
)


def test_production_invite_without_service_role_key_fails_clearly(
    settings, session_factory, storage, verifier, db, auth_header
):
    # APP_ENV=production with no service-role key must not silently "succeed".
    prod = settings.model_copy(
        update={"app_env": "production", "supabase_service_role_key": ""}
    )
    assert isinstance(build_identity_provider(prod), UnconfiguredIdentityProvider)

    prod_app = create_app(
        settings=prod,
        session_factory=session_factory,
        storage=storage,
        verifier=verifier,
    )

    company = make_company(db, name="ProdCo")
    admin = make_user(db, auth_user_id="admin", email="admin@example.com")
    make_membership(db, admin, company, role=MembershipRole.company_admin)

    with TestClient(prod_app) as prod_client:
        response = prod_client.post(
            "/company/employees/invite",
            headers=auth_header("admin"),
            json={"email": "nobody@example.com"},
        )

    assert response.status_code == 502
    assert response.json()["detail"] == "identity provider unavailable"

    # No fake success: no membership and no user row was created.
    db.expire_all()
    members = db.execute(
        select(func.count())
        .select_from(Membership)
        .where(Membership.company_id == company.id)
    ).scalar_one()
    created = db.execute(
        select(func.count()).select_from(User).where(User.email == "nobody@example.com")
    ).scalar_one()
    assert members == 1
    assert created == 0


def test_company_admin_lists_are_scoped_to_own_company(client, db, auth_header):
    alpha = make_company(db, name="Alpha")
    beta = make_company(db, name="Beta")
    admin = make_user(db, auth_user_id="admin", email="admin@example.com")
    make_membership(db, admin, alpha, role=MembershipRole.company_admin)

    quarry_alpha = make_quarry(db, alpha, name="Alpha Pit")
    quarry_beta = make_quarry(db, beta, name="Beta Pit")
    outsider = make_user(db, auth_user_id="outsider", email="outsider@example.com")
    make_membership(db, outsider, beta, role=MembershipRole.employee)
    make_document(db, beta, quarry_beta, size_bytes=999)

    employees = client.get(
        "/company/employees", headers=auth_header("admin")
    ).json()
    assert str(outsider.id) not in {e["id"] for e in employees}

    quarries = client.get("/company/quarries", headers=auth_header("admin")).json()
    ids = {q["id"] for q in quarries}
    assert str(quarry_alpha.id) in ids
    assert str(quarry_beta.id) not in ids

    matrix = client.get("/company/permissions", headers=auth_header("admin")).json()
    assert str(quarry_beta.id) not in {q["id"] for q in matrix["quarries"]}

    usage = client.get("/company/usage", headers=auth_header("admin")).json()
    assert usage["used_bytes"] == 0


def test_company_admin_cannot_touch_other_company_user(client, db, auth_header):
    alpha = make_company(db, name="Alpha")
    beta = make_company(db, name="Beta")
    admin = make_user(db, auth_user_id="admin", email="admin@example.com")
    make_membership(db, admin, alpha, role=MembershipRole.company_admin)
    outsider = make_user(db, auth_user_id="outsider", email="outsider@example.com")
    make_membership(db, outsider, beta, role=MembershipRole.employee)

    assert (
        client.post(
            f"/company/employees/{outsider.id}/disable",
            headers=auth_header("admin"),
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/company/employees/{outsider.id}/enable",
            headers=auth_header("admin"),
        ).status_code
        == 404
    )


def test_company_admin_cannot_escalate(client, db, auth_header):
    company = make_company(db, name="Alpha")
    admin = make_user(db, auth_user_id="admin", email="admin@example.com")
    make_membership(db, admin, company, role=MembershipRole.company_admin)

    # Cannot reach platform endpoints (create companies / become platform admin).
    assert (
        client.post(
            "/platform/companies",
            headers=auth_header("admin"),
            json={"name": "Rogue", "quota_bytes": 1, "max_users": 1},
        ).status_code
        == 403
    )
    # An invite cannot mint another admin: the role is always "employee".
    created = client.post(
        "/company/employees/invite",
        headers=auth_header("admin"),
        json={"email": "sneaky@example.com", "role": "company_admin"},
    )
    assert created.status_code == 201
    assert created.json()["role"] == "employee"
