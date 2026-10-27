from __future__ import annotations

import threading

from app.services.identity import (
    IdentityAlreadyExists,
    IdentityError,
    IdentityProvider,
)


class FakeIdentityProvider(IdentityProvider):
    """Deterministic in-memory identity provider for tests.

    Records invited/disabled ids so tests can assert the side effects. Flags let
    a test force the two failure modes the service must handle.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.invited: dict[str, str] = {}
        self.disabled: set[str] = set()
        self.enabled: set[str] = set()
        self.invite_calls = 0
        self.disable_calls = 0
        self.enable_calls = 0
        self.raise_already_exists = False
        self.raise_identity_error = False

    def invite_user(self, *, email: str, full_name: str | None = None) -> str:
        with self._lock:
            self.invite_calls += 1
        if self.raise_already_exists:
            raise IdentityAlreadyExists("email already registered")
        if self.raise_identity_error:
            raise IdentityError("identity provider unavailable")
        auth_user_id = f"auth-{email}"
        with self._lock:
            self.invited[email] = auth_user_id
        return auth_user_id

    def disable_user(self, auth_user_id: str) -> None:
        with self._lock:
            self.disable_calls += 1
            self.disabled.add(auth_user_id)

    def enable_user(self, auth_user_id: str) -> None:
        with self._lock:
            self.enable_calls += 1
            self.enabled.add(auth_user_id)
            self.disabled.discard(auth_user_id)
