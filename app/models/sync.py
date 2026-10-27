from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class CompanySyncState(Base):
    """Cursor and feed identity for one company's change feed.

    The state row is locked by ``append_changes`` while a batch is allocated.
    It cascades with its company because it is only a cursor, not retained
    history. The change-log rows themselves use restrictive foreign keys.

    ``min_valid_seq`` is the minimum acceptable cursor position, not the first
    retained row: a cursor equal to it is valid and the next read starts at
    ``min_valid_seq + 1``. Retention that removes rows through ``R`` must set
    this field to ``R``.
    """

    __tablename__ = "company_sync_state"
    __table_args__ = (
        CheckConstraint(
            "last_seq >= 0",
            name="ck_company_sync_state_last_seq_nonnegative",
        ),
        CheckConstraint(
            "min_valid_seq >= 0",
            name="ck_company_sync_state_min_valid_seq_nonnegative",
        ),
        CheckConstraint(
            "min_valid_seq <= last_seq",
            name="ck_company_sync_state_min_valid_seq_lte_last_seq",
        ),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey(
            "companies.id",
            name="fk_company_sync_state_company_id",
            ondelete="CASCADE",
        ),
        primary_key=True,
    )
    feed_epoch: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
        nullable=False,
    )
    last_seq: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default=text("0"), nullable=False
    )
    min_valid_seq: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default=text("0"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class ChangeLog(Base):
    """Append-only, company-scoped sequence of folder/document changes.

    ``entity_id`` is intentionally not a foreign key: one column points at
    either a folder or a document. Company and quarry deletion are restricted
    while entries exist so retained sync history cannot disappear implicitly.
    """

    __tablename__ = "change_log"
    __table_args__ = (
        CheckConstraint(
            "entity_type IN ('folder', 'document')",
            name="ck_change_log_entity_type",
        ),
        CheckConstraint(
            "change_type IN ('created', 'updated', 'deleted')",
            name="ck_change_log_change_type",
        ),
        CheckConstraint(
            "entity_version > 0",
            name="ck_change_log_entity_version_positive",
        ),
        CheckConstraint("seq > 0", name="ck_change_log_seq_positive"),
        Index("ix_change_log_company_created_at", "company_id", "created_at"),
        Index("ix_change_log_quarry_id", "quarry_id"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey(
            "companies.id",
            name="fk_change_log_company_id",
            ondelete="RESTRICT",
        ),
        primary_key=True,
    )
    seq: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    quarry_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey(
            "quarries.id",
            name="fk_change_log_quarry_id",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )
    entity_type: Mapped[str] = mapped_column(String(16), nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    change_type: Mapped[str] = mapped_column(String(16), nullable=False)
    entity_version: Mapped[int] = mapped_column(Integer, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        default=dict,
        server_default=text("'{}'::jsonb"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
