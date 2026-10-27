from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str | None
    full_name: str | None
    status: str


class CompanyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    status: str
    quota_bytes: int
    max_users: int
    used_bytes: int


class MeResponse(BaseModel):
    user: UserOut
    company: CompanyOut
    role: str


class QuarryPermissionOut(BaseModel):
    can_view: bool
    can_upload: bool
    can_download: bool


class QuarryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    status: str
    permissions: QuarryPermissionOut


class DocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    quarry_id: uuid.UUID
    folder_id: uuid.UUID | None
    display_name: str
    original_filename: str
    mime_type: str
    size_bytes: int
    sha256: str | None
    status: str
    uploaded_by: uuid.UUID | None
    version: int
    created_at: datetime


class TrashDocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    quarry_id: uuid.UUID
    folder_id: uuid.UUID | None
    display_name: str
    original_filename: str
    mime_type: str
    size_bytes: int
    version: int
    created_at: datetime
    deleted_at: datetime
    deleted_by: uuid.UUID | None
    can_restore: bool
    retention_expires_at: datetime


class ErrorOut(BaseModel):
    detail: str


# --- Folders ----------------------------------------------------------------


class FolderCreate(BaseModel):
    name: str
    parent_id: uuid.UUID | None = None


class FolderRename(BaseModel):
    name: str


class FolderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    quarry_id: uuid.UUID
    parent_id: uuid.UUID | None
    name: str
    version: int
    created_at: datetime
    updated_at: datetime


class DocumentMove(BaseModel):
    # Omitted or null both mean "move to root/unfiled".
    folder_id: uuid.UUID | None = None


# --- Sync feed --------------------------------------------------------------


class SyncChangeOut(BaseModel):
    seq: int
    entity_type: str
    entity_id: uuid.UUID
    quarry_id: uuid.UUID
    change_type: str
    entity_version: int
    changed_at: datetime
    payload: dict[str, Any]


class SyncChangesOut(BaseModel):
    changes: list[SyncChangeOut]
    next_cursor: str
    high_water: int
    has_more: bool
    resync_required: bool
    bootstrap_required: bool


# --- Management API ---------------------------------------------------------


class CompanyCreate(BaseModel):
    name: str
    quota_bytes: int
    max_users: int


class CompanySummary(BaseModel):
    id: uuid.UUID
    name: str
    status: str
    quota_bytes: int
    max_users: int
    used_bytes: int
    user_count: int


class EmployeeOut(BaseModel):
    id: uuid.UUID
    email: str | None
    full_name: str | None
    status: str
    role: str


class InviteRequest(BaseModel):
    email: str
    full_name: str | None = None


class QuarryAdminOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    status: str


class QuarryName(BaseModel):
    name: str


class PermissionUpdate(BaseModel):
    can_view: bool = False
    can_upload: bool = False
    can_download: bool = False


class PermissionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: uuid.UUID
    quarry_id: uuid.UUID
    can_view: bool
    can_upload: bool
    can_download: bool


class UsageOut(BaseModel):
    used_bytes: int
    quota_bytes: int


class PermissionsMatrixOut(BaseModel):
    members: list[EmployeeOut]
    quarries: list[QuarryAdminOut]
    permissions: list[PermissionOut]


class PlatformOverviewOut(BaseModel):
    total_offices: int
    active_offices: int
    suspended_offices: int
    total_users: int
    active_users: int
    disabled_users: int
    total_quarries: int
    active_documents: int
    trash_documents: int
    total_used_bytes: int
    total_quota_bytes: int
    storage_utilization_pct: float
    time_range_days: int
    uploads_count: int
    downloads_count: int
    deletions_count: int
    restorations_count: int
    failed_operations_count: int
    activity_trend: list[dict[str, Any]]
    backend_health: str
    database_health: str
    storage_health: str
    storage_backend: str


class GlobalUserOut(BaseModel):
    id: uuid.UUID
    email: str | None
    full_name: str | None
    status: str
    role: str
    company_id: uuid.UUID | None
    company_name: str | None
    created_at: datetime


class AuditEventOut(BaseModel):
    id: uuid.UUID
    created_at: datetime
    company_id: uuid.UUID | None = None
    company_name: str | None = None
    actor_user_id: uuid.UUID | None = None
    actor_email: str | None = None
    action: str
    target_type: str | None = None
    target_id: str | None = None
    result: str
    ip: str | None = None
    meta: dict[str, Any] | None = None


class AuditListResponse(BaseModel):
    total: int
    items: list[AuditEventOut]


class OperationalAlertOut(BaseModel):
    id: str
    severity: str
    category: str
    title: str
    description: str
    company_id: uuid.UUID | None = None
    company_name: str | None = None
    detected_at: datetime


class OfficeOverviewOut(BaseModel):
    company_id: uuid.UUID
    company_name: str
    company_status: str
    total_users: int
    active_users: int
    disabled_users: int
    max_users: int
    total_quarries: int
    active_documents: int
    trash_documents: int
    used_bytes: int
    quota_bytes: int
    quota_utilization_pct: float
    recent_uploads_count: int
    recent_downloads_count: int
    recent_deletions_count: int
    recent_restorations_count: int
    recent_failures_count: int
    alerts: list[OperationalAlertOut]

