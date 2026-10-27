from __future__ import annotations

import uuid

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.models import Company, Document, DocumentStatus, Folder
from app.services.errors import NotFound, QuotaExceeded

COUNTED_STATUSES = (DocumentStatus.pending, DocumentStatus.available)


def company_used_bytes(db: Session, company_id: uuid.UUID) -> int:
    """Bytes counted against the quota.
    
    Includes pending reservations, active files, and soft-deleted/purge-claimed
    files retained in storage. A file only leaves this count once storage
    deletion is confirmed and its database row is permanently deleted.
    """
    total = db.execute(
        select(func.coalesce(func.sum(Document.size_bytes), 0)).where(
            Document.company_id == company_id,
            Document.status.in_(COUNTED_STATUSES),
        )
    ).scalar_one()
    return int(total)


def reserve_document(
    db: Session,
    company_id: uuid.UUID,
    *,
    quarry_id: uuid.UUID,
    display_name: str,
    original_filename: str,
    mime_type: str,
    size_bytes: int,
    sha256: str,
    uploaded_by: uuid.UUID | None,
    folder_id: uuid.UUID | None = None,
) -> Document:
    """Reserve quota and create a pending document row.

    The company row is locked (``SELECT ... FOR UPDATE``) for the duration of a
    short transaction. Because pending rows are counted, a concurrent uploader
    cannot oversell the quota. The caller commits to release the lock before any
    slow storage I/O.

    When ``folder_id`` is given, the folder row is locked and must belong to the
    same company and quarry. Locking it prevents a concurrent folder deletion
    from racing the insert; the insert keeps the folder relation consistent.
    """
    # ``FOR NO KEY UPDATE`` still serializes quota reservations, but unlike
    # ``FOR UPDATE`` it does not conflict with the ``FOR KEY SHARE`` lock that
    # PostgreSQL takes on this row for the change_log company foreign key. That
    # avoids a cycle with a folder lock and company_sync_state during upload
    # finalization.
    locked_id = db.execute(
        text("SELECT id FROM companies WHERE id = :company_id FOR NO KEY UPDATE"),
        {"company_id": company_id},
    ).scalar_one_or_none()
    if locked_id is None:
        raise NotFound("company not found")
    company = db.get(Company, company_id, populate_existing=True)
    if company is None:
        raise NotFound("company not found")

    if folder_id is not None:
        folder = db.execute(
            select(Folder)
            .where(
                Folder.id == folder_id,
                Folder.deleted_at.is_(None),
            )
            .with_for_update()
        ).scalar_one_or_none()
        if (
            folder is None
            or folder.company_id != company_id
            or folder.quarry_id != quarry_id
        ):
            raise NotFound("folder not found")

    used = company_used_bytes(db, company_id)
    if used + size_bytes > company.quota_bytes:
        raise QuotaExceeded("company storage quota exceeded")

    document = Document(
        company_id=company_id,
        quarry_id=quarry_id,
        display_name=display_name,
        original_filename=original_filename,
        mime_type=mime_type,
        size_bytes=size_bytes,
        sha256=sha256,
        status=DocumentStatus.pending,
        uploaded_by=uploaded_by,
        folder_id=folder_id,
        version=1,
    )
    db.add(document)
    db.flush()
    return document
