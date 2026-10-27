from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import func, select

from app.models import (
    ChangeEntityType,
    ChangeLog,
    ChangeType,
    CompanySyncState,
)
from app.services.errors import NotFound
from app.services.sync import ChangeEntry, append_changes
from tests.factories import (
    make_company,
    make_quarry,
    make_sync_state,
)


def _entry(quarry, **overrides) -> ChangeEntry:
    values = {
        "quarry_id": quarry.id,
        "entity_type": ChangeEntityType.folder,
        "entity_id": uuid.uuid4(),
        "change_type": ChangeType.created,
        "entity_version": 1,
        "payload": {"name": "Plans"},
    }
    values.update(overrides)
    return ChangeEntry(**values)


def _count_logs(db) -> int:
    return db.execute(select(func.count()).select_from(ChangeLog)).scalar_one()


def test_first_allocation_starts_at_one(db):
    company = make_company(db)
    quarry = make_quarry(db, company)
    make_sync_state(db, company)
    entry = _entry(quarry)

    changes = append_changes(db, company.id, [entry])

    assert [change.seq for change in changes] == [1]
    assert changes[0].company_id == company.id
    assert changes[0].quarry_id == quarry.id
    assert changes[0].entity_id == entry.entity_id
    assert changes[0].entity_type == "folder"
    assert changes[0].change_type == "created"
    assert changes[0].entity_version == 1
    assert changes[0].payload == {"name": "Plans"}
    db.commit()

    state = db.get(CompanySyncState, company.id)
    assert state.last_seq == 1
    assert state.min_valid_seq == 0
    assert _count_logs(db) == 1


def test_multi_entry_batch_gets_consecutive_sequences_in_order(db):
    company = make_company(db)
    quarry = make_quarry(db, company)
    make_sync_state(db, company)
    entity_ids = [uuid.uuid4() for _ in range(3)]
    entries = [
        _entry(quarry, entity_id=entity_ids[0], entity_type=ChangeEntityType.folder),
        _entry(quarry, entity_id=entity_ids[1], entity_type=ChangeEntityType.document),
        _entry(
            quarry,
            entity_id=entity_ids[2],
            entity_type=ChangeEntityType.document,
            change_type=ChangeType.updated,
            entity_version=2,
        ),
    ]

    changes = append_changes(db, company.id, entries)

    assert [change.seq for change in changes] == [1, 2, 3]
    assert [change.entity_id for change in changes] == entity_ids
    db.commit()

    stored = db.execute(select(ChangeLog).order_by(ChangeLog.seq)).scalars().all()
    assert [change.seq for change in stored] == [1, 2, 3]
    assert db.get(CompanySyncState, company.id).last_seq == 3


def test_rollback_leaves_no_rows_or_advanced_cursor_and_reuses_sequence(db):
    company = make_company(db)
    quarry = make_quarry(db, company)
    make_sync_state(db, company)

    changes = append_changes(db, company.id, [_entry(quarry)])
    assert [change.seq for change in changes] == [1]

    db.rollback()

    state = db.get(CompanySyncState, company.id)
    assert state.last_seq == 0
    assert _count_logs(db) == 0

    changes = append_changes(db, company.id, [_entry(quarry)])
    assert [change.seq for change in changes] == [1]
    db.commit()

    assert db.get(CompanySyncState, company.id).last_seq == 1
    assert _count_logs(db) == 1


def test_helper_does_not_commit_callers_transaction(db, session_factory):
    company = make_company(db)
    quarry = make_quarry(db, company)
    make_sync_state(db, company)

    writer = session_factory()
    observer = session_factory()
    try:
        changes = append_changes(writer, company.id, [_entry(quarry)])
        assert [change.seq for change in changes] == [1]

        assert observer.execute(
            select(func.count()).select_from(ChangeLog)
        ).scalar_one() == 0

        writer.rollback()

        assert observer.execute(
            select(func.count()).select_from(ChangeLog)
        ).scalar_one() == 0
        state = observer.execute(
            select(CompanySyncState).where(
                CompanySyncState.company_id == company.id
            )
        ).scalar_one()
        assert state.last_seq == 0
    finally:
        writer.rollback()
        observer.rollback()
        writer.close()
        observer.close()


def test_concurrent_allocations_are_unique_and_consecutive(db, session_factory):
    company = make_company(db)
    quarry = make_quarry(db, company)
    make_sync_state(db, company)
    barrier = threading.Barrier(2)
    results: list[object] = []
    lock = threading.Lock()

    def worker() -> None:
        session = session_factory()
        try:
            barrier.wait(timeout=30)
            changes = append_changes(session, company.id, [_entry(quarry)])
            seq = changes[0].seq
            time.sleep(0.05)
            session.commit()
            with lock:
                results.append(seq)
        except Exception as exc:  # surfaced by the assertion below
            session.rollback()
            with lock:
                results.append(f"error:{type(exc).__name__}:{exc}")
        finally:
            session.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(worker) for _ in range(2)]
        for future in futures:
            future.result(timeout=30)

    assert [result for result in results if isinstance(result, str)] == []
    assert sorted(results) == [1, 2]

    db.expire_all()
    assert db.get(CompanySyncState, company.id).last_seq == 2
    assert _count_logs(db) == 2
    stored_seqs = db.execute(
        select(ChangeLog.seq).order_by(ChangeLog.seq)
    ).scalars().all()
    assert stored_seqs == [1, 2]


def test_state_lock_blocks_second_allocation_until_commit(db, session_factory):
    company = make_company(db)
    quarry = make_quarry(db, company)
    make_sync_state(db, company)
    first_allocated = threading.Event()
    second_started = threading.Event()
    release_first = threading.Event()
    results: dict[str, object] = {}
    result_lock = threading.Lock()

    def first_worker() -> None:
        session = session_factory()
        try:
            changes = append_changes(session, company.id, [_entry(quarry)])
            with result_lock:
                results["first"] = changes[0].seq
            first_allocated.set()
            if release_first.wait(timeout=10):
                session.commit()
            else:
                with result_lock:
                    results["first"] = "timeout"
        finally:
            session.rollback()
            session.close()

    def second_worker() -> None:
        session = session_factory()
        try:
            first_allocated.wait(timeout=10)
            second_started.set()
            changes = append_changes(session, company.id, [_entry(quarry)])
            with result_lock:
                results["second"] = changes[0].seq
            session.commit()
        except Exception as exc:  # surfaced by the assertion below
            session.rollback()
            with result_lock:
                results["second"] = f"error:{type(exc).__name__}:{exc}"
        finally:
            session.close()

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first_future = pool.submit(first_worker)
            assert first_allocated.wait(timeout=10)
            second_future = pool.submit(second_worker)
            assert second_started.wait(timeout=10)
            time.sleep(0.3)
            blocked = "second" not in results
            release_first.set()
            first_future.result(timeout=30)
            second_future.result(timeout=30)
    finally:
        release_first.set()

    assert blocked
    assert results == {"first": 1, "second": 2}


def test_companies_allocate_independently(db):
    company_a = make_company(db, name="Company A")
    quarry_a = make_quarry(db, company_a, name="Pit A")
    state_a = make_sync_state(db, company_a)
    company_b = make_company(db, name="Company B")
    quarry_b = make_quarry(db, company_b, name="Pit B")
    state_b = make_sync_state(db, company_b)

    changes_a = append_changes(
        db,
        company_a.id,
        [_entry(quarry_a), _entry(quarry_a)],
    )
    changes_b = append_changes(db, company_b.id, [_entry(quarry_b)])
    db.commit()

    assert [change.seq for change in changes_a] == [1, 2]
    assert [change.seq for change in changes_b] == [1]
    db.expire_all()
    assert db.get(CompanySyncState, state_a.company_id).last_seq == 2
    assert db.get(CompanySyncState, state_b.company_id).last_seq == 1


def test_missing_state_raises_documented_error(db):
    company = make_company(db, with_sync_state=False)
    quarry = make_quarry(db, company)

    with pytest.raises(NotFound, match="company sync state not found"):
        append_changes(db, company.id, [_entry(quarry)])

    assert _count_logs(db) == 0


@pytest.mark.parametrize(
    "overrides",
    [
        {"entity_type": "workspace"},
        {"change_type": "archived"},
        {"entity_version": 0},
        {"entity_version": -1},
        {"entity_version": True},
        {"payload": []},
    ],
)
def test_invalid_entry_values_are_rejected(db, overrides):
    company = make_company(db)
    quarry = make_quarry(db, company)
    make_sync_state(db, company)

    with pytest.raises(ValueError):
        append_changes(db, company.id, [_entry(quarry, **overrides)])

    db.rollback()
    assert db.get(CompanySyncState, company.id).last_seq == 0
    assert _count_logs(db) == 0


def test_empty_batch_and_malformed_mapping_are_rejected(db):
    company = make_company(db)
    quarry = make_quarry(db, company)
    make_sync_state(db, company)

    with pytest.raises(ValueError, match="at least one"):
        append_changes(db, company.id, [])
    with pytest.raises(ValueError, match="invalid change entry"):
        append_changes(db, company.id, [{"entity_type": "folder"}])

    db.rollback()
    assert db.get(CompanySyncState, company.id).last_seq == 0
    assert _count_logs(db) == 0
