from __future__ import annotations

import sys

import pytest

from app.main import create_app


def _app(settings, session_factory, storage, verifier):
    return create_app(
        settings, session_factory=session_factory, storage=storage, verifier=verifier
    )


def test_refuses_multiple_configured_workers(
    settings, session_factory, storage, verifier
):
    bad = settings.model_copy(update={"web_concurrency": 2})
    with pytest.raises(RuntimeError, match="single worker"):
        _app(bad, session_factory, storage, verifier)


def test_refuses_workers_flag(settings, session_factory, storage, verifier, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["uvicorn", "app.main:app", "--workers", "3"])
    with pytest.raises(RuntimeError, match="single worker"):
        _app(settings, session_factory, storage, verifier)


def test_allows_single_worker(settings, session_factory, storage, verifier, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["uvicorn", "app.main:app", "--workers", "1"])
    app = _app(settings, session_factory, storage, verifier)
    assert app is not None
