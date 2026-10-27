from __future__ import annotations

import uuid
import pytest
from app.models import MembershipRole, Quarry, QuarryPermission, UserStatus
from tests.factories import make_company, make_membership, make_user


def test_admin_and_employee_can_create_quarry(client, db, auth_header):
    # Setup company with admin, employee 1, employee 2
    company = make_company(db, name="Alpha Quarries")
    admin = make_user(db, auth_user_id="admin-1", email="admin1@alpha.com")
    make_membership(db, admin, company, role=MembershipRole.company_admin)

    emp1 = make_user(db, auth_user_id="emp-1", email="emp1@alpha.com")
    make_membership(db, emp1, company, role=MembershipRole.employee)

    emp2 = make_user(db, auth_user_id="emp-2", email="emp2@alpha.com")
    make_membership(db, emp2, company, role=MembershipRole.employee)

    # 1. Admin creates quarry
    res_admin = client.post(
        "/quarries",
        headers=auth_header("admin-1"),
        json={"name": "North Mountain Quarry"},
    )
    assert res_admin.status_code == 201
    data_admin = res_admin.json()
    assert data_admin["name"] == "North Mountain Quarry"
    assert data_admin["status"] == "active"
    assert data_admin["permissions"]["can_view"] is True
    assert data_admin["permissions"]["can_upload"] is False
    assert data_admin["permissions"]["can_download"] is False
    quarry_admin_id = data_admin["id"]

    # 2. Employee 1 creates Arabic-named quarry
    res_emp = client.post(
        "/quarries",
        headers=auth_header("emp-1"),
        json={"name": "محجر الجرانيت الشرقي"},
    )
    assert res_emp.status_code == 201
    data_emp = res_emp.json()
    assert data_emp["name"] == "محجر الجرانيت الشرقي"
    assert data_emp["permissions"]["can_view"] is True
    assert data_emp["permissions"]["can_upload"] is False
    assert data_emp["permissions"]["can_download"] is False
    quarry_emp_id = data_emp["id"]

    # 3. Verify visibility: Employee 2 (who did not create either) sees both quarries
    res_emp2_list = client.get("/quarries", headers=auth_header("emp-2"))
    assert res_emp2_list.status_code == 200
    listed_ids = [q["id"] for q in res_emp2_list.json()]
    assert quarry_admin_id in listed_ids
    assert quarry_emp_id in listed_ids

    # 4. Verify that can_upload and can_download are NOT automatically granted to Employee 1 or 2
    for q in res_emp2_list.json():
        if q["id"] in (quarry_admin_id, quarry_emp_id):
            assert q["permissions"]["can_view"] is True
            assert q["permissions"]["can_upload"] is False
            assert q["permissions"]["can_download"] is False


def test_cross_company_isolation_on_quarries(client, db, auth_header):
    company_a = make_company(db, name="Company A")
    company_b = make_company(db, name="Company B")

    emp_a = make_user(db, auth_user_id="emp-a", email="emp@a.com")
    make_membership(db, emp_a, company_a, role=MembershipRole.employee)

    emp_b = make_user(db, auth_user_id="emp-b", email="emp@b.com")
    make_membership(db, emp_b, company_b, role=MembershipRole.employee)

    # Employee A creates a quarry in Company A
    res_a = client.post(
        "/quarries",
        headers=auth_header("emp-a"),
        json={"name": "Company A Private Quarry"},
    )
    assert res_a.status_code == 201
    quarry_a_id = res_a.json()["id"]

    # Attempt to tamper with company_id: Employee B passes Company A's ID
    res_tamper = client.post(
        "/quarries",
        headers=auth_header("emp-b"),
        json={"name": "Hijacked Quarry", "company_id": str(company_a.id)},
    )
    assert res_tamper.status_code == 201
    hijacked_id = res_tamper.json()["id"]

    # Verify that the created quarry was assigned to Company B, NOT Company A
    q_row = db.get(Quarry, uuid.UUID(hijacked_id))
    assert q_row.company_id == company_b.id

    # Employee B listing must NOT contain Company A's quarry
    res_b_list = client.get("/quarries", headers=auth_header("emp-b"))
    b_quarry_ids = [q["id"] for q in res_b_list.json()]
    assert quarry_a_id not in b_quarry_ids
    assert hijacked_id in b_quarry_ids

    # Employee A listing must NOT contain Company B's quarry
    res_a_list = client.get("/quarries", headers=auth_header("emp-a"))
    a_quarry_ids = [q["id"] for q in res_a_list.json()]
    assert quarry_a_id in a_quarry_ids
    assert hijacked_id not in a_quarry_ids


def test_empty_and_duplicate_quarry_name_validation(client, db, auth_header):
    company = make_company(db, name="Validation Quarry Co")
    emp = make_user(db, auth_user_id="val-emp", email="val@example.com")
    make_membership(db, emp, company, role=MembershipRole.employee)

    # Empty name
    empty_res = client.post(
        "/quarries",
        headers=auth_header("val-emp"),
        json={"name": ""},
    )
    assert empty_res.status_code == 400

    # Whitespace only
    whitespace_res = client.post(
        "/quarries",
        headers=auth_header("val-emp"),
        json={"name": "   \t  \n "},
    )
    assert whitespace_res.status_code == 400

    # Create valid quarry
    ok_res = client.post(
        "/quarries",
        headers=auth_header("val-emp"),
        json={"name": "Red Granite"},
    )
    assert ok_res.status_code == 201

    # Exact duplicate name
    dup_res = client.post(
        "/quarries",
        headers=auth_header("val-emp"),
        json={"name": "Red Granite"},
    )
    assert dup_res.status_code == 409

    # Case-insensitive duplicate name
    case_dup_res = client.post(
        "/quarries",
        headers=auth_header("val-emp"),
        json={"name": "  red granite  "},
    )
    assert case_dup_res.status_code == 409


def test_inactive_or_unauthorized_user_cannot_create_quarry(client, db, auth_header):
    company = make_company(db, name="Inactive Co")
    inactive_user = make_user(
        db,
        auth_user_id="inactive-user",
        email="inactive@example.com",
        status=UserStatus.inactive,
    )
    make_membership(db, inactive_user, company, role=MembershipRole.employee)

    # Inactive user rejected
    res_inactive = client.post(
        "/quarries",
        headers=auth_header("inactive-user"),
        json={"name": "Should Fail Quarry"},
    )
    assert res_inactive.status_code == 403

    # Unauthenticated rejected
    res_unauth = client.post(
        "/quarries",
        json={"name": "No Auth Quarry"},
    )
    assert res_unauth.status_code == 401
