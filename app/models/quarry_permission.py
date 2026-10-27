from __future__ import annotations

import uuid

from sqlalchemy import Boolean, ForeignKey, UniqueConstraint, false
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class QuarryPermission(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "quarry_permissions"
    __table_args__ = (
        UniqueConstraint("user_id", "quarry_id", name="uq_permission_user_quarry"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    quarry_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("quarries.id", ondelete="CASCADE"), nullable=False, index=True
    )
    can_view: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false(), nullable=False)
    can_upload: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false(), nullable=False)
    can_download: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false(), nullable=False)
