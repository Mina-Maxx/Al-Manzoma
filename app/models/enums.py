from __future__ import annotations

import enum


class CompanyStatus(str, enum.Enum):
    active = "active"
    suspended = "suspended"


class UserStatus(str, enum.Enum):
    active = "active"
    inactive = "inactive"


class MembershipRole(str, enum.Enum):
    company_admin = "company_admin"
    employee = "employee"


class QuarryStatus(str, enum.Enum):
    active = "active"
    inactive = "inactive"


class DocumentStatus(str, enum.Enum):
    pending = "pending"
    available = "available"
    failed = "failed"


class IdempotencyStatus(str, enum.Enum):
    in_progress = "in_progress"
    completed = "completed"


class AuditResult(str, enum.Enum):
    success = "success"
    denied = "denied"
    failure = "failure"


class ChangeEntityType(str, enum.Enum):
    folder = "folder"
    document = "document"


class ChangeType(str, enum.Enum):
    created = "created"
    updated = "updated"
    deleted = "deleted"
