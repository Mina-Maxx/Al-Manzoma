from __future__ import annotations

from sqlalchemy import String
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.models.enums import UserStatus


class PlatformAdmin(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """A platform operator. Deliberately separate from company memberships.

    Platform admins authenticate like any user but are resolved from this table,
    never from ``memberships``. They have no company and therefore cannot reach
    any company-scoped or document endpoint.
    """

    __tablename__ = "platform_admins"

    auth_user_id: Mapped[str] = mapped_column(
        String(255), unique=True, nullable=False, index=True
    )
    email: Mapped[str | None] = mapped_column(String(320))
    full_name: Mapped[str | None] = mapped_column(String(200))
    status: Mapped[UserStatus] = mapped_column(
        SAEnum(UserStatus, name="user_status"),
        default=UserStatus.active,
        nullable=False,
    )
