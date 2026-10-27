from __future__ import annotations

import hashlib
import io
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from app.models import (
    Company,
    Document,
    DocumentStatus,
    IdempotencyKey,
    IdempotencyStatus,
    Membership,
    User,
)
from app.security.context import AuthContext
from app.services import document_service, idempotency
from app.services.document_service import upload_document
from app.services.errors import (
    IdempotencyConflict,
    IdempotencyInProgress,
    StorageFailure,
)
from app.services.owner_registry import active_owners
from app.services.quota import company_used_bytes
from app.services.reconciliation import reap_stale_attempts
from app.storage.base import StorageUnavailable
from tests.factories import make_quarry, provision_user
from tests.util import pdf_bytes, upload_files


def _load_ctx(session, user_id) -> AuthContext:
    user = session.get(User, user_id)
    membership = session.execute(
        select(Membership).where(Membership.user_id == user_id)
    ).scalar_one()
    company = session.get(Company, membership.company_id)
    return AuthContext(user=user, company=company, membership=membership, claims={})


def _upload(session, storage, settings, user_id, quarry, content, key):
    ctx = _load_ctx(session, user_id)
    upload_file = SimpleNamespace(filename="report.pdf", file=io.BytesIO(content))
    return upload_document(
        db=session,
        storage=storage,
        settings=settings,
        ctx=ctx,
        quarry=quarry,
        upload_file=upload_file,
        idempotency_key=key,
        display_name=None,
    )


def _storage_object_count(storage) -> int:
    return len([p for p in Path(storage.root).rglob("*") if p.is_file()])


def _expired(seconds: int = 60) -> datetime:
    return datetime.now(timezone.utc) - timedelta(seconds=seconds)


def _future(seconds: int = 300) -> datetime:
    return datetime.now(timezone.utc) + timedelta(seconds=seconds)


def _make_key(
    db,
    *,
    user,
    company,
    quarry,
    key,
    content,
    status=IdempotencyStatus.in_progress,
    lease_expires_at=None,
    failed_at=None,
    owner_token=None,
    document_id=None,
    storage_ref=None,
) -> IdempotencyKey:
    row = IdempotencyKey(
        company_id=company.id,
        user_id=user.id,
        quarry_id=quarry.id,
        key=key,
        content_sha256=hashlib.sha256(content).hexdigest(),
        status=status,
        owner_token=owner_token,
        lease_expires_at=lease_expires_at,
        failed_at=failed_at,
        document_id=document_id,
        storage_ref=storage_ref,
    )
    db.add(row)
    db.commit()
    return row


def _make_pending_doc(db, *, company, quarry, user, content, storage_ref=None) -> Document:
    document = Document(
        company_id=company.id,
        quarry_id=quarry.id,
        display_name="doc.pdf",
        original_filename="doc.pdf",
        mime_type="application/pdf",
        size_bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
        storage_ref=storage_ref,
        status=DocumentStatus.pending,
        uploaded_by=user.id,
    )
    db.add(document)
    db.commit()
    return document


# 1. Crash after T1 (claim) before T2 (reserve): stale key with no document.
def test_crash_after_claim_before_reserve_is_recovered(db, storage, settings):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, quota_bytes=10_000_000
    )
    content = pdf_bytes(500)
    _make_key(
        db,
        user=user,
        company=company,
        quarry=quarry,
        key="crash-t1",
        content=content,
        lease_expires_at=_expired(),
    )

    document, created = _upload(db, storage, settings, user.id, quarry, content, "crash-t1")

    assert created is True
    assert document.status == DocumentStatus.available
    row = db.execute(select(IdempotencyKey)).scalar_one()
    assert row.status == IdempotencyStatus.completed
    assert row.document_id == document.id
    assert row.failed_at is None
    assert company_used_bytes(db, company.id) == len(content)
    assert _storage_object_count(storage) == 1


# 2. Crash after T2 (reserve) before storage: the reaper releases the reservation.
def test_crash_after_reserve_before_storage_is_released(db, storage, settings):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, quota_bytes=10_000_000
    )
    content = pdf_bytes(500)
    doc = _make_pending_doc(db, company=company, quarry=quarry, user=user, content=content)
    _make_key(
        db,
        user=user,
        company=company,
        quarry=quarry,
        key="crash-t2",
        content=content,
        lease_expires_at=_expired(),
        document_id=doc.id,
    )
    assert company_used_bytes(db, company.id) == len(content)

    result = reap_stale_attempts(db)

    assert result == {"candidates": 1, "reaped": 1, "skipped": 0}
    assert company_used_bytes(db, company.id) == 0
    assert db.execute(select(func.count()).select_from(Document)).scalar_one() == 0
    row = db.execute(select(IdempotencyKey)).scalar_one()
    assert row.failed_at is not None
    assert row.status == IdempotencyStatus.in_progress
    assert _storage_object_count(storage) == 0


# 3. Storage failure: release the reservation, quota back to zero, key not stuck.
def test_storage_failure_releases_reservation(db, storage, settings, monkeypatch):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, quota_bytes=10_000_000
    )
    content = pdf_bytes(500)

    def boom(*args, **kwargs):
        raise StorageUnavailable("nope")

    monkeypatch.setattr(storage, "put", boom)

    with pytest.raises(StorageFailure):
        _upload(db, storage, settings, user.id, quarry, content, "store-fail")

    assert company_used_bytes(db, company.id) == 0
    assert db.execute(select(func.count()).select_from(Document)).scalar_one() == 0
    row = db.execute(select(IdempotencyKey)).scalar_one()
    assert row.failed_at is not None
    assert _storage_object_count(storage) == 0


# 4. T3a commits, T3b fails: durable reference survives and retry recovers.
def test_finalize_failure_keeps_reference_and_retry_recovers(
    db, storage, settings, monkeypatch
):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, quota_bytes=10_000_000
    )
    content = pdf_bytes(500)

    original = document_service.finalize_attempt
    calls = {"n": 0}

    def flaky(session, attempt, document, ref):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated finalize failure")
        return original(session, attempt, document, ref)

    monkeypatch.setattr(document_service, "finalize_attempt", flaky)

    with pytest.raises(RuntimeError):
        _upload(db, storage, settings, user.id, quarry, content, "t3b-fail")

    row = db.execute(select(IdempotencyKey)).scalar_one()
    assert row.failed_at is not None
    assert row.storage_ref is not None
    doc = db.execute(select(Document)).scalar_one()
    assert doc.status == DocumentStatus.pending
    assert doc.storage_ref == row.storage_ref
    assert _storage_object_count(storage) == 1
    assert company_used_bytes(db, company.id) == len(content)

    # Retry must reuse the durable reference: no second upload, no second charge.
    def no_put(*args, **kwargs):
        raise AssertionError("retry must not re-upload a durable reference")

    monkeypatch.setattr(storage, "put", no_put)

    document, created = _upload(db, storage, settings, user.id, quarry, content, "t3b-fail")

    assert created is True
    assert document.status == DocumentStatus.available
    assert db.execute(select(func.count()).select_from(Document)).scalar_one() == 1
    assert _storage_object_count(storage) == 1
    assert company_used_bytes(db, company.id) == len(content)


# 5. Lease expired but owner still registered: takeover and reaping are refused.
def test_expired_lease_with_live_owner_refuses_takeover_and_reaping(
    db, storage, settings
):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, quota_bytes=10_000_000
    )
    content = pdf_bytes(500)
    token = uuid.uuid4()
    key = _make_key(
        db,
        user=user,
        company=company,
        quarry=quarry,
        key="live-owner",
        content=content,
        lease_expires_at=_expired(),
        owner_token=token,
    )
    active_owners.register(key.id, token)
    try:
        with pytest.raises(IdempotencyInProgress):
            _upload(db, storage, settings, user.id, quarry, content, "live-owner")

        result = reap_stale_attempts(db)
        assert result["reaped"] == 0
        assert result["skipped"] == 1

        row = db.execute(select(IdempotencyKey)).scalar_one()
        assert row.failed_at is None
        assert row.owner_token == token
    finally:
        active_owners.unregister(key.id, token)


# 6. Old owner resumes after takeover: all stale mutations are fenced off.
def test_stale_owner_mutations_are_fenced_after_takeover(db, storage, settings):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, quota_bytes=10_000_000
    )
    content = pdf_bytes(500)
    old_token = uuid.uuid4()
    key = _make_key(
        db,
        user=user,
        company=company,
        quarry=quarry,
        key="fence",
        content=content,
        lease_expires_at=_expired(),
        owner_token=old_token,
    )
    doc = _make_pending_doc(db, company=company, quarry=quarry, user=user, content=content)

    new_token = uuid.uuid4()
    assert idempotency.cas_takeover(
        db,
        key_id=key.id,
        expected_owner_token=old_token,
        new_owner_token=new_token,
        lease_seconds=300,
    )
    db.commit()

    stale = document_service._Attempt(key_id=key.id, owner_token=old_token)

    # Stale owner cannot fail/release/persist/finalize anything.
    document_service._fail_without_document(db, stale)
    document_service._fail_and_release(db, stale, doc)
    assert document_service._persist_reference(db, stale, doc, "ref-x") is False

    db.refresh(key)
    assert key.owner_token == new_token
    assert key.failed_at is None
    still_pending = db.get(Document, doc.id)
    assert still_pending is not None
    assert still_pending.status == DocumentStatus.pending


# 7. Concurrent retries of a stale key: exactly one owner wins.
def test_concurrent_retries_of_stale_key_single_winner(
    db, session_factory, storage, settings
):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="racer2", can_upload=True, quota_bytes=10_000_000
    )
    content = pdf_bytes(50_000)
    _make_key(
        db,
        user=user,
        company=company,
        quarry=quarry,
        key="stale-race",
        content=content,
        lease_expires_at=_expired(),
    )

    barrier = threading.Barrier(2)
    results: list[tuple] = []
    lock = threading.Lock()

    def worker():
        session = session_factory()
        try:
            barrier.wait(timeout=30)
            document, created = _upload(
                session, storage, settings, user.id, quarry, content, "stale-race"
            )
            with lock:
                results.append(("ok", str(document.id), created))
        except IdempotencyInProgress:
            with lock:
                results.append(("in_progress", None, False))
        except Exception as exc:  # pragma: no cover - surfaced in assertion
            with lock:
                results.append((f"error:{type(exc).__name__}:{exc}", None, False))
        finally:
            session.close()

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert [r for r in results if r[0].startswith("error")] == [], results
    assert len(results) == 2
    assert db.execute(select(func.count()).select_from(Document)).scalar_one() == 1
    assert _storage_object_count(storage) == 1
    assert company_used_bytes(db, company.id) == len(content)

    oks = [r for r in results if r[0] == "ok"]
    others = [r for r in results if r[0] == "in_progress"]
    assert len(oks) >= 1
    assert len(oks) + len(others) == 2
    assert sum(1 for r in oks if r[2] is True) <= 1
    if len(oks) == 2:
        assert oks[0][1] == oks[1][1]


# 8. Reaper racing an active upload cannot steal the key or its reservation.
def test_reaper_does_not_touch_active_upload(db, storage, settings):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, quota_bytes=10_000_000
    )
    content = pdf_bytes(500)
    doc = _make_pending_doc(db, company=company, quarry=quarry, user=user, content=content)
    token = uuid.uuid4()
    key = _make_key(
        db,
        user=user,
        company=company,
        quarry=quarry,
        key="active",
        content=content,
        lease_expires_at=_future(),
        owner_token=token,
        document_id=doc.id,
    )
    active_owners.register(key.id, token)
    try:
        result = reap_stale_attempts(db)
        assert result["reaped"] == 0
        assert result["candidates"] == 0
        assert company_used_bytes(db, company.id) == len(content)
        assert db.get(Document, doc.id).status == DocumentStatus.pending
    finally:
        active_owners.unregister(key.id, token)


# 9. Quota is charged exactly once across a crash + release + retry.
def test_quota_charged_once_across_crash_and_retry(db, storage, settings):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, quota_bytes=10_000_000
    )
    content = pdf_bytes(500)
    doc = _make_pending_doc(db, company=company, quarry=quarry, user=user, content=content)
    _make_key(
        db,
        user=user,
        company=company,
        quarry=quarry,
        key="q-once",
        content=content,
        lease_expires_at=_expired(),
        document_id=doc.id,
    )
    assert company_used_bytes(db, company.id) == len(content)

    assert reap_stale_attempts(db)["reaped"] == 1
    assert company_used_bytes(db, company.id) == 0
    assert db.execute(select(func.count()).select_from(Document)).scalar_one() == 0

    document, created = _upload(db, storage, settings, user.id, quarry, content, "q-once")
    assert created is True
    assert company_used_bytes(db, company.id) == len(content)
    assert db.execute(select(func.count()).select_from(Document)).scalar_one() == 1
    assert _storage_object_count(storage) == 1


# 10. A failed key can be retried with the same content and quarry.
def test_failed_key_can_be_retried_with_same_content(db, storage, settings):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, quota_bytes=10_000_000
    )
    content = pdf_bytes(500)
    _make_key(
        db,
        user=user,
        company=company,
        quarry=quarry,
        key="retry-failed",
        content=content,
        failed_at=_expired(),
    )

    document, created = _upload(db, storage, settings, user.id, quarry, content, "retry-failed")

    assert created is True
    assert document.status == DocumentStatus.available
    row = db.execute(select(IdempotencyKey)).scalar_one()
    assert row.status == IdempotencyStatus.completed
    assert row.failed_at is None
    assert company_used_bytes(db, company.id) == len(content)


# 11. Failed/completed keys reject different content or quarry with a conflict.
def test_failed_key_rejects_different_content(db, storage, settings):
    user, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    content = pdf_bytes(500)
    _make_key(
        db,
        user=user,
        company=company,
        quarry=quarry,
        key="cf-failed",
        content=content,
        failed_at=_expired(),
    )
    with pytest.raises(IdempotencyConflict):
        _upload(db, storage, settings, user.id, quarry, pdf_bytes(999), "cf-failed")


def test_completed_key_rejects_different_content(db, storage, settings):
    user, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    _upload(db, storage, settings, user.id, quarry, pdf_bytes(500), "cf-completed")
    with pytest.raises(IdempotencyConflict):
        _upload(db, storage, settings, user.id, quarry, pdf_bytes(999), "cf-completed")


def test_failed_key_rejects_different_quarry(db, storage, settings):
    user, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    other_quarry = make_quarry(db, company, name="South Pit")
    content = pdf_bytes(500)
    _make_key(
        db,
        user=user,
        company=company,
        quarry=quarry,
        key="q-mismatch",
        content=content,
        failed_at=_expired(),
    )
    with pytest.raises(IdempotencyConflict):
        _upload(db, storage, settings, user.id, other_quarry, content, "q-mismatch")


# 12. Existing HTTP 409 translation stays correct.
def test_in_progress_conflict_translates_to_409(client, db, storage, auth_header):
    user, company, quarry, _ = provision_user(db, auth_user_id="u409", can_upload=True)
    content = pdf_bytes(300)
    _make_key(
        db,
        user=user,
        company=company,
        quarry=quarry,
        key="http409",
        content=content,
    )
    response = client.post(
        f"/quarries/{quarry.id}/documents",
        headers={**auth_header("u409"), "Idempotency-Key": "http409"},
        files=upload_files("report.pdf", content),
    )
    assert response.status_code == 409
    assert response.json() == {
        "detail": "an upload with this Idempotency-Key is in progress"
    }


# 13. No referenced object is deleted; unknown storage objects are left untouched.
def test_reaper_never_deletes_storage_objects(db, storage, settings, monkeypatch):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, quota_bytes=10_000_000
    )
    content = pdf_bytes(500)
    doc = _make_pending_doc(
        db, company=company, quarry=quarry, user=user, content=content, storage_ref="orphan-ref"
    )
    _make_key(
        db,
        user=user,
        company=company,
        quarry=quarry,
        key="no-delete",
        content=content,
        lease_expires_at=_expired(),
        document_id=doc.id,
        storage_ref="orphan-ref",
    )

    deleted: list[str] = []
    monkeypatch.setattr(storage, "delete", lambda ref: deleted.append(ref))

    reap_stale_attempts(db)

    assert deleted == []
    row = db.execute(select(IdempotencyKey)).scalar_one()
    assert row.storage_ref == "orphan-ref"
    assert row.failed_at is not None


# 14. Repeated reaper execution is idempotent.
def test_reaper_is_idempotent(db, storage, settings):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, quota_bytes=10_000_000
    )
    content = pdf_bytes(500)
    doc = _make_pending_doc(db, company=company, quarry=quarry, user=user, content=content)
    _make_key(
        db,
        user=user,
        company=company,
        quarry=quarry,
        key="idem-reap",
        content=content,
        lease_expires_at=_expired(),
        document_id=doc.id,
    )

    first = reap_stale_attempts(db)
    second = reap_stale_attempts(db)

    assert first["reaped"] == 1
    assert second == {"candidates": 0, "reaped": 0, "skipped": 0}


# 15. A stale attempt's finally cannot unregister a newer owner.
def test_stale_finally_cannot_unregister_new_owner(db):
    user, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    content = pdf_bytes(100)
    old_token = uuid.uuid4()
    new_token = uuid.uuid4()
    key = _make_key(
        db,
        user=user,
        company=company,
        quarry=quarry,
        key="finally-race",
        content=content,
    )
    active_owners.register(key.id, new_token)
    try:
        # The old attempt's `finally` must not evict the newer owner.
        active_owners.unregister(key.id, old_token)
        assert active_owners.is_active(key.id) is True
        assert active_owners.current_owner(key.id) == new_token
    finally:
        active_owners.unregister(key.id, new_token)


# 16. Successfully completing an upload still registers/unregisters cleanly.
def test_completed_upload_leaves_no_registry_entry(db, storage, settings):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, quota_bytes=10_000_000
    )
    content = pdf_bytes(500)
    document, created = _upload(db, storage, settings, user.id, quarry, content, "clean")
    assert created is True
    row = db.execute(select(IdempotencyKey)).scalar_one()
    assert row.status == IdempotencyStatus.completed
    assert active_owners.is_active(row.id) is False
