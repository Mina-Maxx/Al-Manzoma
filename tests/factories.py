from __future__ import annotations

import uuid
from datetime import datetime

from app.models import (
    Company,
    CompanyStatus,
    CompanySyncState,
    Document,
    DocumentStatus,
    Folder,
    Membership,
    MembershipRole,
    PlatformAdmin,
    Quarry,
    QuarryPermission,
    QuarryStatus,
    User,
    UserStatus,
)

DEFAULT_QUOTA = 5 * 1024 * 1024 * 1024


def make_company(
    db,
    *,
    name: str = "Acme Quarry Co",
    quota_bytes: int = DEFAULT_QUOTA,
    max_users: int = 10,
    status: CompanyStatus = CompanyStatus.active,
    with_sync_state: bool = True,
) -> Company:
    company = Company(
        name=name, quota_bytes=quota_bytes, max_users=max_users, status=status
    )
    db.add(company)
    db.flush()
    if with_sync_state:
        db.add(CompanySyncState(company_id=company.id))
    db.commit()
    return company


def make_user(
    db,
    *,
    auth_user_id: str | None = None,
    email: str | None = None,
    full_name: str = "Test User",
    status: UserStatus = UserStatus.active,
) -> User:
    user = User(
        auth_user_id=auth_user_id or f"sub-{uuid.uuid4().hex}",
        email=email or f"{uuid.uuid4().hex[:8]}@example.com",
        full_name=full_name,
        status=status,
    )
    db.add(user)
    db.commit()
    return user


def make_membership(
    db,
    user: User,
    company: Company,
    *,
    role: MembershipRole = MembershipRole.employee,
) -> Membership:
    membership = Membership(user_id=user.id, company_id=company.id, role=role)
    db.add(membership)
    db.commit()
    return membership


def make_quarry(
    db,
    company: Company,
    *,
    name: str = "North Pit",
    status: QuarryStatus = QuarryStatus.active,
) -> Quarry:
    quarry = Quarry(company_id=company.id, name=name, status=status)
    db.add(quarry)
    db.commit()
    return quarry


def make_sync_state(
    db,
    company: Company,
    *,
    last_seq: int = 0,
    min_valid_seq: int = 0,
    feed_epoch: uuid.UUID | None = None,
) -> CompanySyncState:
    state = db.get(CompanySyncState, company.id)
    if state is None:
        state = CompanySyncState(
            company_id=company.id,
            feed_epoch=feed_epoch or uuid.uuid4(),
            last_seq=last_seq,
            min_valid_seq=min_valid_seq,
        )
        db.add(state)
    else:
        if feed_epoch is not None:
            state.feed_epoch = feed_epoch
        state.last_seq = last_seq
        state.min_valid_seq = min_valid_seq
    db.commit()
    return state


def make_folder(
    db,
    company: Company,
    quarry: Quarry,
    *,
    name: str = "Plans",
    parent: Folder | None = None,
    version: int = 1,
    deleted_at: datetime | None = None,
) -> Folder:
    folder = Folder(
        company_id=company.id,
        quarry_id=quarry.id,
        parent_id=parent.id if parent is not None else None,
        name=name,
        version=version,
        deleted_at=deleted_at,
    )
    db.add(folder)
    db.commit()
    return folder


def make_permission(
    db,
    user: User,
    quarry: Quarry,
    *,
    can_view: bool = True,
    can_upload: bool = False,
    can_download: bool = False,
) -> QuarryPermission:
    perm = QuarryPermission(
        user_id=user.id,
        quarry_id=quarry.id,
        can_view=can_view,
        can_upload=can_upload,
        can_download=can_download,
    )
    db.add(perm)
    db.commit()
    return perm


def provision_user(
    db,
    *,
    auth_user_id: str | None = None,
    company_name: str = "Acme Quarry Co",
    quota_bytes: int = DEFAULT_QUOTA,
    role: MembershipRole = MembershipRole.employee,
    can_view: bool = True,
    can_upload: bool = False,
    can_download: bool = False,
    company_status: CompanyStatus = CompanyStatus.active,
    user_status: UserStatus = UserStatus.active,
    quarry_name: str = "North Pit",
):
    """Create company + user + membership + quarry + permission in one call."""
    company = make_company(
        db, name=company_name, quota_bytes=quota_bytes, status=company_status
    )
    user = make_user(db, auth_user_id=auth_user_id, status=user_status)
    make_membership(db, user, company, role=role)
    quarry = make_quarry(db, company, name=quarry_name)
    permission = make_permission(
        db,
        user,
        quarry,
        can_view=can_view,
        can_upload=can_upload,
        can_download=can_download,
    )
    return user, company, quarry, permission


def make_platform_admin(
    db,
    *,
    auth_user_id: str | None = None,
    email: str | None = None,
    status: UserStatus = UserStatus.active,
) -> PlatformAdmin:
    admin = PlatformAdmin(
        auth_user_id=auth_user_id or f"pa-{uuid.uuid4().hex}",
        email=email or f"{uuid.uuid4().hex[:8]}@platform.test",
        full_name="Platform Admin",
        status=status,
    )
    db.add(admin)
    db.commit()
    return admin


def make_document(
    db,
    company: Company,
    quarry: Quarry,
    *,
    status: DocumentStatus = DocumentStatus.available,
    size_bytes: int = 1024,
    storage_ref: str | None = "ref-123",
    uploaded_by: uuid.UUID | None = None,
    folder_id: uuid.UUID | None = None,
    version: int = 1,
    deleted_at: datetime | None = None,
    deleted_by: uuid.UUID | None = None,
) -> Document:
    document = Document(
        company_id=company.id,
        quarry_id=quarry.id,
        folder_id=folder_id,
        display_name="doc.pdf",
        original_filename="doc.pdf",
        mime_type="application/pdf",
        size_bytes=size_bytes,
        sha256="a" * 64,
        storage_ref=storage_ref,
        status=status,
        uploaded_by=uploaded_by,
        version=version,
        deleted_at=deleted_at,
        deleted_by=deleted_by,
    )
    db.add(document)
    db.commit()
    return document
