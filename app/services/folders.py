from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Document, DocumentStatus, Folder
from app.services.errors import Conflict, NotFound

MAX_FOLDER_NAME_LENGTH = 200


def _clean_name(name: str) -> str:
    cleaned = (name or "").strip()
    if not cleaned:
        raise Conflict("folder name is required")
    if len(cleaned) > MAX_FOLDER_NAME_LENGTH:
        raise Conflict("folder name is too long")
    return cleaned


def get_folder_in_quarry(
    db: Session,
    company_id: uuid.UUID,
    quarry_id: uuid.UUID,
    folder_id: uuid.UUID,
    *,
    for_update: bool = False,
) -> Folder:
    """Load a folder that must belong to the caller's company and quarry.

    Cross-company and cross-quarry ids are indistinguishable from a missing
    folder (404), matching the project's anti-enumeration policy.
    """
    statement = select(Folder).where(Folder.id == folder_id)
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
    """Flat listing (id + parent_id) — enough for clients to build the tree."""
    return list(
        db.execute(
            select(Folder)
            .where(Folder.company_id == company_id, Folder.quarry_id == quarry_id)
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
    )
    db.add(folder)
    try:
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
) -> Folder:
    folder = get_folder_in_quarry(
        db, company_id, quarry_id, folder_id, for_update=True
    )
    cleaned = _clean_name(name)
    if _duplicate_exists(
        db, quarry_id, folder.parent_id, cleaned, exclude_id=folder.id
    ):
        db.rollback()
        raise Conflict("a folder with this name already exists")

    folder.name = cleaned
    try:
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
) -> None:
    folder = get_folder_in_quarry(
        db, company_id, quarry_id, folder_id, for_update=True
    )
    child_folders = db.execute(
        select(func.count()).select_from(Folder).where(Folder.parent_id == folder.id)
    ).scalar_one()
    documents = db.execute(
        select(func.count()).select_from(Document).where(Document.folder_id == folder.id)
    ).scalar_one()
    if child_folders or documents:
        # Deleting would cascade into subfolders or orphan document organization.
        db.rollback()
        raise Conflict("folder is not empty")

    db.delete(folder)
    db.commit()


def move_document(
    db: Session,
    company_id: uuid.UUID,
    quarry_id: uuid.UUID,
    document_id: uuid.UUID,
    folder_id: uuid.UUID | None,
) -> tuple[Document, uuid.UUID | None]:
    """Move a document within one quarry; ``None`` moves it to root/unfiled.

    Only finalized ``available`` documents can be moved; pending/failed rows
    are invisible to the document API and are reported as missing. The stored
    object is untouched: only the ``documents.folder_id`` metadata changes, so
    downloads and quota accounting are unaffected.
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
    ):
        db.rollback()
        raise NotFound("document not found")

    previous_folder_id = document.folder_id
    document.folder_id = target.id if target is not None else None
    db.commit()
    db.refresh(document)
    return document, previous_folder_id
