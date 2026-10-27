from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import uuid
from dataclasses import dataclass

from app.services.errors import InvalidSyncCursor

CURSOR_VERSION = 1
CURSOR_PREFIX = "v1"
MAX_CURSOR_LENGTH = 1024


@dataclass(frozen=True)
class CursorData:
    company_id: uuid.UUID
    feed_epoch: uuid.UUID
    seq: int


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    if not value:
        raise InvalidSyncCursor("invalid sync cursor")
    padding = "=" * (-len(value) % 4)
    try:
        return base64.b64decode(
            (value + padding).encode("ascii"),
            altchars=b"-_",
            validate=True,
        )
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise InvalidSyncCursor("invalid sync cursor") from exc


def _signature(body: str, signing_key: bytes) -> str:
    return _b64encode(
        hmac.new(signing_key, body.encode("ascii"), hashlib.sha256).digest()
    )


def encode_cursor(
    *,
    company_id: uuid.UUID,
    feed_epoch: uuid.UUID,
    seq: int,
    signing_key: bytes,
) -> str:
    """Encode and sign an opaque, versioned sync cursor."""
    payload = {
        "c": str(company_id),
        "e": str(feed_epoch),
        "s": seq,
        "v": CURSOR_VERSION,
    }
    encoded = _b64encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    body = f"{CURSOR_PREFIX}.{encoded}"
    return f"{body}.{_signature(body, signing_key)}"


def decode_cursor(token: str, signing_key: bytes) -> CursorData:
    """Verify and decode a cursor without consulting the database."""
    if not token or len(token) > MAX_CURSOR_LENGTH or not token.isascii():
        raise InvalidSyncCursor("invalid sync cursor")

    version, separator, remainder = token.partition(".")
    if not separator:
        raise InvalidSyncCursor("invalid sync cursor")
    if version != CURSOR_PREFIX:
        if version.startswith("v") and version[1:].isdigit():
            raise InvalidSyncCursor("unsupported cursor version")
        raise InvalidSyncCursor("invalid sync cursor")

    parts = remainder.split(".")
    if len(parts) != 2:
        raise InvalidSyncCursor("invalid sync cursor")
    encoded_payload, supplied_signature = parts
    body = f"{CURSOR_PREFIX}.{encoded_payload}"
    expected_signature = _signature(body, signing_key)
    if not hmac.compare_digest(supplied_signature, expected_signature):
        raise InvalidSyncCursor("invalid sync cursor")

    try:
        payload = json.loads(_b64decode(encoded_payload).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise InvalidSyncCursor("invalid sync cursor") from exc
    if not isinstance(payload, dict):
        raise InvalidSyncCursor("invalid sync cursor")

    try:
        payload_version = payload["v"]
        company_raw = payload["c"]
        epoch_raw = payload["e"]
        seq = payload["s"]
    except KeyError as exc:
        raise InvalidSyncCursor("invalid sync cursor") from exc

    if (
        not isinstance(payload_version, int)
        or isinstance(payload_version, bool)
        or payload_version != CURSOR_VERSION
    ):
        raise InvalidSyncCursor("unsupported cursor version")
    if not isinstance(seq, int) or isinstance(seq, bool):
        raise InvalidSyncCursor("invalid sync cursor")
    if seq < 0:
        raise InvalidSyncCursor("cursor sequence must be non-negative")

    try:
        company_id = uuid.UUID(str(company_raw))
        feed_epoch = uuid.UUID(str(epoch_raw))
    except (AttributeError, TypeError, ValueError) as exc:
        raise InvalidSyncCursor("invalid sync cursor") from exc

    return CursorData(company_id=company_id, feed_epoch=feed_epoch, seq=seq)
