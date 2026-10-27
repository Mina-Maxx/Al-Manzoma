from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, func, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Folder(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """A tenant-scoped folder inside one quarry.

    Folders are hard-deleted only when empty (no child folders, no documents);
    that is enforced in ``app.services.folders``. ``parent_id`` is ``None`` for a
    root-level folder. A folder can never point at a parent from another company
    or quarry: the service validates both ids on every write.
    """

    __tablename__ = "folders"

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    quarry_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("quarries.id", ondelete="CASCADE"), nullable=False, index=True
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("folders.id", ondelete="CASCADE"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)


# Case-insensitive uniqueness per parent. Root folders (``parent_id IS NULL``)
# need a separate partial index because SQL treats NULLs as distinct in a plain
# unique constraint. These are declared after the class so ``lower(name)`` can
# reference the mapped column.
Index(
    "uq_folders_root_name",
    Folder.quarry_id,
    func.lower(Folder.name),
    unique=True,
    postgresql_where=Folder.parent_id.is_(None),
)
Index(
    "uq_folders_child_name",
    Folder.quarry_id,
    Folder.parent_id,
    func.lower(Folder.name),
    unique=True,
    postgresql_where=Folder.parent_id.is_not(None),
)
