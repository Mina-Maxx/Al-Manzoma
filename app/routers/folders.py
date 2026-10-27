from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, Response, status
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
    quarry: Quarry = Depends(require_quarry_permission("can_upload")),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> FolderOut:
    folder = service.rename_folder(
        db, ctx.company_id, quarry.id, folder_id, name=body.name
    )
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
    quarry: Quarry = Depends(require_quarry_permission("can_upload")),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    audit: AuditService = Depends(get_audit),
) -> Response:
    service.delete_folder(db, ctx.company_id, quarry.id, folder_id)
    audit.record(
        action="folder.delete",
        result=AuditResult.success,
        company_id=ctx.company_id,
        actor_user_id=ctx.user_id,
        target_type="folder",
        target_id=folder_id,
        request=request,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
