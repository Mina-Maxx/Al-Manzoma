from __future__ import annotations

from app.models import QuarryStatus
from tests.factories import make_document, provision_user
from tests.util import pdf_bytes, upload_files


def _deactivate(db, quarry):
    quarry.status = QuarryStatus.inactive
    db.add(quarry)
    db.commit()


def test_inactive_quarry_hides_documents_and_blocks_download(client, db, auth_header):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="viewer", can_view=True, can_upload=True, can_download=True
    )
    document = make_document(db, company, quarry)
    _deactivate(db, quarry)

    assert (
        client.get(
            f"/quarries/{quarry.id}/documents", headers=auth_header("viewer")
        ).status_code
        == 404
    )
    assert (
        client.get(
            f"/documents/{document.id}/download", headers=auth_header("viewer")
        ).status_code
        == 404
    )


def test_inactive_quarry_is_hidden_from_quarry_list(client, db, auth_header):
    user, company, quarry, _ = provision_user(db, auth_user_id="viewer", can_view=True)
    _deactivate(db, quarry)

    response = client.get("/quarries", headers=auth_header("viewer"))
    assert response.status_code == 200
    assert str(quarry.id) not in {item["id"] for item in response.json()}


def test_upload_to_inactive_quarry_is_404(client, db, auth_header):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="uploader", can_view=True, can_upload=True
    )
    _deactivate(db, quarry)

    response = client.post(
        f"/quarries/{quarry.id}/documents",
        headers={**auth_header("uploader"), "Idempotency-Key": "k1"},
        files=upload_files("r.pdf", pdf_bytes()),
    )
    assert response.status_code == 404
