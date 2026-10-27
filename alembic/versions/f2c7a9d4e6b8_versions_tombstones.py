"""folder/document versions, tombstones, and active-name indexes

Revision ID: f2c7a9d4e6b8
Revises: a7c1e9d4b2f0
Create Date: 2026-10-23 18:00:00.000000

Adds optimistic-concurrency versions and soft-deletion tombstones. Existing
folders and documents are backfilled to version 1 with ``deleted_at = NULL``.
Folder-name uniqueness now applies only to active rows, so a deleted sibling's
name can be reused. Also initializes any company created after the Phase 1B.1
state backfill, without touching an existing feed epoch or sequence.

Downgrading cannot represent tombstones, so it discards soft-deleted folders
before restoring the original whole-name unique indexes.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = 'f2c7a9d4e6b8'
down_revision = 'a7c1e9d4b2f0'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'folders',
        sa.Column(
            'version',
            sa.Integer(),
            server_default=sa.text('1'),
            nullable=False,
        ),
    )
    op.add_column(
        'folders',
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_check_constraint(
        'ck_folders_version_positive',
        'folders',
        'version >= 1',
    )

    op.add_column(
        'documents',
        sa.Column(
            'version',
            sa.Integer(),
            server_default=sa.text('1'),
            nullable=False,
        ),
    )
    op.add_column(
        'documents',
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_check_constraint(
        'ck_documents_version_positive',
        'documents',
        'version >= 1',
    )

    # Uniqueness applies only to active folders. A soft-deleted folder keeps its
    # row for sync history but no longer reserves its name.
    op.execute("DROP INDEX IF EXISTS uq_folders_child_name")
    op.execute("DROP INDEX IF EXISTS uq_folders_root_name")
    op.execute(
        "CREATE UNIQUE INDEX uq_folders_root_name "
        "ON folders (quarry_id, lower(name)) "
        "WHERE parent_id IS NULL AND deleted_at IS NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_folders_child_name "
        "ON folders (quarry_id, parent_id, lower(name)) "
        "WHERE parent_id IS NOT NULL AND deleted_at IS NULL"
    )

    # Covers companies created after a7c1e9d4b2f0's one-time backfill. Never
    # updates an existing state row, so feed epochs and sequence numbers survive.
    op.execute(
        'INSERT INTO company_sync_state (company_id) '
        'SELECT id FROM companies '
        'ON CONFLICT (company_id) DO NOTHING'
    )


def downgrade() -> None:
    op.drop_constraint(
        'ck_documents_version_positive',
        'documents',
        type_='check',
    )
    op.drop_column('documents', 'deleted_at')
    op.drop_column('documents', 'version')

    op.drop_constraint(
        'ck_folders_version_positive',
        'folders',
        type_='check',
    )
    # The pre-1B.2 schema cannot keep tombstones, and their names may collide
    # with active replacements once uniqueness covers every row again.
    op.execute("DELETE FROM folders WHERE deleted_at IS NOT NULL")
    op.drop_column('folders', 'deleted_at')
    op.drop_column('folders', 'version')

    op.execute("DROP INDEX IF EXISTS uq_folders_child_name")
    op.execute("DROP INDEX IF EXISTS uq_folders_root_name")
    op.execute(
        "CREATE UNIQUE INDEX uq_folders_root_name "
        "ON folders (quarry_id, lower(name)) WHERE parent_id IS NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_folders_child_name "
        "ON folders (quarry_id, parent_id, lower(name)) "
        "WHERE parent_id IS NOT NULL"
    )
