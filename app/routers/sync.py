from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.config import Settings
from app.schemas import SyncChangeOut, SyncChangesOut
from app.security.context import AuthContext
from app.security.deps import get_auth_context, get_db, get_settings
from app.services.sync_feed import read_changes

router = APIRouter(tags=["sync"])


@router.get("/sync/changes", response_model=SyncChangesOut)
def list_sync_changes(
    cursor: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> SyncChangesOut:
    """Return one visible page of the authenticated company's change feed.

    ``limit`` bounds the number of change-log records processed, including
    records skipped because the caller cannot view their quarry. Fewer visible
    records may therefore be returned. An absent cursor is an explicit bootstrap
    request, not the first page of a complete snapshot.
    """
    page = read_changes(
        db,
        ctx,
        cursor=cursor,
        limit=limit,
        signing_key=settings.sync_cursor_key,
    )
    return SyncChangesOut(
        changes=[
            SyncChangeOut(
                seq=change.seq,
                entity_type=change.entity_type,
                entity_id=change.entity_id,
                quarry_id=change.quarry_id,
                change_type=change.change_type,
                entity_version=change.entity_version,
                changed_at=change.changed_at,
                payload=change.payload,
            )
            for change in page.changes
        ],
        next_cursor=page.next_cursor,
        high_water=page.high_water,
        has_more=page.has_more,
        resync_required=page.resync_required,
        bootstrap_required=page.bootstrap_required,
    )
