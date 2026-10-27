from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import (
    ChangeEntityType,
    ChangeType,
    Document,
    DocumentStatus,
    IdempotencyKey,
    IdempotencyStatus,
    Quarry,
)
from app.security.context import AuthContext
from app.services import idempotency
from app.services.errors import (
    IdempotencyConflict,
    IdempotencyInProgress,
    InvalidFileType,
    StorageFailure,
)
from app.services.owner_registry import active_owners
from app.services.quota import reserve_document
from app.services.sync import ChangeEntry, append_changes
from app.storage.base import Storage, StorageError
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
