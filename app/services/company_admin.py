from __future__ import annotations

import logging
import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    Company,
    Membership,
    MembershipRole,
    Quarry,
    QuarryPermission,
    QuarryStatus,
    User,
    UserStatus,
)
from app.services.errors import (
    Conflict,
    InviteFailed,
    LastCompanyAdmin,
    MaxUsersReached,
    NotFound,
)
from app.services.identity import (
    IdentityAlreadyExists,
    IdentityError,
    IdentityProvider,
)
from app.services.quota import company_used_bytes

logger = logging.getLogger("quarryvault.management")

# Deliberately generic: a conflicting email must never reveal that the address
# belongs to another company (or that it exists at all).
GENERIC_INVITE_CONFLICT = "invitation could not be created"


def _lock_company(db: Session, company_id: uuid.UUID) -> Company:
    company = db.execute(
        select(Company).where(Company.id == company_id).with_for_update()
    ).scalar_one_or_none()
    if company is None:
        raise NotFound("company not found")
    return company


def _company_membership(
    db: Session, company_id: uuid.UUID, user_id: uuid.UUID
) -> Membership:
    membership = db.execute(
        select(Membership).where(
            Membership.company_id == company_id, Membership.user_id == user_id
        )
    ).scalar_one_or_none()
    if membership is None:
        # A user from another company is indistinguishable from a missing one.
        raise NotFound("user not found")
    return membership


def _quarry_in_company(
    db: Session, company_id: uuid.UUID, quarry_id: uuid.UUID
) -> Quarry:
    quarry = db.get(Quarry, quarry_id)
    if quarry is None or quarry.company_id != company_id:
        raise NotFound("quarry not found")
    return quarry


def _compensate_disable(identity: IdentityProvider, auth_user_id: str) -> None:
    try:
        identity.disable_user(auth_user_id)
    except IdentityError:
        logger.warning(
            "invitation compensation failed; an identity may need manual review"
        )


def list_employees(db: Session, company_id: uuid.UUID) -> list[dict]:
    rows = db.execute(
        select(User, Membership)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.company_id == company_id)
        .order_by(User.created_at.asc())
    ).all()
    return [{"user": user, "role": membership.role} for user, membership in rows]


def invite_employee(
    db: Session,
    identity: IdentityProvider,
    company_id: uuid.UUID,
    *,
    email: str,
    full_name: str | None = None,
) -> dict:
    """Invite an employee: create the identity, then the local user + membership.

    The identity is created before the row lock so no network I/O happens while
    holding the company lock. ``max_users`` and duplicate-email decisions are
    then serialized by that lock. If the database write fails after a successful
    invite, the new identity is disabled as compensation.
    """
    cleaned = (email or "").strip().lower()
    if not cleaned:
        raise Conflict("email is required")

    existing = db.execute(
        select(User).where(func.lower(User.email) == cleaned)
    ).scalar_one_or_none()
    if existing is not None:
        raise Conflict(GENERIC_INVITE_CONFLICT)

    try:
        auth_user_id = identity.invite_user(email=cleaned, full_name=full_name)
    except IdentityAlreadyExists:
        raise Conflict(GENERIC_INVITE_CONFLICT)
    except IdentityError:
        raise InviteFailed("identity provider unavailable")

    company = _lock_company(db, company_id)
    member_count = db.execute(
        select(func.count(Membership.id)).where(Membership.company_id == company_id)
    ).scalar_one()
    if member_count >= company.max_users:
        db.rollback()
        _compensate_disable(identity, auth_user_id)
        raise MaxUsersReached("company user limit reached")

    # Re-check under the lock: another transaction may have taken the email.
    existing = db.execute(
        select(User).where(func.lower(User.email) == cleaned)
    ).scalar_one_or_none()
    if existing is not None:
        db.rollback()
        _compensate_disable(identity, auth_user_id)
        raise Conflict(GENERIC_INVITE_CONFLICT)

    try:
        user = User(
            auth_user_id=auth_user_id,
            email=cleaned,
            full_name=full_name,
            status=UserStatus.active,
        )
        db.add(user)
        db.flush()
        membership = Membership(
            user_id=user.id, company_id=company_id, role=MembershipRole.employee
        )
        db.add(membership)
        db.commit()
        db.refresh(user)
    except Exception:
        db.rollback()
        _compensate_disable(identity, auth_user_id)
        raise InviteFailed("invitation could not be completed")

    return {"user": user, "role": membership.role}


def set_user_status(
    db: Session,
    identity: IdentityProvider,
    company_id: uuid.UUID,
    user_id: uuid.UUID,
    status: UserStatus,
) -> dict:
    """Enable/disable an employee. The database is the authority.

    The provider is updated afterwards, best-effort: if it fails the database
    change still stands (and the failure is logged for a later retry). Disabling
    the last active company_admin is refused under a company row lock.
    """
    membership = _company_membership(db, company_id, user_id)
    user = db.get(User, user_id)

    if status == UserStatus.inactive and membership.role == MembershipRole.company_admin:
        _lock_company(db, company_id)
        active_admins = db.execute(
            select(func.count(Membership.id))
            .join(User, User.id == Membership.user_id)
            .where(
                Membership.company_id == company_id,
                Membership.role == MembershipRole.company_admin,
                User.status == UserStatus.active,
            )
        ).scalar_one()
        if active_admins <= 1:
            db.rollback()
            raise LastCompanyAdmin(
                "cannot disable the last active company administrator"
            )

    user.status = status
    db.add(user)
    db.commit()
    db.refresh(user)

    try:
        if status == UserStatus.inactive:
            identity.disable_user(user.auth_user_id)
        else:
            identity.enable_user(user.auth_user_id)
    except IdentityError:
        logger.warning(
            "identity provider status sync failed; database is authoritative "
            "(user_id=%s status=%s)",
            user.id,
            status.value,
        )

    return {"user": user, "role": membership.role}


def list_quarries(db: Session, company_id: uuid.UUID) -> list[Quarry]:
    return list(
        db.execute(
            select(Quarry)
            .where(Quarry.company_id == company_id)
            .order_by(Quarry.name.asc())
        ).scalars().all()
    )


def create_quarry(db: Session, company_id: uuid.UUID, *, name: str) -> Quarry:
    cleaned = (name or "").strip()
    if not cleaned:
        raise Conflict("quarry name is required")
    existing = db.execute(
        select(Quarry).where(
            Quarry.company_id == company_id,
            func.lower(Quarry.name) == cleaned.lower(),
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise Conflict("a quarry with this name already exists")

    quarry = Quarry(company_id=company_id, name=cleaned, status=QuarryStatus.active)
    db.add(quarry)
    db.commit()
    db.refresh(quarry)
    return quarry


def rename_quarry(
    db: Session, company_id: uuid.UUID, quarry_id: uuid.UUID, *, name: str
) -> Quarry:
    cleaned = (name or "").strip()
    if not cleaned:
        raise Conflict("quarry name is required")
    quarry = _quarry_in_company(db, company_id, quarry_id)
    clash = db.execute(
        select(Quarry).where(
            Quarry.company_id == company_id,
            Quarry.id != quarry_id,
            func.lower(Quarry.name) == cleaned.lower(),
        )
    ).scalar_one_or_none()
    if clash is not None:
        raise Conflict("a quarry with this name already exists")

    quarry.name = cleaned
    db.add(quarry)
    db.commit()
    db.refresh(quarry)
    return quarry


def set_quarry_status(
    db: Session, company_id: uuid.UUID, quarry_id: uuid.UUID, status: QuarryStatus
) -> Quarry:
    quarry = _quarry_in_company(db, company_id, quarry_id)
    quarry.status = status
    db.add(quarry)
    db.commit()
    db.refresh(quarry)
    return quarry


def set_permission(
    db: Session,
    company_id: uuid.UUID,
    quarry_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    can_view: bool,
    can_upload: bool,
    can_download: bool,
) -> QuarryPermission:
    # Both the quarry and the target user must belong to the actor's company.
    quarry = _quarry_in_company(db, company_id, quarry_id)
    _company_membership(db, company_id, user_id)

    perm = db.execute(
        select(QuarryPermission).where(
            QuarryPermission.user_id == user_id,
            QuarryPermission.quarry_id == quarry.id,
        )
    ).scalar_one_or_none()
    if perm is None:
        perm = QuarryPermission(
            user_id=user_id,
            quarry_id=quarry.id,
            can_view=can_view,
            can_upload=can_upload,
            can_download=can_download,
        )
        db.add(perm)
    else:
        perm.can_view = can_view
        perm.can_upload = can_upload
        perm.can_download = can_download
        db.add(perm)
    db.commit()
    db.refresh(perm)
    return perm


def permissions_matrix(db: Session, company_id: uuid.UUID) -> dict:
    members = list_employees(db, company_id)
    quarries = list_quarries(db, company_id)
    permissions = db.execute(
        select(QuarryPermission)
        .join(Quarry, Quarry.id == QuarryPermission.quarry_id)
        .where(Quarry.company_id == company_id)
    ).scalars().all()
    return {"members": members, "quarries": quarries, "permissions": permissions}


def company_usage(db: Session, company_id: uuid.UUID) -> dict:
    company = db.get(Company, company_id)
    if company is None:
        raise NotFound("company not found")
    return {
        "used_bytes": company_used_bytes(db, company_id),
        "quota_bytes": company.quota_bytes,
    }
