from __future__ import annotations

from tests.factories import (
    make_document,
    provision_user,
)
from tests.util import pdf_bytes, upload_files


def _setup_two_companies(db):
    user_a, company_a, quarry_a, _ = provision_user(
        db,
        auth_user_id="alice",
        company_name="Company A",
        can_upload=True,
        can_download=True,
    )
    user_b, company_b, quarry_b, _ = provision_user(
        db,
        auth_user_id="bob",
        company_name="Company B",
        can_upload=True,
        can_download=True,
    )
    document_b = make_document(db, company_b, quarry_b)
    return (user_a, company_a, quarry_a), (user_b, company_b, quarry_b), document_b


def test_list_documents_of_other_company_quarry_is_404(client, db, storage, auth_header):
    (_, _, _), (_, _, quarry_b), _ = _setup_two_companies(db)
    response = client.get(
        f"/quarries/{quarry_b.id}/documents", headers=auth_header("alice")
    )
    assert response.status_code == 404


def test_upload_to_other_company_quarry_is_404(client, db, storage, auth_header):
    (_, _, _), (_, _, quarry_b), _ = _setup_two_companies(db)
    response = client.post(
        f"/quarries/{quarry_b.id}/documents",
        headers={**auth_header("alice"), "Idempotency-Key": "k1"},
        files=upload_files("report.pdf", pdf_bytes()),
    )
    assert response.status_code == 404


def test_download_other_company_document_is_404(client, db, storage, auth_header):
    (_, _, _), (_, _, _), document_b = _setup_two_companies(db)
    response = client.get(
        f"/documents/{document_b.id}/download", headers=auth_header("alice")
    )
    assert response.status_code == 404


def test_quarries_list_only_contains_own_company(client, db, auth_header):
    (_, _, quarry_a), (_, _, quarry_b), _ = _setup_two_companies(db)
    response = client.get("/quarries", headers=auth_header("alice"))
    assert response.status_code == 200
    ids = {item["id"] for item in response.json()}
    assert str(quarry_a.id) in ids
    assert str(quarry_b.id) not in ids


def test_client_supplied_company_id_is_ignored(client, db, auth_header):
    (_, _, quarry_a), (_, company_b, _), _ = _setup_two_companies(db)
    # A client-supplied company_id in the path/query must never grant access.
    response = client.get(
        f"/quarries/{quarry_a.id}/documents?company_id={company_b.id}",
        headers=auth_header("alice"),
    )
    assert response.status_code == 200
