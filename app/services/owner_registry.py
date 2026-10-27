from __future__ import annotations

import threading
import uuid


class ActiveOwnerRegistry:
    """Process-local map of idempotency key row id -> current owner token.

    This is the primary *liveness* signal for an in-flight upload inside a single
    application process. It exists because a database lease alone cannot tell a
    crashed attempt apart from a slow-but-alive one: a live owner may hold the
    key for longer than the lease, and the lease could expire while the owner is
    still working.

    IMPORTANT: this registry is only correct for a **single process**. It is NOT
    a cross-process or cross-instance liveness authority. In a multi-worker
    deployment (e.g. several Uvicorn workers or several containers) each process
    has its own registry, so a key owned by another worker would look "unowned"
    here. Multi-worker recovery would require a shared mechanism such as database
    advisory locks; that is explicitly out of scope for this slice.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._owners: dict[uuid.UUID, uuid.UUID] = {}

    def register(self, key_id: uuid.UUID, owner_token: uuid.UUID) -> None:
        with self._lock:
            self._owners[key_id] = owner_token

    def unregister(self, key_id: uuid.UUID, owner_token: uuid.UUID) -> None:
        """Remove ``key_id`` only if it is still owned by ``owner_token``.

        This guards against the common race where a stale attempt's ``finally``
        block runs *after* a newer attempt has already taken the key over: the
        stale cleanup must never evict the new owner's entry.
        """
        with self._lock:
            if self._owners.get(key_id) == owner_token:
                del self._owners[key_id]

    def is_active(self, key_id: uuid.UUID) -> bool:
        with self._lock:
            return key_id in self._owners

    def current_owner(self, key_id: uuid.UUID) -> uuid.UUID | None:
        with self._lock:
            return self._owners.get(key_id)

    def clear(self) -> None:
        with self._lock:
            self._owners.clear()


#: Process-wide registry for the single-process deployment.
active_owners = ActiveOwnerRegistry()
