from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    ChangeEntityType,
    ChangeLog,
    CompanySyncState,
    Quarry,
    QuarryPermission,
    QuarryStatus,
)
from app.security.context import AuthContext
from app.services.errors import (
    InvalidSyncCursor,
    NotFound,
    SyncResyncRequired,
)
from app.utils.sync_cursor import decode_cursor, encode_cursor

_SENSITIVE_KEY_PARTS = (
    "authorization",
    "credential",
    "password",
    "secret",
    "storage_ref",
    "token",
)


@dataclass(frozen=True)
class SyncChange:
    seq: int
    entity_type: str
    entity_id: uuid.UUID
    quarry_id: uuid.UUID
    change_type: str
    entity_version: int
    changed_at: datetime
    payload: dict[str, Any]


@dataclass(frozen=True)
class SyncPage:
    changes: list[SyncChange]
    next_cursor: str
    high_water: int
    has_more: bool
    resync_required: bool
    bootstrap_required: bool


def _public_payload(value: Any, *, depth: int = 0) -> Any:
    """Defense-in-depth copy that removes sensitive keys from feed payloads."""
    if depth > 8:
        return None
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if any(part in lowered for part in _SENSITIVE_KEY_PARTS):
                continue
            cleaned[key] = _public_payload(item, depth=depth + 1)
        return cleaned
    if isinstance(value, list):
        return [_public_payload(item, depth=depth + 1) for item in value]
    return value


def _visible_quarry_ids(db: Session, ctx: AuthContext) -> set[uuid.UUID]:
    rows = db.execute(
        select(Quarry.id)
        .join(QuarryPermission, QuarryPermission.quarry_id == Quarry.id)
        .where(
            Quarry.company_id == ctx.company_id,
            Quarry.status == QuarryStatus.active,
            QuarryPermission.user_id == ctx.user_id,
            QuarryPermission.can_view.is_(True),
        )
    ).scalars()
    return set(rows)


def _change_out(row: ChangeLog) -> SyncChange:
    payload = _public_payload(row.payload)
    if not isinstance(payload, dict):
        payload = {}
    return SyncChange(
        seq=row.seq,
        entity_type=row.entity_type,
        entity_id=row.entity_id,
        quarry_id=row.quarry_id,
        change_type=row.change_type,
        entity_version=row.entity_version,
        changed_at=row.created_at,
        payload=payload,
    )


def read_changes(
    db: Session,
    ctx: AuthContext,
    *,
    cursor: str | None,
    limit: int,
    signing_key: bytes,
) -> SyncPage:
    """Read one bounded page from the authenticated company's change feed.

    The state row is locked with ``FOR SHARE`` so writers cannot allocate or
    commit new sequences between choosing ``high_water`` and reading the page.
    The lock is released before returning, after rows are copied to plain data.
    Every fetched sequence must be contiguous; a hole means retained history is
    incomplete and the request fails with a resync error.
    """
    parsed = decode_cursor(cursor, signing_key) if cursor is not None else None

    state = db.execute(
        select(CompanySyncState)
        .where(CompanySyncState.company_id == ctx.company_id)
        .with_for_update(read=True)
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if state is None:
        db.rollback()
        raise NotFound("company sync state not found")

    high_water = state.last_seq
    if parsed is None:
        next_cursor = encode_cursor(
            company_id=ctx.company_id,
            feed_epoch=state.feed_epoch,
            seq=high_water,
            signing_key=signing_key,
        )
        db.commit()
        return SyncPage(
            changes=[],
            next_cursor=next_cursor,
            high_water=high_water,
            has_more=False,
            resync_required=True,
            bootstrap_required=True,
        )

    if parsed.company_id != ctx.company_id:
        db.rollback()
        raise InvalidSyncCursor("cursor belongs to another company")
    if parsed.feed_epoch != state.feed_epoch:
        db.rollback()
        raise InvalidSyncCursor("cursor feed epoch does not match")
    if parsed.seq < state.min_valid_seq:
        db.rollback()
        raise SyncResyncRequired(
            "sync cursor is older than retained history; full resync required"
        )
    if parsed.seq > high_water:
        db.rollback()
        raise InvalidSyncCursor("cursor is ahead of the feed boundary")

    rows = list(
        db.execute(
            select(ChangeLog)
            .where(
                ChangeLog.company_id == ctx.company_id,
                ChangeLog.seq > parsed.seq,
                ChangeLog.seq <= high_water,
                ChangeLog.entity_type.in_(
                    (ChangeEntityType.folder.value, ChangeEntityType.document.value)
                ),
            )
            .order_by(ChangeLog.seq.asc())
            .limit(limit + 1)
        )
        .scalars()
        .all()
    )

    # Sequences are allocated contiguously under the state lock. Any hole means
    # retained history is incomplete, including holes after the current page.
    expected_seq = parsed.seq + 1
    for row in rows:
        if row.seq != expected_seq:
            db.rollback()
            raise SyncResyncRequired(
                "change feed gap detected; full resync required"
            )
        expected_seq += 1
    if len(rows) <= limit and expected_seq != high_water + 1:
        db.rollback()
        raise SyncResyncRequired("change feed gap detected; full resync required")

    has_more = len(rows) > limit
    page_rows = rows[:limit]
    last_processed = page_rows[-1].seq if page_rows else parsed.seq
    visible_quarries = _visible_quarry_ids(db, ctx)
    changes = [
        _change_out(row) for row in page_rows if row.quarry_id in visible_quarries
    ]
    next_cursor = encode_cursor(
        company_id=ctx.company_id,
        feed_epoch=state.feed_epoch,
        seq=last_processed,
        signing_key=signing_key,
    )
    db.commit()

    return SyncPage(
        changes=changes,
        next_cursor=next_cursor,
        high_water=high_water,
        has_more=has_more,
        resync_required=False,
        bootstrap_required=False,
    )
