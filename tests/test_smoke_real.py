from __future__ import annotations

from scripts import smoke_real


def test_pdf_fixture_has_pdf_magic_bytes():
    assert smoke_real.PDF_BYTES.startswith(b"%PDF")


def test_missing_inputs_exit_2_without_network(monkeypatch, capsys):
    monkeypatch.delenv("SMOKE_PASSWORD", raising=False)
    monkeypatch.delenv("SMOKE_QUARRY_ID", raising=False)

    code = smoke_real.main(
        [
            "--supabase-url",
            "https://example.supabase.co",
            "--anon-key",
            "anon-key",
            "--email",
            "employee@example.com",
        ]
    )

    assert code == 2
    out = capsys.readouterr().out
    assert "missing required input" in out
    assert "password" in out.lower()
