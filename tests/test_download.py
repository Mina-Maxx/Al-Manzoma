from __future__ import annotations

from app.models import DocumentStatus
from tests.factories import make_document, provision_user
from tests.util import pdf_bytes, upload_files


def _upload(client, auth_header, quarry_id, content, key="k1"):
    return client.post(
        f"/quarries/{quarry_id}/documents",
        headers={**auth_header, "Idempotency-Key": key},
        files=upload_files("report.pdf", content),
    )


def test_download_sets_safe_headers(client, db, storage, auth_header):
    _, _, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, can_download=True
    )
    content = pdf_bytes(256)
    document = _upload(client, auth_header("u1"), quarry.id, content).json()

    response = client.get(
        f"/documents/{document['id']}/download", headers=auth_header("u1")
    )
    assert response.status_code == 200
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.headers["content-type"] == "application/pdf"
    assert response.content == content


def test_download_pending_document_is_404(client, db, storage, auth_header):
    _, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_view=True, can_download=True
    )
    document = make_document(db, company, quarry, status=DocumentStatus.pending)
    response = client.get(
        f"/documents/{document.id}/download",
        headers=auth_header("u1"),
    )
    assert response.status_code == 404
