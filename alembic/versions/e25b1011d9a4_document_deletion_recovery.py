"""document_deletion_recovery

Revision ID: e25b1011d9a4
Revises: f2c7a9d4e6b8
Create Date: 2026-10-26 04:47:59.145609

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = 'e25b1011d9a4'
down_revision = 'f2c7a9d4e6b8'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'documents',
        sa.Column(
            'deleted_by',
            sa.Uuid(as_uuid=True),
            sa.ForeignKey(
                'users.id',
                name='fk_documents_deleted_by_users',
                ondelete='SET NULL',
            ),
            nullable=True,
        ),
    )
    op.add_column(
        'documents',
        sa.Column(
            'purge_attempt',
            sa.Integer(),
            server_default=sa.text('0'),
            nullable=False,
        ),
    )
    op.add_column(
        'documents',
        sa.Column(
            'purge_token',
            sa.Uuid(as_uuid=True),
            nullable=True,
        ),
    )
    op.add_column(
        'documents',
        sa.Column(
            'purge_claimed_at',
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        'documents',
        sa.Column(
            'purge_failed_at',
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.create_index(
        'ix_documents_retention_purge',
        'documents',
        ['company_id', 'quarry_id', 'deleted_at'],
        postgresql_where=sa.text('deleted_at IS NOT NULL'),
    )


def downgrade() -> None:
    op.drop_index(
        'ix_documents_retention_purge',
        table_name='documents',
        postgresql_where=sa.text('deleted_at IS NOT NULL'),
    )
    op.drop_constraint('fk_documents_deleted_by_users', 'documents', type_='foreignkey')
    op.drop_column('documents', 'purge_failed_at')
    op.drop_column('documents', 'purge_claimed_at')
    op.drop_column('documents', 'purge_token')
    op.drop_column('documents', 'purge_attempt')
    op.drop_column('documents', 'deleted_by')
