from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Quarry, QuarryPermission, QuarryStatus
from app.schemas import QuarryOut, QuarryPermissionOut
from app.security.context import AuthContext
from app.security.deps import get_auth_context, get_db

router = APIRouter(tags=["quarries"])


@router.get("/quarries", response_model=list[QuarryOut])
def list_quarries(
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> list[QuarryOut]:
    rows = db.execute(
        select(Quarry, QuarryPermission)
        .join(QuarryPermission, QuarryPermission.quarry_id == Quarry.id)
        .where(
            Quarry.company_id == ctx.company_id,
            Quarry.status == QuarryStatus.active,
            QuarryPermission.user_id == ctx.user_id,
            QuarryPermission.can_view.is_(True),
        )
        .order_by(Quarry.name.asc())
    ).all()
    return [
        QuarryOut(
            id=quarry.id,
            name=quarry.name,
            status=quarry.status.value,
            permissions=QuarryPermissionOut(
                can_view=perm.can_view,
                can_upload=perm.can_upload,
                can_download=perm.can_download,
            ),
        )
        for quarry, perm in rows
    ]
