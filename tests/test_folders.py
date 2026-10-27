from __future__ import annotations

import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import func, select

from app.models import (
    AuditEvent,
    CompanyStatus,
    Document,
    DocumentStatus,
    Folder,
    QuarryStatus,
)
from app.services import folders as folder_service
from app.services.errors import Conflict
from app.services.quota import company_used_bytes
from tests.factories import (
    make_company,
    make_document,
    make_folder,
    make_permission,
    make_platform_admin,
    make_quarry,
    provision_user,
)
from tests.util import pdf_bytes, upload_files


def _create(client, auth_header, quarry_id, *, name, parent_id=None, sub="u1"):
    return client.post(
        f"/quarries/{quarry_id}/folders",
        headers=auth_header(sub),
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
    sub: str = "u1",
):
    return client.post(
        f"/quarries/{quarry_id}/documents",
        headers={**auth_header(sub), "Idempotency-Key": key},
        files=upload_files("report.pdf", content or pdf_bytes()),
        data=data or {},
    )


# --- Folder behaviour -------------------------------------------------------


def test_create_root_folder(client, db, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)

    response = _create(client, auth_header, quarry.id, name="  Plans  ")

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Plans"
    assert body["parent_id"] is None
    assert body["quarry_id"] == str(quarry.id)
    assert body["id"]


def test_create_nested_folder(client, db, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    root = _create(client, auth_header, quarry.id, name="Site").json()

    response = _create(
        client, auth_header, quarry.id, name="Reports", parent_id=root["id"]
    )

    assert response.status_code == 201
    assert response.json()["parent_id"] == root["id"]


def test_list_folders_is_flat_with_parent_ids(client, db, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    root = _create(client, auth_header, quarry.id, name="Site").json()
    child = _create(
        client, auth_header, quarry.id, name="Reports", parent_id=root["id"]
    ).json()

    response = client.get(
        f"/quarries/{quarry.id}/folders", headers=auth_header("u1")
    )

    assert response.status_code == 200
    by_id = {item["id"]: item for item in response.json()}
    assert set(by_id) == {root["id"], child["id"]}
    assert by_id[child["id"]]["parent_id"] == root["id"]
    assert by_id[root["id"]]["parent_id"] is None


def test_rename_folder(client, db, auth_header):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    folder = make_folder(db, company, quarry, name="Old")

    response = client.patch(
        f"/quarries/{quarry.id}/folders/{folder.id}",
        headers=auth_header("u1"),
        json={"name": "New"},
    )

    assert response.status_code == 200
    assert response.json()["name"] == "New"
    db.expire_all()
    assert db.get(Folder, folder.id).name == "New"


def test_delete_empty_folder(client, db, auth_header):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    folder = make_folder(db, company, quarry)
    folder_id = folder.id

    response = client.delete(
        f"/quarries/{quarry.id}/folders/{folder_id}", headers=auth_header("u1")
    )

    assert response.status_code == 204
    assert response.content == b""
    db.expire_all()
    remaining = db.execute(
        select(Folder).where(Folder.id == folder_id)
    ).scalar_one_or_none()
    assert remaining is not None
    assert remaining.deleted_at is not None
    assert remaining.version == 2

    repeated = client.delete(
        f"/quarries/{quarry.id}/folders/{folder_id}", headers=auth_header("u1")
    )
    assert repeated.status_code == 404


def test_delete_folder_with_child_is_409(client, db, auth_header):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    parent = make_folder(db, company, quarry, name="Parent")
    make_folder(db, company, quarry, name="Child", parent=parent)

    response = client.delete(
        f"/quarries/{quarry.id}/folders/{parent.id}", headers=auth_header("u1")
    )

    assert response.status_code == 409
    db.expire_all()
    assert db.get(Folder, parent.id) is not None


def test_delete_folder_with_document_is_409(client, db, auth_header):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    folder = make_folder(db, company, quarry)
    make_document(db, company, quarry, folder_id=folder.id)

    response = client.delete(
        f"/quarries/{quarry.id}/folders/{folder.id}", headers=auth_header("u1")
    )

    assert response.status_code == 409
    db.expire_all()
    assert db.get(Folder, folder.id) is not None


def test_duplicate_name_in_same_parent_is_case_insensitive_409(
    client, db, auth_header
):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    assert _create(client, auth_header, quarry.id, name="Plans").status_code == 201

    response = _create(client, auth_header, quarry.id, name="plans")

    assert response.status_code == 409


def test_same_name_allowed_in_different_parents(client, db, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    left = _create(client, auth_header, quarry.id, name="Left").json()
    right = _create(client, auth_header, quarry.id, name="Right").json()

    assert (
        _create(
            client, auth_header, quarry.id, name="Plans", parent_id=left["id"]
        ).status_code
        == 201
    )
    assert (
        _create(
            client, auth_header, quarry.id, name="Plans", parent_id=right["id"]
        ).status_code
        == 201
    )


def test_same_name_allowed_in_different_quarries(client, db, auth_header):
    user, company, quarry_a, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    quarry_b = make_quarry(db, company, name="South Pit")
    make_permission(db, user, quarry_b, can_view=True, can_upload=True)

    assert _create(client, auth_header, quarry_a.id, name="Plans").status_code == 201
    assert _create(client, auth_header, quarry_b.id, name="Plans").status_code == 201


def test_empty_or_whitespace_folder_name_is_409(client, db, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)

    assert _create(client, auth_header, quarry.id, name="   ").status_code == 409


def test_too_long_folder_name_is_409(client, db, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)

    response = _create(client, auth_header, quarry.id, name="a" * 201)

    assert response.status_code == 409


def test_parent_from_another_quarry_is_404(client, db, auth_header):
    user, company, quarry_a, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    quarry_b = make_quarry(db, company, name="South Pit")
    make_permission(db, user, quarry_b, can_view=True, can_upload=True)
    foreign_parent = make_folder(db, company, quarry_b, name="Other")

    response = _create(
        client, auth_header, quarry_a.id, name="Plans", parent_id=foreign_parent.id
    )

    assert response.status_code == 404


def test_parent_from_another_company_is_404(client, db, auth_header):
    _, _, quarry_a, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, company_name="Company A"
    )
    _, company_b, quarry_b, _ = provision_user(
        db, auth_user_id="u2", company_name="Company B"
    )
    foreign_parent = make_folder(db, company_b, quarry_b, name="Other")

    response = _create(
        client, auth_header, quarry_a.id, name="Plans", parent_id=foreign_parent.id
    )

    assert response.status_code == 404


# --- Folder authorization ---------------------------------------------------


def test_folder_creation_requires_can_upload(client, db, auth_header):
    _, _, quarry, _ = provision_user(
        db, auth_user_id="u1", can_view=True, can_upload=False
    )

    response = _create(client, auth_header, quarry.id, name="Plans")

    assert response.status_code == 403


def test_folder_list_requires_can_view(client, db, auth_header):
    _, _, quarry, _ = provision_user(
        db, auth_user_id="u1", can_view=False, can_upload=True
    )

    response = client.get(
        f"/quarries/{quarry.id}/folders", headers=auth_header("u1")
    )

    assert response.status_code == 403


def test_rename_and_delete_require_can_upload(client, db, auth_header):
    _, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_view=True, can_upload=False
    )
    folder = make_folder(db, company, quarry)

    rename = client.patch(
        f"/quarries/{quarry.id}/folders/{folder.id}",
        headers=auth_header("u1"),
        json={"name": "Nope"},
    )
    delete = client.delete(
        f"/quarries/{quarry.id}/folders/{folder.id}", headers=auth_header("u1")
    )

    assert rename.status_code == 403
    assert delete.status_code == 403


def test_cross_company_folder_rename_and_delete_are_404(client, db, auth_header):
    _, _, quarry_a, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, company_name="Company A"
    )
    _, company_b, quarry_b, _ = provision_user(
        db, auth_user_id="u2", company_name="Company B"
    )
    foreign = make_folder(db, company_b, quarry_b, name="Secret")

    rename = client.patch(
        f"/quarries/{quarry_a.id}/folders/{foreign.id}",
        headers=auth_header("u1"),
        json={"name": "Hijacked"},
    )
    delete = client.delete(
        f"/quarries/{quarry_a.id}/folders/{foreign.id}", headers=auth_header("u1")
    )

    assert rename.status_code == 404
    assert delete.status_code == 404
    db.expire_all()
    assert db.get(Folder, foreign.id).name == "Secret"


def test_platform_admin_cannot_use_folder_endpoints(client, db, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    make_platform_admin(db, auth_user_id="pa")

    listing = client.get(
        f"/quarries/{quarry.id}/folders", headers=auth_header("pa")
    )
    creating = _create(client, auth_header, quarry.id, name="Plans", sub="pa")

    assert listing.status_code == 403
    assert creating.status_code == 403


def test_inactive_quarry_folder_access_is_404(client, db, auth_header):
    user, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    quarry.status = QuarryStatus.inactive
    db.add(quarry)
    db.commit()

    response = client.get(
        f"/quarries/{quarry.id}/folders", headers=auth_header("u1")
    )

    assert response.status_code == 404


def test_suspended_company_folder_access_is_403(client, db, auth_header):
    _, _, quarry, _ = provision_user(
        db,
        auth_user_id="u1",
        can_upload=True,
        company_status=CompanyStatus.suspended,
    )

    response = client.get(
        f"/quarries/{quarry.id}/folders", headers=auth_header("u1")
    )

    assert response.status_code == 403


def test_forged_company_id_query_does_not_change_scope(client, db, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    other = make_company(db, name="Other Co")
    _create(client, auth_header, quarry.id, name="Plans")

    response = client.get(
        f"/quarries/{quarry.id}/folders?company_id={other.id}",
        headers=auth_header("u1"),
    )

    assert response.status_code == 200
    assert [item["name"] for item in response.json()] == ["Plans"]


# --- Document organization --------------------------------------------------


def test_upload_into_folder_sets_folder_id(client, db, auth_header):
    _, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, can_download=True
    )
    folder = make_folder(db, company, quarry, name="Plans")

    response = _upload(
        client,
        auth_header,
        quarry.id,
        data={"folder_id": str(folder.id)},
    )

    assert response.status_code == 201
    assert response.json()["folder_id"] == str(folder.id)
    db.expire_all()
    document = db.get(Document, uuid.UUID(response.json()["id"]))
    assert document.folder_id == folder.id


def test_idempotent_retry_does_not_refile_or_require_the_folder(
    client, db, auth_header
):
    _, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True
    )
    first = make_folder(db, company, quarry, name="First")
    second = make_folder(db, company, quarry, name="Second")
    content = pdf_bytes(256)
    created = _upload(
        client, auth_header, quarry.id, content=content, data={"folder_id": str(first.id)}
    )
    assert created.status_code == 201
    document_id = uuid.UUID(created.json()["id"])

    # Same key + same content: a different target folder must not move the file.
    retried = _upload(
        client, auth_header, quarry.id, content=content, data={"folder_id": str(second.id)}
    )
    assert retried.status_code == 200
    assert retried.json()["id"] == str(document_id)
    db.expire_all()
    assert db.get(Document, document_id).folder_id == first.id

    # Move it out, delete the original folder, then retry the original request.
    client.patch(
        f"/quarries/{quarry.id}/documents/{document_id}",
        headers=auth_header("u1"),
        json={},
    )
    client.delete(
        f"/quarries/{quarry.id}/folders/{first.id}", headers=auth_header("u1")
    )
    late_retry = _upload(
        client, auth_header, quarry.id, content=content, data={"folder_id": str(first.id)}
    )
    assert late_retry.status_code == 200
    assert late_retry.json()["id"] == str(document_id)
    assert late_retry.json()["folder_id"] is None


def test_upload_into_invalid_folder_is_404_without_side_effects(
    client, db, auth_header
):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True
    )
    quarry_b = make_quarry(db, company, name="South Pit")
    make_permission(db, user, quarry_b, can_view=True, can_upload=True)
    foreign_folder = make_folder(db, company, quarry_b, name="Elsewhere")

    response = _upload(
        client,
        auth_header,
        quarry.id,
        data={"folder_id": str(foreign_folder.id)},
    )

    assert response.status_code == 404
    assert db.execute(select(func.count()).select_from(Document)).scalar_one() == 0
    assert company_used_bytes(db, company.id) == 0


def test_list_documents_by_folder_and_root(client, db, auth_header):
    _, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_view=True, can_upload=True
    )
    plans = make_folder(db, company, quarry, name="Plans")
    reports = make_folder(db, company, quarry, name="Reports")
    in_plans = make_document(db, company, quarry, folder_id=plans.id)
    in_reports = make_document(db, company, quarry, folder_id=reports.id)
    unfiled = make_document(db, company, quarry)

    def listed(query: str):
        response = client.get(
            f"/quarries/{quarry.id}/documents{query}", headers=auth_header("u1")
        )
        assert response.status_code == 200
        return {item["id"] for item in response.json()}

    assert listed(f"?folder_id={plans.id}") == {str(in_plans.id)}
    assert listed("?root_only=true") == {str(unfiled.id)}
    assert listed("") == {
        str(in_plans.id),
        str(in_reports.id),
        str(unfiled.id),
    }


def test_document_list_rejects_foreign_folder_filter(client, db, auth_header):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_view=True)
    quarry_b = make_quarry(db, company, name="South Pit")
    foreign = make_folder(db, company, quarry_b, name="Elsewhere")

    response = client.get(
        f"/quarries/{quarry.id}/documents?folder_id={foreign.id}",
        headers=auth_header("u1"),
    )

    assert response.status_code == 404


def test_document_list_rejects_folder_and_root_together(client, db, auth_header):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_view=True)
    folder = make_folder(db, company, quarry)

    response = client.get(
        f"/quarries/{quarry.id}/documents?folder_id={folder.id}&root_only=true",
        headers=auth_header("u1"),
    )

    assert response.status_code == 422


def test_move_document_to_folder_preserves_object_and_download(
    client, db, storage, auth_header
):
    _, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, can_download=True
    )
    content = pdf_bytes(512)
    uploaded = _upload(client, auth_header, quarry.id, content=content).json()
    document_id = uuid.UUID(uploaded["id"])
    db.expire_all()
    before = db.get(Document, document_id)
    original_ref = before.storage_ref
    original_hash = before.sha256
    folder = make_folder(db, company, quarry, name="Plans")

    moved = client.patch(
        f"/quarries/{quarry.id}/documents/{document_id}",
        headers=auth_header("u1"),
        json={"folder_id": str(folder.id)},
    )

    assert moved.status_code == 200
    assert moved.json()["folder_id"] == str(folder.id)
    db.expire_all()
    after = db.get(Document, document_id)
    assert after.folder_id == folder.id
    assert after.storage_ref == original_ref
    assert after.sha256 == original_hash
    assert after.size_bytes == len(content)

    download = client.get(
        f"/documents/{document_id}/download", headers=auth_header("u1")
    )
    assert download.status_code == 200
    assert download.content == content

    in_folder = client.get(
        f"/quarries/{quarry.id}/documents?folder_id={folder.id}",
        headers=auth_header("u1"),
    )
    assert {item["id"] for item in in_folder.json()} == {str(document_id)}


def test_move_document_to_root(client, db, auth_header):
    _, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True
    )
    folder = make_folder(db, company, quarry)
    document = make_document(db, company, quarry, folder_id=folder.id)

    response = client.patch(
        f"/quarries/{quarry.id}/documents/{document.id}",
        headers=auth_header("u1"),
        json={},
    )

    assert response.status_code == 200
    assert response.json()["folder_id"] is None
    db.expire_all()
    assert db.get(Document, document.id).folder_id is None


@pytest.mark.parametrize(
    "status", [DocumentStatus.pending, DocumentStatus.failed]
)
def test_move_non_available_document_is_404(
    client, db, auth_header, status
):
    _, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True
    )
    folder = make_folder(db, company, quarry)
    document = make_document(
        db, company, quarry, status=status, folder_id=folder.id
    )

    response = client.patch(
        f"/quarries/{quarry.id}/documents/{document.id}",
        headers=auth_header("u1"),
        json={},
    )

    assert response.status_code == 404
    db.expire_all()
    assert db.get(Document, document.id).folder_id == folder.id


def test_move_document_from_another_quarry_is_404(client, db, auth_header):
    user, company, quarry_a, _ = provision_user(
        db, auth_user_id="u1", can_upload=True
    )
    quarry_b = make_quarry(db, company, name="South Pit")
    make_permission(db, user, quarry_b, can_view=True, can_upload=True)
    document_b = make_document(db, company, quarry_b)

    response = client.patch(
        f"/quarries/{quarry_a.id}/documents/{document_b.id}",
        headers=auth_header("u1"),
        json={},
    )

    assert response.status_code == 404
    db.expire_all()
    assert db.get(Document, document_b.id).folder_id is None


def test_move_document_to_folder_in_another_quarry_is_404(client, db, auth_header):
    user, company, quarry_a, _ = provision_user(
        db, auth_user_id="u1", can_upload=True
    )
    quarry_b = make_quarry(db, company, name="South Pit")
    make_permission(db, user, quarry_b, can_view=True, can_upload=True)
    folder_b = make_folder(db, company, quarry_b, name="Elsewhere")
    document = make_document(db, company, quarry_a)

    response = client.patch(
        f"/quarries/{quarry_a.id}/documents/{document.id}",
        headers=auth_header("u1"),
        json={"folder_id": str(folder_b.id)},
    )

    assert response.status_code == 404
    db.expire_all()
    assert db.get(Document, document.id).folder_id is None


def test_move_document_to_folder_in_another_company_is_404(
    client, db, auth_header
):
    _, company_a, quarry_a, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, company_name="Company A"
    )
    _, company_b, quarry_b, _ = provision_user(
        db, auth_user_id="u2", company_name="Company B"
    )
    folder_b = make_folder(db, company_b, quarry_b, name="Elsewhere")
    document = make_document(db, company_a, quarry_a)

    response = client.patch(
        f"/quarries/{quarry_a.id}/documents/{document.id}",
        headers=auth_header("u1"),
        json={"folder_id": str(folder_b.id)},
    )

    assert response.status_code == 404


def test_move_document_from_another_company_is_404(client, db, auth_header):
    _, company_a, quarry_a, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, company_name="Company A"
    )
    _, company_b, quarry_b, _ = provision_user(
        db, auth_user_id="u2", company_name="Company B"
    )
    foreign_document = make_document(db, company_b, quarry_b)

    response = client.patch(
        f"/quarries/{quarry_a.id}/documents/{foreign_document.id}",
        headers=auth_header("u1"),
        json={},
    )

    assert response.status_code == 404


def test_move_requires_can_upload(client, db, auth_header):
    _, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_view=True, can_upload=False
    )
    document = make_document(db, company, quarry)
    folder = make_folder(db, company, quarry)

    response = client.patch(
        f"/quarries/{quarry.id}/documents/{document.id}",
        headers=auth_header("u1"),
        json={"folder_id": str(folder.id)},
    )

    assert response.status_code == 403


# --- Audit ------------------------------------------------------------------


def test_folder_lifecycle_and_move_are_audited(client, db, auth_header):
    _, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True
    )
    document = make_document(db, company, quarry)
    target = make_folder(db, company, quarry, name="Target")

    created = _create(client, auth_header, quarry.id, name="Scratch")
    assert created.status_code == 201
    scratch_id = created.json()["id"]
    renamed = client.patch(
        f"/quarries/{quarry.id}/folders/{scratch_id}",
        headers=auth_header("u1"),
        json={"name": "Renamed"},
    )
    assert renamed.status_code == 200
    moved = client.patch(
        f"/quarries/{quarry.id}/documents/{document.id}",
        headers=auth_header("u1"),
        json={"folder_id": str(target.id)},
    )
    assert moved.status_code == 200
    deleted = client.delete(
        f"/quarries/{quarry.id}/folders/{scratch_id}", headers=auth_header("u1")
    )
    assert deleted.status_code == 204

    events = {
        event.action: event
        for event in db.execute(select(AuditEvent)).scalars().all()
        if event.action.startswith(("folder.", "document.move"))
    }
    assert set(events) == {
        "folder.create",
        "folder.rename",
        "folder.delete",
        "document.move",
    }
    assert events["folder.create"].target_id == scratch_id
    assert events["folder.delete"].target_id == scratch_id
    assert events["document.move"].target_id == str(document.id)
    assert events["document.move"].meta == {
        "from_folder_id": None,
        "to_folder_id": str(target.id),
    }


# --- Concurrency ------------------------------------------------------------


def test_concurrent_duplicate_folder_creates_single_winner(db, session_factory):
    _, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    barrier = threading.Barrier(2)
    outcomes: list[str] = []
    lock = threading.Lock()

    def worker() -> None:
        session = session_factory()
        try:
            barrier.wait(timeout=30)
            folder_service.create_folder(
                session, company.id, quarry.id, name="Plans"
            )
            with lock:
                outcomes.append("ok")
        except Conflict:
            with lock:
                outcomes.append("conflict")
        finally:
            session.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(worker) for _ in range(2)]
        for future in futures:
            future.result(timeout=30)

    assert sorted(outcomes) == ["conflict", "ok"]
    count = db.execute(
        select(func.count())
        .select_from(Folder)
        .where(Folder.quarry_id == quarry.id, func.lower(Folder.name) == "plans")
    ).scalar_one()
    assert count == 1
