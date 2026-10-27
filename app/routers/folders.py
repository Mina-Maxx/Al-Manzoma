from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Header, Request, Response, status
from sqlalchemy.orm import Session

from app.models import AuditResult, Quarry
from app.schemas import FolderCreate, FolderOut, FolderRename
from app.security.context import AuthContext
from app.security.deps import (
    get_audit,
    get_auth_context,
    get_db,
    require_quarry_permission,
)
from app.services import folders as service
from app.services.audit import AuditService
from app.utils.preconditions import etag_for_version, parse_if_match

router = APIRouter(tags=["folders"])


@router.get("/quarries/{quarry_id}/folders", response_model=list[FolderOut])
def list_folders(
    quarry: Quarry = Depends(require_quarry_permission("can_view")),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> list[FolderOut]:
    """Flat listing; clients reconstruct the tree from ``parent_id``."""
    return [
        FolderOut.model_validate(folder)
        for folder in service.list_folders(db, ctx.company_id, quarry.id)
    ]


@router.post(
    "/quarries/{quarry_id}/folders",
    response_model=FolderOut,
    status_code=status.HTTP_201_CREATED,
)
def create_folder(
    body: FolderCreate,
    request: Request,
    response: Response,
    quarry: Quarry = Depends(require_quarry_permission("can_upload")),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> FolderOut:
    folder = service.create_folder(
        db,
        ctx.company_id,
        quarry.id,
        name=body.name,
        parent_id=body.parent_id,
    )
    response.headers["ETag"] = etag_for_version(folder.version)
    audit.record(
        action="folder.create",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="folder",
        target_id=folder.id,
        meta={"parent_id": str(folder.parent_id) if folder.parent_id else None},
        request=request,
    )
    return FolderOut.model_validate(folder)


@router.patch(
    "/quarries/{quarry_id}/folders/{folder_id}", response_model=FolderOut
)
def rename_folder(
    folder_id: uuid.UUID,
    body: FolderRename,
    request: Request,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    quarry: Quarry = Depends(require_quarry_permission("can_upload")),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> FolderOut:
    folder = service.rename_folder(
        db,
        ctx.company_id,
        quarry.id,
        folder_id,
        name=body.name,
        expected_version=parse_if_match(if_match),
    )
    response.headers["ETag"] = etag_for_version(folder.version)
    audit.record(
        action="folder.rename",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="folder",
        target_id=folder.id,
        meta={"parent_id": str(folder.parent_id) if folder.parent_id else None},
        request=request,
    )
    return FolderOut.model_validate(folder)


@router.delete(
    "/quarries/{quarry_id}/folders/{folder_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_folder(
    folder_id: uuid.UUID,
    request: Request,
    if_match: str | None = Header(default=None, alias="If-Match"),
    quarry: Quarry = Depends(require_quarry_permission("can_upload")),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> Response:
    folder = service.delete_folder(
        db,
        ctx.company_id,
        quarry.id,
        folder_id,
        expected_version=parse_if_match(if_match),
    )
    audit.record(
        action="folder.delete",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="folder",
        target_id=folder_id,
        request=request,
    )
    return Response(
        status_code=status.HTTP_204_NO_CONTENT,
        headers={"ETag": etag_for_version(folder.version)},
    )
