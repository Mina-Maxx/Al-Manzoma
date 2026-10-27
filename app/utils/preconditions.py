from __future__ import annotations

from fastapi import HTTPException, status


def parse_if_match(value: str | None) -> int | None:
    """Parse ``If-Match: "<version>"``; absence means last-write-wins.

    Invalid or multi-value headers are rejected rather than ignored so a client
    cannot accidentally lose optimistic-concurrency protection.
    """
    if value is None:
        return None
    candidate = value.strip()
    if candidate.startswith("W/"):
        raise _invalid()
    if candidate.startswith('"') or candidate.endswith('"'):
        if len(candidate) < 2 or not (
            candidate.startswith('"') and candidate.endswith('"')
        ):
            raise _invalid()
        candidate = candidate[1:-1]
    if not candidate.isdigit():
        raise _invalid()
    version = int(candidate)
    if version < 1:
        raise _invalid()
    return version


def etag_for_version(version: int) -> str:
    return f'"{version}"'


def _invalid() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="If-Match must be a single positive integer version",
    )
