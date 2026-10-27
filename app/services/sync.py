from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    ChangeEntityType,
    ChangeLog,
    ChangeType,
    CompanySyncState,
)
from app.services.errors import NotFound

_ENTITY_TYPES = frozenset(item.value for item in ChangeEntityType)
_CHANGE_TYPES = frozenset(item.value for item in ChangeType)


@dataclass(frozen=True)
class ChangeEntry:
    """One change to append to a company's feed."""

    quarry_id: uuid.UUID
    entity_type: ChangeEntityType | str
    entity_id: uuid.UUID
    change_type: ChangeType | str
    entity_version: int
    payload: Mapping[str, Any] = field(default_factory=dict)


def _as_uuid(value: object, field_name: str) -> uuid.UUID:
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a UUID") from exc


def _as_choice(
    value: object,
    field_name: str,
    allowed: frozenset[str],
    enum_type: type[ChangeEntityType] | type[ChangeType],
) -> str:
    if isinstance(value, enum_type):
        return value.value
    if isinstance(value, str) and value in allowed:
        return value
    raise ValueError(
        f"{field_name} must be one of {sorted(allowed)!r}, got {value!r}"
    )


def _normalize(raw: ChangeEntry | Mapping[str, Any]) -> ChangeEntry:
    if isinstance(raw, Mapping):
        try:
            raw = ChangeEntry(**dict(raw))
        except TypeError as exc:
            raise ValueError(f"invalid change entry: {exc}") from exc
    if not isinstance(raw, ChangeEntry):
        raise ValueError("change entries must be ChangeEntry instances or mappings")

    if not isinstance(raw.entity_version, int) or isinstance(
        raw.entity_version, bool
    ):
        raise ValueError("entity_version must be a positive integer")
    if raw.entity_version <= 0:
        raise ValueError("entity_version must be a positive integer")

    payload = raw.payload
    if payload is None:
        payload = {}
    if not isinstance(payload, Mapping):
        raise ValueError("payload must be a JSON object")

    return ChangeEntry(
        quarry_id=_as_uuid(raw.quarry_id, "quarry_id"),
        entity_type=_as_choice(
            raw.entity_type,
            "entity_type",
            _ENTITY_TYPES,
            ChangeEntityType,
        ),
        entity_id=_as_uuid(raw.entity_id, "entity_id"),
        change_type=_as_choice(
            raw.change_type,
            "change_type",
            _CHANGE_TYPES,
            ChangeType,
        ),
        entity_version=raw.entity_version,
        payload=dict(payload),
    )


def append_changes(
    db: Session,
    company_id: uuid.UUID,
    entries: Iterable[ChangeEntry | Mapping[str, Any]]
    | ChangeEntry
    | Mapping[str, Any],
    *additional_entries: ChangeEntry | Mapping[str, Any],
) -> list[ChangeLog]:
    """Append one or more changes to a company's feed without committing.

    The company's ``company_sync_state`` row is locked with ``FOR UPDATE`` and
    held until the caller commits or rolls back. Sequence numbers are allocated
    consecutively from ``last_seq + 1`` and written in the same transaction as
    the log rows. This function deliberately never calls ``commit()`` or
    ``rollback()``; the caller owns the transaction.

    Raises:
        ValueError: for an empty batch or any invalid entry.
        NotFound: when the company has no ``company_sync_state`` row. State is
            not auto-created because a row created after an unsuccessful lock
            attempt would not serialize allocation correctly.
    """
    if isinstance(entries, (ChangeEntry, Mapping)):
        raw_entries: list[ChangeEntry | Mapping[str, Any]] = [entries]
    else:
        try:
            raw_entries = list(entries)
        except TypeError as exc:
            raise ValueError("entries must be an iterable of change entries") from exc
    if additional_entries:
        raw_entries.extend(additional_entries)
    if not raw_entries:
        raise ValueError("append_changes requires at least one change entry")

    company_id = _as_uuid(company_id, "company_id")
    normalized = [_normalize(entry) for entry in raw_entries]

    state = db.execute(
        select(CompanySyncState)
        .where(CompanySyncState.company_id == company_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if state is None:
        raise NotFound("company sync state not found")

    first_seq = state.last_seq + 1
    changes = [
        ChangeLog(
            company_id=company_id,
            seq=first_seq + offset,
            quarry_id=entry.quarry_id,
            entity_type=entry.entity_type,
            entity_id=entry.entity_id,
            change_type=entry.change_type,
            entity_version=entry.entity_version,
            payload=entry.payload,
        )
        for offset, entry in enumerate(normalized)
    ]
    db.add_all(changes)
    state.last_seq = first_seq + len(changes) - 1
    state.updated_at = datetime.now(timezone.utc)
    db.flush()
    return changes
