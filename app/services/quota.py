from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Company, Document, DocumentStatus
from app.services.errors import QuotaExceeded

COUNTED_STATUSES = (DocumentStatus.pending, DocumentStatus.available)


def company_used_bytes(db: Session, company_id: uuid.UUID) -> int:
    """Bytes counted against the quota (pending reservations + available files)."""
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
) -> Document:
    """Reserve quota and create a pending document row.

    The company row is locked (``SELECT ... FOR UPDATE``) for the duration of a
    short transaction. Because pending rows are counted, a concurrent uploader
    cannot oversell the quota. The caller commits to release the lock before any
    slow storage I/O.
    """
    company = db.execute(
        select(Company).where(Company.id == company_id).with_for_update()
    ).scalar_one()

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
    )
    db.add(document)
    db.flush()
    return document
