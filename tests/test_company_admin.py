from __future__ import annotations

from sqlalchemy import func, select

from app.models import AuditEvent, Membership, MembershipRole, Quarry, UserStatus
from tests.factories import (
    make_company,
    make_document,
    make_membership,
    make_quarry,
    make_user,
)


def _setup(db, *, max_users: int = 10, admin_sub: str = "admin"):
    company = make_company(db, name="Alpha", max_users=max_users)
    admin = make_user(db, auth_user_id=admin_sub, email=f"{admin_sub}@example.com")
    make_membership(db, admin, company, role=MembershipRole.company_admin)
    quarry = make_quarry(db, company, name="North Pit")
    return company, admin, quarry


def _invite(client, auth_header, sub, email, **extra):
    return client.post(
        "/company/employees/invite",
        headers=auth_header(sub),
        json={"email": email, **extra},
    )


def test_invite_employee_success(client, db, auth_header, identity):
    company, _, _ = _setup(db)

    response = _invite(client, auth_header, "admin", "newbie@example.com")

    assert response.status_code == 201
    body = response.json()
    assert body["role"] == "employee"
    assert body["status"] == "active"
    assert identity.invited["newbie@example.com"] == "auth-newbie@example.com"

    db.expire_all()
    count = db.execute(
        select(func.count()).select_from(Membership).where(
            Membership.company_id == company.id
        )
    ).scalar_one()
    assert count == 2


def test_invite_writes_audit_event(client, db, auth_header):
    _setup(db)
    _invite(client, auth_header, "admin", "audited@example.com")
    db.expire_all()
    actions = {
        row[0]
        for row in db.execute(select(AuditEvent.action)).all()
    }
    assert "company.employee.invite" in actions


def test_invite_duplicate_email_is_generic_409(client, db, auth_header):
    _setup(db)
    assert _invite(client, auth_header, "admin", "dup@example.com").status_code == 201
    second = _invite(client, auth_header, "admin", "dup@example.com")
    assert second.status_code == 409
    assert second.json()["detail"] == "invitation could not be created"
    assert "dup@example.com" not in second.text


def test_invite_email_in_other_company_is_generic_409(client, db, auth_header):
    _setup(db)
    other = make_company(db, name="Beta")
    shared = make_user(db, auth_user_id="beta-user", email="shared@example.com")
    make_membership(db, shared, other, role=MembershipRole.employee)

    response = _invite(client, auth_header, "admin", "shared@example.com")
    assert response.status_code == 409
    assert response.json()["detail"] == "invitation could not be created"


def test_invite_enforces_max_users(client, db, auth_header):
    _setup(db, max_users=2)
    assert _invite(client, auth_header, "admin", "first@example.com").status_code == 201
    blocked = _invite(client, auth_header, "admin", "second@example.com")
    assert blocked.status_code == 409
    assert blocked.json()["detail"] == "company user limit reached"


def test_invite_provider_failure_is_502(client, db, auth_header, identity):
    _setup(db)
    identity.raise_identity_error = True
    response = _invite(client, auth_header, "admin", "boom@example.com")
    assert response.status_code == 502


def test_invite_provider_already_exists_is_409(client, db, auth_header, identity):
    _setup(db)
    identity.raise_already_exists = True
    response = _invite(client, auth_header, "admin", "clash@example.com")
    assert response.status_code == 409
    assert response.json()["detail"] == "invitation could not be created"


def test_invite_compensates_when_db_write_fails(client, db, auth_header, identity):
    _setup(db)
    email = "race@example.com"
    # Force an integrity conflict on the second insert: a row already owns the
    # auth id the provider is about to return, with a different email so the
    # pre-check passes.
    make_user(db, auth_user_id=f"auth-{email}", email="someone-else@example.com")

    response = _invite(client, auth_header, "admin", email)

    assert response.status_code == 502
    assert f"auth-{email}" in identity.disabled


def test_disable_and_enable_employee(client, db, auth_header, identity):
    _, _, _ = _setup(db)
    created = _invite(client, auth_header, "admin", "toggle@example.com").json()
    user_id = created["id"]
    auth_id = identity.invited["toggle@example.com"]

    disable = client.post(
        f"/company/employees/{user_id}/disable", headers=auth_header("admin")
    )
    assert disable.status_code == 200
    assert disable.json()["status"] == "inactive"
    assert auth_id in identity.disabled

    enable = client.post(
        f"/company/employees/{user_id}/enable", headers=auth_header("admin")
    )
    assert enable.status_code == 200
    assert enable.json()["status"] == "active"
    assert auth_id in identity.enabled


def test_disabling_employee_blocks_next_request(client, db, auth_header, identity):
    _setup(db)
    created = _invite(client, auth_header, "admin", "blocked@example.com").json()
    user_id = created["id"]
    # Provision a membership-scoped identity so /me works, then disable it.
    client.post(f"/company/employees/{user_id}/disable", headers=auth_header("admin"))
    # The employee authenticates by auth id "auth-blocked@example.com".
    assert (
        client.get(
            "/me", headers=auth_header("auth-blocked@example.com")
        ).status_code
        == 403
    )


def test_cannot_disable_last_company_admin(client, db, auth_header, identity):
    company, admin, _ = _setup(db)
    response = client.post(
        f"/company/employees/{admin.id}/disable", headers=auth_header("admin")
    )
    assert response.status_code == 409
    assert "last active company administrator" in response.json()["detail"]


def test_can_disable_admin_when_another_exists(client, db, auth_header, identity):
    company, admin, _ = _setup(db)
    second = make_user(db, auth_user_id="admin2", email="admin2@example.com")
    make_membership(db, second, company, role=MembershipRole.company_admin)

    response = client.post(
        f"/company/employees/{admin.id}/disable", headers=auth_header("admin2")
    )
    assert response.status_code == 200


def test_cannot_touch_other_company_user(client, db, auth_header, identity):
    _setup(db)
    other = make_company(db, name="Beta")
    outsider = make_user(db, auth_user_id="outsider", email="outsider@example.com")
    make_membership(db, outsider, other, role=MembershipRole.employee)

    response = client.post(
        f"/company/employees/{outsider.id}/disable", headers=auth_header("admin")
    )
    assert response.status_code == 404


def test_quarry_crud_and_duplicates(client, db, auth_header):
    _setup(db)
    create = client.post(
        "/company/quarries", headers=auth_header("admin"), json={"name": "South Pit"}
    )
    assert create.status_code == 201
    quarry_id = create.json()["id"]
    assert (
        client.post(
            "/company/quarries", headers=auth_header("admin"), json={"name": "south pit"}
        ).status_code
        == 409
    )

    rename = client.patch(
        f"/company/quarries/{quarry_id}",
        headers=auth_header("admin"),
        json={"name": "Deep Pit"},
    )
    assert rename.status_code == 200
    assert rename.json()["name"] == "Deep Pit"

    deactivate = client.post(
        f"/company/quarries/{quarry_id}/deactivate", headers=auth_header("admin")
    )
    assert deactivate.status_code == 200
    assert deactivate.json()["status"] == "inactive"


def test_rename_other_company_quarry_is_404(client, db, auth_header):
    _setup(db)
    other = make_company(db, name="Beta")
    other_quarry = make_quarry(db, other, name="Beta Pit")

    response = client.patch(
        f"/company/quarries/{other_quarry.id}",
        headers=auth_header("admin"),
        json={"name": "Hijack"},
    )
    assert response.status_code == 404


def test_set_permission_and_matrix(client, db, auth_header, identity):
    company, _, quarry = _setup(db)
    created = _invite(client, auth_header, "admin", "perm@example.com").json()
    user_id = created["id"]

    set_perm = client.put(
        f"/company/quarries/{quarry.id}/permissions/{user_id}",
        headers=auth_header("admin"),
        json={"can_view": True, "can_upload": True, "can_download": False},
    )
    assert set_perm.status_code == 200
    assert set_perm.json()["can_upload"] is True

    matrix = client.get("/company/permissions", headers=auth_header("admin"))
    assert matrix.status_code == 200
    body = matrix.json()
    assert any(m["id"] == user_id for m in body["members"])
    assert any(
        p["user_id"] == user_id and p["quarry_id"] == str(quarry.id)
        for p in body["permissions"]
    )


def test_set_permission_cross_company_is_404(client, db, auth_header, identity):
    _, _, quarry = _setup(db)
    other = make_company(db, name="Beta")
    outsider = make_user(db, auth_user_id="outsider", email="outsider@example.com")
    make_membership(db, outsider, other, role=MembershipRole.employee)

    response = client.put(
        f"/company/quarries/{quarry.id}/permissions/{outsider.id}",
        headers=auth_header("admin"),
        json={"can_view": True},
    )
    assert response.status_code == 404


def test_usage_matches_quota_source(client, db, auth_header):
    company, _, quarry = _setup(db)
    make_document(db, company, quarry, size_bytes=1234)

    response = client.get("/company/usage", headers=auth_header("admin"))
    assert response.status_code == 200
    assert response.json()["used_bytes"] == 1234
    assert response.json()["quota_bytes"] == company.quota_bytes


def test_employee_cannot_use_company_admin_endpoints(client, db, auth_header):
    _setup(db)
    make_user(db, auth_user_id="emp", email="emp@example.com")
    response = client.get("/company/employees", headers=auth_header("emp"))
    assert response.status_code == 403


def test_platform_admin_cannot_use_company_endpoints(client, db, auth_header):
    from tests.factories import make_platform_admin

    make_platform_admin(db, auth_user_id="pa")
    assert client.get(
        "/company/employees", headers=auth_header("pa")
    ).status_code == 403


def test_invite_is_rate_limited(client, db, auth_header, identity):
    _setup(db, max_users=100)
    for index in range(10):
        assert (
            _invite(client, auth_header, "admin", f"u{index}@example.com").status_code
            == 201
        )
    blocked = _invite(client, auth_header, "admin", "one-too-many@example.com")
    assert blocked.status_code == 429
