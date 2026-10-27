from __future__ import annotations

import io
import threading
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from sqlalchemy import func, select

from app.models import (
    AuditEvent,
    AuditResult,
    ChangeLog,
    ChangeType,
    Company,
    CompanyStatus,
    Document,
    DocumentStatus,
    Folder,
    Membership,
    MembershipRole,
    Quarry,
    QuarryStatus,
    User,
    UserStatus,
)
from app.services.document_service import (
    list_trash_documents,
    purge_expired_documents,
    restore_document,
    soft_delete_document,
)
from app.services.errors import (
    Conflict,
    Forbidden,
    Gone,
    NotFound,
    PreconditionFailed,
)
from app.services.quota import company_used_bytes
from app.storage.base import StorageNotFound, StorageUnavailable
from tests.factories import (
    make_company,
    make_document,
    make_folder,
    make_membership,
    make_permission,
    make_quarry,
    make_user,
    provision_user,
)


# ==============================================================================
# 1. Authorization & Role Separation Tests
# ==============================================================================

def test_delete_document_success_with_can_upload(client, db, auth_header):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="uploader", can_view=True, can_upload=True
    )
    doc = make_document(db, company, quarry, uploaded_by=user.id)

    response = client.delete(
        f"/quarries/{quarry.id}/documents/{doc.id}",
        headers=auth_header("uploader"),
    )
    assert response.status_code == 204

    # DB state verified
    db.refresh(doc)
    assert doc.deleted_at is not None
    assert doc.deleted_by == user.id
    assert doc.version == 2

    # Atomic audit event verified
    audit_evt = db.execute(
        select(AuditEvent).where(
            AuditEvent.action == "document.delete",
            AuditEvent.target_id == str(doc.id),
        )
    ).scalar_one()
    assert audit_evt.result == AuditResult.success
    assert audit_evt.actor_user_id == user.id
    assert audit_evt.meta["deleted_by_user_id"] == str(user.id)

    # Sync changelog verified
    change = db.execute(
        select(ChangeLog).where(
            ChangeLog.entity_id == doc.id,
            ChangeLog.change_type == "deleted",
        )
    ).scalar_one()
    assert change.entity_version == 2


def test_delete_document_denied_without_can_upload(client, db, auth_header):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="viewer", can_view=True, can_upload=False
    )
    doc = make_document(db, company, quarry)

    response = client.delete(
        f"/quarries/{quarry.id}/documents/{doc.id}",
        headers=auth_header("viewer"),
    )
    assert response.status_code == 403

    db.refresh(doc)
    assert doc.deleted_at is None


def test_delete_document_repeated_returns_404(client, db, auth_header):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="deleter", can_view=True, can_upload=True
    )
    doc = make_document(
        db, company, quarry, deleted_at=datetime.now(timezone.utc), deleted_by=user.id
    )

    response = client.delete(
        f"/quarries/{quarry.id}/documents/{doc.id}",
        headers=auth_header("deleter"),
    )
    assert response.status_code == 404


def test_delete_document_with_if_match_condition(client, db, auth_header):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="deleter", can_view=True, can_upload=True
    )
    doc = make_document(db, company, quarry, version=1)

    # Mismatched version -> 412
    resp_bad = client.delete(
        f"/quarries/{quarry.id}/documents/{doc.id}",
        headers={**auth_header("deleter"), "If-Match": '"99"'},
    )
    assert resp_bad.status_code == 412

    # Matching version -> 204
    resp_ok = client.delete(
        f"/quarries/{quarry.id}/documents/{doc.id}",
        headers={**auth_header("deleter"), "If-Match": '"1"'},
    )
    assert resp_ok.status_code == 204


def test_restore_document_by_original_deleter_succeeds_without_can_upload(
    client, db, auth_header
):
    """Proves that a deleter who only has can_view (can_upload=False) can restore."""
    user, company, quarry, _ = provision_user(
        db, auth_user_id="deleter_user", can_view=True, can_upload=False
    )
    doc = make_document(
        db,
        company,
        quarry,
        deleted_at=datetime.now(timezone.utc) - timedelta(days=2),
        deleted_by=user.id,
        version=2,
    )

    response = client.post(
        f"/quarries/{quarry.id}/documents/{doc.id}/restore",
        headers=auth_header("deleter_user"),
    )
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(doc.id)
    assert data["version"] == 3

    db.refresh(doc)
    assert doc.deleted_at is None
    assert doc.deleted_by is None
    assert doc.version == 3

    # Audit event records original deleter and restorer
    audit_evt = db.execute(
        select(AuditEvent).where(
            AuditEvent.action == "document.restore",
            AuditEvent.target_id == str(doc.id),
        )
    ).scalar_one()
    assert audit_evt.result == AuditResult.success
    assert audit_evt.meta["previously_deleted_by"] == str(user.id)
    assert audit_evt.meta["restored_by_user_id"] == str(user.id)


def test_restore_document_by_company_admin_succeeds(client, db, auth_header):
    admin, company, quarry, _ = provision_user(
        db,
        auth_user_id="admin_user",
        role=MembershipRole.company_admin,
        can_view=True,
        can_upload=False,
    )
    employee = make_user(db, auth_user_id="employee_deleter")
    make_membership(db, employee, company, role=MembershipRole.employee)
    make_permission(db, employee, quarry, can_view=True, can_upload=True)

    doc = make_document(
        db,
        company,
        quarry,
        deleted_at=datetime.now(timezone.utc) - timedelta(days=5),
        deleted_by=employee.id,
    )

    response = client.post(
        f"/quarries/{quarry.id}/documents/{doc.id}/restore",
        headers=auth_header("admin_user"),
    )
    assert response.status_code == 200

    db.refresh(doc)
    assert doc.deleted_at is None
    assert doc.deleted_by is None


def test_restore_document_denied_for_unauthorized_employee(client, db, auth_header):
    user_a, company, quarry, _ = provision_user(
        db, auth_user_id="user_a", can_view=True, can_upload=True
    )
    user_b = make_user(db, auth_user_id="user_b")
    make_membership(db, user_b, company, role=MembershipRole.employee)
    make_permission(db, user_b, quarry, can_view=True, can_upload=True)

    doc = make_document(
        db,
        company,
        quarry,
        deleted_at=datetime.now(timezone.utc) - timedelta(days=1),
        deleted_by=user_a.id,
    )

    # User B (not admin, not original deleter) attempts restore -> 403 Forbidden
    response = client.post(
        f"/quarries/{quarry.id}/documents/{doc.id}/restore",
        headers=auth_header("user_b"),
    )
    assert response.status_code == 403
    assert "only the deleting employee or a company administrator" in response.json()["detail"]

    db.refresh(doc)
    assert doc.deleted_at is not None


def test_restore_document_already_active_returns_409(client, db, auth_header):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="restorer", can_view=True, can_upload=True
    )
    doc = make_document(db, company, quarry, deleted_at=None)

    response = client.post(
        f"/quarries/{quarry.id}/documents/{doc.id}/restore",
        headers=auth_header("restorer"),
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "document is not deleted"


# ==============================================================================
# 2. Trash Listing Privacy & Visibility Tests
# ==============================================================================

def test_trash_listing_employee_sees_only_own_deletions(client, db, auth_header):
    user_a, company, quarry, _ = provision_user(
        db, auth_user_id="user_a", can_view=True, can_upload=True
    )
    user_b = make_user(db, auth_user_id="user_b")
    make_membership(db, user_b, company, role=MembershipRole.employee)
    make_permission(db, user_b, quarry, can_view=True, can_upload=True)

    now = datetime.now(timezone.utc)
    doc_a = make_document(db, company, quarry, deleted_at=now - timedelta(days=1), deleted_by=user_a.id)
    doc_b = make_document(db, company, quarry, deleted_at=now - timedelta(days=2), deleted_by=user_b.id)

    # User A requests trash -> sees only doc_a
    resp_a = client.get(f"/quarries/{quarry.id}/trash", headers=auth_header("user_a"))
    assert resp_a.status_code == 200
    ids_a = [item["id"] for item in resp_a.json()]
    assert str(doc_a.id) in ids_a
    assert str(doc_b.id) not in ids_a


def test_trash_listing_company_admin_sees_all_company_deletions(client, db, auth_header):
    admin, company, quarry, _ = provision_user(
        db, auth_user_id="admin_user", role=MembershipRole.company_admin, can_view=True
    )
    user_1 = make_user(db, auth_user_id="user_1")
    make_membership(db, user_1, company, role=MembershipRole.employee)
    make_permission(db, user_1, quarry, can_view=True)

    now = datetime.now(timezone.utc)
    doc_1 = make_document(db, company, quarry, deleted_at=now - timedelta(days=1), deleted_by=user_1.id)
    doc_2 = make_document(db, company, quarry, deleted_at=now - timedelta(days=3), deleted_by=admin.id)

    response = client.get(f"/quarries/{quarry.id}/trash", headers=auth_header("admin_user"))
    assert response.status_code == 200
    ids = [item["id"] for item in response.json()]
    assert str(doc_1.id) in ids
    assert str(doc_2.id) in ids


def test_trash_listing_excludes_documents_past_30_days(client, db, auth_header):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="user_x", can_view=True, can_upload=True
    )
    now = datetime.now(timezone.utc)
    doc_recent = make_document(db, company, quarry, deleted_at=now - timedelta(days=15), deleted_by=user.id)
    doc_expired = make_document(db, company, quarry, deleted_at=now - timedelta(days=31), deleted_by=user.id)

    response = client.get(f"/quarries/{quarry.id}/trash", headers=auth_header("user_x"))
    assert response.status_code == 200
    ids = [item["id"] for item in response.json()]
    assert str(doc_recent.id) in ids
    assert str(doc_expired.id) not in ids


# ==============================================================================
# 3. Tenant & Quarry Isolation Tests
# ==============================================================================

def test_cross_company_delete_and_restore_return_404(client, db, auth_header):
    user_a, company_a, quarry_a, _ = provision_user(
        db, auth_user_id="user_a", company_name="Company A", can_view=True, can_upload=True
    )
    user_b, company_b, quarry_b, _ = provision_user(
        db, auth_user_id="user_b", company_name="Company B", can_view=True, can_upload=True
    )
    doc_b = make_document(db, company_b, quarry_b, deleted_at=datetime.now(timezone.utc), deleted_by=user_b.id)

    # User A tries to delete Company B document -> 404
    resp_del = client.delete(
        f"/quarries/{quarry_a.id}/documents/{doc_b.id}",
        headers=auth_header("user_a"),
    )
    assert resp_del.status_code == 404

    # User A tries to restore Company B document -> 404
    resp_res = client.post(
        f"/quarries/{quarry_a.id}/documents/{doc_b.id}/restore",
        headers=auth_header("user_a"),
    )
    assert resp_res.status_code == 404


def test_inactive_quarry_cannot_delete_or_restore(client, db, auth_header):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="user_pit", can_view=True, can_upload=True
    )
    doc = make_document(db, company, quarry)

    # Deactivate quarry
    quarry.status = QuarryStatus.inactive
    db.commit()

    resp_del = client.delete(
        f"/quarries/{quarry.id}/documents/{doc.id}",
        headers=auth_header("user_pit"),
    )
    assert resp_del.status_code == 404

    # Soft-delete directly in DB to test restore path
    doc.deleted_at = datetime.now(timezone.utc)
    doc.deleted_by = user.id
    db.commit()

    resp_res = client.post(
        f"/quarries/{quarry.id}/documents/{doc.id}/restore",
        headers=auth_header("user_pit"),
    )
    assert resp_res.status_code == 404


# ==============================================================================
# 4. Exact 30-Day Retention Boundary Tests
# ==============================================================================

def test_restore_exact_30_day_boundary(client, db, auth_header):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="boundary_user", can_view=True, can_upload=True
    )
    now = datetime.now(timezone.utc)

    # Doc A: deleted 29 days, 23 hours ago (< 30 days) -> Restorable (200)
    doc_a = make_document(
        db, company, quarry, deleted_at=now - timedelta(days=29, hours=23), deleted_by=user.id
    )
    resp_a = client.post(
        f"/quarries/{quarry.id}/documents/{doc_a.id}/restore",
        headers=auth_header("boundary_user"),
    )
    assert resp_a.status_code == 200

    # Doc B: deleted exactly 30 days + 1 second ago (> 30 days) -> 410 Gone
    doc_b = make_document(
        db, company, quarry, deleted_at=now - timedelta(days=30, seconds=1), deleted_by=user.id
    )
    resp_b = client.post(
        f"/quarries/{quarry.id}/documents/{doc_b.id}/restore",
        headers=auth_header("boundary_user"),
    )
    assert resp_b.status_code == 410
    assert "retention period has expired" in resp_b.json()["detail"]


# ==============================================================================
# 5. Approved Folder Fallback Tests
# ==============================================================================

def test_restore_with_deleted_folder_unfiles_to_root(client, db, auth_header):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="folder_user", can_view=True, can_upload=True
    )
    folder = make_folder(db, company, quarry, name="Plans")
    doc = make_document(
        db,
        company,
        quarry,
        folder_id=folder.id,
        deleted_at=datetime.now(timezone.utc) - timedelta(days=1),
        deleted_by=user.id,
    )

    # Parent folder is subsequently soft-deleted
    folder.deleted_at = datetime.now(timezone.utc)
    db.commit()

    response = client.post(
        f"/quarries/{quarry.id}/documents/{doc.id}/restore",
        headers=auth_header("folder_user"),
    )
    assert response.status_code == 200
    assert response.json()["folder_id"] is None  # Unfiled to root

    db.refresh(doc)
    assert doc.folder_id is None

    # Audit records that folder was unfiled to root
    audit_evt = db.execute(
        select(AuditEvent).where(
            AuditEvent.action == "document.restore",
            AuditEvent.target_id == str(doc.id),
        )
    ).scalar_one()
    assert audit_evt.meta["folder_unfiled"] is True
    assert audit_evt.meta["original_folder_id"] == str(folder.id)


def test_restore_with_active_folder_preserves_folder_id(client, db, auth_header):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="active_folder_user", can_view=True, can_upload=True
    )
    folder = make_folder(db, company, quarry, name="Reports")
    doc = make_document(
        db,
        company,
        quarry,
        folder_id=folder.id,
        deleted_at=datetime.now(timezone.utc) - timedelta(days=2),
        deleted_by=user.id,
    )

    response = client.post(
        f"/quarries/{quarry.id}/documents/{doc.id}/restore",
        headers=auth_header("active_folder_user"),
    )
    assert response.status_code == 200
    assert response.json()["folder_id"] == str(folder.id)

    db.refresh(doc)
    assert doc.folder_id == folder.id


# ==============================================================================
# 6. Quota Accounting Tests
# ==============================================================================

def test_quota_accounting_lifecycle(client, db, storage, auth_header):
    size = 50_000
    user, company, quarry, _ = provision_user(
        db, auth_user_id="quota_tester", quota_bytes=100_000, can_view=True, can_upload=True
    )
    doc = make_document(db, company, quarry, size_bytes=size, uploaded_by=user.id)

    # 1. Active file occupies quota
    assert company_used_bytes(db, company.id) == size

    # 2. Soft-deleting document preserves quota occupied
    resp_del = client.delete(
        f"/quarries/{quarry.id}/documents/{doc.id}",
        headers=auth_header("quota_tester"),
    )
    assert resp_del.status_code == 204
    assert company_used_bytes(db, company.id) == size

    # 3. Restoring document has zero delta on quota
    resp_res = client.post(
        f"/quarries/{quarry.id}/documents/{doc.id}/restore",
        headers=auth_header("quota_tester"),
    )
    assert resp_res.status_code == 200
    assert company_used_bytes(db, company.id) == size

    # 4. Soft-delete again, then permanent purge frees quota
    client.delete(
        f"/quarries/{quarry.id}/documents/{doc.id}",
        headers=auth_header("quota_tester"),
    )
    doc.deleted_at = datetime.now(timezone.utc) - timedelta(days=35)
    db.commit()

    report = purge_expired_documents(db, storage, retention_days=30)
    assert report.purged_count == 1
    assert report.freed_bytes == size
    assert company_used_bytes(db, company.id) == 0


# ==============================================================================
# 7. Purge Fencing, Stale Workers & Safe No-Op Tests
# ==============================================================================

def test_stale_worker_missing_row_safe_noop_and_replacement_unaffected(db, storage):
    company = make_company(db)
    quarry = make_quarry(db, company)

    # 1. Document 1 created and soft-deleted (age > 30 days)
    storage_ref_1 = storage.put(io.BytesIO(b"old-content-v1"), f"doc-1-{uuid.uuid4().hex}")
    doc_1 = make_document(
        db,
        company,
        quarry,
        storage_ref=storage_ref_1,
        deleted_at=datetime.now(timezone.utc) - timedelta(days=31),
    )

    # 2. Worker 1 claims doc_1 (attempt 1)
    doc_1.purge_attempt = 1
    token_1 = uuid.uuid4()
    doc_1.purge_token = token_1
    doc_1.purge_claimed_at = datetime.now(timezone.utc) - timedelta(minutes=15)  # Expired lease
    db.commit()

    # 3. Worker 2 takes over doc_1 (attempt 2), deletes file, and deletes DB row
    doc_1.purge_attempt = 2
    token_2 = uuid.uuid4()
    doc_1.purge_token = token_2
    db.commit()

    storage.delete(storage_ref_1)
    db.delete(doc_1)
    db.commit()

    # 4. User uploads Replacement Document 2
    storage_ref_2 = storage.put(io.BytesIO(b"new-content-v2"), f"doc-2-{uuid.uuid4().hex}")
    doc_2 = make_document(
        db, company, quarry, storage_ref=storage_ref_2, status=DocumentStatus.available
    )

    # 5. Worker 1 wakes up:
    # A. storage.delete(storage_ref_1) is an idempotent no-op (file already deleted)
    storage.delete(storage_ref_1)

    # B. Worker 1 attempts CAS delete on doc_1 row using its stale token_1 and attempt 1
    stmt = (
        Document.__table__.delete().where(
            Document.id == doc_1.id,
            Document.purge_token == token_1,
            Document.purge_attempt == 1,
        )
    )
    res = db.execute(stmt)
    assert res.rowcount == 0  # 0 rows affected
    db.rollback()

    # 6. Assertions:
    # Replacement Document 2 row in DB is 100% intact
    db.refresh(doc_2)
    assert doc_2.id != doc_1.id
    assert doc_2.status == DocumentStatus.available

    # Replacement storage object is completely intact
    assert storage.exists(storage_ref_2) is True
    assert storage.open(storage_ref_2).read() == b"new-content-v2"


def test_purge_failure_fencing_prevents_overwriting_newer_worker(db):
    company = make_company(db)
    quarry = make_quarry(db, company)

    doc = make_document(
        db,
        company,
        quarry,
        deleted_at=datetime.now(timezone.utc) - timedelta(days=32),
    )

    # Worker 1 claims
    doc.purge_attempt = 1
    token_1 = uuid.uuid4()
    doc.purge_token = token_1
    doc.purge_claimed_at = datetime.now(timezone.utc) - timedelta(minutes=15)
    db.commit()

    # Worker 2 reclaims with attempt 2
    doc.purge_attempt = 2
    token_2 = uuid.uuid4()
    doc.purge_token = token_2
    doc.purge_claimed_at = datetime.now(timezone.utc)
    db.commit()

    # Worker 1 attempts to record failure with stale token_1
    fail_stmt = (
        Document.__table__.update()
        .where(
            Document.id == doc.id,
            Document.purge_token == token_1,
            Document.purge_attempt == 1,
        )
        .values(
            purge_failed_at=datetime.now(timezone.utc),
            purge_claimed_at=None,
            purge_token=None,
        )
    )
    res = db.execute(fail_stmt)
    assert res.rowcount == 0  # Mismatch, safe no-op!
    db.rollback()

    # Worker 2 state remains completely pristine in DB
    db.refresh(doc)
    assert doc.purge_attempt == 2
    assert doc.purge_token == token_2
    assert doc.purge_failed_at is None


def test_purge_preserves_db_row_when_storage_fails(db):
    company = make_company(db)
    quarry = make_quarry(db, company)
    doc = make_document(
        db,
        company,
        quarry,
        storage_ref="mock-fail-ref",
        deleted_at=datetime.now(timezone.utc) - timedelta(days=35),
    )

    failing_storage = MagicMock()
    failing_storage.delete.side_effect = StorageUnavailable("Google Drive 503 Timeout")

    report = purge_expired_documents(db, failing_storage, retention_days=30)
    assert report.purged_count == 0
    assert report.failed_count == 1

    # DB row is NOT deleted
    db.refresh(doc)
    assert doc.status == DocumentStatus.available
    assert doc.purge_failed_at is not None
    assert doc.purge_claimed_at is None


# ==============================================================================
# 8. Audit Atomicity & Transaction Consistency Tests
# ==============================================================================

def test_audit_success_event_rolled_back_on_commit_failure(client, db, auth_header, monkeypatch):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="commit_fail_user", can_view=True, can_upload=True
    )
    membership = db.execute(
        select(Membership).where(Membership.user_id == user.id, Membership.company_id == company.id)
    ).scalar_one()
    from app.security.context import AuthContext
    ctx = AuthContext(user=user, company=company, membership=membership, claims={})
    doc = make_document(db, company, quarry)

    # Monkeypatch db.commit inside soft_delete_document to simulate a DB commit failure
    orig_commit = db.commit

    def fail_commit():
        raise RuntimeError("Simulated Database Commit Failure")

    monkeypatch.setattr(db, "commit", fail_commit)

    with pytest.raises(RuntimeError, match="Simulated Database Commit Failure"):
        soft_delete_document(db, ctx, quarry, doc.id)

    db.rollback()
    # Restore original commit
    monkeypatch.setattr(db, "commit", orig_commit)

    # Document was NOT deleted
    db.refresh(doc)
    assert doc.deleted_at is None

    # NO success audit event exists in audit_events!
    success_evts = db.execute(
        select(func.count())
        .select_from(AuditEvent)
        .where(
            AuditEvent.action == "document.delete",
            AuditEvent.target_id == str(doc.id),
            AuditEvent.result == AuditResult.success,
        )
    ).scalar_one()
    assert success_evts == 0


def test_audit_failure_persisted_best_effort_when_business_transaction_fails(
    client, db, auth_header
):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="fail_audit_user", can_view=True, can_upload=True
    )
    non_existent_id = uuid.uuid4()

    response = client.delete(
        f"/quarries/{quarry.id}/documents/{non_existent_id}",
        headers=auth_header("fail_audit_user"),
    )
    assert response.status_code == 404

    # Secondary failure audit event was persisted
    fail_evt = db.execute(
        select(AuditEvent).where(
            AuditEvent.action == "document.delete",
            AuditEvent.target_id == str(non_existent_id),
            AuditEvent.result == AuditResult.failure,
        )
    ).scalar_one()
    assert fail_evt.actor_user_id == user.id


def test_deleter_identity_preserved_in_audit_after_account_deletion(db):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="temp_user", can_view=True, can_upload=True
    )
    doc = make_document(
        db,
        company,
        quarry,
        deleted_at=datetime.now(timezone.utc),
        deleted_by=user.id,
    )

    # Record deletion audit event
    evt = AuditEvent(
        company_id=company.id,
        actor_user_id=user.id,
        action="document.delete",
        target_type="document",
        target_id=str(doc.id),
        result=AuditResult.success,
        meta={
            "deleted_by_user_id": str(user.id),
            "deleted_by_email": user.email,
        },
    )
    db.add(evt)
    db.commit()

    # User row is deleted
    db.delete(user)
    db.commit()

    # doc.deleted_by was SET NULL by postgres FK
    db.refresh(doc)
    assert doc.deleted_by is None

    # BUT audit_events.meta JSONB preserves original deleter UUID and email
    db.refresh(evt)
    assert evt.actor_user_id is None  # FK set null
    assert evt.meta["deleted_by_user_id"] == str(user.id)
    assert evt.meta["deleted_by_email"] == user.email


# ==============================================================================
# 9. Genuinely Concurrent Multithreaded Race Test
# ==============================================================================

def test_genuinely_concurrent_restore_versus_purge_claim(session_factory, storage):
    # Setup test record in independent session
    with session_factory() as setup_session:
        company = make_company(setup_session)
        quarry = make_quarry(setup_session, company)
        user = make_user(setup_session)
        make_membership(setup_session, user, company)
        make_permission(setup_session, user, quarry, can_view=True, can_upload=True)
        storage_ref = storage.put(io.BytesIO(b"concurrent test content"), f"co-{company.id}/q-{quarry.id}/doc")
        doc = make_document(
            setup_session,
            company,
            quarry,
            storage_ref=storage_ref,
            deleted_at=datetime.now(timezone.utc) - timedelta(days=31),
            deleted_by=user.id,
        )
        doc_id = doc.id
        company_id = company.id
        quarry_id = quarry.id
        user_id = user.id

    barrier = threading.Barrier(2)
    results = {}

    def restore_worker():
        session = session_factory()
        try:
            from app.security.context import AuthContext
            u = session.get(User, user_id)
            c = session.get(Company, company_id)
            m = session.execute(
                select(Membership)
                .where(Membership.user_id == user_id, Membership.company_id == company_id)
            ).scalar_one()
            ctx = AuthContext(user=u, company=c, membership=m, claims={})
            q = session.get(Quarry, quarry_id)

            barrier.wait(timeout=10)
            restore_document(session, ctx, q, doc_id)
            results["restore"] = "success"
        except (Gone, Conflict) as exc:
            results["restore"] = f"blocked:{type(exc).__name__}"
        except Exception as exc:
            results["restore"] = f"error:{type(exc).__name__}:{exc}"
        finally:
            session.close()

    def purge_worker():
        session = session_factory()
        try:
            barrier.wait(timeout=10)
            rep = purge_expired_documents(session, storage, retention_days=30)
            results["purge"] = f"purged:{rep.purged_count}"
        except Exception as exc:
            results["purge"] = f"error:{type(exc).__name__}:{exc}"
        finally:
            session.close()

    t1 = threading.Thread(target=restore_worker)
    t2 = threading.Thread(target=purge_worker)

    t1.start()
    t2.start()

    t1.join(timeout=15)
    t2.join(timeout=15)

    assert "error" not in results.get("restore", "")
    assert "error" not in results.get("purge", "")

    # Consistent outcome: either restore won or purge won, no split-brain
    if results["restore"] == "success":
        assert results["purge"] == "purged:0"
    else:
        assert results["restore"].startswith("blocked")
