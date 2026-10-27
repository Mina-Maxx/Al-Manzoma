from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from typing import BinaryIO


class StorageError(Exception):
    """Base class for storage failures that map to a safe client error."""


class StorageNotFound(StorageError):
    """The referenced object does not exist in the backend."""


class StorageUnavailable(StorageError):
    """The backend could not be reached or returned a retryable failure."""


class Storage(ABC):
    """Backend-agnostic object store.

    ``name`` is a logical key such as
    ``company/{company_id}/quarry/{quarry_id}/{document_id}``. Implementations
    decide how to map it to physical layout. The value returned by :meth:`put`
    (``ref``) is the single source of truth stored in the database.
    """

    @abstractmethod
    def put(
        self, stream: BinaryIO, name: str, *, content_type: str | None = None
    ) -> str:
        """Store ``stream`` under logical ``name``; return an opaque ref."""

    @abstractmethod
    def open(self, ref: str) -> BinaryIO:
        """Return a readable binary stream for ``ref``."""

    @abstractmethod
    def delete(self, ref: str) -> None:
        """Delete ``ref``. Must be idempotent (no error if already gone)."""

    @abstractmethod
    def exists(self, ref: str) -> bool:
        """Return whether ``ref`` exists."""

    def iter_refs(self) -> Iterator[str]:
        """Yield every ref currently stored. Used by read-only audit tooling.

        Optional: backends that cannot enumerate their contents raise
        :class:`NotImplementedError`. Implementations must never mutate storage.
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not support listing stored objects"
        )
