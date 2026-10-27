from __future__ import annotations

from app.models import CompanyStatus, UserStatus
from tests.factories import provision_user


def test_missing_token_is_401(client):
    assert client.get("/me").status_code == 401


def test_invalid_token_is_401(client):
    response = client.get("/me", headers={"Authorization": "Bearer not-a-jwt"})
    assert response.status_code == 401


def test_unknown_user_is_403(client, db, auth_header):
    assert client.get("/me", headers=auth_header("sub-does-not-exist")).status_code == 403


def test_inactive_user_is_rejected(client, db, auth_header):
    provision_user(db, auth_user_id="inactive-sub", user_status=UserStatus.inactive)
    response = client.get("/me", headers=auth_header("inactive-sub"))
    assert response.status_code == 403


def test_suspended_company_is_rejected(client, db, auth_header):
    provision_user(
        db, auth_user_id="susp-sub", company_status=CompanyStatus.suspended
    )
    response = client.get("/me", headers=auth_header("susp-sub"))
    assert response.status_code == 403


def test_disabling_user_blocks_the_next_request(client, db, auth_header):
    user, _, _, _ = provision_user(db, auth_user_id="toggle-sub")
    headers = auth_header("toggle-sub")

    assert client.get("/me", headers=headers).status_code == 200

    user.status = UserStatus.inactive
    db.add(user)
    db.commit()

    # Status is read from the database on every request, so the next one fails.
    assert client.get("/me", headers=headers).status_code == 403


def test_me_returns_identity_and_company(client, db, auth_header):
    user, company, quarry, _ = provision_user(db, auth_user_id="me-sub")
    response = client.get("/me", headers=auth_header("me-sub"))
    assert response.status_code == 200
    body = response.json()
    assert body["user"]["id"] == str(user.id)
    assert body["company"]["id"] == str(company.id)
    assert body["role"] == "employee"
