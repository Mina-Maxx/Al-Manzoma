"""platform_admins table

Revision ID: c1f0a2b3d4e5
Revises: 52fc90c20366
Create Date: 2026-10-16 10:00:00.000000

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'c1f0a2b3d4e5'
down_revision = '52fc90c20366'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'platform_admins',
        sa.Column('auth_user_id', sa.String(length=255), nullable=False),
        sa.Column('email', sa.String(length=320), nullable=True),
        sa.Column('full_name', sa.String(length=200), nullable=True),
        sa.Column(
            'status',
            postgresql.ENUM('active', 'inactive', name='user_status', create_type=False),
            nullable=False,
        ),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        op.f('ix_platform_admins_auth_user_id'),
        'platform_admins',
        ['auth_user_id'],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_platform_admins_auth_user_id'), table_name='platform_admins')
    op.drop_table('platform_admins')
