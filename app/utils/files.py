from __future__ import annotations

import hashlib
import re
import tempfile
from dataclasses import dataclass
from typing import BinaryIO

import filetype

from app.services.errors import EmptyFile, FileTooLarge

CHUNK_SIZE = 64 * 1024
_HEAD_SIZE = 4096
_SPOOL_MAX = 1024 * 1024

ALLOWED_MIME_TYPES = {"application/pdf", "image/jpeg", "image/png"}
ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png"}

_SAFE_CHARS = re.compile(r"[^A-Za-z0-9._ -]")
_MAX_NAME_LEN = 200


@dataclass
class StreamedUpload:
    spool: BinaryIO
    size_bytes: int
    sha256: str
    mime_type: str | None


def sniff_mime(head: bytes) -> str | None:
    """Detect the real content type from magic bytes. Never trusts the client."""
    kind = filetype.guess(head)
    return kind.mime if kind is not None else None


def extension_of(filename: str) -> str:
    name = (filename or "").strip().lower()
    dot = name.rfind(".")
    return name[dot:] if dot != -1 else ""


def sanitize_filename(filename: str, fallback: str = "document") -> str:
    name = (filename or "").replace("\\", "/").split("/")[-1]
    name = _SAFE_CHARS.sub("_", name).strip(" .")
    name = name[:_MAX_NAME_LEN]
    return name or fallback


def stream_upload_to_spool(fileobj: BinaryIO, max_bytes: int) -> StreamedUpload:
    """Read ``fileobj`` in chunks, enforcing the size limit while streaming.

    The content is spooled to disk (never fully in memory) and hashed. The size
    limit is enforced on the actual bytes read, not on any client header.
    """
    spool = tempfile.SpooledTemporaryFile(max_size=_SPOOL_MAX)
    hasher = hashlib.sha256()
    head = bytearray()
    size = 0
    try:
        while True:
            chunk = fileobj.read(CHUNK_SIZE)
            if not chunk:
                break
            size += len(chunk)
            if size > max_bytes:
                raise FileTooLarge("file exceeds the maximum allowed size")
            if len(head) < _HEAD_SIZE:
                head.extend(chunk[: _HEAD_SIZE - len(head)])
            hasher.update(chunk)
            spool.write(chunk)
        if size == 0:
            raise EmptyFile("empty file")
        spool.seek(0)
        return StreamedUpload(
            spool=spool,
            size_bytes=size,
            sha256=hasher.hexdigest(),
            mime_type=sniff_mime(bytes(head)),
        )
    except Exception:
        spool.close()
        raise
