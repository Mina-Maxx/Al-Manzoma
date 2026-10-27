"""Report storage objects that do not line up with the database (read-only).

Two directions are reported:

* ``orphan_on_storage`` - a stored object with no database row referencing it.
* ``missing_in_storage`` - a database ref whose object is absent from storage.

Both ``documents.storage_ref`` and ``idempotency_keys.storage_ref`` count as
"known" refs, because a failed attempt keeps its storage ref for recovery
attribution (it is intentionally not an orphan).

This command is strictly read-only: it only issues ``SELECT`` and storage
listing calls. It NEVER deletes or mutates anything.

Usage:
    python -m app.scripts.orphans
"""
from __future__ import annotations

import argparse

from sqlalchemy import select

from app.config import get_settings
from app.db import build_engine, build_session_factory
from app.models import Document, IdempotencyKey
from app.storage import build_storage


def _known_refs(db) -> set[str]:
    doc_refs = db.execute(
        select(Document.storage_ref).where(Document.storage_ref.is_not(None))
    ).scalars()
    key_refs = db.execute(
        select(IdempotencyKey.storage_ref).where(IdempotencyKey.storage_ref.is_not(None))
    ).scalars()
    return {ref for ref in doc_refs} | {ref for ref in key_refs}


def diff_refs(known: set[str], stored: set[str]) -> tuple[list[str], list[str]]:
    """Return ``(orphan_on_storage, missing_in_storage)`` sorted lists."""
    orphan_on_storage = sorted(stored - known)
    missing_in_storage = sorted(known - stored)
    return orphan_on_storage, missing_in_storage


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.scripts.orphans",
        description="Print orphan/missing storage objects vs the database (read-only).",
    )
    parser.parse_args(argv)

    settings = get_settings()
    storage = build_storage(settings)

    try:
        storage_refs = set(storage.iter_refs())
    except NotImplementedError as exc:
        print(f"Storage backend cannot be listed: {exc}")
        return 2

    engine = build_engine(settings.database_url)
    Session = build_session_factory(engine)
    with Session() as db:
        known = _known_refs(db)

    orphan_on_storage, missing_in_storage = diff_refs(known, storage_refs)

    print(f"backend         : {settings.storage_backend}")
    print(f"objects in store: {len(storage_refs)}")
    print(f"known db refs   : {len(known)}")
    print(f"orphan_on_storage  ({len(orphan_on_storage)}):")
    for ref in orphan_on_storage:
        print(f"  {ref}")
    print(f"missing_in_storage ({len(missing_in_storage)}):")
    for ref in missing_in_storage:
        print(f"  {ref}")
    print("Read-only report: nothing was deleted or modified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
