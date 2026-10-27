from __future__ import annotations

from tests.factories import make_document, provision_user
from tests.util import pdf_bytes, upload_files


def _doc_for(db, company, quarry):
    return make_document(db, company, quarry)


def test_upload_denied_without_can_upload(client, db, storage, auth_header):
    _, company, quarry, _ = provision_user(
        db, auth_user_id="viewer", can_view=True, can_upload=False
    )
    response = client.post(
        f"/quarries/{quarry.id}/documents",
        headers={**auth_header("viewer"), "Idempotency-Key": "k1"},
        files=upload_files("report.pdf", pdf_bytes()),
    )
    assert response.status_code == 403


def test_download_denied_without_can_download(client, db, auth_header):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="viewer", can_view=True, can_download=False
    )
    document = _doc_for(db, company, quarry)
    response = client.get(
        f"/documents/{document.id}/download", headers=auth_header("viewer")
    )
    assert response.status_code == 403


def test_documents_denied_without_can_view(client, db, auth_header):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="nobody", can_view=False, can_upload=True, can_download=True
    )
    response = client.get(
        f"/quarries/{quarry.id}/documents", headers=auth_header("nobody")
    )
    assert response.status_code == 403


def test_quarry_hidden_without_can_view(client, db, auth_header):
    user, company, quarry, _ = provision_user(db, auth_user_id="nobody", can_view=False)
    response = client.get("/quarries", headers=auth_header("nobody"))
    assert response.status_code == 200
    assert str(quarry.id) not in {item["id"] for item in response.json()}


def test_permissions_are_not_granted_automatically(client, db, auth_header):
    """A user with no permission rows at all sees no quarries."""
    from tests.factories import make_membership, make_quarry, make_company, make_user

    company = make_company(db)
    user = make_user(db, auth_user_id="lonely")
    make_membership(db, user, company)
    quarry = make_quarry(db, company)

    response = client.get("/quarries", headers=auth_header("lonely"))
    assert response.status_code == 200
    assert response.json() == []
    assert (
        client.get(
            f"/quarries/{quarry.id}/documents", headers=auth_header("lonely")
        ).status_code
        == 403
    )
