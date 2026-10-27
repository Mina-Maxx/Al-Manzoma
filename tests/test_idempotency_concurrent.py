from __future__ import annotations

import io
import threading
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import func, select

from app.models import Company, Document, Membership, User
from app.security.context import AuthContext
from app.services.document_service import upload_document
from app.services.errors import IdempotencyInProgress
from app.services.quota import company_used_bytes
from tests.factories import provision_user
from tests.util import pdf_bytes

SIZE = 50_000
KEY = "duplicate-key"


def _load_ctx(session, user_id) -> AuthContext:
    user = session.get(User, user_id)
    membership = session.execute(
        select(Membership).where(Membership.user_id == user_id)
    ).scalar_one()
    company = session.get(Company, membership.company_id)
    return AuthContext(user=user, company=company, membership=membership, claims={})


def _upload(session, storage, settings, user_id, quarry, content, key):
    ctx = _load_ctx(session, user_id)
    upload_file = SimpleNamespace(filename="same.pdf", file=io.BytesIO(content))
    return upload_document(
        db=session,
        storage=storage,
        settings=settings,
        ctx=ctx,
        quarry=quarry,
        upload_file=upload_file,
        idempotency_key=key,
        display_name=None,
    )


def _storage_object_count(storage) -> int:
    return len([p for p in Path(storage.root).rglob("*") if p.is_file()])


def test_concurrent_same_idempotency_key_creates_one_document(
    db, session_factory, storage, settings
):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="racer", can_upload=True, quota_bytes=10_000_000
    )
    content = pdf_bytes(SIZE)

    barrier = threading.Barrier(2)
    results: list[tuple] = []
    lock = threading.Lock()

    def worker():
        session = session_factory()
        try:
            barrier.wait(timeout=30)
            document, created = _upload(
                session, storage, settings, user.id, quarry, content, KEY
            )
            with lock:
                results.append(("ok", str(document.id), created))
        except IdempotencyInProgress:
            with lock:
                results.append(("in_progress", None, False))
        except Exception as exc:  # pragma: no cover - surfaced in assertion
            with lock:
                results.append((f"error:{type(exc).__name__}:{exc}", None, False))
        finally:
            session.close()

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert [r for r in results if r[0].startswith("error")] == [], results
    assert len(results) == 2

    # At most one document and at most one storage object.
    document_count = db.execute(select(func.count()).select_from(Document)).scalar_one()
    assert document_count == 1
    assert _storage_object_count(storage) == 1

    # Quota is charged once.
    assert company_used_bytes(db, company.id) == len(content)

    # Exactly one request created the document; the other either returned the
    # same (existing) document or an in-progress conflict (409).
    oks = [r for r in results if r[0] == "ok"]
    assert len(oks) >= 1
    assert sum(1 for r in oks if r[2] is True) <= 1
    if len(oks) == 2:
        assert oks[0][1] == oks[1][1]
    others = [r for r in results if r[0] == "in_progress"]
    assert len(oks) + len(others) == 2


def test_retry_after_completion_does_not_create_duplicate(
    db, session_factory, storage, settings
):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="retrier", can_upload=True, quota_bytes=10_000_000
    )
    content = pdf_bytes(SIZE)

    session = session_factory()
    try:
        first_document, first_created = _upload(
            session, storage, settings, user.id, quarry, content, KEY
        )
        second_document, second_created = _upload(
            session, storage, settings, user.id, quarry, content, KEY
        )
    finally:
        session.close()

    assert first_created is True
    assert second_created is False
    assert first_document.id == second_document.id

    document_count = db.execute(select(func.count()).select_from(Document)).scalar_one()
    assert document_count == 1
    assert _storage_object_count(storage) == 1
    assert company_used_bytes(db, company.id) == len(content)
