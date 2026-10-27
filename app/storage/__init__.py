from __future__ import annotations

from app.config import Settings
from app.storage.base import Storage, StorageError, StorageNotFound, StorageUnavailable


def build_storage(settings: Settings) -> Storage:
    backend = settings.storage_backend.lower()
    if backend == "local":
        from app.storage.local import LocalDiskStorage

        return LocalDiskStorage(settings.storage_local_root)
    if backend == "gdrive":
        from app.storage.gdrive import GoogleDriveStorage, build_drive_service

        service = build_drive_service(settings)
        return GoogleDriveStorage(
            service,
            settings.gdrive_root_folder_id,
            max_attempts=settings.google_retry_max_attempts,
            base_seconds=settings.google_retry_base_seconds,
        )
    raise ValueError(f"unknown STORAGE_BACKEND: {settings.storage_backend}")


__all__ = [
    "Storage",
    "StorageError",
    "StorageNotFound",
    "StorageUnavailable",
    "build_storage",
]
