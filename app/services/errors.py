from __future__ import annotations


class DomainError(Exception):
    """Base class for expected, safe-to-surface application errors."""

    http_status = 400


class QuotaExceeded(DomainError):
    http_status = 409


class InvalidFileType(DomainError):
    http_status = 415


class FileTooLarge(DomainError):
    http_status = 413


class EmptyFile(DomainError):
    http_status = 400


class IdempotencyConflict(DomainError):
    http_status = 409


class IdempotencyInProgress(DomainError):
    http_status = 409


class StorageFailure(DomainError):
    http_status = 502
