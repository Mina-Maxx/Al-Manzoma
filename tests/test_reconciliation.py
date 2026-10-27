from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.models import Document, DocumentStatus
from app.services.reconciliation import list_reconciliation_candidates
from tests.factories import provision_user


def _make_doc(db, company, quarry, *, status, storage_ref, age_seconds):
    document = Document(
        company_id=company.id,
        quarry_id=quarry.id,
        display_name="doc.pdf",
        original_filename="doc.pdf",
        mime_type="application/pdf",
        size_bytes=10,
        sha256="a" * 64,
        storage_ref=storage_ref,
        status=status,
        created_at=datetime.now(timezone.utc) - timedelta(seconds=age_seconds),
    )
    db.add(document)
    db.commit()
    return document


def test_reconciliation_lists_pending_and_orphans_but_not_available(db):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    old = 7200
    recent = 10

    incomplete = _make_doc(
        db, company, quarry, status=DocumentStatus.pending, storage_ref=None, age_seconds=old
    )
    orphan = _make_doc(
        db, company, quarry, status=DocumentStatus.pending, storage_ref="drive-1", age_seconds=old
    )
    _make_doc(
        db, company, quarry, status=DocumentStatus.available, storage_ref="drive-2", age_seconds=old
    )
    _make_doc(
        db, company, quarry, status=DocumentStatus.pending, storage_ref=None, age_seconds=recent
    )

    candidates = list_reconciliation_candidates(db, older_than_seconds=3600)
    by_id = {c["document_id"]: c for c in candidates}

    assert set(by_id) == {incomplete.id, orphan.id}
    assert by_id[incomplete.id]["reason"] == "upload_incomplete"
    assert by_id[orphan.id]["reason"] == "orphan_in_drive"
