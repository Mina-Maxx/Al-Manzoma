"""Operational tool to permanently purge expired documents and their storage objects.

Runs as a standalone scheduled task or manual CLI command. Fenced against stale workers,
preserves company quota until physical storage removal is confirmed, and is safe for
idempotent retries.

Usage:
    python scripts/purge_expired_documents.py [--retention-days 30] [--dry-run]
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select, and_, or_  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.db import build_engine_from_settings, build_session_factory  # noqa: E402
from app.models import Document, DocumentStatus  # noqa: E402
from app.services.document_service import purge_expired_documents  # noqa: E402
from app.storage import build_storage  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("quarryvault.purge_script")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--retention-days",
        type=int,
        default=30,
        help="Retention period in days (default: 30). Documents older than this will be purged.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=50,
        help="Number of documents to process in a single batch (default: 50).",
    )
    parser.add_argument(
        "--lease-seconds",
        type=int,
        default=600,
        help="Lease duration in seconds for in-flight purge attempts (default: 600).",
    )
    parser.add_argument(
        "--backoff-seconds",
        type=int,
        default=300,
        help="Backoff duration in seconds before retrying failed purge attempts (default: 300).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Scan and report expired documents without deleting anything.",
    )
    args = parser.parse_args()

    settings = get_settings()
    engine = build_engine_from_settings(settings)
    session_factory = build_session_factory(engine)
    storage = build_storage(settings)

    now_utc = datetime.now(timezone.utc)
    cutoff = now_utc - timedelta(days=args.retention_days)

    if args.dry_run:
        logger.info("[DRY RUN] Scanning documents deleted before %s...", cutoff.isoformat())
        with session_factory() as session:
            stmt = (
                select(Document)
                .where(
                    Document.deleted_at < cutoff,
                    Document.status == DocumentStatus.available,
                )
                .order_by(Document.deleted_at.asc())
            )
            expired = session.execute(stmt).scalars().all()
            total_bytes = sum(doc.size_bytes for doc in expired)
            logger.info(
                "[DRY RUN] Found %d expired documents occupying %d bytes (%0.2f MB). No changes made.",
                len(expired),
                total_bytes,
                total_bytes / (1024 * 1024),
            )
        return 0

    logger.info(
        "Starting purge of documents deleted before %s (batch_size=%d)...",
        cutoff.isoformat(),
        args.batch_size,
    )

    with session_factory() as session:
        report = purge_expired_documents(
            db=session,
            storage=storage,
            retention_days=args.retention_days,
            lease_seconds=args.lease_seconds,
            backoff_seconds=args.backoff_seconds,
            batch_size=args.batch_size,
        )

    logger.info(
        "Purge completed: %d documents permanently deleted, %d bytes (%0.2f MB) freed, %d failures.",
        report.purged_count,
        report.freed_bytes,
        report.freed_bytes / (1024 * 1024),
        report.failed_count,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
