from __future__ import annotations

import io

from app.scripts import orphans, reap
from app.storage.local import LocalDiskStorage


def test_iter_refs_lists_files(tmp_path):
    storage = LocalDiskStorage(tmp_path)
    storage.put(io.BytesIO(b"a"), "company/c1/quarry/q1/doc1")
    storage.put(io.BytesIO(b"bb"), "company/c1/quarry/q1/doc2")

    assert set(storage.iter_refs()) == {
        "company/c1/quarry/q1/doc1",
        "company/c1/quarry/q1/doc2",
    }


def test_diff_refs():
    orphan_on_storage, missing_in_storage = orphans.diff_refs({"a", "b"}, {"b", "c"})

    assert orphan_on_storage == ["c"]
    assert missing_in_storage == ["a"]


def test_reap_cli_runs(settings, monkeypatch, capsys):
    monkeypatch.setattr(reap, "get_settings", lambda: settings)

    code = reap.main(["--older-than-seconds", "0"])

    assert code == 0
    assert "Reaped" in capsys.readouterr().out


def test_orphans_cli_runs(settings, monkeypatch, capsys):
    monkeypatch.setattr(orphans, "get_settings", lambda: settings)

    code = orphans.main([])

    out = capsys.readouterr().out
    assert code == 0
    assert "orphan_on_storage" in out
    assert "Read-only report" in out
