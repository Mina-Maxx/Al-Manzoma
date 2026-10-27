from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, delete, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import (
    AuditEvent,
    AuditResult,
    ChangeEntityType,
    ChangeType,
    Document,
    DocumentStatus,
    Folder,
    IdempotencyKey,
    IdempotencyStatus,
    MembershipRole,
    Quarry,
)
from app.schemas import TrashDocumentOut
from app.security.context import AuthContext
from app.services import idempotency
from app.services.errors import (
    Conflict,
    Forbidden,
    Gone,
    IdempotencyConflict,
    IdempotencyInProgress,
    InvalidFileType,
    NotFound,
    PreconditionFailed,
    StorageFailure,
)
from app.services.owner_registry import active_owners
from app.services.quota import reserve_document
from app.services.sync import ChangeEntry, append_changes
from app.storage.base import Storage, StorageError, StorageUnavailable

logger = logging.getLogger("quarryvault.documents")
from app.utils.files import (
    ALLOWED_EXTENSIONS,
    ALLOWED_MIME_TYPES,
    extension_of,
    sanitize_filename,
    stream_upload_to_spool,
)


def storage_name(company_id: uuid.UUID, quarry_id: uuid.UUID, doc_id: uuid.UUID) -> str:
    """Logical storage key. Uses IDs only, never user-supplied names."""
    return f"company/{company_id}/quarry/{quarry_id}/{doc_id}"


def _document_payload(document: Document) -> dict:
    """Safe sync payload: metadata only, never a storage reference."""
    return {
        "display_name": document.display_name,
        "folder_id": str(document.folder_id) if document.folder_id else None,
        "mime_type": document.mime_type,
        "size_bytes": document.size_bytes,
        "sha256": document.sha256,
    }


@dataclass
class _Attempt:
    """A claimed (or taken-over) upload attempt owned by ``owner_token``."""

    key_id: uuid.UUID
    owner_token: uuid.UUID
    document_id: uuid.UUID | None = None
    storage_ref: str | None = None
    resolved: Document | None = None


def _check_identity(
    row: IdempotencyKey, quarry: Quarry, content_sha256: str
) -> None:
    if row.quarry_id != quarry.id or row.content_sha256 != content_sha256:
        raise IdempotencyConflict(
            "Idempotency-Key was already used with a different request"
        )


def _is_retryable(existing: IdempotencyKey) -> bool:
    """Whether a non-completed key may be safely taken over by a new owner.

    Takeover requires ALL of: no live owner in the process-local registry, and
    either a recorded failure (``failed_at``) or an expired lease. Lease expiry
    alone is never trusted: a live-but-slow owner stays registered.
    """
    if active_owners.is_active(existing.id):
        return False
    if existing.failed_at is not None:
        return True
    if existing.lease_expires_at is None:
        # No lease recorded (legacy row): treat as active and refuse takeover.
        return False
    return existing.lease_expires_at < idempotency.utcnow()


def _resolve_or_takeover(
    db: Session,
    existing: IdempotencyKey,
    quarry: Quarry,
    content_sha256: str,
    owner_token: uuid.UUID,
    settings: Settings,
) -> _Attempt:
    _check_identity(existing, quarry, content_sha256)

    if existing.status == IdempotencyStatus.completed and existing.document_id:
        document = db.get(Document, existing.document_id, populate_existing=True)
        if document is not None:
            return _Attempt(key_id=existing.id, owner_token=owner_token, resolved=document)

    if not _is_retryable(existing):
        raise IdempotencyInProgress(
            "an upload with this Idempotency-Key is in progress"
        )

    # Re-check under a row lock before CAS-ing ownership across.
    fresh = idempotency.lock_key(db, existing.id)
    if fresh is None:
        db.rollback()
        raise IdempotencyConflict("idempotency key conflict")
    if fresh.quarry_id != quarry.id or fresh.content_sha256 != content_sha256:
        db.rollback()
        raise IdempotencyConflict(
            "Idempotency-Key was already used with a different request"
        )
    if fresh.status == IdempotencyStatus.completed and fresh.document_id:
        document = db.get(Document, fresh.document_id, populate_existing=True)
        if document is not None:
            db.rollback()
            return _Attempt(key_id=fresh.id, owner_token=owner_token, resolved=document)
    if not _is_retryable(fresh):
        db.rollback()
        raise IdempotencyInProgress(
            "an upload with this Idempotency-Key is in progress"
        )
    if not idempotency.cas_takeover(
        db,
        key_id=fresh.id,
        expected_owner_token=fresh.owner_token,
        new_owner_token=owner_token,
        lease_seconds=settings.idempotency_lease_seconds,
    ):
        db.rollback()
        raise IdempotencyInProgress(
            "an upload with this Idempotency-Key is in progress"
        )

    attempt = _Attempt(
        key_id=fresh.id,
        owner_token=owner_token,
        document_id=fresh.document_id,
        storage_ref=fresh.storage_ref,
    )
    db.commit()
    return attempt


def _begin_attempt(
    db: Session,
    ctx: AuthContext,
    quarry: Quarry,
    *,
    content_sha256: str,
    idempotency_key: str,
    owner_token: uuid.UUID,
    settings: Settings,
) -> _Attempt:
    """T1: claim a fresh attempt, or resolve/retry an existing key."""
    existing = idempotency.find_key(
        db, ctx.company_id, ctx.user_id, idempotency_key
    )
    if existing is not None:
        return _resolve_or_takeover(
            db, existing, quarry, content_sha256, owner_token, settings
        )

    row = idempotency.insert_key(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user_id,
        quarry_id=quarry.id,
        key=idempotency_key,
        content_sha256=content_sha256,
        owner_token=owner_token,
        lease_seconds=settings.idempotency_lease_seconds,
    )
    try:
        db.commit()
    except IntegrityError:
        # Another request claimed the same key concurrently.
        db.rollback()
        existing = idempotency.find_key(
            db, ctx.company_id, ctx.user_id, idempotency_key
        )
        if existing is None:
            raise IdempotencyConflict("idempotency key conflict")
        return _resolve_or_takeover(
            db, existing, quarry, content_sha256, owner_token, settings
        )
    return _Attempt(key_id=row.id, owner_token=owner_token)


def _ensure_pending_document(
    db: Session,
    ctx: AuthContext,
    quarry: Quarry,
    streamed,
    display_name: str | None,
    original_filename: str,
    attempt: _Attempt,
    folder_id: uuid.UUID | None = None,
) -> Document:
    """Reuse a crashed attempt's pending document, or reserve a new one (T2)."""
    if attempt.document_id is not None:
        document = db.get(Document, attempt.document_id, populate_existing=True)
        if document is not None and document.status == DocumentStatus.pending:
            if attempt.storage_ref and document.storage_ref != attempt.storage_ref:
                document.storage_ref = attempt.storage_ref
                db.commit()
            return document
        if document is not None and document.status == DocumentStatus.available:
            # Already finalized elsewhere; nothing more to reserve.
            return document

    # Lock the idempotency key row first, then the company row (quota), then the
    # single pending document. Consistent lock order avoids deadlocks.
    fresh = idempotency.lock_key(db, attempt.key_id)
    if not idempotency.owns(fresh, attempt.owner_token):
        db.rollback()
        raise IdempotencyInProgress(
            "an upload with this Idempotency-Key is in progress"
        )
    try:
        document = reserve_document(
            db,
            ctx.company_id,
            quarry_id=quarry.id,
            display_name=sanitize_filename(display_name or original_filename),
            original_filename=original_filename,
            mime_type=streamed.mime_type,
            size_bytes=streamed.size_bytes,
            sha256=streamed.sha256,
            uploaded_by=ctx.user_id,
            folder_id=folder_id,
        )
        db.flush()
        fresh.document_id = document.id
        if attempt.storage_ref:
            document.storage_ref = attempt.storage_ref
        db.commit()
    except Exception:
        db.rollback()
        _fail_without_document(db, attempt)
        raise
    return document


def _persist_reference(
    db: Session, attempt: _Attempt, document: Document, ref: str
) -> bool:
    """T3a: durably record the storage reference before finalization."""
    fresh = idempotency.lock_key(db, attempt.key_id)
    if not idempotency.owns(fresh, attempt.owner_token):
        db.rollback()
        return False
    locked = db.execute(
        select(Document)
        .where(Document.id == document.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if locked is None or locked.status != DocumentStatus.pending:
        db.rollback()
        return False
    locked.storage_ref = ref
    fresh.storage_ref = ref
    db.commit()
    return True


def finalize_attempt(
    db: Session, attempt: _Attempt, document: Document, ref: str
) -> None:
    """T3b: flip the pending document and the key to completed, atomically."""
    fresh = idempotency.lock_key(db, attempt.key_id)
    if not idempotency.owns(fresh, attempt.owner_token):
        db.rollback()
        raise IdempotencyInProgress(
            "an upload with this Idempotency-Key is in progress"
        )
    locked = db.execute(
        select(Document)
        .where(Document.id == document.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if locked is None:
        db.rollback()
        raise StorageFailure("could not finalize the upload")
    if locked.status == DocumentStatus.pending:
        locked.storage_ref = ref
        locked.status = DocumentStatus.available
        append_changes(
            db,
            locked.company_id,
            ChangeEntry(
                quarry_id=locked.quarry_id,
                entity_type=ChangeEntityType.document,
                entity_id=locked.id,
                change_type=ChangeType.created,
                entity_version=locked.version,
                payload=_document_payload(locked),
            ),
        )
    elif locked.status == DocumentStatus.available:
        # A retried finalization must not emit a second creation event.
        locked.storage_ref = ref
    else:
        db.rollback()
        raise StorageFailure("could not finalize the upload")
    fresh.document_id = locked.id
    fresh.storage_ref = ref
    fresh.status = IdempotencyStatus.completed
    fresh.failed_at = None
    fresh.lease_expires_at = None
    db.commit()


def _fail_without_document(db: Session, attempt: _Attempt) -> None:
    """T4 without a reservation (e.g. quota rejection): mark the key failed."""
    fresh = idempotency.lock_key(db, attempt.key_id)
    if not idempotency.owns(fresh, attempt.owner_token):
        db.rollback()
        return
    fresh.failed_at = idempotency.utcnow()
    fresh.lease_expires_at = None
    db.commit()


def _fail_and_release(db: Session, attempt: _Attempt, document: Document) -> None:
    """T4: release this attempt's pending reservation; keep any storage ref."""
    fresh = idempotency.lock_key(db, attempt.key_id)
    if not idempotency.owns(fresh, attempt.owner_token):
        db.rollback()
        return
    locked = db.execute(
        select(Document)
        .where(Document.id == document.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if locked is not None and locked.status == DocumentStatus.pending:
        db.delete(locked)
    fresh.failed_at = idempotency.utcnow()
    fresh.lease_expires_at = None
    # ``fresh.storage_ref`` (if any) is preserved for recovery attribution.
    db.commit()


def _mark_failed_keep_reference(
    db: Session, attempt: _Attempt, ref: str | None
) -> None:
    """Mark a post-upload failure retryable while keeping the durable object.

    Used when T3a committed but T3b failed: the object already exists, so the
    pending document and the reference must survive to let a retry finalize
    without re-uploading or double-charging quota.
    """
    fresh = idempotency.lock_key(db, attempt.key_id)
    if not idempotency.owns(fresh, attempt.owner_token):
        db.rollback()
        return
    if ref:
        fresh.storage_ref = ref
    fresh.failed_at = idempotency.utcnow()
    fresh.lease_expires_at = None
    db.commit()


def _complete_attempt(
    db: Session,
    storage: Storage,
    ctx: AuthContext,
    quarry: Quarry,
    streamed,
    attempt: _Attempt,
    document: Document,
) -> tuple[Document, bool]:
    ref = attempt.storage_ref
    if ref is None:
        # Slow I/O happens outside any database transaction.
        try:
            ref = storage.put(
                streamed.spool,
                storage_name(ctx.company_id, quarry.id, document.id),
                content_type=streamed.mime_type,
            )
        except StorageError as exc:
            _fail_and_release(db, attempt, document)
            raise StorageFailure("file storage is unavailable") from exc

        if not _persist_reference(db, attempt, document, ref):
            # Ownership was lost after the object was written. Leave the object
            # in place (it cannot be safely attributed) and abort.
            raise IdempotencyInProgress(
                "an upload with this Idempotency-Key is in progress"
            )

    try:
        finalize_attempt(db, attempt, document, ref)
    except IdempotencyInProgress:
        raise
    except Exception:
        # The object exists but finalization failed. Keep the durable reference
        # so a retry can complete without re-uploading or re-reserving quota.
        db.rollback()
        try:
            _mark_failed_keep_reference(db, attempt, ref)
        except Exception:
            db.rollback()
        raise
    return document, True


def upload_document(
    *,
    db: Session,
    storage: Storage,
    settings: Settings,
    ctx: AuthContext,
    quarry: Quarry,
    upload_file,
    idempotency_key: str,
    display_name: str | None,
    folder_id: uuid.UUID | None = None,
) -> tuple[Document, bool]:
    """Orchestrate an authorized upload. Returns (document, created).

    ``folder_id`` is validated under a row lock when the pending document is
    reserved, so a foreign folder returns 404 before any row is inserted. Row
    locking (not an up-front check) also lets an idempotent retry return its
    original document unchanged, even if the originally requested folder was
    deleted since, and never re-files an existing document.
    """
    original_filename = sanitize_filename(upload_file.filename or "")
    if extension_of(upload_file.filename or "") not in ALLOWED_EXTENSIONS:
        raise InvalidFileType("file extension is not allowed")

    streamed = stream_upload_to_spool(upload_file.file, settings.max_file_size_bytes)
    try:
        if streamed.mime_type not in ALLOWED_MIME_TYPES:
            raise InvalidFileType("file content type is not allowed")

        owner_token = uuid.uuid4()
        attempt = _begin_attempt(
            db,
            ctx,
            quarry,
            content_sha256=streamed.sha256,
            idempotency_key=idempotency_key,
            owner_token=owner_token,
            settings=settings,
        )
        if attempt.resolved is not None:
            return attempt.resolved, False

        active_owners.register(attempt.key_id, attempt.owner_token)
        try:
            document = _ensure_pending_document(
                db,
                ctx,
                quarry,
                streamed,
                display_name,
                original_filename,
                attempt,
                folder_id,
            )
            return _complete_attempt(
                db, storage, ctx, quarry, streamed, attempt, document
            )
        finally:
            active_owners.unregister(attempt.key_id, attempt.owner_token)
    finally:
        streamed.spool.close()


def soft_delete_document(
    db: Session,
    ctx: AuthContext,
    quarry: Quarry,
    document_id: uuid.UUID,
    *,
    expected_version: int | None = None,
) -> Document:
    now_utc = datetime.now(timezone.utc)
    document = db.execute(
        select(Document)
        .where(Document.id == document_id)
        .with_for_update()
    ).scalar_one_or_none()

    if (
        document is None
        or document.company_id != ctx.company_id
        or document.quarry_id != quarry.id
    ):
        raise NotFound("document not found")

    if document.status != DocumentStatus.available or document.deleted_at is not None:
        raise NotFound("document not found")

    if expected_version is not None and document.version != expected_version:
        raise PreconditionFailed("document version does not match If-Match")

    document.deleted_at = now_utc
    document.deleted_by = ctx.user_id
    document.version += 1

    append_changes(
        db,
        ctx.company_id,
        ChangeEntry(
            quarry_id=quarry.id,
            entity_type=ChangeEntityType.document,
            entity_id=document.id,
            change_type=ChangeType.deleted,
            entity_version=document.version,
            payload={},
        ),
    )

    success_audit = AuditEvent(
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        action="document.delete",
        target_type="document",
        target_id=str(document.id),
        result=AuditResult.success,
        meta={
            "deleted_by_user_id": str(ctx.user_id),
            "deleted_by_email": ctx.user.email,
            "deleted_at": document.deleted_at.isoformat(),
            "document_name": document.display_name,
            "size_bytes": document.size_bytes,
            "quarry_id": str(quarry.id),
        },
    )
    db.add(success_audit)
    db.commit()
    return document


def restore_document(
    db: Session,
    ctx: AuthContext,
    quarry: Quarry,
    document_id: uuid.UUID,
    *,
    expected_version: int | None = None,
) -> Document:
    now_utc = datetime.now(timezone.utc)
    cutoff_30d = now_utc - timedelta(days=30)

    document = db.execute(
        select(Document)
        .where(Document.id == document_id)
        .with_for_update()
    ).scalar_one_or_none()

    if (
        document is None
        or document.company_id != ctx.company_id
        or document.quarry_id != quarry.id
    ):
        raise NotFound("document not found")

    if document.deleted_at is None:
        raise Conflict("document is not deleted")

    if expected_version is not None and document.version != expected_version:
        raise PreconditionFailed("document version does not match If-Match")

    # Authorization rule: caller must be company_admin OR the original deleter
    is_admin = ctx.role == MembershipRole.company_admin
    is_deleter = document.deleted_by is not None and document.deleted_by == ctx.user_id
    if not (is_admin or is_deleter):
        raise Forbidden(
            "only the deleting employee or a company administrator may restore this document"
        )

    # Exact 30-day boundary and purge status check:
    if (
        document.deleted_at < cutoff_30d
        or document.purge_attempt > 0
        or document.purge_claimed_at is not None
        or document.purge_failed_at is not None
    ):
        raise Gone(
            "document retention period has expired; cannot be restored"
        )

    # Approved folder fallback: if parent folder is missing or soft-deleted, unfile to root
    folder_unfiled = False
    original_folder_id = document.folder_id
    if document.folder_id is not None:
        folder = db.get(Folder, document.folder_id)
        if (
            folder is None
            or folder.deleted_at is not None
            or folder.quarry_id != document.quarry_id
        ):
            document.folder_id = None
            folder_unfiled = True

    original_deleted_by = document.deleted_by
    original_deleted_at = document.deleted_at

    document.deleted_at = None
    document.deleted_by = None
    document.version += 1

    append_changes(
        db,
        ctx.company_id,
        ChangeEntry(
            quarry_id=quarry.id,
            entity_type=ChangeEntityType.document,
            entity_id=document.id,
            change_type=ChangeType.created,
            entity_version=document.version,
            payload=_document_payload(document),
        ),
    )

    success_audit = AuditEvent(
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        action="document.restore",
        target_type="document",
        target_id=str(document.id),
        result=AuditResult.success,
        meta={
            "restored_by_user_id": str(ctx.user_id),
            "restored_by_email": ctx.user.email,
            "restorer_role": ctx.role.value,
            "previously_deleted_by": str(original_deleted_by) if original_deleted_by else None,
            "previously_deleted_at": original_deleted_at.isoformat() if original_deleted_at else None,
            "folder_unfiled": folder_unfiled,
            "original_folder_id": str(original_folder_id) if original_folder_id else None,
        },
    )
    db.add(success_audit)
    db.commit()
    return document


def list_trash_documents(
    db: Session,
    ctx: AuthContext,
    quarry: Quarry,
    *,
    limit: int = 50,
    offset: int = 0,
) -> list[TrashDocumentOut]:
    now_utc = datetime.now(timezone.utc)
    cutoff_30d = now_utc - timedelta(days=30)

    stmt = (
        select(Document)
        .where(
            Document.company_id == ctx.company_id,
            Document.quarry_id == quarry.id,
            Document.status == DocumentStatus.available,
            Document.deleted_at.is_not(None),
            Document.deleted_at >= cutoff_30d,
            Document.purge_attempt == 0,
            Document.purge_claimed_at.is_(None),
            Document.purge_failed_at.is_(None),
        )
    )
    if ctx.role != MembershipRole.company_admin:
        stmt = stmt.where(Document.deleted_by == ctx.user_id)

    rows = (
        db.execute(
            stmt.order_by(Document.deleted_at.desc())
            .limit(limit)
            .offset(offset)
        )
        .scalars()
        .all()
    )

    out: list[TrashDocumentOut] = []
    for doc in rows:
        can_restore = (
            ctx.role == MembershipRole.company_admin
            or (doc.deleted_by is not None and doc.deleted_by == ctx.user_id)
        )
        retention_expires_at = doc.deleted_at + timedelta(days=30)
        out.append(
            TrashDocumentOut(
                id=doc.id,
                quarry_id=doc.quarry_id,
                folder_id=doc.folder_id,
                display_name=doc.display_name,
                original_filename=doc.original_filename,
                mime_type=doc.mime_type,
                size_bytes=doc.size_bytes,
                version=doc.version,
                created_at=doc.created_at,
                deleted_at=doc.deleted_at,
                deleted_by=doc.deleted_by,
                can_restore=can_restore,
                retention_expires_at=retention_expires_at,
            )
        )
    return out


@dataclass(frozen=True)
class PurgeReport:
    purged_count: int
    freed_bytes: int
    failed_count: int


def purge_expired_documents(
    db: Session,
    storage: Storage,
    *,
    retention_days: int = 30,
    lease_seconds: int = 600,
    backoff_seconds: int = 300,
    batch_size: int = 50,
    now_override: datetime | None = None,
) -> PurgeReport:
    now_utc = now_override or datetime.now(timezone.utc)
    cutoff = now_utc - timedelta(days=retention_days)
    lease_cutoff = now_utc - timedelta(seconds=lease_seconds)
    backoff_cutoff = now_utc - timedelta(seconds=backoff_seconds)

    # Phase 1: Claim batch under row lock
    candidates_stmt = (
        select(Document)
        .where(
            Document.deleted_at < cutoff,
            Document.status == DocumentStatus.available,
            or_(
                and_(Document.purge_claimed_at.is_(None), Document.purge_failed_at.is_(None)),
                and_(Document.purge_claimed_at.is_(None), Document.purge_failed_at < backoff_cutoff),
                Document.purge_claimed_at < lease_cutoff,
            ),
        )
        .order_by(Document.deleted_at.asc())
        .limit(batch_size)
        .with_for_update(skip_locked=True)
    )
    candidates = db.execute(candidates_stmt).scalars().all()
    if not candidates:
        return PurgeReport(purged_count=0, freed_bytes=0, failed_count=0)

    claimed_items = []
    for doc in candidates:
        attempt = doc.purge_attempt + 1
        token = uuid.uuid4()
        doc.purge_attempt = attempt
        doc.purge_token = token
        doc.purge_claimed_at = now_utc
        doc.purge_failed_at = None
        claimed_items.append((doc.id, doc.company_id, doc.quarry_id, doc.storage_ref, doc.size_bytes, token, attempt))

    db.commit()  # Commits Phase 1 claims; in-flight lease active

    purged_count = 0
    freed_bytes = 0
    failed_count = 0

    for doc_id, company_id, quarry_id, storage_ref, size_bytes, token, attempt in claimed_items:
        storage_ok = True
        if storage_ref:
            try:
                storage.delete(storage_ref)
            except StorageUnavailable as exc:
                logger.warning("Storage delete failed for %s: %s", storage_ref, exc)
                storage_ok = False
            except Exception as exc:
                logger.error("Unexpected storage delete error for %s: %s", storage_ref, exc)
                storage_ok = False

        if not storage_ok:
            failed_count += 1
            # Fenced failure update: only update if token & attempt still match
            fail_stmt = (
                update(Document)
                .where(
                    Document.id == doc_id,
                    Document.purge_token == token,
                    Document.purge_attempt == attempt,
                )
                .values(
                    purge_failed_at=now_utc,
                    purge_claimed_at=None,
                    purge_token=None,
                )
            )
            res = db.execute(fail_stmt)
            if res.rowcount == 0:
                db.rollback()  # Stale worker safe no-op
                logger.info("Purge failure update: doc %s missing or superseded; safe no-op", doc_id)
            else:
                db.commit()
            continue

        # Phase 3: Finalize DB deletion using CAS
        del_stmt = (
            delete(Document)
            .where(
                Document.id == doc_id,
                Document.purge_token == token,
                Document.purge_attempt == attempt,
            )
        )
        res = db.execute(del_stmt)
        if res.rowcount == 0:
            db.rollback()
            logger.info("Purge finalize: doc %s already deleted or superseded; safe no-op", doc_id)
        else:
            audit_event = AuditEvent(
                company_id=company_id,
                action="document.purge",
                target_type="document",
                target_id=str(doc_id),
                result=AuditResult.success,
                meta={"storage_ref": storage_ref, "size_bytes": size_bytes},
            )
            db.add(audit_event)
            db.commit()
            purged_count += 1
            freed_bytes += size_bytes

    return PurgeReport(purged_count=purged_count, freed_bytes=freed_bytes, failed_count=failed_count)
