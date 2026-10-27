"""company sync state and append-only change log

Revision ID: a7c1e9d4b2f0
Revises: e5f6a7b8c9d0
Create Date: 2026-10-23 16:00:00.000000

Initializes one state row per existing company. Existing folders/documents do
not get synthetic history; the feed starts empty at sequence zero.

Retention note: change-log rows restrict company/quarry deletion so retained
history cannot be erased implicitly. State rows cascade because they are only
cursors; the restrictive change-log FKs still protect history.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'a7c1e9d4b2f0'
down_revision = 'e5f6a7b8c9d0'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'company_sync_state',
        sa.Column('company_id', sa.Uuid(), nullable=False),
        sa.Column(
            'feed_epoch',
            sa.Uuid(),
            server_default=sa.text('gen_random_uuid()'),
            nullable=False,
        ),
        sa.Column(
            'last_seq',
            sa.BigInteger(),
            server_default=sa.text('0'),
            nullable=False,
        ),
        sa.Column(
            'min_valid_seq',
            sa.BigInteger(),
            server_default=sa.text('0'),
            nullable=False,
        ),
        sa.Column(
            'updated_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.CheckConstraint(
            'last_seq >= 0',
            name='ck_company_sync_state_last_seq_nonnegative',
        ),
        sa.CheckConstraint(
            'min_valid_seq >= 0',
            name='ck_company_sync_state_min_valid_seq_nonnegative',
        ),
        sa.CheckConstraint(
            'min_valid_seq <= last_seq',
            name='ck_company_sync_state_min_valid_seq_lte_last_seq',
        ),
        sa.ForeignKeyConstraint(
            ['company_id'],
            ['companies.id'],
            name='fk_company_sync_state_company_id',
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('company_id'),
    )

    op.create_table(
        'change_log',
        sa.Column('company_id', sa.Uuid(), nullable=False),
        sa.Column('seq', sa.BigInteger(), nullable=False),
        sa.Column('quarry_id', sa.Uuid(), nullable=False),
        sa.Column('entity_type', sa.String(length=16), nullable=False),
        sa.Column('entity_id', sa.Uuid(), nullable=False),
        sa.Column('change_type', sa.String(length=16), nullable=False),
        sa.Column('entity_version', sa.Integer(), nullable=False),
        sa.Column(
            'payload',
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.CheckConstraint(
            "entity_type IN ('folder', 'document')",
            name='ck_change_log_entity_type',
        ),
        sa.CheckConstraint(
            "change_type IN ('created', 'updated', 'deleted')",
            name='ck_change_log_change_type',
        ),
        sa.CheckConstraint(
            'entity_version > 0',
            name='ck_change_log_entity_version_positive',
        ),
        sa.CheckConstraint('seq > 0', name='ck_change_log_seq_positive'),
        sa.ForeignKeyConstraint(
            ['company_id'],
            ['companies.id'],
            name='fk_change_log_company_id',
            ondelete='RESTRICT',
        ),
        sa.ForeignKeyConstraint(
            ['quarry_id'],
            ['quarries.id'],
            name='fk_change_log_quarry_id',
            ondelete='RESTRICT',
        ),
        sa.PrimaryKeyConstraint('company_id', 'seq'),
    )
    op.create_index(
        'ix_change_log_company_created_at',
        'change_log',
        ['company_id', 'created_at'],
        unique=False,
    )
    op.create_index(
        'ix_change_log_quarry_id',
        'change_log',
        ['quarry_id'],
        unique=False,
    )

    # Initialize the feed for every company that already exists. New companies
    # created after this migration will need an explicit state row (foundation
    # only; no business mutation is wired in this phase).
    op.execute(
        'INSERT INTO company_sync_state (company_id) '
        'SELECT id FROM companies'
    )


def downgrade() -> None:
    op.drop_index('ix_change_log_quarry_id', table_name='change_log')
    op.drop_index('ix_change_log_company_created_at', table_name='change_log')
    op.drop_table('change_log')
    op.drop_table('company_sync_state')
