"""Release reservations for upload attempts that crashed while ``in_progress``.

A stale attempt is an in-progress idempotency key whose lease has expired and
which has no live owner in the current process. Running this command releases
the attempt's pending reservation and marks the key failed so the client can
safely retry with the same idempotency key.

This command NEVER deletes stored objects. It is safe to run repeatedly.

Important: this runs in its own process, so it cannot see the API server's
in-memory owner registry. It therefore relies solely on lease expiry, and must
be run with a threshold comfortably longer than any legitimate upload. The
default threshold is ``IDEMPOTENCY_LEASE_SECONDS`` (see config).

Usage:
    python -m app.scripts.reap
    python -m app.scripts.reap --older-than-seconds 600 --limit 500
"""
from __future__ import annotations

import argparse

from app.config import get_settings
from app.db import build_engine, build_session_factory
from app.services.reconciliation import reap_stale_attempts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.scripts.reap",
        description="Release stale in-progress upload attempts (no storage deletion).",
    )
    parser.add_argument(
        "--older-than-seconds",
        type=int,
        default=None,
        help=(
            "Only reap attempts whose lease expired at least this many seconds "
            "ago. Defaults to IDEMPOTENCY_LEASE_SECONDS."
        ),
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=100,
        help="Maximum number of candidate attempts to process in one run.",
    )
    args = parser.parse_args(argv)

    settings = get_settings()
    older_than = (
        args.older_than_seconds
        if args.older_than_seconds is not None
        else settings.idempotency_lease_seconds
    )

    engine = build_engine(settings.database_url)
    Session = build_session_factory(engine)
    with Session() as db:
        result = reap_stale_attempts(
            db, older_than_seconds=older_than, limit=args.limit
        )

    print(
        f"Reaped {result['reaped']} stale attempt(s); "
        f"skipped {result['skipped']} of {result['candidates']} candidate(s) "
        f"(threshold {older_than}s). Storage objects were not deleted."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
