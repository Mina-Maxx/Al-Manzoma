from __future__ import annotations

import uuid
from datetime import datetime

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
    display_name: str
    original_filename: str
    mime_type: str
    size_bytes: int
    sha256: str | None
    status: str
    uploaded_by: uuid.UUID | None
    created_at: datetime


class ErrorOut(BaseModel):
    detail: str
