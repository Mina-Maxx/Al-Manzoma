"""folders and document folder assignment

Revision ID: e5f6a7b8c9d0
Revises: c1f0a2b3d4e5
Create Date: 2026-10-23 12:00:00.000000

Adds tenant-scoped folders and a nullable ``documents.folder_id``. Existing
documents keep ``folder_id = NULL`` (root/unfiled) and remain fully accessible.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = 'e5f6a7b8c9d0'
down_revision = 'c1f0a2b3d4e5'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'folders',
        sa.Column('company_id', sa.Uuid(), nullable=False),
        sa.Column('quarry_id', sa.Uuid(), nullable=False),
        sa.Column('parent_id', sa.Uuid(), nullable=True),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.Column(
            'updated_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(['company_id'], ['companies.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['quarry_id'], ['quarries.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['parent_id'], ['folders.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_folders_company_id'), 'folders', ['company_id'], unique=False)
    op.create_index(op.f('ix_folders_quarry_id'), 'folders', ['quarry_id'], unique=False)
    op.create_index(op.f('ix_folders_parent_id'), 'folders', ['parent_id'], unique=False)

    # Case-insensitive duplicate prevention per parent. A plain unique constraint
    # cannot cover root folders because PostgreSQL treats NULLs as distinct, so
    # root and nested folders get separate partial expression indexes.
    op.execute(
        "CREATE UNIQUE INDEX uq_folders_root_name "
        "ON folders (quarry_id, lower(name)) WHERE parent_id IS NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_folders_child_name "
        "ON folders (quarry_id, parent_id, lower(name)) WHERE parent_id IS NOT NULL"
    )

    op.add_column('documents', sa.Column('folder_id', sa.Uuid(), nullable=True))
    op.create_foreign_key(
        'fk_documents_folder_id',
        'documents',
        'folders',
        ['folder_id'],
        ['id'],
        ondelete='SET NULL',
    )
    op.create_index(
        op.f('ix_documents_folder_id'), 'documents', ['folder_id'], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_documents_folder_id'), table_name='documents')
    op.drop_constraint('fk_documents_folder_id', 'documents', type_='foreignkey')
    op.drop_column('documents', 'folder_id')

    op.execute("DROP INDEX IF EXISTS uq_folders_child_name")
    op.execute("DROP INDEX IF EXISTS uq_folders_root_name")
    op.drop_index(op.f('ix_folders_parent_id'), table_name='folders')
    op.drop_index(op.f('ix_folders_quarry_id'), table_name='folders')
    op.drop_index(op.f('ix_folders_company_id'), table_name='folders')
    op.drop_table('folders')
