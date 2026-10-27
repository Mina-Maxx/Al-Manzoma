"""Real-service smoke test for QuarryVault.

Runs against your live Supabase + running backend using the values already in
``.env`` (or explicit flags). It never prints passwords, tokens or keys, and it
does not create permissions — the employee you use must already have
``can_view`` + ``can_upload`` + ``can_download`` on the target quarry.

Steps:
  1. sign in an employee against Supabase Auth
  2. GET /me
  3. upload a tiny PDF
  4. download it and compare SHA-256
  5. try to read another company's quarry (expects 404)

Usage:
    python scripts/smoke_real.py \
        --email employee@example.com --password '...' \
        --quarry-id <uuid> [--other-quarry-id <uuid>]

Environment fallbacks: SMOKE_BASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY,
SMOKE_EMAIL, SMOKE_PASSWORD, SMOKE_QUARRY_ID, SMOKE_OTHER_QUARRY_ID.
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

try:  # optional, mirrors pydantic-settings behaviour
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # pragma: no cover
    pass

PDF_BYTES = b"%PDF-1.4\n" + b"0" * 256 + b"\n%%EOF\n"


def _env(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


def _report(step: str, ok: bool, detail: str = "") -> None:
    status = "PASS" if ok else "FAIL"
    line = f"[{status}] {step}"
    if detail:
        line += f" - {detail}"
    print(line)


def _sign_in(supabase_url: str, anon_key: str, email: str, password: str) -> str:
    url = f"{supabase_url.rstrip('/')}/auth/v1/token"
    headers = {"apikey": anon_key, "Content-Type": "application/json"}
    with httpx.Client(timeout=20.0) as client:
        response = client.post(
            url,
            params={"grant_type": "password"},
            headers=headers,
            json={"email": email, "password": password},
        )
    if response.status_code != 200:
        raise RuntimeError(f"sign-in failed (HTTP {response.status_code})")
    token = response.json().get("access_token")
    if not token:
        raise RuntimeError("sign-in returned no access token")
    return token


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python scripts/smoke_real.py",
        description="Live smoke test (no secrets are printed).",
    )
    parser.add_argument(
        "--base-url",
        default=_env("SMOKE_BASE_URL", "DASHBOARD_BASE_URL") or "http://localhost:8000",
        help="backend base URL (default: SMOKE_BASE_URL or http://localhost:8000)",
    )
    parser.add_argument("--supabase-url", default=_env("SUPABASE_URL"))
    parser.add_argument("--anon-key", default=_env("SUPABASE_ANON_KEY"))
    parser.add_argument("--email", default=_env("SMOKE_EMAIL"))
    parser.add_argument("--password", default=_env("SMOKE_PASSWORD"))
    parser.add_argument("--quarry-id", default=_env("SMOKE_QUARRY_ID"))
    parser.add_argument("--other-quarry-id", default=_env("SMOKE_OTHER_QUARRY_ID"))
    args = parser.parse_args(argv)

    if not args.password and sys.stdin.isatty():
        try:
            args.password = getpass.getpass("Employee password (hidden): ")
        except (EOFError, KeyboardInterrupt):
            print("\nAborted.")
            return 1

    missing = [
        name
        for name, value in {
            "--supabase-url/SUPABASE_URL": args.supabase_url,
            "--anon-key/SUPABASE_ANON_KEY": args.anon_key,
            "--email/SMOKE_EMAIL": args.email,
            "--password/SMOKE_PASSWORD": args.password,
            "--quarry-id/SMOKE_QUARRY_ID": args.quarry_id,
        }.items()
        if not value
    ]
    if missing:
        print("missing required input: " + ", ".join(missing))
        print("hint: copy .env.example to .env, or pass the flags explicitly.")
        return 2

    base = args.base_url.rstrip("/")

    # 1. sign in
    try:
        token = _sign_in(args.supabase_url, args.anon_key, args.email, args.password)
    except Exception as exc:  # noqa: BLE001 - message is already secret-free
        _report("sign in (Supabase Auth)", False, str(exc))
        return 1
    _report("sign in (Supabase Auth)", True)

    auth = {"Authorization": f"Bearer {token}"}

    with httpx.Client(timeout=30.0) as client:
        # 2. GET /me
        try:
            me = client.get(f"{base}/me", headers=auth)
            if me.status_code != 200:
                _report("GET /me", False, f"HTTP {me.status_code}")
                return 1
            body = me.json()
            _report("GET /me", True, f"role={body.get('role')}")
        except Exception as exc:  # noqa: BLE001
            _report("GET /me", False, str(exc))
            return 1

        # 3. upload
        try:
            upload = client.post(
                f"{base}/quarries/{args.quarry_id}/documents",
                headers={**auth, "Idempotency-Key": uuid.uuid4().hex},
                files={"file": ("smoke.pdf", PDF_BYTES, "application/pdf")},
            )
            if upload.status_code not in (200, 201):
                _report(
                    "upload PDF",
                    False,
                    f"HTTP {upload.status_code} - {upload.text[:500]}",
                )
                return 1
            doc = upload.json()
            document_id = doc.get("id")
            _report("upload PDF", True, f"document {document_id}")
        except Exception as exc:  # noqa: BLE001
            _report("upload PDF", False, str(exc))
            return 1

        # 4. download + compare
        try:
            download = client.get(f"{base}/documents/{document_id}/download", headers=auth)
            if download.status_code != 200:
                _report("download + verify SHA-256", False, f"HTTP {download.status_code}")
                return 1
            local_hash = hashlib.sha256(PDF_BYTES).hexdigest()
            got_hash = hashlib.sha256(download.content).hexdigest()
            if got_hash != local_hash:
                _report(
                    "download + verify SHA-256",
                    False,
                    "downloaded bytes do not match the uploaded content",
                )
                return 1
            _report("download + verify SHA-256", True, "hashes match")
        except Exception as exc:  # noqa: BLE001
            _report("download + verify SHA-256", False, str(exc))
            return 1

        # 5. cross-company access
        if not args.other_quarry_id:
            _report(
                "cross-company quarry (expect 404)",
                True,
                "SKIPPED - pass --other-quarry-id to exercise this",
            )
        else:
            try:
                foreign = client.get(
                    f"{base}/quarries/{args.other_quarry_id}/documents", headers=auth
                )
                ok = foreign.status_code == 404
                _report(
                    "cross-company quarry (expect 404)",
                    ok,
                    f"HTTP {foreign.status_code}"
                    + ("" if ok else " - expected 404"),
                )
                if not ok:
                    return 1
            except Exception as exc:  # noqa: BLE001
                _report("cross-company quarry (expect 404)", False, str(exc))
                return 1

    print("smoke test finished: all steps passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
