from __future__ import annotations

import hashlib

from sqlalchemy import func, select

from app.models import Document, IdempotencyKey, IdempotencyStatus
from tests.factories import provision_user
from tests.util import pdf_bytes, upload_files


def _upload(client, auth_header, quarry_id, content, key):
    return client.post(
        f"/quarries/{quarry_id}/documents",
        headers={**auth_header, "Idempotency-Key": key},
        files=upload_files("report.pdf", content),
    )


def test_same_key_twice_creates_one_document(client, db, storage, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    content = pdf_bytes(300)

    first = _upload(client, auth_header("u1"), quarry.id, content, "same-key")
    second = _upload(client, auth_header("u1"), quarry.id, content, "same-key")

    assert first.status_code == 201
    assert second.status_code == 200
    assert first.json()["id"] == second.json()["id"]

    doc_count = db.execute(select(func.count()).select_from(Document)).scalar_one()
    key_count = db.execute(select(func.count()).select_from(IdempotencyKey)).scalar_one()
    assert doc_count == 1
    assert key_count == 1


def test_same_key_with_different_content_is_409(client, db, storage, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)

    first = _upload(client, auth_header("u1"), quarry.id, pdf_bytes(300), "key-x")
    assert first.status_code == 201

    second = _upload(client, auth_header("u1"), quarry.id, pdf_bytes(999), "key-x")
    assert second.status_code == 409


def test_different_keys_create_different_documents(client, db, storage, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)

    first = _upload(client, auth_header("u1"), quarry.id, pdf_bytes(300), "key-1")
    second = _upload(client, auth_header("u1"), quarry.id, pdf_bytes(300), "key-2")
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["id"] != second.json()["id"]
    doc_count = db.execute(select(func.count()).select_from(Document)).scalar_one()
    assert doc_count == 2


def test_in_progress_key_is_translated_to_http_409(client, db, storage, auth_header):
    user, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    content = pdf_bytes(300)
    key = "in-progress-key"

    db.add(
        IdempotencyKey(
            company_id=company.id,
            user_id=user.id,
            quarry_id=quarry.id,
            key=key,
            content_sha256=hashlib.sha256(content).hexdigest(),
            status=IdempotencyStatus.in_progress,
        )
    )
    db.commit()

    response = _upload(client, auth_header("u1"), quarry.id, content, key)

    assert response.status_code == 409
    assert response.json() == {
        "detail": "an upload with this Idempotency-Key is in progress"
    }

    doc_count = db.execute(select(func.count()).select_from(Document)).scalar_one()
    assert doc_count == 0
