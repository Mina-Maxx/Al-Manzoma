from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app


def test_dashboard_config_is_public_and_leaks_no_secret(
    settings, session_factory, storage, verifier
):
    secret = "service-role-super-secret"
    cfg = settings.model_copy(
        update={
            "supabase_service_role_key": secret,
            "supabase_anon_key": "anon-public-key",
        }
    )
    dashboard_app = create_app(
        settings=cfg,
        session_factory=session_factory,
        storage=storage,
        verifier=verifier,
    )

    with TestClient(dashboard_app) as dashboard_client:
        response = dashboard_client.get("/dashboard/config")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"supabase_url", "supabase_anon_key"}
    assert body["supabase_anon_key"] == "anon-public-key"
    assert secret not in response.text
    assert "service" not in response.text.lower()


def test_dashboard_config_needs_no_auth(client):
    response = client.get("/dashboard/config")
    assert response.status_code == 200


def test_dashboard_index_is_served(client):
    response = client.get("/dashboard/")
    assert response.status_code == 200
    assert "QuarryVault" in response.text


def test_dashboard_assets_are_served(client):
    script = client.get("/dashboard/app.js")
    assert script.status_code == 200
    assert "service_role" not in script.text
    assert client.get("/dashboard/styles.css").status_code == 200


def test_auth_callback_pages_are_served(client):
    for path in ("/dashboard/accept-invite", "/dashboard/reset-password"):
        response = client.get(path)
        assert response.status_code == 200
        assert "QuarryVault" in response.text


def test_dashboard_sets_strict_security_headers(client, settings):
    response = client.get("/dashboard/")
    csp = response.headers["content-security-policy"]

    assert "default-src 'self'" in csp
    assert "script-src 'self'" in csp
    assert "frame-ancestors 'none'" in csp
    assert "unsafe-inline" not in csp
    assert "connect-src 'self'" in csp
    assert settings.supabase_url in csp

    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["x-frame-options"] == "DENY"


def test_dashboard_config_gets_security_headers(client):
    response = client.get("/dashboard/config")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


def test_non_dashboard_endpoints_get_no_csp(client):
    response = client.get("/health")
    assert "content-security-policy" not in response.headers

