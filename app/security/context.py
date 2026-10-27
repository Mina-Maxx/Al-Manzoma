from __future__ import annotations

from dataclasses import dataclass

from app.models import Company, Membership, MembershipRole, PlatformAdmin, User


@dataclass(frozen=True)
class AuthContext:
    """Server-derived identity and tenancy for the current request.

    ``company_id`` is always derived from the membership row, never from any
    client-supplied value or JWT claim.
    """

    user: User
    company: Company
    membership: Membership
    claims: dict

    @property
    def user_id(self):
        return self.user.id

    @property
    def company_id(self):
        return self.company.id

    @property
    def role(self) -> MembershipRole:
        return self.membership.role


@dataclass(frozen=True)
class PlatformAdminContext:
    """Server-derived identity for a platform operator.

    Platform admins have no company and no membership; they can only reach the
    platform management endpoints.
    """

    admin: PlatformAdmin
    claims: dict

    @property
    def admin_id(self):
        return self.admin.id

    @property
    def auth_user_id(self) -> str:
        return self.admin.auth_user_id
