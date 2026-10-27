from __future__ import annotations

import random
import tempfile
import time
from collections.abc import Iterator
from typing import BinaryIO

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseDownload, MediaIoBaseUpload

from app.config import Settings
from app.storage.base import Storage, StorageNotFound, StorageUnavailable

_DRIVE_SCOPE = ["https://www.googleapis.com/auth/drive.file"]
_FOLDER_MIME = "application/vnd.google-apps.folder"
_RETRYABLE_STATUS = {429, 500, 502, 503, 504}
_SUPPORTS_ALL = True


def build_drive_service(settings: Settings):
    """Build an authenticated Drive client from the owner's stored credentials.

    The credentials file is produced once by ``scripts/gdrive_oauth.py`` and the
    refresh token must live only in secret storage. Never log its contents.
    """
    if not settings.gdrive_credentials_file:
        raise StorageUnavailable("GDRIVE_CREDENTIALS_FILE is not configured")
    creds = Credentials.from_authorized_user_file(
        settings.gdrive_credentials_file, scopes=_DRIVE_SCOPE
    )
    return build("drive", "v3", credentials=creds, cache_discovery=False)


class GoogleDriveStorage(Storage):
    """Google Drive implementation. Every file is private; no link sharing."""

    def __init__(
        self,
        service,
        root_folder_id: str,
        *,
        max_attempts: int = 5,
        base_seconds: float = 0.5,
    ) -> None:
        if not root_folder_id:
            raise StorageUnavailable("GDRIVE_ROOT_FOLDER_ID is not configured")
        self.service = service
        self.root_folder_id = root_folder_id
        self.max_attempts = max_attempts
        self.base_seconds = base_seconds
        self._folder_cache: dict[tuple[str, str], str] = {}

    def _execute(self, request):
        """Run a Drive request with exponential backoff on 429/5xx.

        Maps 404 to StorageNotFound and any other failure to StorageUnavailable
        so that Google error details never reach the client.
        """
        attempt = 0
        while True:
            attempt += 1
            try:
                return request.execute()
            except HttpError as exc:
                status = getattr(exc.resp, "status", None)
                if status == 404:
                    raise StorageNotFound("google drive object not found") from exc
                if status in _RETRYABLE_STATUS and attempt < self.max_attempts:
                    sleep_for = self.base_seconds * (2 ** (attempt - 1))
                    sleep_for += random.uniform(0, self.base_seconds)
                    time.sleep(sleep_for)
                    continue
                raise StorageUnavailable("google drive request failed") from exc

    def _find_child_folder(self, parent_id: str, name: str) -> str | None:
        query = (
            f"'{parent_id}' in parents and name = '{name}' "
            f"and mimeType = '{_FOLDER_MIME}' and trashed = false"
        )
        resp = self._execute(
            self.service.files().list(
                q=query,
                spaces="drive",
                fields="files(id, name)",
                pageSize=1,
                supportsAllDrives=_SUPPORTS_ALL,
                includeItemsFromAllDrives=_SUPPORTS_ALL,
            )
        )
        files = resp.get("files", [])
        return files[0]["id"] if files else None

    def _ensure_folder(self, parent_id: str, name: str) -> str:
        cache_key = (parent_id, name)
        cached = self._folder_cache.get(cache_key)
        if cached:
            return cached
        existing = self._find_child_folder(parent_id, name)
        if existing:
            self._folder_cache[cache_key] = existing
            return existing
        created = self._execute(
            self.service.files().create(
                body={"name": name, "mimeType": _FOLDER_MIME, "parents": [parent_id]},
                fields="id",
                supportsAllDrives=_SUPPORTS_ALL,
            )
        )
        folder_id = created["id"]
        self._folder_cache[cache_key] = folder_id
        return folder_id

    def put(
        self, stream: BinaryIO, name: str, *, content_type: str | None = None
    ) -> str:
        parts = [p for p in name.split("/") if p]
        if not parts:
            raise StorageUnavailable("empty storage name")
        *folder_parts, filename = parts
        parent_id = self.root_folder_id
        for part in folder_parts:
            parent_id = self._ensure_folder(parent_id, part)
        media = MediaIoBaseUpload(
            stream, mimetype=content_type or "application/octet-stream", resumable=False
        )
        created = self._execute(
            self.service.files().create(
                body={"name": filename, "parents": [parent_id]},
                media_body=media,
                fields="id",
                supportsAllDrives=_SUPPORTS_ALL,
            )
        )
        return created["id"]

    def open(self, ref: str) -> BinaryIO:
        spool = tempfile.SpooledTemporaryFile(max_size=1024 * 1024)
        try:
            downloader = MediaIoBaseDownload(
                spool, self.service.files().get_media(fileId=ref)
            )
            done = False
            while not done:
                _, done = downloader.next_chunk()
        except (HttpError, StorageUnavailable):
            spool.close()
            raise
        spool.seek(0)
        return spool

    def delete(self, ref: str) -> None:
        try:
            self._execute(
                self.service.files().delete(fileId=ref, supportsAllDrives=_SUPPORTS_ALL)
            )
        except StorageNotFound:
            return

    def exists(self, ref: str) -> bool:
        try:
            self._execute(
                self.service.files().get(
                    fileId=ref, fields="id, trashed", supportsAllDrives=_SUPPORTS_ALL
                )
            )
            return True
        except StorageNotFound:
            return False

    def iter_refs(self) -> Iterator[str]:
        """Yield the id of every non-folder file under the root folder.

        Breadth-first walk of the private root folder tree. Read-only: only
        ``files().list`` is called, never create/update/delete.
        """
        queue = [self.root_folder_id]
        while queue:
            parent_id = queue.pop()
            page_token = None
            while True:
                resp = self._execute(
                    self.service.files().list(
                        q=f"'{parent_id}' in parents and trashed = false",
                        spaces="drive",
                        fields="nextPageToken, files(id, mimeType)",
                        pageSize=1000,
                        pageToken=page_token,
                        supportsAllDrives=_SUPPORTS_ALL,
                        includeItemsFromAllDrives=_SUPPORTS_ALL,
                    )
                )
                for entry in resp.get("files", []):
                    if entry.get("mimeType") == _FOLDER_MIME:
                        queue.append(entry["id"])
                    else:
                        yield entry["id"]
                page_token = resp.get("nextPageToken")
                if not page_token:
                    break
