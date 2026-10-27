from __future__ import annotations

import hashlib
import io
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from app.models import (
    ChangeEntityType,
    ChangeLog,
    ChangeType,
    Company,
    CompanySyncState,
    Document,
    DocumentStatus,
    Folder,
    IdempotencyKey,
    Membership,
    User,
)
from app.security.context import AuthContext
from app.services import document_service
from app.services import folders as folder_service
from app.services.document_service import upload_document
from app.services.reconciliation import reap_stale_attempts
from app.storage.base import StorageUnavailable
from tests.factories import make_document, make_folder, provision_user
from tests.util import pdf_bytes, upload_files


def _changes(db) -> list[ChangeLog]:
    db.expire_all()
    return list(
        db.execute(select(ChangeLog).order_by(ChangeLog.seq)).scalars().all()
    )


def _create(client, auth_header, quarry_id, *, name, parent_id=None):
    return client.post(
        f"/quarries/{quarry_id}/folders",
        headers=auth_header("u1"),
        json={"name": name, "parent_id": str(parent_id) if parent_id else None},
    )


def _upload(
    client,
    auth_header,
    quarry_id,
    *,
    content: bytes | None = None,
    key: str = "k1",
    data: dict | None = None,
):
    return client.post(
        f"/quarries/{quarry_id}/documents",
        headers={**auth_header("u1"), "Idempotency-Key": key},
        files=upload_files("report.pdf", content or pdf_bytes()),
        data=data or {},
    )


def _load_ctx(db, user_id) -> AuthContext:
    user = db.get(User, user_id)
    membership = db.execute(
        select(Membership).where(Membership.user_id == user_id)
    ).scalar_one()
    company = db.get(Company, membership.company_id)
    return AuthContext(user=user, company=company, membership=membership, claims={})


def _service_upload(db, storage, settings, user_id, quarry, content, key):
    ctx = _load_ctx(db, user_id)
    upload_file = SimpleNamespace(filename="report.pdf", file=io.BytesIO(content))
    return upload_document(
        db=db,
        storage=storage,
        settings=settings,
        ctx=ctx,
        quarry=quarry,
        upload_file=upload_file,
        idempotency_key=key,
        display_name=None,
    )


def test_folder_create_rename_delete_events_versions_and_noop(
    client, db, auth_header
):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)

    created = _create(client, auth_header, quarry.id, name="Plans")
    assert created.status_code == 201
    assert created.json()["version"] == 1
    assert created.headers["ETag"] == '"1"'
    folder_id = uuid.UUID(created.json()["id"])

    changes = _changes(db)
    assert len(changes) == 1
    assert changes[0].entity_type == ChangeEntityType.folder.value
    assert changes[0].entity_id == folder_id
    assert changes[0].change_type == ChangeType.created.value
    assert changes[0].entity_version == 1
    assert changes[0].payload == {"name": "Plans", "parent_id": None}
    assert changes[0].quarry_id == quarry.id

    renamed = client.patch(
        f"/quarries/{quarry.id}/folders/{folder_id}",
        headers=auth_header("u1"),
        json={"name": "Archive"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["version"] == 2
    assert renamed.headers["ETag"] == '"2"'

    changes = _changes(db)
    assert len(changes) == 2
    assert changes[1].change_type == ChangeType.updated.value
    assert changes[1].entity_version == 2
    assert changes[1].payload == {"name": "Archive", "parent_id": None}

    noop = client.patch(
        f"/quarries/{quarry.id}/folders/{folder_id}",
        headers=auth_header("u1"),
        json={"name": " Archive "},
    )
    assert noop.status_code == 200
    assert noop.json()["version"] == 2
    assert len(_changes(db)) == 2

    deleted = client.delete(
        f"/quarries/{quarry.id}/folders/{folder_id}", headers=auth_header("u1")
    )
    assert deleted.status_code == 204
    assert deleted.headers["ETag"] == '"3"'

    changes = _changes(db)
    assert len(changes) == 3
    assert changes[2].change_type == ChangeType.deleted.value
    assert changes[2].entity_version == 3
    assert changes[2].payload == {}
    db.expire_all()
    stored = db.get(Folder, folder_id)
    assert stored.deleted_at is not None
    assert stored.version == 3

    repeated = client.delete(
        f"/quarries/{quarry.id}/folders/{folder_id}", headers=auth_header("u1")
    )
    assert repeated.status_code == 404
    assert len(_changes(db)) == 3

    listing = client.get(
        f"/quarries/{quarry.id}/folders", headers=auth_header("u1")
    )
    assert folder_id not in {uuid.UUID(item["id"]) for item in listing.json()}


def test_deleted_folder_name_can_be_reused_and_deleted_parent_is_rejected(
    client, db, auth_header
):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    first = _create(client, auth_header, quarry.id, name="Plans").json()
    deleted = client.delete(
        f"/quarries/{quarry.id}/folders/{first['id']}", headers=auth_header("u1")
    )
    assert deleted.status_code == 204

    second = _create(client, auth_header, quarry.id, name="Plans")
    assert second.status_code == 201
    assert second.json()["id"] != first["id"]

    name_count = db.execute(
        select(func.count())
        .select_from(Folder)
        .where(Folder.quarry_id == quarry.id, Folder.name == "Plans")
    ).scalar_one()
    assert name_count == 2

    child = _create(
        client,
        auth_header,
        quarry.id,
        name="Child",
        parent_id=uuid.UUID(first["id"]),
    )
    assert child.status_code == 404


def test_folder_delete_rejects_active_children_and_documents(
    client, db, auth_header
):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    parent = make_folder(db, company, quarry, name="Parent")
    make_folder(db, company, quarry, name="Child", parent=parent)
    document = make_document(db, company, quarry, folder_id=parent.id)

    with_children = client.delete(
        f"/quarries/{quarry.id}/folders/{parent.id}", headers=auth_header("u1")
    )
    assert with_children.status_code == 409

    child = db.execute(
        select(Folder).where(Folder.parent_id == parent.id)
    ).scalar_one()
    assert (
        client.delete(
            f"/quarries/{quarry.id}/folders/{child.id}", headers=auth_header("u1")
        ).status_code
        == 204
    )

    with_document = client.delete(
        f"/quarries/{quarry.id}/folders/{parent.id}", headers=auth_header("u1")
    )
    assert with_document.status_code == 409

    document.deleted_at = datetime.now(timezone.utc)
    db.add(document)
    db.commit()

    allowed = client.delete(
        f"/quarries/{quarry.id}/folders/{parent.id}", headers=auth_header("u1")
    )
    assert allowed.status_code == 204


def test_document_move_event_version_and_noop(client, db, auth_header):
    _, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True
    )
    content = pdf_bytes()
    uploaded = _upload(client, auth_header, quarry.id, content=content)
    assert uploaded.status_code == 201
    assert uploaded.json()["version"] == 1
    document_id = uuid.UUID(uploaded.json()["id"])
    folder = make_folder(db, company, quarry, name="Plans")

    moved = client.patch(
        f"/quarries/{quarry.id}/documents/{document_id}",
        headers={**auth_header("u1"), "If-Match": '"1"'},
        json={"folder_id": str(folder.id)},
    )
    assert moved.status_code == 200
    assert moved.json()["version"] == 2
    assert moved.headers["ETag"] == '"2"'

    changes = _changes(db)
    assert [change.change_type for change in changes] == [
        ChangeType.created.value,
        ChangeType.updated.value,
    ]
    assert changes[1].entity_type == ChangeEntityType.document.value
    assert changes[1].entity_version == 2
    assert changes[1].payload == {
        "display_name": "report.pdf",
        "folder_id": str(folder.id),
        "mime_type": "application/pdf",
        "size_bytes": len(content),
        "sha256": changes[1].payload["sha256"],
    }
    assert "storage_ref" not in changes[1].payload

    noop = client.patch(
        f"/quarries/{quarry.id}/documents/{document_id}",
        headers=auth_header("u1"),
        json={"folder_id": str(folder.id)},
    )
    assert noop.status_code == 200
    assert noop.json()["version"] == 2
    assert len(_changes(db)) == 2

    to_root = client.patch(
        f"/quarries/{quarry.id}/documents/{document_id}",
        headers={**auth_header("u1"), "If-Match": '"2"'},
        json={},
    )
    assert to_root.status_code == 200
    assert to_root.json()["version"] == 3
    assert to_root.json()["folder_id"] is None
    assert len(_changes(db)) == 3


@pytest.mark.parametrize(
    "status, deleted",
    [
        (DocumentStatus.pending, False),
        (DocumentStatus.failed, False),
        (DocumentStatus.available, True),
    ],
)
def test_non_movable_documents_emit_no_event(
    client, db, auth_header, status, deleted
):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    document = make_document(
        db,
        company,
        quarry,
        status=status,
        deleted_at=datetime.now(timezone.utc) if deleted else None,
    )

    response = client.patch(
        f"/quarries/{quarry.id}/documents/{document.id}",
        headers=auth_header("u1"),
        json={},
    )

    assert response.status_code == 404
    assert _changes(db) == []


def test_upload_finalization_emits_exactly_one_creation_event(
    client, db, auth_header
):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    content = pdf_bytes(256)

    created = _upload(client, auth_header, quarry.id, content=content)
    assert created.status_code == 201
    assert created.json()["version"] == 1

    changes = _changes(db)
    assert len(changes) == 1
    assert changes[0].change_type == ChangeType.created.value
    assert changes[0].entity_version == 1
    assert changes[0].payload == {
        "display_name": "report.pdf",
        "folder_id": None,
        "mime_type": "application/pdf",
        "size_bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
    }
    assert set(changes[0].payload) == {
        "display_name",
        "folder_id",
        "mime_type",
        "size_bytes",
        "sha256",
    }

    retried = _upload(client, auth_header, quarry.id, content=content)
    assert retried.status_code == 200
    assert retried.json()["id"] == created.json()["id"]
    assert len(_changes(db)) == 1

    state = db.get(CompanySyncState, changes[0].company_id)
    assert state.last_seq == 1


def test_storage_failure_and_stale_reaping_do_not_emit_events(
    client, db, storage, auth_header, monkeypatch
):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True
    )

    def unavailable(*args, **kwargs):
        raise StorageUnavailable("nope")

    monkeypatch.setattr(storage, "put", unavailable)
    failed = _upload(client, auth_header, quarry.id, content=pdf_bytes(128))
    assert failed.status_code == 502
    assert _changes(db) == []

    monkeypatch.setattr(storage, "put", lambda *args, **kwargs: "unused")
    pending = make_document(
        db,
        company,
        quarry,
        status=DocumentStatus.pending,
        storage_ref=None,
    )
    key = IdempotencyKey(
        company_id=company.id,
        user_id=user.id,
        quarry_id=quarry.id,
        key="stale-event",
        content_sha256="a" * 64,
        document_id=pending.id,
        lease_expires_at=datetime.now(timezone.utc) - timedelta(seconds=60),
    )
    db.add(key)
    db.commit()

    assert reap_stale_attempts(db)["reaped"] == 1
    assert _changes(db) == []


def test_finalize_failure_rolls_back_event_and_retry_appends_once(
    db, storage, settings, monkeypatch
):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True
    )
    content = pdf_bytes(256)
    original_append = document_service.append_changes
    calls = {"n": 0}

    def flaky_append(*args, **kwargs):
        calls["n"] += 1
        result = original_append(*args, **kwargs)
        if calls["n"] == 1:
            raise RuntimeError("simulated finalize failure")
        return result

    monkeypatch.setattr(document_service, "append_changes", flaky_append)

    with pytest.raises(RuntimeError):
        _service_upload(db, storage, settings, user.id, quarry, content, "retry-event")

    assert _changes(db) == []
    assert db.get(CompanySyncState, company.id).last_seq == 0
    pending = db.execute(select(Document)).scalar_one()
    assert pending.status == DocumentStatus.pending

    monkeypatch.setattr(document_service, "append_changes", original_append)
    document, created = _service_upload(
        db, storage, settings, user.id, quarry, content, "retry-event"
    )

    assert created is True
    assert document.status == DocumentStatus.available
    changes = _changes(db)
    assert len(changes) == 1
    assert changes[0].seq == 1
    assert changes[0].change_type == ChangeType.created.value
    assert db.get(CompanySyncState, company.id).last_seq == 1


def test_business_rollback_rolls_back_event_and_sequence(
    db, monkeypatch
):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    original_append = folder_service.append_changes

    def append_then_fail(*args, **kwargs):
        original_append(*args, **kwargs)
        raise RuntimeError("simulated transaction failure")

    monkeypatch.setattr(folder_service, "append_changes", append_then_fail)

    with pytest.raises(RuntimeError):
        folder_service.create_folder(db, company.id, quarry.id, name="Plans")

    db.rollback()
    assert db.execute(select(func.count()).select_from(Folder)).scalar_one() == 0
    assert _changes(db) == []
    assert db.get(CompanySyncState, company.id).last_seq == 0

    monkeypatch.setattr(folder_service, "append_changes", original_append)
    folder = folder_service.create_folder(db, company.id, quarry.id, name="Plans")
    assert folder.version == 1
    changes = _changes(db)
    assert len(changes) == 1
    assert changes[0].seq == 1


def test_if_match_accepts_matching_version_and_rejects_stale_or_malformed(
    client, db, auth_header
):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    folder = make_folder(db, company, quarry, name="Plans")

    stale = client.patch(
        f"/quarries/{quarry.id}/folders/{folder.id}",
        headers={**auth_header("u1"), "If-Match": '"9"'},
        json={"name": "Nope"},
    )
    assert stale.status_code == 412
    db.expire_all()
    assert db.get(Folder, folder.id).name == "Plans"
    assert db.get(Folder, folder.id).version == 1
    assert _changes(db) == []

    malformed = client.patch(
        f"/quarries/{quarry.id}/folders/{folder.id}",
        headers={**auth_header("u1"), "If-Match": "not-a-version"},
        json={"name": "Nope"},
    )
    assert malformed.status_code == 400

    renamed = client.patch(
        f"/quarries/{quarry.id}/folders/{folder.id}",
        headers={**auth_header("u1"), "If-Match": '"1"'},
        json={"name": "Archive"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["version"] == 2
    assert renamed.headers["ETag"] == '"2"'

    stale_delete = client.delete(
        f"/quarries/{quarry.id}/folders/{folder.id}",
        headers={**auth_header("u1"), "If-Match": '"1"'},
    )
    assert stale_delete.status_code == 412

    deleted = client.delete(
        f"/quarries/{quarry.id}/folders/{folder.id}",
        headers={**auth_header("u1"), "If-Match": '"2"'},
    )
    assert deleted.status_code == 204


def test_if_match_document_move_and_malformed_header(client, db, auth_header):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    document = make_document(db, company, quarry)
    folder = make_folder(db, company, quarry, name="Plans")

    malformed = client.patch(
        f"/quarries/{quarry.id}/documents/{document.id}",
        headers={**auth_header("u1"), "If-Match": "one"},
        json={"folder_id": str(folder.id)},
    )
    assert malformed.status_code == 400

    stale = client.patch(
        f"/quarries/{quarry.id}/documents/{document.id}",
        headers={**auth_header("u1"), "If-Match": '"2"'},
        json={"folder_id": str(folder.id)},
    )
    assert stale.status_code == 412
    db.expire_all()
    assert db.get(Document, document.id).folder_id is None
    assert db.get(Document, document.id).version == 1

    moved = client.patch(
        f"/quarries/{quarry.id}/documents/{document.id}",
        headers={**auth_header("u1"), "If-Match": '"1"'},
        json={"folder_id": str(folder.id)},
    )
    assert moved.status_code == 200
    assert moved.json()["version"] == 2
    assert moved.headers["ETag"] == '"2"'


def test_deleted_folders_and_documents_are_filtered_and_not_downloadable(
    client, db, storage, auth_header, monkeypatch
):
    _, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_view=True, can_upload=True, can_download=True
    )
    active_folder = make_folder(db, company, quarry, name="Active")
    deleted_folder = make_folder(
        db,
        company,
        quarry,
        name="Deleted",
        deleted_at=datetime.now(timezone.utc),
    )
    active_document = make_document(db, company, quarry, folder_id=active_folder.id)
    deleted_document = make_document(
        db,
        company,
        quarry,
        deleted_at=datetime.now(timezone.utc),
    )

    folders = client.get(
        f"/quarries/{quarry.id}/folders", headers=auth_header("u1")
    )
    assert {item["id"] for item in folders.json()} == {str(active_folder.id)}

    documents = client.get(
        f"/quarries/{quarry.id}/documents", headers=auth_header("u1")
    )
    assert {item["id"] for item in documents.json()} == {str(active_document.id)}

    root = client.get(
        f"/quarries/{quarry.id}/documents?root_only=true", headers=auth_header("u1")
    )
    assert root.json() == []

    filtered = client.get(
        f"/quarries/{quarry.id}/documents?folder_id={deleted_folder.id}",
        headers=auth_header("u1"),
    )
    assert filtered.status_code == 404

    upload = _upload(
        client,
        auth_header,
        quarry.id,
        data={"folder_id": str(deleted_folder.id)},
    )
    assert upload.status_code == 404

    def must_not_open(ref):
        raise AssertionError("download must fail before opening storage")

    monkeypatch.setattr(storage, "open", must_not_open)
    download = client.get(
        f"/documents/{deleted_document.id}/download", headers=auth_header("u1")
    )
    assert download.status_code == 404

    move = client.patch(
        f"/quarries/{quarry.id}/documents/{active_document.id}",
        headers=auth_header("u1"),
        json={"folder_id": str(deleted_folder.id)},
    )
    assert move.status_code == 404
    db.expire_all()
    assert db.get(Document, active_document.id).folder_id == active_folder.id

    listing = client.get(
        f"/quarries/{quarry.id}/documents?folder_id={active_folder.id}",
        headers=auth_header("u1"),
    )
    assert {item["id"] for item in listing.json()} == {str(active_document.id)}
