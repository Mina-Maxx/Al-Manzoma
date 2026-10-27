from __future__ import annotations

import io
import threading
from types import SimpleNamespace

from sqlalchemy import func, select

from app.models import Document, DocumentStatus, Membership
from app.security.context import AuthContext
from app.services.document_service import upload_document
from app.services.errors import QuotaExceeded
from app.services.quota import company_used_bytes
from tests.factories import provision_user
from tests.util import pdf_bytes

SIZE = 100_000
QUOTA = 250_000  # exactly two files fit


def _load_ctx(session, user_id, quarry):
    from app.models import Company, User

    user = session.get(User, user_id)
    membership = session.execute(
        select(Membership).where(Membership.user_id == user_id)
    ).scalar_one()
    company = session.get(Company, membership.company_id)
    return AuthContext(user=user, company=company, membership=membership, claims={})


def test_concurrent_uploads_never_exceed_quota(
    db, session_factory, storage, settings, auth_header
):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, quota_bytes=QUOTA
    )
    threads_count = 6
    barrier = threading.Barrier(threads_count)
    results: list[str] = []
    lock = threading.Lock()

    def worker(index: int):
        session = session_factory()
        try:
            ctx = _load_ctx(session, user.id, quarry)
            upload_file = SimpleNamespace(
                filename=f"f{index}.pdf", file=io.BytesIO(pdf_bytes(SIZE))
            )
            barrier.wait(timeout=30)
            upload_document(
                db=session,
                storage=storage,
                settings=settings,
                ctx=ctx,
                quarry=quarry,
                upload_file=upload_file,
                idempotency_key=f"key-{index}",
                display_name=None,
            )
            with lock:
                results.append("ok")
        except QuotaExceeded:
            with lock:
                results.append("quota")
        except Exception as exc:  # pragma: no cover - surfaced in assertion
            with lock:
                results.append(f"error:{type(exc).__name__}:{exc}")
        finally:
            session.close()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(threads_count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert [r for r in results if r.startswith("error")] == []
    assert results.count("ok") == 2
    assert results.count("quota") == 4

    used = company_used_bytes(db, company.id)
    assert used == 2 * SIZE
    assert used <= QUOTA

    available = db.execute(
        select(func.count())
        .select_from(Document)
        .where(
            Document.company_id == company.id,
            Document.status == DocumentStatus.available,
        )
    ).scalar_one()
    assert available == 2
