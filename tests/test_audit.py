from __future__ import annotations

import logging

from sqlalchemy import func, select

from app.models import AuditEvent, AuditResult
from app.services.audit import AuditService
from tests.factories import make_document, provision_user
from tests.util import exe_bytes, pdf_bytes, upload_files


def _events(db, action: str | None = None) -> list[AuditEvent]:
    statement = select(AuditEvent).order_by(AuditEvent.created_at)
    if action is not None:
        statement = statement.where(AuditEvent.action == action)
    return list(db.execute(statement).scalars().all())


def _serialize(events: list[AuditEvent]) -> str:
    blob = []
    for event in events:
        blob.append(
            str(
                {
                    "action": event.action,
                    "result": event.result.value,
                    "target_type": event.target_type,
                    "target_id": event.target_id,
                    "ip": event.ip,
                    "user_agent": event.user_agent,
                    "meta": event.meta,
                }
            )
        )
    return " ".join(blob)


def _upload(client, auth_header, quarry_id, content, key="k1"):
    return client.post(
        f"/quarries/{quarry_id}/documents",
        headers={**auth_header, "Idempotency-Key": key},
        files=upload_files("report.pdf", content),
    )


def test_upload_success_is_audited(client, db, storage, auth_header):
    user, company, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    response = _upload(client, auth_header("u1"), quarry.id, pdf_bytes(128))
    assert response.status_code == 201

    events = _events(db, "document.upload")
    assert len(events) == 1
    event = events[0]
    assert event.result == AuditResult.success
    assert event.company_id == company.id
    assert event.actor_user_id == user.id
    assert event.target_type == "document"
    assert event.target_id == response.json()["id"]
    assert event.created_at is not None


def test_failed_upload_is_audited(client, db, storage, auth_header):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    response = _upload(client, auth_header("u1"), quarry.id, exe_bytes())
    assert response.status_code == 415

    events = _events(db, "document.upload")
    assert len(events) == 1
    assert events[0].result == AuditResult.failure


def test_download_is_audited(client, db, storage, auth_header):
    _, _, quarry, _ = provision_user(
        db, auth_user_id="u1", can_upload=True, can_download=True
    )
    document = _upload(client, auth_header("u1"), quarry.id, pdf_bytes(128)).json()

    response = client.get(
        f"/documents/{document['id']}/download", headers=auth_header("u1")
    )
    assert response.status_code == 200

    events = _events(db, "document.download")
    assert len(events) == 1
    event = events[0]
    assert event.result == AuditResult.success
    assert event.target_type == "document"
    assert event.target_id == document["id"]


def test_authorization_denial_is_audited(client, db, storage, auth_header):
    user, company, quarry, _ = provision_user(
        db, auth_user_id="u1", can_view=True, can_download=False
    )
    document = make_document(db, company, quarry)

    response = client.get(
        f"/documents/{document.id}/download", headers=auth_header("u1")
    )
    assert response.status_code == 403

    events = _events(db, "quarry.can_download")
    assert len(events) == 1
    event = events[0]
    assert event.result == AuditResult.denied
    assert event.company_id == company.id
    assert event.actor_user_id == user.id
    assert event.target_id == str(document.id)


def test_me_access_is_audited(client, db, auth_header):
    user, company, _, _ = provision_user(db, auth_user_id="u1")
    response = client.get("/me", headers=auth_header("u1"))
    assert response.status_code == 200

    events = _events(db, "auth.me")
    assert len(events) == 1
    event = events[0]
    assert event.result == AuditResult.success
    assert event.actor_user_id == user.id
    assert event.company_id == company.id


def test_audit_events_contain_no_secrets_or_file_contents(
    client, db, storage, auth_header, make_token
):
    _, _, quarry, _ = provision_user(db, auth_user_id="u1", can_upload=True)
    sentinel = "TOP_SECRET_SENTINEL_STRING_98765"
    content = b"%PDF-1.4\n" + sentinel.encode() + b"\npadding"
    token = make_token("u1")

    response = _upload(
        client, {"Authorization": f"Bearer {token}"}, quarry.id, content
    )
    assert response.status_code == 201

    blob = _serialize(_events(db))
    assert sentinel not in blob
    assert token not in blob
    assert "Bearer" not in blob


def test_audit_failure_does_not_break_request_and_is_logged(
    app, client, db, caplog, auth_header, make_token
):
    provision_user(db, auth_user_id="u1")
    token = make_token("u1")

    def broken_session_factory():
        raise RuntimeError("audit backend down")

    app.state.audit = AuditService(broken_session_factory)

    with caplog.at_level(logging.WARNING, logger="quarryvault.audit"):
        response = client.get("/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200

    messages = [r.getMessage() for r in caplog.records if r.name == "quarryvault.audit"]
    assert any("audit event not persisted" in m for m in messages)
    assert token not in caplog.text
    assert "dev-insecure" not in caplog.text

    persisted = db.execute(select(func.count()).select_from(AuditEvent)).scalar_one()
    assert persisted == 0
