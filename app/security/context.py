from __future__ import annotations

from dataclasses import dataclass

from app.models import Company, Membership, MembershipRole, User


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
