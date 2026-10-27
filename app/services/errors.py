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


class NotFound(DomainError):
    http_status = 404


class Conflict(DomainError):
    http_status = 409


class MaxUsersReached(Conflict):
    """The company already has its maximum number of users."""


class LastCompanyAdmin(Conflict):
    """Operation would leave the company without an active company_admin."""


class RateLimited(DomainError):
    http_status = 429


class InviteFailed(DomainError):
    """The invitation could not be completed; retry is safe."""

    http_status = 502
