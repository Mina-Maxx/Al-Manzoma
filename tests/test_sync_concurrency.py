from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import select, text

from app.models import (
    ChangeEntityType,
    ChangeLog,
    ChangeType,
    Company,
    CompanySyncState,
    Membership,
    User,
)
from app.security.context import AuthContext
from app.services import sync_feed
from app.services.quota import reserve_document
from app.services.sync import ChangeEntry, append_changes
from app.services.sync_feed import read_changes
from app.utils.sync_cursor import decode_cursor, encode_cursor
from tests.factories import make_folder, make_quarry, provision_user


def _entry(quarry_id: uuid.UUID) -> ChangeEntry:
    return ChangeEntry(
        quarry_id=quarry_id,
        entity_type=ChangeEntityType.folder,
        entity_id=uuid.uuid4(),
        change_type=ChangeType.created,
        entity_version=1,
        payload={"name": "Plans"},
    )


def _context(db, user_id) -> AuthContext:
    membership = db.execute(
        select(Membership).where(Membership.user_id == user_id)
    ).scalar_one()
    user = db.get(User, user_id)
    company = db.get(Company, membership.company_id)
    return AuthContext(user=user, company=company, membership=membership, claims={})


def _cursor(db, settings, company, seq: int) -> str:
    state = db.get(CompanySyncState, company.id, populate_existing=True)
    return encode_cursor(
        company_id=company.id,
        feed_epoch=state.feed_epoch,
        seq=seq,
        signing_key=settings.sync_cursor_key,
    )


def _state_seq(db, company_id) -> int:
    state = db.get(CompanySyncState, company_id, populate_existing=True)
    return state.last_seq


def _log_seqs(db) -> list[int]:
    db.expire_all()
    return list(
        db.execute(select(ChangeLog.seq).order_by(ChangeLog.seq.asc())).scalars()
    )


def test_concurrent_allocations_across_independent_connections(
    db, session_factory
):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1")
    workers = 4
    per_worker = 2
    barrier = threading.Barrier(workers)
    quarry_id = quarry.id
    company_id = company.id

    def worker() -> list[int]:
        session = session_factory()
        try:
            barrier.wait(timeout=20)
            changes = append_changes(
                session,
                company_id,
                [_entry(quarry_id) for _ in range(per_worker)],
            )
            seqs = [change.seq for change in changes]
            time.sleep(0.02)
            session.commit()
            return seqs
        finally:
            session.close()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(worker) for _ in range(workers)]
        allocated = [seq for future in futures for seq in future.result(timeout=30)]

    assert sorted(allocated) == list(range(1, workers * per_worker + 1))
    assert len(set(allocated)) == len(allocated)
    assert _state_seq(db, company.id) == workers * per_worker
    assert _log_seqs(db) == list(range(1, workers * per_worker + 1))


def test_reader_waits_for_allocation_then_commit_before_high_water(
    db, session_factory, settings
):
    user, company, quarry, _ = provision_user(db, auth_user_id="u1")
    ctx = _context(db, user.id)
    token = _cursor(db, settings, company, 0)
    key = settings.sync_cursor_key

    writer = session_factory()
    allocated = append_changes(writer, company.id, [_entry(quarry.id)])
    assert allocated[0].seq == 1

    started = threading.Event()
    results: dict[str, object] = {}
    lock = threading.Lock()

    def reader_worker() -> None:
        session = session_factory()
        try:
            started.set()
            page = read_changes(session, ctx, cursor=token, limit=10, signing_key=key)
            with lock:
                results["page"] = page
        except Exception as exc:
            with lock:
                results["error"] = f"{type(exc).__name__}:{exc}"
        finally:
            session.close()

    writer_committed = False
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(reader_worker)
            assert started.wait(timeout=10)
            time.sleep(0.3)
            with lock:
                assert "page" not in results and "error" not in results
            writer.commit()
            writer_committed = True
            future.result(timeout=20)
    finally:
        if not writer_committed:
            writer.rollback()
        writer.close()

    assert "error" not in results
    page = results["page"]
    assert page.high_water == 1
    assert [change.seq for change in page.changes] == [1]
    assert decode_cursor(page.next_cursor, key).seq == 1


def test_rollback_after_allocation_releases_reader_and_reuses_sequence(
    db, session_factory, settings
):
    user, company, quarry, _ = provision_user(db, auth_user_id="u1")
    ctx = _context(db, user.id)
    token = _cursor(db, settings, company, 0)
    key = settings.sync_cursor_key

    writer = session_factory()
    allocated = append_changes(writer, company.id, [_entry(quarry.id)])
    assert allocated[0].seq == 1

    started = threading.Event()
    results: dict[str, object] = {}
    lock = threading.Lock()

    def reader_worker() -> None:
        session = session_factory()
        try:
            started.set()
            page = read_changes(session, ctx, cursor=token, limit=10, signing_key=key)
            with lock:
                results["page"] = page
        except Exception as exc:
            with lock:
                results["error"] = f"{type(exc).__name__}:{exc}"
        finally:
            session.close()

    writer_rolled_back = False
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(reader_worker)
            assert started.wait(timeout=10)
            time.sleep(0.3)
            with lock:
                assert "page" not in results and "error" not in results
            writer.rollback()
            writer_rolled_back = True
            future.result(timeout=20)
    finally:
        if not writer_rolled_back:
            writer.rollback()
        writer.close()

    assert "error" not in results
    page = results["page"]
    assert page.high_water == 0
    assert page.changes == []
    assert decode_cursor(page.next_cursor, key).seq == 0
    assert _state_seq(db, company.id) == 0

    replacement = session_factory()
    try:
        reallocated = append_changes(replacement, company.id, [_entry(quarry.id)])
        assert reallocated[0].seq == 1
        replacement.commit()
    finally:
        replacement.close()

    after = session_factory()
    try:
        next_page = read_changes(
            after,
            ctx,
            cursor=page.next_cursor,
            limit=10,
            signing_key=key,
        )
    finally:
        after.close()

    assert next_page.high_water == 1
    assert [change.seq for change in next_page.changes] == [1]


def test_feed_share_lock_blocks_writer_until_page_is_read(
    db, session_factory, settings, monkeypatch
):
    user, company, quarry, _ = provision_user(db, auth_user_id="u1")
    ctx = _context(db, user.id)
    token = _cursor(db, settings, company, 0)
    key = settings.sync_cursor_key
    seed = session_factory()
    try:
        append_changes(seed, company.id, [_entry(quarry.id)])
        seed.commit()
    finally:
        seed.close()

    original_visible = sync_feed._visible_quarry_ids
    reader_holds_lock = threading.Event()
    release_reader = threading.Event()

    def blocking_visible(db_session, auth_ctx):
        reader_holds_lock.set()
        if not release_reader.wait(timeout=20):
            raise RuntimeError("timed out waiting to release the feed reader")
        return original_visible(db_session, auth_ctx)

    monkeypatch.setattr(sync_feed, "_visible_quarry_ids", blocking_visible)

    results: dict[str, object] = {}
    result_lock = threading.Lock()

    def reader_worker() -> None:
        session = session_factory()
        try:
            page = read_changes(session, ctx, cursor=token, limit=10, signing_key=key)
            with result_lock:
                results["page"] = page
        except Exception as exc:
            with result_lock:
                results["error"] = f"{type(exc).__name__}:{exc}"
        finally:
            session.close()

    def writer_worker() -> None:
        session = session_factory()
        try:
            changes = append_changes(session, company.id, [_entry(quarry.id)])
            with result_lock:
                results["writer_seq"] = changes[0].seq
            session.commit()
            with result_lock:
                results["writer_committed"] = True
        except Exception as exc:
            session.rollback()
            with result_lock:
                results["writer_error"] = f"{type(exc).__name__}:{exc}"
        finally:
            session.close()

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            reader_future = pool.submit(reader_worker)
            assert reader_holds_lock.wait(timeout=10)
            writer_future = pool.submit(writer_worker)
            time.sleep(0.3)
            with result_lock:
                assert "writer_committed" not in results
            release_reader.set()
            reader_future.result(timeout=20)
            writer_future.result(timeout=20)
    finally:
        release_reader.set()

    assert "error" not in results
    assert "writer_error" not in results
    page = results["page"]
    assert page.high_water == 1
    assert [change.seq for change in page.changes] == [1]
    assert results["writer_seq"] == 2
    assert results["writer_committed"] is True

    next_session = session_factory()
    try:
        next_page = read_changes(
            next_session,
            ctx,
            cursor=page.next_cursor,
            limit=10,
            signing_key=key,
        )
    finally:
        next_session.close()
    assert next_page.high_water == 2
    assert [change.seq for change in next_page.changes] == [2]


def test_concurrent_writes_while_paging_across_high_water(
    db, session_factory, settings
):
    user, company, quarry, _ = provision_user(db, auth_user_id="u1")
    ctx = _context(db, user.id)
    key = settings.sync_cursor_key
    seed = session_factory()
    try:
        append_changes(
            seed,
            company.id,
            [_entry(quarry.id), _entry(quarry.id)],
        )
        seed.commit()
    finally:
        seed.close()

    token = _cursor(db, settings, company, 0)
    first_session = session_factory()
    try:
        first = read_changes(first_session, ctx, cursor=token, limit=1, signing_key=key)
    finally:
        first_session.close()
    assert first.high_water == 2
    assert [change.seq for change in first.changes] == [1]
    seen = [1]
    cursor = first.next_cursor

    writer_done = threading.Event()
    writer_errors: list[str] = []

    def writer_worker() -> None:
        session = session_factory()
        try:
            for _ in range(8):
                append_changes(session, company.id, [_entry(quarry.id)])
                session.commit()
                time.sleep(0.01)
        except Exception as exc:
            session.rollback()
            writer_errors.append(f"{type(exc).__name__}:{exc}")
        finally:
            session.close()
            writer_done.set()

    page_session = session_factory()
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            writer_future = pool.submit(writer_worker)
            deadline = time.monotonic() + 20
            final_last = None
            while time.monotonic() < deadline:
                page = read_changes(
                    page_session,
                    ctx,
                    cursor=cursor,
                    limit=2,
                    signing_key=key,
                )
                seen.extend(change.seq for change in page.changes)
                cursor = page.next_cursor
                if writer_done.is_set() and not page.has_more:
                    final_last = _state_seq(db, company.id)
                    if decode_cursor(cursor, key).seq == final_last:
                        break
                time.sleep(0.01)
            writer_future.result(timeout=30)
    finally:
        page_session.close()

    assert writer_errors == []
    assert final_last is not None
    assert final_last == 10
    assert seen == list(range(1, 11))
    assert len(seen) == len(set(seen))
    assert _log_seqs(db) == list(range(1, 11))


def test_quota_folder_and_feed_locks_do_not_deadlock(db, session_factory):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    folder = make_folder(db, company, quarry, name="Plans")
    company_id = company.id
    quarry_id = quarry.id
    folder_id = folder.id

    folder_locked = threading.Event()
    state_locked = threading.Event()
    start_folder_append = threading.Event()
    start_state_append = threading.Event()
    results: dict[str, str] = {}
    result_lock = threading.Lock()

    def record(name: str, value: str) -> None:
        with result_lock:
            results[name] = value

    def folder_worker() -> None:
        session = session_factory()
        try:
            session.execute(text("SET lock_timeout = '8s'"))
            session.execute(
                text("SELECT id FROM folders WHERE id = :id FOR UPDATE"),
                {"id": folder_id},
            )
            folder_locked.set()
            assert start_folder_append.wait(timeout=10)
            append_changes(session, company_id, [_entry(quarry_id)])
            session.commit()
            record("folder", "committed")
        except Exception as exc:
            session.rollback()
            record("folder", f"{type(exc).__name__}:{exc}")
        finally:
            session.close()

    def quota_worker() -> None:
        session = session_factory()
        try:
            session.execute(text("SET lock_timeout = '8s'"))
            reserve_document(
                session,
                company_id,
                quarry_id=quarry_id,
                display_name="pending.pdf",
                original_filename="pending.pdf",
                mime_type="application/pdf",
                size_bytes=10,
                sha256="a" * 64,
                uploaded_by=None,
                folder_id=folder_id,
            )
            session.commit()
            record("quota", "committed")
        except Exception as exc:
            session.rollback()
            record("quota", f"{type(exc).__name__}:{exc}")
        finally:
            session.close()

    def state_worker() -> None:
        session = session_factory()
        try:
            session.execute(text("SET lock_timeout = '8s'"))
            session.execute(
                text(
                    "SELECT company_id FROM company_sync_state "
                    "WHERE company_id = :id FOR UPDATE"
                ),
                {"id": company_id},
            )
            state_locked.set()
            assert start_state_append.wait(timeout=10)
            append_changes(session, company_id, [_entry(quarry_id)])
            session.commit()
            record("state", "committed")
        except Exception as exc:
            session.rollback()
            record("state", f"{type(exc).__name__}:{exc}")
        finally:
            session.close()

    with ThreadPoolExecutor(max_workers=3) as pool:
        folder_future = pool.submit(folder_worker)
        assert folder_locked.wait(timeout=10)
        quota_future = pool.submit(quota_worker)
        time.sleep(0.4)
        state_future = pool.submit(state_worker)
        assert state_locked.wait(timeout=10)
        start_folder_append.set()
        time.sleep(0.4)
        start_state_append.set()
        folder_future.result(timeout=20)
        quota_future.result(timeout=20)
        state_future.result(timeout=20)

    assert results == {
        "folder": "committed",
        "quota": "committed",
        "state": "committed",
    }
    assert _state_seq(db, company.id) == 2
    assert _log_seqs(db) == [1, 2]
