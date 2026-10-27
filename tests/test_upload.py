from __future__ import annotations

import hashlib

from app.models import DocumentStatus
from tests.factories import make_document, provision_user
from tests.util import exe_bytes, jpeg_bytes, pdf_bytes, png_bytes, upload_files


def _upload(
    client, auth_header, quarry_id, *, content, name="report.pdf", key="k1", data=None
):
    headers = {**auth_header, "Idempotency-Key": key}
    return client.post(
        f"/quarries/{quarry_id}/documents",
        headers=headers,
        files=upload_files(name, content),
        data=data or {},
    )


def test_happy_path_upload_then_download(client, db, storage, auth_header):
    _, _, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, can_download=True
    )
    content = pdf_bytes(512)
    response = _upload(client, auth_header("u1"), quarry.id, content=content)
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "available"
    assert body["size_bytes"] == len(content)
    assert body["sha256"] == hashlib.sha256(content).hexdigest()
    assert body["mime_type"] == "application/pdf"

    listed = client.get(f"/quarries/{quarry.id}/documents", headers=auth_header("u1"))
    assert listed.status_code == 200
    assert {d["id"] for d in listed.json()} == {body["id"]}

    download = client.get(
        f"/documents/{body['id']}/download", headers=auth_header("u1")
    )
    assert download.status_code == 200
    assert download.content == content


def test_display_name_is_used(client, db, storage, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    response = _upload(
        client,
        auth_header("u1"),
        quarry.id,
        content=pdf_bytes(),
        data={"display_name": "Quarterly Report"},
    )
    assert response.status_code == 201
    assert response.json()["display_name"] == "Quarterly Report"


def test_jpeg_and_png_are_allowed(client, db, storage, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    assert (
        _upload(
            client, auth_header("u1"), quarry.id, content=jpeg_bytes(), name="a.jpg", key="j"
        ).status_code
        == 201
    )
    assert (
        _upload(
            client, auth_header("u1"), quarry.id, content=png_bytes(), name="b.png", key="p"
        ).status_code
        == 201
    )


def test_exe_renamed_to_pdf_is_rejected(client, db, storage, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    response = _upload(
        client, auth_header("u1"), quarry.id, content=exe_bytes(), name="malware.pdf"
    )
    assert response.status_code == 415


def test_disallowed_extension_is_rejected(client, db, storage, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    response = _upload(
        client, auth_header("u1"), quarry.id, content=pdf_bytes(), name="report.doc"
    )
    assert response.status_code == 415


def test_oversize_file_is_rejected(client, db, storage, settings, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    content = pdf_bytes(settings.max_file_size_bytes + 1024)
    response = _upload(client, auth_header("u1"), quarry.id, content=content)
    assert response.status_code == 413


def test_empty_file_is_rejected(client, db, storage, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    response = _upload(client, auth_header("u1"), quarry.id, content=b"")
    assert response.status_code == 400


def test_missing_idempotency_key_is_422(client, db, storage, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    response = client.post(
        f"/quarries/{quarry.id}/documents",
        headers=auth_header("u1"),
        files=upload_files("report.pdf", pdf_bytes()),
    )
    assert response.status_code == 422


def test_over_quota_upload_is_rejected(client, db, storage, auth_header):
    _, _, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, quota_bytes=1000
    )
    response = _upload(client, auth_header("u1"), quarry.id, content=pdf_bytes(2000))
    assert response.status_code == 409


def test_list_excludes_pending_documents(client, db, auth_header):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_view=True)
    make_document(db, company, quarry, status=DocumentStatus.pending)
    response = client.get(f"/quarries/{quarry.id}/documents", headers=auth_header("u1"))
    assert response.status_code == 200
    assert response.json() == []
