from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.models import IdempotencyKey, IdempotencyStatus

DEFAULT_LEASE_SECONDS = 300


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def lease_deadline(seconds: int) -> datetime:
    return utcnow() + timedelta(seconds=seconds)


def find_key(
    db: Session, company_id: uuid.UUID, user_id: uuid.UUID, key: str
) -> IdempotencyKey | None:
    return db.execute(
        select(IdempotencyKey).where(
            IdempotencyKey.company_id == company_id,
            IdempotencyKey.user_id == user_id,
            IdempotencyKey.key == key,
        )
    ).scalar_one_or_none()


def lock_key(db: Session, key_id: uuid.UUID) -> IdempotencyKey | None:
    """Load an idempotency key row under a ``SELECT ... FOR UPDATE`` lock.

    ``populate_existing`` is required: sessions use ``expire_on_commit=False``,
    so without it the row lock would return a stale identity-mapped instance
    instead of the authoritative columns (owner token, status, lease).
    """
    return db.execute(
        select(IdempotencyKey)
        .where(IdempotencyKey.id == key_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()


def owns(key_row: IdempotencyKey | None, owner_token: uuid.UUID) -> bool:
    """Whether ``key_row`` is currently owned (and still in-progress) by the token."""
    return (
        key_row is not None
        and key_row.owner_token == owner_token
        and key_row.status == IdempotencyStatus.in_progress
    )


def insert_key(
    db: Session,
    *,
    company_id: uuid.UUID,
    user_id: uuid.UUID,
    quarry_id: uuid.UUID,
    key: str,
    content_sha256: str,
    owner_token: uuid.UUID,
    lease_seconds: int,
) -> IdempotencyKey:
    """Build a fresh ``in_progress`` claim. The caller commits."""
    row = IdempotencyKey(
        company_id=company_id,
        user_id=user_id,
        quarry_id=quarry_id,
        key=key,
        content_sha256=content_sha256,
        status=IdempotencyStatus.in_progress,
        owner_token=owner_token,
        lease_expires_at=lease_deadline(lease_seconds),
    )
    db.add(row)
    return row


def cas_takeover(
    db: Session,
    *,
    key_id: uuid.UUID,
    expected_owner_token: uuid.UUID | None,
    new_owner_token: uuid.UUID,
    lease_seconds: int,
) -> bool:
    """Compare-and-swap the owner token of an in-progress attempt.

    The update only applies while the row still carries the observed owner token
    (``IS NOT DISTINCT FROM`` so ``NULL`` is a legal observed value) and is still
    ``in_progress``. Returns ``True`` only when exactly one row was changed.
    """
    result = db.execute(
        update(IdempotencyKey)
        .where(
            IdempotencyKey.id == key_id,
            IdempotencyKey.status == IdempotencyStatus.in_progress,
            IdempotencyKey.owner_token.is_not_distinct_from(expected_owner_token),
        )
        .values(
            owner_token=new_owner_token,
            lease_expires_at=lease_deadline(lease_seconds),
            failed_at=None,
        )
        .execution_options(synchronize_session=False)
    )
    return result.rowcount == 1


def delete_key(db: Session, key_id: uuid.UUID) -> None:
    db.execute(delete(IdempotencyKey).where(IdempotencyKey.id == key_id))


def cas_mark_failed(
    db: Session,
    *,
    key_id: uuid.UUID,
    expected_owner_token: uuid.UUID | None,
    failed_at: datetime,
) -> bool:
    """Compare-and-swap a stale attempt to failed.

    Only applies while the row still carries the observed owner token and is
    still an unfailed ``in_progress`` attempt. Returns ``True`` iff one row
    changed; zero rows must never be treated as success.
    """
    result = db.execute(
        update(IdempotencyKey)
        .where(
            IdempotencyKey.id == key_id,
            IdempotencyKey.status == IdempotencyStatus.in_progress,
            IdempotencyKey.failed_at.is_(None),
            IdempotencyKey.owner_token.is_not_distinct_from(expected_owner_token),
        )
        .values(failed_at=failed_at, lease_expires_at=None)
        .execution_options(synchronize_session=False)
    )
    return result.rowcount == 1
