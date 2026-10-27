from __future__ import annotations

import uuid
from collections.abc import Iterator
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import AuditResult, Document, DocumentStatus, Quarry
from app.schemas import DocumentMove, DocumentOut, TrashDocumentOut
from app.security.context import AuthContext
from app.security.deps import (
    get_auth_context,
    get_audit,
    get_db,
    get_download_document,
    get_settings,
    get_storage,
    require_quarry_permission,
)
from app.services import folders as folder_service
from app.services.audit import AuditService
from app.services.document_service import (
    list_trash_documents,
    restore_document,
    soft_delete_document,
    upload_document,
)
from app.services.errors import DomainError
from app.storage.base import Storage, StorageNotFound, StorageUnavailable
from app.utils.files import sanitize_filename
from app.utils.preconditions import etag_for_version, parse_if_match

router = APIRouter(tags=["documents"])

_READ_CHUNK = 64 * 1024


def _iter_stream(stream) -> Iterator[bytes]:
    try:
        while True:
            chunk = stream.read(_READ_CHUNK)
            if not chunk:
                break
            yield chunk
    finally:
        stream.close()


def _content_disposition(filename: str) -> str:
    ascii_name = filename.encode("ascii", "ignore").decode("ascii") or "download"
    ascii_name = ascii_name.replace('"', "")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


@router.get("/quarries/{quarry_id}/documents", response_model=list[DocumentOut])
def list_documents(
    quarry: Quarry = Depends(require_quarry_permission("can_view")),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    folder_id: uuid.UUID | None = Query(default=None),
    root_only: bool = Query(default=False),
) -> list[DocumentOut]:
    """List available documents in a quarry.

    Without ``folder_id``/``root_only`` the whole quarry is returned (existing
    behaviour). ``folder_id`` filters one folder; ``root_only=true`` returns
    unfiled documents (``folder_id IS NULL``, including pre-folder documents).
    """
    if folder_id is not None and root_only:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="folder_id and root_only are mutually exclusive",
        )
    if folder_id is not None:
        folder_service.get_folder_in_quarry(
            db, ctx.company_id, quarry.id, folder_id
        )

    statement = select(Document).where(
        Document.company_id == ctx.company_id,
        Document.quarry_id == quarry.id,
        Document.status == DocumentStatus.available,
        Document.deleted_at.is_(None),
    )
    if folder_id is not None:
        statement = statement.where(Document.folder_id == folder_id)
    elif root_only:
        statement = statement.where(Document.folder_id.is_(None))

    rows = db.execute(
        statement.order_by(Document.created_at.desc())
        .limit(limit)
        .offset(offset)
    ).scalars().all()
    return [DocumentOut.model_validate(document) for document in rows]


@router.post("/quarries/{quarry_id}/documents", response_model=DocumentOut)
def upload_document_endpoint(
    request: Request,
    response: Response,
    file: UploadFile = File(...),
    display_name: str | None = Form(default=None),
    folder_id: uuid.UUID | None = Form(default=None),
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    quarry: Quarry = Depends(require_quarry_permission("can_upload")),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    storage: Storage = Depends(get_storage),
    audit: AuditService = Depends(get_audit),
    settings: Settings = Depends(get_settings),
) -> DocumentOut:
    try:
        document, created = upload_document(
            db=db,
            storage=storage,
            settings=settings,
            ctx=ctx,
            quarry=quarry,
            upload_file=file,
            idempotency_key=idempotency_key,
            display_name=display_name,
            folder_id=folder_id,
        )
    except DomainError as exc:
        audit.record(
            action="document.upload",
            result=AuditResult.failure,
            company_id=ctx.company_id,
            actor_user_id=ctx.user_id,
            target_type="quarry",
            target_id=quarry.id,
            meta={"reason": type(exc).__name__},
            request=request,
        )
        raise

    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    response.headers["ETag"] = etag_for_version(document.version)
    audit.record(
        action="document.upload",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="document",
        target_id=document.id,
        meta={"size_bytes": document.size_bytes, "created": created},
        request=request,
    )
    return DocumentOut.model_validate(document)


@router.patch(
    "/quarries/{quarry_id}/documents/{document_id}", response_model=DocumentOut
)
def move_document_endpoint(
    document_id: uuid.UUID,
    body: DocumentMove,
    request: Request,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    quarry: Quarry = Depends(require_quarry_permission("can_upload")),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> DocumentOut:
    """Move a document within the same quarry; ``folder_id: null`` = root."""
    document, previous_folder_id = folder_service.move_document(
        db,
        ctx.company_id,
        quarry.id,
        document_id,
        body.folder_id,
        expected_version=parse_if_match(if_match),
    )
    response.headers["ETag"] = etag_for_version(document.version)
    audit.record(
        action="document.move",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="document",
        target_id=document.id,
        meta={
            "from_folder_id": (
                str(previous_folder_id) if previous_folder_id else None
            ),
            "to_folder_id": str(document.folder_id) if document.folder_id else None,
        },
        request=request,
    )
    return DocumentOut.model_validate(document)


@router.delete(
    "/quarries/{quarry_id}/documents/{document_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_document_endpoint(
    quarry_id: uuid.UUID,
    document_id: uuid.UUID,
    request: Request,
    if_match: str | None = Header(default=None, alias="If-Match"),
    quarry: Quarry = Depends(require_quarry_permission("can_upload")),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> Response:
    try:
        soft_delete_document(
            db,
            ctx,
            quarry,
            document_id,
            expected_version=parse_if_match(if_match),
        )
    except Exception as exc:
        db.rollback()
        try:
            audit.record(
                action="document.delete",
                result=AuditResult.failure,
                company_id=ctx.company_id,
                actor_user_id=ctx.user_id,
                target_type="document",
                target_id=str(document_id),
                meta={"error": type(exc).__name__, "detail": str(exc)},
                request=request,
            )
        except Exception:
            pass
        raise
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/quarries/{quarry_id}/documents/{document_id}/restore",
    response_model=DocumentOut,
)
def restore_document_endpoint(
    quarry_id: uuid.UUID,
    document_id: uuid.UUID,
    request: Request,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    quarry: Quarry = Depends(require_quarry_permission("can_view")),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> DocumentOut:
    try:
        document = restore_document(
            db,
            ctx,
            quarry,
            document_id,
            expected_version=parse_if_match(if_match),
        )
    except Exception as exc:
        db.rollback()
        try:
            audit.record(
                action="document.restore",
                result=AuditResult.failure,
                company_id=ctx.company_id,
                actor_user_id=ctx.user_id,
                target_type="document",
                target_id=str(document_id),
                meta={"error": type(exc).__name__, "detail": str(exc)},
                request=request,
            )
        except Exception:
            pass
        raise
    response.headers["ETag"] = etag_for_version(document.version)
    return DocumentOut.model_validate(document)


@router.get(
    "/quarries/{quarry_id}/trash",
    response_model=list[TrashDocumentOut],
)
def list_trash_endpoint(
    quarry_id: uuid.UUID,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    quarry: Quarry = Depends(require_quarry_permission("can_view")),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> list[TrashDocumentOut]:
    return list_trash_documents(db, ctx, quarry, limit=limit, offset=offset)


@router.get("/documents/{document_id}/download")
def download_document(
    request: Request,
    document: Document = Depends(get_download_document),
    storage: Storage = Depends(get_storage),
    audit: AuditService = Depends(get_audit),
    ctx: AuthContext = Depends(get_auth_context),
):
    try:
        stream = storage.open(document.storage_ref)
    except StorageNotFound:
        audit.record(
            action="document.download",
            result=AuditResult.failure,
            company_id=ctx.company_id,
            actor_user_id=ctx.user_id,
            target_type="document",
            target_id=document.id,
            request=request,
        )
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="document not found")
    except StorageUnavailable:
        audit.record(
            action="document.download",
            result=AuditResult.failure,
            company_id=ctx.company_id,
            actor_user_id=ctx.user_id,
            target_type="document",
            target_id=document.id,
            request=request,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="file storage is unavailable"
        )

    audit.record(
        action="document.download",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="document",
        target_id=document.id,
        request=request,
    )
    filename = sanitize_filename(document.display_name or document.original_filename)
    headers = {
        "Content-Disposition": _content_disposition(filename),
        "Content-Length": str(document.size_bytes),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
    }
    return StreamingResponse(
        _iter_stream(stream), media_type=document.mime_type, headers=headers
    )
