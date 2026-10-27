from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import QuarryStatus


class Quarry(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "quarries"
    __table_args__ = (
        UniqueConstraint("company_id", "name", name="uq_quarry_company_name"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[QuarryStatus] = mapped_column(
        SAEnum(QuarryStatus, name="quarry_status"),
        default=QuarryStatus.active,
        nullable=False,
    )
