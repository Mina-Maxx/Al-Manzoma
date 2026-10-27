from __future__ import annotations

import logging
import uuid
from typing import Any

from app.models import AuditEvent, AuditResult

logger = logging.getLogger("quarryvault.audit")

_REDACT_KEYS = ("token", "password", "secret", "authorization", "jwt", "content")
_MAX_VALUE_LEN = 300


def _sanitize(meta: dict[str, Any] | None) -> dict[str, Any] | None:
    if not meta:
        return None
    clean: dict[str, Any] = {}
    for key, value in meta.items():
        lowered = str(key).lower()
        if any(bad in lowered for bad in _REDACT_KEYS):
            clean[key] = "[redacted]"
            continue
        if isinstance(value, str):
            clean[key] = value[:_MAX_VALUE_LEN]
        else:
            clean[key] = value
    return clean


class AuditService:
    """Writes audit events in an isolated transaction.

    A separate session is used so that events survive the rollback of a failed
    request. Tokens, passwords and file contents are never recorded.
    """

    def __init__(self, session_factory) -> None:
        self._session_factory = session_factory

    def record(
        self,
        *,
        action: str,
        result: AuditResult,
        company_id: uuid.UUID | None = None,
        actor_user_id: uuid.UUID | None = None,
        target_type: str | None = None,
        target_id: str | None = None,
        meta: dict[str, Any] | None = None,
        request=None,
    ) -> None:
        ip = None
        user_agent = None
        if request is not None:
            client = getattr(request, "client", None)
            ip = getattr(client, "host", None) if client else None
            headers = getattr(request, "headers", None)
            if headers is not None:
                user_agent = headers.get("user-agent")
        event = AuditEvent(
            company_id=company_id,
            actor_user_id=actor_user_id,
            action=action,
            target_type=target_type,
            target_id=str(target_id) if target_id is not None else None,
            result=result,
            ip=ip,
            user_agent=(user_agent[:400] if user_agent else None),
            meta=_sanitize(meta),
        )
        try:
            with self._session_factory() as session:
                session.add(event)
                session.commit()
        except Exception as exc:
            # Auditing must never break the request path. Record a warning so a
            # failed write is not silently invisible, but never include tokens,
            # secrets or file contents (only the action and error type).
            logger.warning(
                "audit event not persisted: action=%s result=%s error=%s",
                action,
                result.value,
                type(exc).__name__,
            )
