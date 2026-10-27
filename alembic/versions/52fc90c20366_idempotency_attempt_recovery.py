"""idempotency attempt ownership, lease and storage reference

Revision ID: 52fc90c20366
Revises: b63b044962a6
Create Date: 2026-10-16 08:00:00.000000

Adds durable ownership/lease metadata used to recover attempts that crashed
mid-upload (stuck ``in_progress`` idempotency keys).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = '52fc90c20366'
down_revision = 'b63b044962a6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'idempotency_keys',
        sa.Column('owner_token', sa.Uuid(), nullable=True),
    )
    op.add_column(
        'idempotency_keys',
        sa.Column('lease_expires_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        'idempotency_keys',
        sa.Column('failed_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        'idempotency_keys',
        sa.Column('storage_ref', sa.String(length=255), nullable=True),
    )
    op.create_index(
        'ix_idempotency_keys_stale',
        'idempotency_keys',
        ['lease_expires_at'],
        unique=False,
        postgresql_where=sa.text("status = 'in_progress'"),
    )


def downgrade() -> None:
    op.drop_index('ix_idempotency_keys_stale', table_name='idempotency_keys')
    op.drop_column('idempotency_keys', 'storage_ref')
    op.drop_column('idempotency_keys', 'failed_at')
    op.drop_column('idempotency_keys', 'lease_expires_at')
    op.drop_column('idempotency_keys', 'owner_token')
