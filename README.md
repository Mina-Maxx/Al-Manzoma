# QuarryVault — Backend

Multi-tenant document archive for quarry companies. This is the FastAPI backend
only. The backend is the single authority for authorization: clients never talk
to the database or to Google Drive directly.

Delivered so far: login (Supabase JWT) → upload → download with Google Drive as
the file store behind a storage interface; the **management API**: platform
admins manage companies, and company admins manage their users, quarries and
permissions; and a static **admin dashboard** at `/dashboard/`.

## Architecture

Modular monolith:

```
app/
  main.py            app factory, routers, error handlers
  config.py          environment-based settings (pydantic-settings)
  db.py              SQLAlchemy engine/session factory
  models/            companies, users, memberships, platform_admins, quarries,
                     quarry_permissions, documents, idempotency_keys, audit_events
  schemas.py         request/response models
  security/
    jwt.py           Supabase JWT verification via JWKS (cached)
    context.py       AuthContext / PlatformAdminContext (server-derived identity)
    deps.py          get_auth_context, require_company_admin, get_platform_admin,
                     require_quarry_permission, download guard
  services/
    document_service.py  upload orchestrator (idempotency, quota, storage)
    quota.py             transactional quota reservation (row lock)
    idempotency.py       idempotency key helpers
    audit.py             isolated audit writes (sanitized)
    reconciliation.py    detection hook for stuck/orphan documents
    identity.py          swappable IdentityProvider (Supabase Admin API)
    platform_admin.py    company create/list/suspend/reactivate
    company_admin.py     users, invitations, quarries, permissions, usage
    rate_limit.py        in-process sliding-window limiter (invitations)
  storage/
    base.py          Storage interface: put / open / delete / exists
    local.py         LocalDiskStorage (tests/dev only)
    gdrive.py        GoogleDriveStorage (pilot)
  routers/           health, me, quarries, documents, platform, company_admin,
                     dashboard
  scripts/           operational CLIs (python -m app.scripts.reap / .orphans)
  dashboard/         static admin dashboard (vanilla ES modules, no build step)
alembic/             migrations
scripts/
  gdrive_oauth.py    one-time local refresh-token helper
  seed_dev.py        development seed data (no real secrets)
  bootstrap.py       production bootstrap (first platform admin + company)
tests/               pytest suite
```

### Data model notes

- **Multi-tenant from the start**: `company_id` is present on all tenant data.
- **Identity is separate from membership**: `users` holds a profile row linked
  to the Supabase auth user id (`auth_user_id`); `memberships` links a user to a
  company with a role (`company_admin` or `employee`). One membership per user in
  the MVP.
- **Quarry access is explicit**: a user only sees a quarry through a
  `quarry_permissions` row. There is no implicit access to all quarries.
- **`company_id` is always derived server-side** from the caller's membership
  row, never from the client or from JWT claims.
- **Platform admins are separate**: `platform_admins` holds operators who are
  deliberately *not* members of any company. An identity is never both a
  platform admin and a company member; the bootstrap script enforces this.
- **Roles live only in our tables**, never in JWT claims. The backend re-reads
  membership and status on every request.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | no auth |
| GET | `/me` | user + company + role (+ used bytes) |
| GET | `/quarries` | only active quarries with `can_view` |
| GET | `/quarries/{id}/documents` | only `available` documents, paginated |
| POST | `/quarries/{id}/documents` | multipart upload, requires `Idempotency-Key` |
| GET | `/documents/{id}/download` | streamed through the backend |
| GET | `/dashboard/config` | **public** dashboard config (URL + anon key only) |
| GET | `/dashboard/` | the static admin dashboard |

### Platform admin (`/platform`, platform admins only)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/platform/companies` | list companies (+ usage) |
| POST | `/platform/companies` | create a company |
| POST | `/platform/companies/{id}/suspend` | suspend a company |
| POST | `/platform/companies/{id}/reactivate` | reactivate a company |

### Company admin (`/company`, company admins only)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/company/employees` | list employees (own company only) + status |
| POST | `/company/employees/invite` | invite by email (rate limited); never exceeds `max_users` |
| POST | `/company/employees/{user_id}/disable` | disable a user (last-admin protected) |
| POST | `/company/employees/{user_id}/enable` | re-enable a user |
| GET | `/company/quarries` | list quarries (incl. inactive) |
| POST | `/company/quarries` | create a quarry |
| PATCH | `/company/quarries/{quarry_id}` | rename a quarry |
| POST | `/company/quarries/{quarry_id}/deactivate` | deactivate a quarry |
| POST | `/company/quarries/{quarry_id}/reactivate` | reactivate a quarry |
| PUT | `/company/quarries/{quarry_id}/permissions/{user_id}` | set a user's flags |
| GET | `/company/permissions` | permission matrix (members × quarries) |
| GET | `/company/usage` | quota usage from the same source as uploads |

Deactivating a quarry makes it invisible to its members and blocks listing,
upload and download (all return **404**).

The invitation **rate limiter is in-memory** (`app/services/rate_limit.py`,
`INVITE_RATE_LIMIT_PER_MINUTE`). Its counters live in the process and are
**reset every time the backend restarts**, and they are not shared across
processes. It is a best-effort protection against accidental hammering, not a
durable quota; it relies on the single-instance deployment described below.

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate            # Windows
pip install -r requirements.txt -r requirements-dev.txt

copy .env.example .env            # then fill in real values
```

Required environment (see `.env.example`): `DATABASE_URL`, `SUPABASE_URL`,
`STORAGE_BACKEND` (`local` or `gdrive`) and, for Drive, `GDRIVE_ROOT_FOLDER_ID`
and `GDRIVE_CREDENTIALS_FILE`. Management features additionally need
`SUPABASE_SERVICE_ROLE_KEY` (backend-only: it is used to create/disable auth
users and is never logged or sent to clients) and optionally
`INVITE_RATE_LIMIT_PER_MINUTE`. The dashboard additionally needs
`SUPABASE_ANON_KEY` (public) and `DASHBOARD_BASE_URL` (public base URL used to
build auth email redirects).

### Migrations

```bash
alembic upgrade head
```

### Run

```bash
uvicorn app.main:app --reload
```

### Seed (development only)

```bash
python scripts/seed_dev.py        # one company, users, quarries, permissions
```

### Bootstrap (production)

On a fresh deployment there are no platform admins, so nobody can use
`/platform`. Run the bootstrap once to create the first platform admin, the
first company and that company's first company admin:

```bash
python scripts/bootstrap.py \
  --platform-admin-email root@example.com \
  --company-name "Acme Quarry" \
  --company-admin-email owner@example.com
```

Passing `--auth-user-id` instead of `--email` reuses an existing account without
inviting anyone. With `--email`, the identity provider sends a real invitation
email (see the dashboard section below). The script refuses if the identity is
ambiguous (already a platform admin, already in a company, or both admins are
the same person) and contains no secrets.

### Live smoke test (real services)

With a running backend and a real Supabase project, you can exercise the whole
path against the real services. It prints **no secrets or tokens**, and only
reports PASS/FAIL per step:

```bash
python scripts/smoke_real.py \
  --email employee@example.com --password '...' \
  --quarry-id <uuid> --other-quarry-id <uuid>
```

It (1) signs an employee in through Supabase Auth, (2) calls `GET /me`,
(3) uploads a tiny PDF, (4) downloads it and compares SHA-256, and (5) tries to
read a quarry from another company (expects 404). Inputs can also come from the
environment (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SMOKE_EMAIL`, `SMOKE_PASSWORD`,
`SMOKE_QUARRY_ID`, `SMOKE_OTHER_QUARRY_ID`, `SMOKE_BASE_URL`). The employee must
already hold `can_view` + `can_upload` + `can_download` on `--quarry-id`; the
script does not create permissions.

## Admin dashboard

A small static dashboard is served by the backend at **`/dashboard/`** (for
example `http://localhost:8000/dashboard/`). It has no build step and no
framework: plain ES modules in `app/dashboard/`.

- **Authentication is Supabase Auth only.** There is no dev login and no auth
  bypass in the dashboard. The browser signs in directly against Supabase
  (GoTrue) and then calls this backend with the Supabase access token; the
  backend verifies that token on every request exactly like the API.
- **What the browser receives.** Only `/dashboard/config`, which returns the
  **public** `SUPABASE_URL` and `SUPABASE_ANON_KEY`. The `SUPABASE_SERVICE_ROLE_KEY`
  is never returned to or used by the browser — it stays backend-only. The anon
  key is safe to expose here only because the database is never queried with it
  (no PostgREST/RLS data path); all data flows through this API.
- **Screens:** sign in; accept an invitation and set a password; forgot /
  reset password; a platform view (companies) for platform admins; and a company
  view (employees, invitations, quarries, permissions, usage) for company
  admins. Employees see a "no access" notice.

### Decision: static dashboard instead of Next.js + TypeScript (MVP)

**Decision.** For the MVP the dashboard is plain static HTML/CSS/ES-modules
served by the backend, not a Next.js + TypeScript app.

**Why.**
- **No build step and no Node toolchain at build/deploy time.** The whole
  backend ships as Python; adding Next.js would add a second toolchain, a
  bundler and a second deploy target for zero functional gain here.
- **Same-origin.** Serving `/dashboard` from the API removes CORS, a second
  hostname and a second set of cookies/tokens to reason about.
- **Small surface.** The dashboard only talks to Supabase Auth and this API;
  it needs no SSR, routing, data fetching layer or component framework.

**Limits (accepted for the MVP).**
- **No type safety.** No TypeScript, so mistakes in the client are only caught by
  review and the checks below — not by the compiler.
- **No automated tests for the JS logic.** The DOM wiring in `app/dashboard/app.js`
  is not unit-tested; only the pure view helpers (`views.js`) are exercised (see
  "Tests"). Everything else is verified by review and manually in a browser.
- **No component reuse across screens** and no framework conventions; a larger
  dashboard would justify revisiting this.

This is a deliberate MVP trade-off, not a permanent architectural claim.

### Token storage in the browser (and its risk)

The access and refresh tokens returned by Supabase are kept in
**`localStorage`** under the key `qv_session` (the access token is also used as
the `Authorization: Bearer` header for API calls).

**Why `localStorage`:** the backend serves the dashboard as a static file and
does **not** own the auth session, so it cannot set an httpOnly session cookie;
with the browser talking to Supabase Auth directly, `localStorage` is the
simplest place to persist the session across reloads, and it avoids CSRF concerns
that cookie auth would introduce.

**Risk:** any JavaScript running on the origin can read `localStorage`, so a
cross-site-scripting (XSS) bug would expose the tokens. We reduce that risk with:
- a strict Content-Security-Policy on `/dashboard` (no `unsafe-inline`, no
  third-party script origins — see "Security properties"),
- rendering **all** user-supplied data through strict escaping (`views.js`), with
  a test that feeds `<script>` and `"><img onerror>` payloads,
- a **short-lived access token** (Supabase default) that is transparently
  refreshed, and
- clearing the stored session on sign-out and on any 401/expired session.

**Alternative (recommended if the threat model tightens):** move to a
backend-issued, **httpOnly, Secure, SameSite** session cookie (the browser would
stop holding tokens at all). That requires the backend to own the session and is
out of scope for the MVP.

### Supabase URL configuration (required)

In Supabase → **Authentication → URL Configuration**, set the **Site URL** and
add these **Redirect URLs** (replace the host with your public `DASHBOARD_BASE_URL`):

```
https://<host>/dashboard/accept-invite
https://<host>/dashboard/reset-password
```

For local development add the `http://localhost:8000/...` equivalents. The
invitation email link returns to `/dashboard/accept-invite`; the password-reset
link returns to `/dashboard/reset-password`. Links that are not allow-listed are
rejected by Supabase.

### Email delivery (invitations and password resets)

Supabase's **built-in email service is limited** (a few messages per hour, and it
is meant for testing only — it may not deliver to arbitrary recipients). For real
use, configure a custom SMTP provider.

Using **Resend**:

1. Create a Resend account and **verify a sending domain** (DNS records).
2. Create an **API key** (this acts as the SMTP password).
3. In Supabase → **Project Settings → Auth → SMTP Settings**, enable
   **Custom SMTP** and fill in:
   - Host: `smtp.resend.com`
   - Port: `465` (SSL) or `587`
   - Username: `resend`
   - Password: your Resend API key
   - Sender email: e.g. `no-reply@yourdomain`, plus a sender name
4. Save, then send a test email from the same page.
5. Optionally raise the email rate limit under Auth settings.

## Storage

`Storage` is a small interface:

```python
put(stream, name) -> ref
open(ref) -> stream
delete(ref)
exists(ref)
iter_refs() -> Iterator[ref]   # optional; read-only audit listing
```

`name` is a logical key (`company/{company_id}/quarry/{quarry_id}/{document_id}`)
built from IDs only, never user-supplied names. The database stores the returned
Drive **file id** as the source of truth, never a filename.

`iter_refs()` enumerates stored objects for the read-only orphan audit. It is
optional: a backend that cannot enumerate raises `NotImplementedError`.
`LocalDiskStorage` walks its root; `GoogleDriveStorage` walks the private root
folder tree (list calls only, never create/update/delete).

Two implementations: `GoogleDriveStorage` (pilot) and `LocalDiskStorage` (tests
and local development only).

### Google Drive setup

1. Create an OAuth client (Desktop app) in Google Cloud and enable the Drive API.
2. Set the OAuth consent screen to **In production**. In *Testing* mode Google
   expires refresh tokens after **7 days**, which would silently break uploads.
3. Run the one-time helper on the owner's machine:
   ```bash
   python scripts/gdrive_oauth.py --client-secret client_secret.json --out gdrive_credentials.json
   ```
   Scope is `drive.file` only — the backend can only see files it created itself.
4. Move `gdrive_credentials.json` into secret storage and point
   `GDRIVE_CREDENTIALS_FILE` at it. Never commit it.
5. Create the app root folder in Drive and set `GDRIVE_ROOT_FOLDER_ID`.
   Per-company and per-quarry folders are created automatically using IDs.

Files are private: the backend never creates public links or "anyone with the
link" permissions. Retryable Drive failures (429/5xx) use exponential backoff and
surface a generic error to the client; Google error details are never exposed.

## Upload semantics

1. **Authorize first** (`can_upload` on that quarry within the caller's company).
2. Stream the file in chunks to a spooled temp file, enforcing the size limit on
   the actual bytes (not the client's `Content-Length`) and computing SHA-256.
3. Detect the real type by magic bytes (PDF, JPEG, PNG only) and reject mismatch.
4. **Reserve quota in a short transaction**: lock the company row
   (`SELECT ... FOR UPDATE`), count `pending` + `available` bytes, insert a
   `pending` document, commit and release the lock. Pending rows count toward the
   quota, so concurrent uploads cannot oversell it.
5. Upload to Drive **outside the lock**.
6. Mark the document `available` with the Drive file id and SHA-256. Users only
   ever see `available` documents.
7. On Drive failure the reservation is released. If Drive succeeds but the DB
   update fails, the row stays `pending` for reconciliation.

**Idempotency**: the `Idempotency-Key` header plus the content hash makes a retry
return the same document. Reusing a key with different content returns `409`.

## Download semantics

Authorize `can_download` on the document's quarry, then stream from Drive through
the backend with `Content-Disposition: attachment`, `X-Content-Type-Options:
nosniff`, and `Cache-Control: private, no-store`. A document id from another
company returns **404, not 403**.

## Security properties

- Supabase JWT verified against JWKS (issuer + audience + expiry).
- User and company status are read from the database on **every** request, with
  no caching, so deactivating a user or suspending a company blocks the next
  request.
- Cross-tenant access by changing any id returns 404.
- Client-supplied `company_id` is never trusted.
- Platform admins are **not** company members: every tenant endpoint (quarries,
  documents, downloads, `/company/*`) rejects them with **403**. Authorization
  for tenant data is always derived from a membership row.
- A `company_admin` cannot escalate: `/platform/*` returns 403, there is no
  role-change endpoint, and invitations can only ever mint `employee` roles.
- Every company-scoped action re-checks that the target user *and* quarry belong
  to the caller's company; a foreign id is reported as 404.
- The last active `company_admin` cannot be disabled (`409`), and `max_users` is
  enforced under a company row lock so concurrent invitations cannot oversell it.
- Deactivating a user or quarry takes effect on the **next** request, from the
  database, with no caching.
- The dashboard (`/dashboard/*`) is served with a strict
  `Content-Security-Policy` (`default-src 'self'`, no `unsafe-inline`,
  `connect-src 'self' <supabase-origin>`, `frame-ancestors 'none'`),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
  `X-Frame-Options: DENY`. It renders user-supplied fields through strict HTML
  escaping (never raw `innerHTML`), and the invite/reset token fragment is
  stripped from the URL/history as soon as it is read and is never logged.
- Audit events record auth outcomes, upload success/failure, downloads and
  authorization denials. Tokens, passwords and file contents are never logged or
  recorded (audit metadata is sanitized).

## Tests

Tests run against a **real PostgreSQL** database (no skipping of concurrency
tests). Point `TEST_DATABASE_URL` at a throwaway database:

```bash
docker run -d --name quarryvault-pg \
  -e POSTGRES_USER=quarryvault -e POSTGRES_PASSWORD=quarryvault \
  -e POSTGRES_DB=quarryvault_test -p 55432:5432 postgres:16

set TEST_DATABASE_URL=postgresql+psycopg://quarryvault:quarryvault@localhost:55432/quarryvault_test
pytest
```

The suite resets the schema and applies Alembic migrations, then truncates tables
between tests. Covered: tenant isolation on every endpoint, missing/invalid
tokens, inactive user, suspended company, per-quarry permissions, bad magic
bytes, oversize/over-quota uploads, idempotency (same key once; same key +
different content → 409), concurrent uploads near the quota, reconciliation
candidates, and the local storage interface. The management API adds: the
identity provider, platform company management, company users/quarries/
permissions/usage, invitation limits (rate limit, `max_users`, retry/dedup,
compensation), last-admin protection, inactive-quarry visibility, and real
PostgreSQL concurrency tests for concurrent invites and concurrent disables. The
dashboard adds tests that `/dashboard/config` exposes only public values (never
the service-role key) and that the static assets and auth-callback pages are
served.

## Reconciliation and stale-attempt recovery

`app.services.reconciliation.list_reconciliation_candidates(db, older_than_seconds)`
lists documents stuck in a non-final state. `reason` is `upload_incomplete`
(no Drive ref) or `orphan_in_drive` (Drive ref present).

`reap_stale_attempts(db, ...)` releases reservations for uploads that crashed
while an idempotency key was `in_progress`. A candidate is an `in_progress` key
with no recorded failure whose lease has expired and which has no live owner in
the process-local registry (`app/services/owner_registry.py`). Each candidate is
re-checked under a row lock and taken over with an owner-token CAS before its
pending reservation is released and it is marked failed (`failed_at`). The
reaper never deletes storage objects; the key's `storage_ref` is preserved for
recovery attribution.

Because the active-owner registry is **process-local**, it is only correct for a
single Uvicorn process. It is not a cross-process liveness authority; a
multi-worker deployment would need a shared mechanism (e.g. advisory locks).
PostgreSQL and the storage backend are also not one transaction: an object
written just before a crash cannot always be attributed, so it is left in place
(residual orphan risk). No scheduler or background worker is built in this
slice; the reaper is run explicitly (see below).

### Running the reaper

```bash
python -m app.scripts.reap
python -m app.scripts.reap --older-than-seconds 600 --limit 500
```

Run it from cron/systemd-timer on a schedule (e.g. every few minutes) with a
threshold **comfortably longer than any legitimate upload**. The default
threshold is `IDEMPOTENCY_LEASE_SECONDS` (300s). The command releases the
pending reservation and marks the key failed so the client can retry with the
same key; it never deletes storage objects, and it is safe to run repeatedly.

Caveat: the command runs in its **own process**, so it cannot see the API
server's in-memory owner registry and relies solely on lease expiry. Keep the
threshold well above the worst-case upload time.

### Auditing orphaned storage objects

```bash
python -m app.scripts.orphans
```

Prints two read-only lists: objects in storage with no database row
(`orphan_on_storage`) and database refs whose object is missing from storage
(`missing_in_storage`). Both `documents.storage_ref` and
`idempotency_keys.storage_ref` count as known refs (a failed attempt keeps its
ref on purpose). This command **never deletes or mutates** anything.

### Single worker, single instance (required)

The active-owner registry is process-local, so upload idempotency is only safe
when the backend runs as **one worker in one instance**. The app enforces this:
if `WEB_CONCURRENCY` (or a `--workers N` / `-w N` command-line flag with `N > 1`)
is set, `create_app()` raises at startup and the process refuses to serve.

```bash
# correct
uvicorn app.main:app --workers 1
# or simply
uvicorn app.main:app
```

Do not scale the API to multiple replicas. This restriction is a hard
requirement of the current design, not a tuning knob.

## Out of scope (so far)

Android app, deleting records, search, export, sharing links, versions/trash,
OCR, notifications, reports, billing, background workers, RLS policies,
deployment.
