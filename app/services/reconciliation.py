from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Document,
    DocumentStatus,
    IdempotencyKey,
    IdempotencyStatus,
)
from app.services import idempotency
from app.services.owner_registry import active_owners


def list_reconciliation_candidates(
    db: Session, older_than_seconds: int = 3600
) -> list[dict]:
    """List documents stuck in a non-final state.

    A document that stays "pending" longer than the threshold indicates one of:
    - Drive upload never completed (safe to retry or release the reservation);
    - Drive upload succeeded but the DB finalization failed (orphan in Drive).
    No job is built in this slice; this is the detection hook.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=older_than_seconds)
    rows = db.execute(
        select(Document)
        .where(
            Document.status.in_([DocumentStatus.pending, DocumentStatus.failed]),
            Document.created_at < cutoff,
        )
        .order_by(Document.created_at.asc())
    ).scalars().all()
    return [
        {
            "document_id": doc.id,
            "company_id": doc.company_id,
            "quarry_id": doc.quarry_id,
            "status": doc.status.value,
            "storage_ref": doc.storage_ref,
            "size_bytes": doc.size_bytes,
            "created_at": doc.created_at,
            "reason": (
                "orphan_in_drive" if doc.storage_ref else "upload_incomplete"
            ),
        }
        for doc in rows
    ]


def _is_reapable(key_row: IdempotencyKey, cutoff: datetime) -> bool:
    return (
        key_row.status == IdempotencyStatus.in_progress
        and key_row.failed_at is None
        and key_row.lease_expires_at is not None
        and key_row.lease_expires_at < cutoff
    )


def reap_stale_attempts(
    db: Session,
    *,
    older_than_seconds: int = 0,
    now: datetime | None = None,
    limit: int = 100,
) -> dict:
    """Release reservations for attempts that crashed while ``in_progress``.

    A candidate is an ``in_progress`` key with no recorded failure whose lease
    has expired and which has no live owner in the process-local registry. Each
    candidate is re-checked under a row lock, then its pending reservation is
    released and the key is marked failed (``failed_at``).

    Storage objects are never deleted: an object written just before a crash
    cannot be safely attributed to this attempt, so it is left untouched
    (documented residual orphan risk). The key's ``storage_ref`` is preserved
    for recovery attribution.

    Safe to run repeatedly; returns structured counts.
    """
    moment = now or datetime.now(timezone.utc)
    cutoff = moment - timedelta(seconds=older_than_seconds)

    candidate_ids = db.execute(
        select(IdempotencyKey.id)
        .where(
            IdempotencyKey.status == IdempotencyStatus.in_progress,
            IdempotencyKey.failed_at.is_(None),
            IdempotencyKey.lease_expires_at.is_not(None),
            IdempotencyKey.lease_expires_at < cutoff,
        )
        .order_by(IdempotencyKey.lease_expires_at.asc())
        .limit(limit)
    ).scalars().all()

    reaped = 0
    skipped = 0
    for key_id in candidate_ids:
        # Cheap pre-check before taking any lock.
        if active_owners.is_active(key_id):
            skipped += 1
            continue

        fresh = db.execute(
            select(IdempotencyKey)
            .where(IdempotencyKey.id == key_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).scalar_one_or_none()
        if fresh is None or not _is_reapable(fresh, cutoff):
            db.rollback()
            skipped += 1
            continue

        # Re-check the registry after acquiring the lock: a fresh claim may have
        # registered an owner in the meantime.
        if active_owners.is_active(fresh.id):
            db.rollback()
            skipped += 1
            continue

        document = None
        if fresh.document_id is not None:
            document = db.execute(
                select(Document)
                .where(Document.id == fresh.document_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            ).scalar_one_or_none()
        observed_token = fresh.owner_token
        if document is not None and document.status == DocumentStatus.pending:
            db.delete(document)

        # CAS on the observed owner token before mutating: a newer owner must
        # never be overwritten by a stale reaper decision.
        if not idempotency.cas_mark_failed(
            db,
            key_id=fresh.id,
            expected_owner_token=observed_token,
            failed_at=moment,
        ):
            db.rollback()
            skipped += 1
            continue

        # The CAS mutates the row out-of-band; drop the stale identity-mapped
        # instance so later reads in this session see the committed state.
        db.expire(fresh)
        db.commit()
        reaped += 1

    return {"candidates": len(candidate_ids), "reaped": reaped, "skipped": skipped}
