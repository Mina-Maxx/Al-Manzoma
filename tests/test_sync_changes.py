from __future__ import annotations

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import ValidationError
from sqlalchemy import delete, select

from app.config import Settings
from app.models import (
    ChangeEntityType,
    ChangeLog,
    ChangeType,
    CompanyStatus,
    CompanySyncState,
    Membership,
    QuarryStatus,
    UserStatus,
)
from app.security.context import AuthContext
from app.services.sync import ChangeEntry, append_changes
from app.services.sync_feed import read_changes
from app.utils.sync_cursor import decode_cursor, encode_cursor
from tests.factories import (
    make_company,
    make_membership,
    make_platform_admin,
    make_quarry,
    make_user,
    provision_user,
)

_UNSET = object()


def _entry(
    quarry,
    *,
    entity_type=ChangeEntityType.folder,
    entity_id: uuid.UUID | None = None,
    change_type=ChangeType.created,
    version: int = 1,
    payload: dict | None = None,
) -> ChangeEntry:
    if payload is None:
        payload = (
            {"name": "Plans"}
            if entity_type == ChangeEntityType.folder
            else {"display_name": "doc.pdf"}
        )
    return ChangeEntry(
        quarry_id=quarry.id,
        entity_type=entity_type,
        entity_id=entity_id or uuid.uuid4(),
        change_type=change_type,
        entity_version=version,
        payload=payload,
    )


def _append(db, company, entries):
    changes = append_changes(db, company.id, entries)
    db.commit()
    return changes


def _state(db, company) -> CompanySyncState:
    db.expire_all()
    return db.get(CompanySyncState, company.id)


def _cursor(settings, db, company, seq: int) -> str:
    state = _state(db, company)
    return encode_cursor(
        company_id=company.id,
        feed_epoch=state.feed_epoch,
        seq=seq,
        signing_key=settings.sync_cursor_key,
    )


def _decode(settings, token: str):
    return decode_cursor(token, settings.sync_cursor_key)


def _get(client, headers, *, cursor=_UNSET, limit=None):
    params = {}
    if cursor is not _UNSET:
        params["cursor"] = cursor
    if limit is not None:
        params["limit"] = limit
    return client.get("/sync/changes", headers=headers, params=params)


def test_bootstrap_requires_snapshot_and_returns_boundary_cursor(
    client, db, auth_header, settings
):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_view=True)
    _append(db, company, [_entry(quarry), _entry(quarry)])

    response = _get(client, auth_header("u1"))

    assert response.status_code == 200
    body = response.json()
    assert body["changes"] == []
    assert body["high_water"] == 2
    assert body["has_more"] is False
    assert body["resync_required"] is True
    assert body["bootstrap_required"] is True

    parsed = _decode(settings, body["next_cursor"])
    state = _state(db, company)
    assert parsed.company_id == company.id
    assert parsed.feed_epoch == state.feed_epoch
    assert parsed.seq == 2

    resume = _get(client, auth_header("u1"), cursor=body["next_cursor"])
    assert resume.status_code == 200
    resumed = resume.json()
    assert resumed["changes"] == []
    assert resumed["high_water"] == 2
    assert resumed["resync_required"] is False
    assert resumed["bootstrap_required"] is False

    _append(db, company, [_entry(quarry)])
    after = _get(client, auth_header("u1"), cursor=body["next_cursor"]).json()
    assert [change["seq"] for change in after["changes"]] == [3]


def test_default_limit_and_validation(client, db, auth_header, settings):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_view=True)
    token = _cursor(settings, db, company, 0)
    _append(db, company, [_entry(quarry) for _ in range(105)])

    default = _get(client, auth_header("u1"), cursor=token)
    assert default.status_code == 200
    body = default.json()
    assert len(body["changes"]) == 100
    assert body["high_water"] == 105
    assert body["has_more"] is True
    assert _decode(settings, body["next_cursor"]).seq == 100

    largest = _get(client, auth_header("u1"), cursor=token, limit=500)
    assert largest.status_code == 200
    assert len(largest.json()["changes"]) == 105
    assert largest.json()["has_more"] is False

    assert _get(client, auth_header("u1"), cursor=token, limit=0).status_code == 422
    assert _get(client, auth_header("u1"), cursor=token, limit=501).status_code == 422


def test_pagination_no_duplicates_or_loss_and_concurrent_appends(
    client, db, auth_header, settings
):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_view=True)
    _append(db, company, [_entry(quarry) for _ in range(3)])
    cursor = _cursor(settings, db, company, 0)

    first = _get(client, auth_header("u1"), cursor=cursor, limit=2).json()
    assert [change["seq"] for change in first["changes"]] == [1, 2]
    assert first["high_water"] == 3
    assert first["has_more"] is True

    _append(db, company, [_entry(quarry) for _ in range(2)])

    seen = [change["seq"] for change in first["changes"]]
    cursor = first["next_cursor"]
    while True:
        page = _get(client, auth_header("u1"), cursor=cursor, limit=2).json()
        seen.extend(change["seq"] for change in page["changes"])
        cursor = page["next_cursor"]
        if not page["has_more"]:
            break

    assert seen == [1, 2, 3, 4, 5]
    assert len(seen) == len(set(seen))

    empty = _get(client, auth_header("u1"), cursor=cursor, limit=2).json()
    assert empty["changes"] == []
    assert empty["high_water"] == 5
    assert empty["has_more"] is False
    assert empty["resync_required"] is False


def test_cursor_validation(client, db, auth_header, settings):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_view=True)
    _append(db, company, [_entry(quarry)])
    state = _state(db, company)
    valid = _cursor(settings, db, company, 0)
    headers = auth_header("u1")

    malformed = _get(client, headers, cursor="not-a-cursor")
    assert malformed.status_code == 400
    assert malformed.json()["code"] == "invalid_cursor"

    assert _get(client, headers, cursor="").status_code == 400
    assert _get(client, headers, cursor="v1.é.signature").status_code == 400

    unsupported = _get(client, headers, cursor="v2.abc.def")
    assert unsupported.status_code == 400
    assert "unsupported" in unsupported.json()["detail"]

    tampered = valid[:-1] + ("A" if valid[-1] != "A" else "B")
    assert _get(client, headers, cursor=tampered).status_code == 400

    other = make_company(db, name="Other Co")
    wrong_company = encode_cursor(
        company_id=other.id,
        feed_epoch=_state(db, other).feed_epoch,
        seq=0,
        signing_key=settings.sync_cursor_key,
    )
    assert _get(client, headers, cursor=wrong_company).status_code == 400

    wrong_epoch = encode_cursor(
        company_id=company.id,
        feed_epoch=uuid.uuid4(),
        seq=0,
        signing_key=settings.sync_cursor_key,
    )
    assert _get(client, headers, cursor=wrong_epoch).status_code == 400

    negative = encode_cursor(
        company_id=company.id,
        feed_epoch=state.feed_epoch,
        seq=-1,
        signing_key=settings.sync_cursor_key,
    )
    negative_response = _get(client, headers, cursor=negative)
    assert negative_response.status_code == 400
    assert negative_response.json()["code"] == "invalid_cursor"

    future = _cursor(settings, db, company, state.last_seq + 1)
    future_response = _get(client, headers, cursor=future)
    assert future_response.status_code == 400
    assert future_response.json()["code"] == "invalid_cursor"

    version, encoded_payload, signature = valid.split(".")
    payload_tamper = f"{version}.{encoded_payload}A.{signature}"
    assert _get(client, headers, cursor=payload_tamper).status_code == 400
    assert _get(client, headers, cursor="a" * 1025).status_code == 400

    at_high_water = _get(
        client, headers, cursor=_cursor(settings, db, company, state.last_seq)
    )
    assert at_high_water.status_code == 200
    assert at_high_water.json()["changes"] == []
    assert at_high_water.json()["high_water"] == state.last_seq


def test_cursor_below_min_valid_returns_410(client, db, auth_header, settings):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_view=True)
    _append(db, company, [_entry(quarry) for _ in range(5)])
    state = _state(db, company)
    state.min_valid_seq = 3
    db.add(state)
    db.commit()

    expired = _get(
        client, auth_header("u1"), cursor=_cursor(settings, db, company, 2)
    )
    assert expired.status_code == 410
    assert expired.json()["code"] == "resync_required"
    assert "resync" in expired.json()["detail"].lower()

    boundary = _get(
        client, auth_header("u1"), cursor=_cursor(settings, db, company, 3)
    )
    assert boundary.status_code == 200
    assert [change["seq"] for change in boundary.json()["changes"]] == [4, 5]
    assert boundary.json()["resync_required"] is False


def test_empty_feed(client, db, auth_header, settings):
    _, company, _, _ = provision_user(db, auth_user_id="u1", can_view=True)
    response = _get(
        client, auth_header("u1"), cursor=_cursor(settings, db, company, 0)
    )

    assert response.status_code == 200
    body = response.json()
    assert body["changes"] == []
    assert body["high_water"] == 0
    assert body["has_more"] is False
    assert body["resync_required"] is False
    assert body["bootstrap_required"] is False


def test_inaccessible_changes_are_skipped_but_advance_cursor(
    client, db, auth_header, settings
):
    _, company, visible, _ = provision_user(
        db, auth_user_id="u1", can_view=True
    )
    hidden = make_quarry(db, company, name="Hidden Pit")
    hidden_ids = [uuid.uuid4(), uuid.uuid4()]
    _append(
        db,
        company,
        [
            _entry(hidden, entity_id=hidden_ids[0], payload={"name": "Secret"}),
            _entry(visible, payload={"name": "Visible"}),
            _entry(hidden, entity_id=hidden_ids[1], payload={"name": "Secret 2"}),
        ],
    )

    first = _get(
        client,
        auth_header("u1"),
        cursor=_cursor(settings, db, company, 0),
        limit=2,
    )
    assert first.status_code == 200
    body = first.json()
    assert [change["seq"] for change in body["changes"]] == [2]
    assert body["high_water"] == 3
    assert body["has_more"] is True
    assert _decode(settings, body["next_cursor"]).seq == 2
    assert "Secret" not in first.text
    assert all(str(entity_id) not in first.text for entity_id in hidden_ids)

    second = _get(
        client, auth_header("u1"), cursor=body["next_cursor"], limit=2
    ).json()
    assert second["changes"] == []
    assert second["high_water"] == 3
    assert second["has_more"] is False
    assert _decode(settings, second["next_cursor"]).seq == 3

    _append(db, company, [_entry(visible)])
    after = _get(
        client, auth_header("u1"), cursor=second["next_cursor"], limit=2
    ).json()
    assert [change["seq"] for change in after["changes"]] == [4]


def test_page_with_only_inaccessible_events_then_visible_before_high_water(
    client, db, auth_header, settings
):
    _, company, visible, _ = provision_user(
        db, auth_user_id="u1", can_view=True
    )
    hidden = make_quarry(db, company, name="Hidden Pit")
    hidden_ids = [uuid.uuid4() for _ in range(3)]
    _append(
        db,
        company,
        [
            _entry(hidden, entity_id=hidden_id, payload={"name": "Hidden plans"})
            for hidden_id in hidden_ids
        ]
        + [_entry(visible, payload={"name": "Visible plans"})],
    )
    cursor = _cursor(settings, db, company, 0)

    first = _get(client, auth_header("u1"), cursor=cursor, limit=3)
    assert first.status_code == 200
    body = first.json()
    assert body["changes"] == []
    assert body["high_water"] == 4
    assert body["has_more"] is True
    assert _decode(settings, body["next_cursor"]).seq == 3
    assert "Hidden plans" not in first.text
    assert all(str(hidden_id) not in first.text for hidden_id in hidden_ids)

    second = _get(
        client, auth_header("u1"), cursor=body["next_cursor"], limit=3
    ).json()
    assert [change["seq"] for change in second["changes"]] == [4]
    assert second["high_water"] == 4
    assert second["has_more"] is False
    assert _decode(settings, second["next_cursor"]).seq == 4

    caught_up = _get(
        client, auth_header("u1"), cursor=second["next_cursor"], limit=3
    ).json()
    assert caught_up["changes"] == []
    assert caught_up["has_more"] is False
    assert _decode(settings, caught_up["next_cursor"]).seq == 4


def test_mixed_visibility_raw_limit_delivers_all_visible_once(
    client, db, auth_header, settings
):
    _, company, visible, _ = provision_user(
        db, auth_user_id="u1", can_view=True
    )
    hidden = make_quarry(db, company, name="Hidden Pit")
    hidden_ids = [uuid.uuid4() for _ in range(3)]
    visible_ids = [uuid.uuid4() for _ in range(3)]
    _append(
        db,
        company,
        [
            _entry(hidden, entity_id=hidden_ids[0], payload={"name": "Hidden A"}),
            _entry(visible, entity_id=visible_ids[0], payload={"name": "Visible A"}),
            _entry(hidden, entity_id=hidden_ids[1], payload={"name": "Hidden B"}),
            _entry(visible, entity_id=visible_ids[1], payload={"name": "Visible B"}),
            _entry(hidden, entity_id=hidden_ids[2], payload={"name": "Hidden C"}),
            _entry(visible, entity_id=visible_ids[2], payload={"name": "Visible C"}),
        ],
    )
    cursor = _cursor(settings, db, company, 0)
    seen: list[int] = []
    responses: list[str] = []

    for _ in range(10):
        response = _get(client, auth_header("u1"), cursor=cursor, limit=2)
        assert response.status_code == 200
        body = response.json()
        seen.extend(change["seq"] for change in body["changes"])
        responses.append(response.text)
        cursor = body["next_cursor"]
        if not body["has_more"]:
            break
    else:
        pytest.fail("pagination did not terminate")

    assert seen == [2, 4, 6]
    assert len(seen) == len(set(seen))
    combined = "".join(responses)
    assert all(str(hidden_id) not in combined for hidden_id in hidden_ids)
    assert "Hidden" not in combined
    assert _decode(settings, cursor).seq == 6


@pytest.mark.parametrize("missing_seq", [2, 3])
def test_feed_gap_returns_410(
    client, db, auth_header, settings, missing_seq
):
    _, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_view=True
    )
    _append(db, company, [_entry(quarry) for _ in range(3)])
    db.execute(
        delete(ChangeLog).where(
            ChangeLog.company_id == company.id,
            ChangeLog.seq == missing_seq,
        )
    )
    db.commit()

    response = _get(
        client,
        auth_header("u1"),
        cursor=_cursor(settings, db, company, 0),
        limit=10,
    )

    assert response.status_code == 410
    assert response.json()["code"] == "resync_required"


def test_can_upload_alone_does_not_imply_can_view(
    client, db, auth_header, settings
):
    _, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_view=False, can_upload=True
    )
    _append(db, company, [_entry(quarry)])

    response = _get(
        client, auth_header("u1"), cursor=_cursor(settings, db, company, 0)
    )
    assert response.status_code == 200
    body = response.json()
    assert body["changes"] == []
    assert body["high_water"] == 1
    assert _decode(settings, body["next_cursor"]).seq == 1


def test_permission_changes_apply_between_pages(
    client, db, auth_header, settings
):
    user, company, quarry, permission = provision_user(
        db, auth_user_id="u1", can_view=True
    )
    _append(db, company, [_entry(quarry)])

    first = _get(
        client,
        auth_header("u1"),
        cursor=_cursor(settings, db, company, 0),
        limit=1,
    ).json()
    assert [change["seq"] for change in first["changes"]] == [1]

    permission.can_view = False
    db.add(permission)
    db.commit()
    _append(db, company, [_entry(quarry)])

    revoked = _get(
        client, auth_header("u1"), cursor=first["next_cursor"], limit=1
    )
    assert revoked.status_code == 200
    assert revoked.json()["changes"] == []
    assert _decode(settings, revoked.json()["next_cursor"]).seq == 2

    permission.can_view = True
    db.add(permission)
    db.commit()
    _append(db, company, [_entry(quarry)])

    restored = _get(
        client, auth_header("u1"), cursor=revoked.json()["next_cursor"], limit=1
    ).json()
    assert [change["seq"] for change in restored["changes"]] == [3]


def test_inactive_quarry_changes_are_skipped(
    client, db, auth_header, settings
):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_view=True)
    _append(db, company, [_entry(quarry)])
    quarry.status = QuarryStatus.inactive
    db.add(quarry)
    db.commit()

    response = _get(
        client, auth_header("u1"), cursor=_cursor(settings, db, company, 0)
    )
    assert response.status_code == 200
    assert response.json()["changes"] == []
    assert _decode(settings, response.json()["next_cursor"]).seq == 1


def test_membership_company_and_user_status_are_rechecked(
    client, db, auth_header, settings
):
    user, company, _, _ = provision_user(db, auth_user_id="u1", can_view=True)
    token = _cursor(settings, db, company, 0)

    membership = db.execute(
        select(Membership).where(Membership.user_id == user.id)
    ).scalar_one()
    db.delete(membership)
    db.commit()
    assert _get(client, auth_header("u1"), cursor=token).status_code == 403

    make_membership(db, user, company)
    company.status = CompanyStatus.suspended
    db.add(company)
    db.commit()
    assert _get(client, auth_header("u1"), cursor=token).status_code == 403

    company.status = CompanyStatus.active
    db.add(company)
    user.status = UserStatus.inactive
    db.add(user)
    db.commit()
    assert _get(client, auth_header("u1"), cursor=token).status_code == 403


def test_platform_admin_without_membership_is_forbidden(client, db, auth_header):
    make_user(db, auth_user_id="pa")
    make_platform_admin(db, auth_user_id="pa")

    response = _get(client, auth_header("pa"))

    assert response.status_code == 403
    assert response.json()["detail"] == "no company membership"


def test_cross_company_changes_are_isolated(client, db, auth_header, settings):
    _, company_a, quarry_a, _ = provision_user(
        db, auth_user_id="u1", company_name="A Co", quarry_name="A Pit"
    )
    _, company_b, quarry_b, _ = provision_user(
        db, auth_user_id="u2", company_name="B Co", quarry_name="B Pit"
    )
    a_id = uuid.uuid4()
    b_id = uuid.uuid4()
    _append(db, company_a, [_entry(quarry_a, entity_id=a_id, payload={"name": "A"})])
    _append(db, company_b, [_entry(quarry_b, entity_id=b_id, payload={"name": "B"})])

    response = _get(
        client,
        auth_header("u1"),
        cursor=_cursor(settings, db, company_a, 0),
        limit=500,
    )
    assert response.status_code == 200
    body = response.json()
    assert [change["entity_id"] for change in body["changes"]] == [str(a_id)]
    assert str(b_id) not in response.text
    assert "B Co" not in response.text


def test_payload_privacy_removes_storage_references(
    client, db, auth_header, settings
):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_view=True)
    _append(
        db,
        company,
        [
            _entry(
                quarry,
                entity_type=ChangeEntityType.document,
                payload={
                    "display_name": "doc.pdf",
                    "sha256": "a" * 64,
                    "storage_ref": "drive-secret-ref",
                    "nested": {"token": "nested-secret", "safe": 1},
                },
            )
        ],
    )

    response = _get(
        client, auth_header("u1"), cursor=_cursor(settings, db, company, 0)
    )
    assert response.status_code == 200
    payload = response.json()["changes"][0]["payload"]
    assert payload == {
        "display_name": "doc.pdf",
        "sha256": "a" * 64,
        "nested": {"safe": 1},
    }
    assert "drive-secret-ref" not in response.text
    assert "nested-secret" not in response.text


def test_feed_waits_for_uncommitted_allocation_before_high_water(
    db, session_factory, settings
):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_view=True
    )
    token = _cursor(settings, db, company, 0)
    membership = db.execute(
        select(Membership).where(Membership.user_id == user.id)
    ).scalar_one()
    ctx = AuthContext(user=user, company=company, membership=membership, claims={})
    key = settings.sync_cursor_key

    writer = session_factory()
    allocated = append_changes(writer, company.id, [_entry(quarry)])
    assert allocated[0].seq == 1

    started = threading.Event()
    results: dict[str, object] = {}
    result_lock = threading.Lock()

    def reader_worker() -> None:
        reader = session_factory()
        try:
            started.set()
            page = read_changes(
                reader,
                ctx,
                cursor=token,
                limit=10,
                signing_key=key,
            )
            with result_lock:
                results["page"] = page
        except Exception as exc:  # surfaced by the assertion below
            with result_lock:
                results["error"] = f"{type(exc).__name__}:{exc}"
        finally:
            reader.close()

    writer_committed = False
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(reader_worker)
            assert started.wait(timeout=10)
            time.sleep(0.3)
            with result_lock:
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
    assert page.has_more is False

    _append(db, company, [_entry(quarry)])
    next_page = read_changes(
        db,
        ctx,
        cursor=page.next_cursor,
        limit=10,
        signing_key=key,
    )
    assert next_page.high_water == 2
    assert [change.seq for change in next_page.changes] == [2]


def test_production_requires_a_sync_cursor_signing_secret(monkeypatch):
    monkeypatch.delenv("SYNC_CURSOR_SECRET", raising=False)

    with pytest.raises(ValidationError, match="SYNC_CURSOR_SECRET"):
        Settings(_env_file=None, app_env="production")

    with pytest.raises(ValidationError, match="SYNC_CURSOR_SECRET"):
        Settings(
            _env_file=None,
            app_env="production",
            sync_cursor_secret="too-short",
        )

    configured = Settings(
        _env_file=None,
        app_env="production",
        sync_cursor_secret="s" * 40,
    )
    assert configured.sync_cursor_key == b"s" * 40

