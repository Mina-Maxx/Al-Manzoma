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
from app.schemas import DocumentOut
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
from app.services.audit import AuditService
from app.services.document_service import upload_document
from app.services.errors import DomainError
from app.storage.base import Storage, StorageNotFound, StorageUnavailable
from app.utils.files import sanitize_filename

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
) -> list[DocumentOut]:
    rows = db.execute(
        select(Document)
        .where(
            Document.company_id == ctx.company_id,
            Document.quarry_id == quarry.id,
            Document.status == DocumentStatus.available,
        )
        .order_by(Document.created_at.desc())
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
