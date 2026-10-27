"""One-time local OAuth helper to obtain the Drive refresh token.

Run this once on the owner's machine, then move the resulting credentials file
into secret storage. NEVER commit it.

Usage:
    python scripts/gdrive_oauth.py \
        --client-secret /path/to/client_secret.json \
        --out gdrive_credentials.json

Important:
    The OAuth consent screen must be set to "In production". In "Testing" mode
    Google expires refresh tokens after 7 days, which would silently break
    uploads. The scope is drive.file only: the backend can only see files it
    creates itself.
"""
from __future__ import annotations

import argparse
import sys

SCOPES = ["https://www.googleapis.com/auth/drive.file"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--client-secret",
        required=True,
        help="Path to the OAuth client secret JSON downloaded from Google.",
    )
    parser.add_argument(
        "--out",
        default="gdrive_credentials.json",
        help="Where to write the authorized-user credentials file.",
    )
    args = parser.parse_args()

    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        print("google-auth-oauthlib is not installed.", file=sys.stderr)
        return 1

    flow = InstalledAppFlow.from_client_secrets_file(args.client_secret, SCOPES)
    credentials = flow.run_local_server(port=0, access_type="offline", prompt="consent")

    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(credentials.to_json())

    print(f"Credentials written to {args.out}")
    print("Move it into secret storage and point GDRIVE_CREDENTIALS_FILE at it.")
    print(
        "Reminder: set the OAuth consent screen to 'In production' so the "
        "refresh token does not expire after 7 days."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
