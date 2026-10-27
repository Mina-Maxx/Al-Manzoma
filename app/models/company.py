from __future__ import annotations

from sqlalchemy import BigInteger, Integer, String
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import CompanyStatus


class Company(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    __tablename__ = "companies"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[CompanyStatus] = mapped_column(
        SAEnum(CompanyStatus, name="company_status"),
        default=CompanyStatus.active,
        nullable=False,
    )
    quota_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    max_users: Mapped[int] = mapped_column(Integer, nullable=False)
