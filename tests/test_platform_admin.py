from __future__ import annotations

from sqlalchemy import func, select

from app.models import Company, CompanyStatus
from tests.factories import make_platform_admin, provision_user


def _create(client, auth_header, **overrides):
    body = {"name": "NewCo", "quota_bytes": 1000, "max_users": 5}
    body.update(overrides)
    return client.post("/platform/companies", headers=auth_header("pa"), json=body)


def _codes(response) -> str:
    return response.text


def test_platform_admin_lists_companies_with_usage(client, db, auth_header):
    make_platform_admin(db, auth_user_id="pa")
    provision_user(db, auth_user_id="e1", company_name="Alpha")

    response = client.get("/platform/companies", headers=auth_header("pa"))
    assert response.status_code == 200
    alpha = next(c for c in response.json() if c["name"] == "Alpha")
    assert alpha["user_count"] == 1
    assert alpha["used_bytes"] == 0
    assert alpha["status"] == "active"


def test_platform_admin_creates_company(client, db, auth_header):
    make_platform_admin(db, auth_user_id="pa")

    response = _create(client, auth_header, name="FreshCo", quota_bytes=2048, max_users=7)

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "FreshCo"
    assert body["quota_bytes"] == 2048
    assert body["max_users"] == 7
    db.expire_all()
    stored = db.execute(
        select(Company).where(Company.name == "FreshCo")
    ).scalar_one()
    assert stored.status == CompanyStatus.active


def test_create_company_input_validation(client, db, auth_header):
    make_platform_admin(db, auth_user_id="pa")
    assert _create(client, auth_header, name="  ").status_code == 409
    assert _create(client, auth_header, quota_bytes=0).status_code == 409
    assert _create(client, auth_header, max_users=0).status_code == 409
    assert _create(client, auth_header, name="Dup").status_code == 201
    assert _create(client, auth_header, name="dup").status_code == 409


def test_suspend_and_reactivate_take_effect_immediately(client, db, auth_header):
    make_platform_admin(db, auth_user_id="pa")
    provision_user(db, auth_user_id="e1", company_name="Alpha")
    company_id = db.execute(
        select(Company.id).where(Company.name == "Alpha")
    ).scalar_one()

    assert client.get("/me", headers=auth_header("e1")).status_code == 200
    suspend = client.post(
        f"/platform/companies/{company_id}/suspend", headers=auth_header("pa")
    )
    assert suspend.status_code == 200
    assert suspend.json()["status"] == "suspended"
    # The very next request is rejected, no caching.
    assert client.get("/me", headers=auth_header("e1")).status_code == 403

    reactivate = client.post(
        f"/platform/companies/{company_id}/reactivate", headers=auth_header("pa")
    )
    assert reactivate.status_code == 200
    assert client.get("/me", headers=auth_header("e1")).status_code == 200


def test_company_admin_cannot_use_platform_endpoints(client, db, auth_header):
    from app.models import MembershipRole
    from tests.factories import provision_user as provision

    provision(db, auth_user_id="admin", role=MembershipRole.company_admin)
    assert client.get(
        "/platform/companies", headers=auth_header("admin")
    ).status_code == 403


def test_employee_cannot_use_platform_endpoints(client, db, auth_header):
    provision_user(db, auth_user_id="emp")
    assert client.get(
        "/platform/companies", headers=auth_header("emp")
    ).status_code == 403


def test_platform_admin_requires_token(client, db):
    make_platform_admin(db, auth_user_id="pa")
    assert client.get("/platform/companies").status_code == 401
    assert (
        client.get(
            "/platform/companies", headers={"Authorization": "Bearer not-a-jwt"}
        ).status_code
        == 401
    )


def test_inactive_platform_admin_is_rejected(client, db, auth_header):
    from app.models import UserStatus

    make_platform_admin(db, auth_user_id="pa", status=UserStatus.inactive)
    assert client.get(
        "/platform/companies", headers=auth_header("pa")
    ).status_code == 403


def test_platform_admin_cannot_access_documents(client, db, auth_header):
    from tests.factories import make_document

    make_platform_admin(db, auth_user_id="pa")
    user, company, quarry, _ = provision_user(
        db, auth_user_id="e1", can_view=True, can_upload=True, can_download=True
    )
    document = make_document(db, company, quarry)

    headers = auth_header("pa")
    assert client.get("/quarries", headers=headers).status_code == 403
    assert (
        client.get(f"/quarries/{quarry.id}/documents", headers=headers).status_code
        == 403
    )
    assert (
        client.get(f"/documents/{document.id}/download", headers=headers).status_code
        == 403
    )
    upload = client.post(
        f"/quarries/{quarry.id}/documents",
        headers={**headers, "Idempotency-Key": "k1"},
        files={"file": ("r.pdf", b"%PDF-1.4\n", "application/pdf")},
    )
    assert upload.status_code == 403


def test_suspend_unknown_company_is_404(client, db, auth_header):
    import uuid

    make_platform_admin(db, auth_user_id="pa")
    response = client.post(
        f"/platform/companies/{uuid.uuid4()}/suspend", headers=auth_header("pa")
    )
    assert response.status_code == 404
