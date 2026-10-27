from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import (
    ChangeEntityType,
    ChangeLog,
    ChangeType,
    Document,
    DocumentStatus,
    Folder,
)
from app.services.errors import Conflict, NotFound, PreconditionFailed
from app.services.sync import ChangeEntry, append_changes

MAX_FOLDER_NAME_LENGTH = 200


def _clean_name(name: str) -> str:
    cleaned = (name or "").strip()
    if not cleaned:
        raise Conflict("folder name is required")
    if len(cleaned) > MAX_FOLDER_NAME_LENGTH:
        raise Conflict("folder name is too long")
    return cleaned


def _folder_payload(folder: Folder) -> dict[str, Any]:
    return {
        "name": folder.name,
        "parent_id": str(folder.parent_id) if folder.parent_id else None,
    }


def _append_folder_change(
    db: Session, folder: Folder, change_type: ChangeType
) -> list[ChangeLog]:
    payload = {} if change_type == ChangeType.deleted else _folder_payload(folder)
    return append_changes(
        db,
        folder.company_id,
        ChangeEntry(
            quarry_id=folder.quarry_id,
            entity_type=ChangeEntityType.folder,
            entity_id=folder.id,
            change_type=change_type,
            entity_version=folder.version,
            payload=payload,
        ),
    )


def get_folder_in_quarry(
    db: Session,
    company_id: uuid.UUID,
    quarry_id: uuid.UUID,
    folder_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> Folder:
    """Load an active folder that must belong to the caller's company/quarry.

    Cross-company and cross-quarry ids are indistinguishable from a missing
    folder (404), matching the project's anti-enumeration policy. Soft-deleted
    folders are likewise treated as missing.
    """
    statement = select(Folder).where(
        Folder.id == folder_id,
        Folder.deleted_at.is_(None),
    )
    if for_update:
        statement = statement.with_for_update()
    folder = db.execute(statement).scalar_one_or_none()
    if (
        folder is None
        or folder.company_id != company_id
        or folder.quarry_id != quarry_id
    ):
        raise NotFound("folder not found")
    return folder


def _duplicate_exists(
    db: Session,
    quarry_id: uuid.UUID,
    parent_id: uuid.UUID | None,
    name: str,
    *,
    exclude_id: uuid.UUID | None = None,
) -> bool:
    statement = select(Folder.id).where(
        Folder.quarry_id == quarry_id,
        Folder.deleted_at.is_(None),
        func.lower(Folder.name) == name.lower(),
    )
    if parent_id is None:
        statement = statement.where(Folder.parent_id.is_(None))
    else:
        statement = statement.where(Folder.parent_id == parent_id)
    if exclude_id is not None:
        statement = statement.where(Folder.id != exclude_id)
    return db.execute(statement.limit(1)).first() is not None


def list_folders(
    db: Session, company_id: uuid.UUID, quarry_id: uuid.UUID
) -> list[Folder]:
    """Flat active-folder listing (id + parent_id) enough to build the tree."""
    return list(
        db.execute(
            select(Folder)
            .where(
                Folder.company_id == company_id,
                Folder.quarry_id == quarry_id,
                Folder.deleted_at.is_(None),
            )
            .order_by(func.lower(Folder.name).asc(), Folder.name.asc())
        )
        .scalars()
        .all()
    )


def create_folder(
    db: Session,
    company_id: uuid.UUID,
    quarry_id: uuid.UUID,
    *,
    name: str,
    parent_id: uuid.UUID | None = None,
) -> Folder:
    cleaned = _clean_name(name)
    if parent_id is not None:
        # Lock the parent so it cannot be deleted while we attach a child and so
        # concurrent creates under the same parent serialize for the name check.
        get_folder_in_quarry(
            db, company_id, quarry_id, parent_id, for_update=True
        )
    if _duplicate_exists(db, quarry_id, parent_id, cleaned):
        db.rollback()
        raise Conflict("a folder with this name already exists")

    folder = Folder(
        company_id=company_id,
        quarry_id=quarry_id,
        parent_id=parent_id,
        name=cleaned,
        version=1,
    )
    db.add(folder)
    try:
        db.flush()
        _append_folder_change(db, folder, ChangeType.created)
        db.commit()
    except IntegrityError:
        # Unique partial indexes are the final authority under concurrency.
        db.rollback()
        raise Conflict("a folder with this name already exists")
    db.refresh(folder)
    return folder


def rename_folder(
    db: Session,
    company_id: uuid.UUID,
    quarry_id: uuid.UUID,
    folder_id: uuid.UUID,
    *,
    name: str,
    expected_version: int | None = None,
) -> Folder:
    folder = get_folder_in_quarry(
        db, company_id, quarry_id, folder_id, for_update=True
    )
    if expected_version is not None and folder.version != expected_version:
        db.rollback()
        raise PreconditionFailed("folder version does not match If-Match")

    cleaned = _clean_name(name)
    if cleaned == folder.name:
        db.commit()
        db.refresh(folder)
        return folder
    if _duplicate_exists(
        db, quarry_id, folder.parent_id, cleaned, exclude_id=folder.id
    ):
        db.rollback()
        raise Conflict("a folder with this name already exists")

    folder.name = cleaned
    folder.version += 1
    try:
        _append_folder_change(db, folder, ChangeType.updated)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise Conflict("a folder with this name already exists")
    db.refresh(folder)
    return folder


def delete_folder(
    db: Session,
    company_id: uuid.UUID,
    quarry_id: uuid.UUID,
    folder_id: uuid.UUID,
    *,
    expected_version: int | None = None,
) -> Folder:
    folder = get_folder_in_quarry(
        db, company_id, quarry_id, folder_id, for_update=True
    )
    if expected_version is not None and folder.version != expected_version:
        db.rollback()
        raise PreconditionFailed("folder version does not match If-Match")

    child_folders = db.execute(
        select(func.count())
        .select_from(Folder)
        .where(
            Folder.parent_id == folder.id,
            Folder.deleted_at.is_(None),
        )
    ).scalar_one()
    documents = db.execute(
        select(func.count())
        .select_from(Document)
        .where(
            Document.folder_id == folder.id,
            Document.deleted_at.is_(None),
        )
    ).scalar_one()
    if child_folders or documents:
        db.rollback()
        raise Conflict("folder is not empty")

    folder.deleted_at = datetime.now(timezone.utc)
    folder.version += 1
    _append_folder_change(db, folder, ChangeType.deleted)
    db.commit()
    return folder


def move_document(
    db: Session,
    company_id: uuid.UUID,
    quarry_id: uuid.UUID,
    document_id: uuid.UUID,
    folder_id: uuid.UUID | None,
    *,
    expected_version: int | None = None,
) -> tuple[Document, uuid.UUID | None]:
    """Move a document within one quarry; ``None`` moves it to root/unfiled.

    Only active, finalized ``available`` documents can be moved; pending/failed
    and soft-deleted rows are invisible to the document API and are reported as
    missing. The stored object is untouched: only ``documents.folder_id``
    metadata changes, so downloads and quota accounting are unaffected.
    """
    target = None
    if folder_id is not None:
        target = get_folder_in_quarry(
            db, company_id, quarry_id, folder_id, for_update=True
        )

    document = db.execute(
        select(Document).where(Document.id == document_id).with_for_update()
    ).scalar_one_or_none()
    if (
        document is None
        or document.company_id != company_id
        or document.quarry_id != quarry_id
        or document.status != DocumentStatus.available
        or document.deleted_at is not None
    ):
        db.rollback()
        raise NotFound("document not found")
    if expected_version is not None and document.version != expected_version:
        db.rollback()
        raise PreconditionFailed("document version does not match If-Match")

    previous_folder_id = document.folder_id
    new_folder_id = target.id if target is not None else None
    if previous_folder_id == new_folder_id:
        db.commit()
        db.refresh(document)
        return document, previous_folder_id

    document.folder_id = new_folder_id
    document.version += 1
    append_changes(
        db,
        document.company_id,
        ChangeEntry(
            quarry_id=document.quarry_id,
            entity_type=ChangeEntityType.document,
            entity_id=document.id,
            change_type=ChangeType.updated,
            entity_version=document.version,
            payload={
                "display_name": document.display_name,
                "folder_id": str(document.folder_id) if document.folder_id else None,
                "mime_type": document.mime_type,
                "size_bytes": document.size_bytes,
                "sha256": document.sha256,
            },
        ),
    )
    db.commit()
    db.refresh(document)
    return document, previous_folder_id
