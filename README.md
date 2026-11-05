# QuarryVault — Full-Stack Multi-Tenant Document Archive

QuarryVault is a secure, multi-tenant document archiving and permission management system designed for quarry operations.

## Architecture & Technology Stack

- **Backend:** Node.js + Express + TypeScript (`backend/`)
- **Database:** MongoDB (`mongoose` with strict schema validation, unique compound indexes, atomic `$expr` updates) via Docker container `quarryvault-mongodb`
- **Document Storage:** Cloudflare R2 (S3-compatible API via `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` with local disk fallback)
- **Admin Web Application:** Next.js 14 + TypeScript (`admin/`) with full bilingual English LTR / Arabic RTL support
- **Mobile Client:** Android Kotlin + Jetpack Compose (`android/`)

> [!NOTE]
> **PostgreSQL Decommissioning Notice**:
> The legacy Python/FastAPI/SQLAlchemy/PostgreSQL stack (`app/`, `alembic/`, `tests/`, `scripts/`, `requirements.txt`, `pyproject.toml`) has been completely decommissioned from the repository. All application services now run exclusively on Node.js/Express, MongoDB, Next.js, and Android Kotlin. Historical database dumps (`.dump` files) and the standalone database container (`quarryvault-pg`) are preserved as immutable archive assets outside the active application path.

For detailed operational documentation:
- [Migration Status & Component Matrix](docs/MIGRATION_STATUS.md)
- [Production Deployment & Operator's Guide](docs/DEPLOYMENT_GUIDE.md)
- [Backup, Recovery, and Disaster Management Guide](docs/BACKUP_AND_RECOVERY.md)

---

## Quick Start & Service Orchestration

### One-Click Local Orchestration (Windows)

The repository provides automated startup and teardown scripts that verify Docker, ensure `quarryvault-mongodb` is running and healthy on port 27017, and launch both Backend (port 8000) and Admin Dashboard (port 3001):

```powershell
# Start MongoDB container, Node.js Backend, and Next.js Admin
.\start_all.ps1       # or .\start_all.bat
# Production mode rebuilds both latest backend and dashboard source before launch
.\start_all.ps1 -Mode prod

# Stop background services cleanly
.\stop_all.ps1        # or .\stop_all.bat
```

### Manual Service Execution

```bash
# 1. MongoDB Database Container
docker start quarryvault-mongodb
# Fresh installs should use the start_all script. It creates persistent Mongo volumes,
# starts MongoDB with --replSet rs0, and initializes the single-node replica set.

# 2. Node.js Express Backend
cd backend
npm install
npm run build
npm test             # Run the backend regression and integration suite
npm start            # Runs on http://localhost:8000

# 3. Next.js Admin Web Application
cd ../admin
npm install
npm run build
npm start            # Runs on http://localhost:3001

# 4. Android Mobile Application
cd ../android
.\gradlew.bat test   # Runs all Android unit tests
```

---

## Core System Architecture

### 1. Multi-Tenant Isolation & Granular Permissions
- **Tenant Scope:** Every quarry, folder, document, and version is bound to a `company_id`. Cross-tenant requests are strictly blocked and return 404 to avoid leaking tenant existence.
- **Independent Permissions:** Quarry access is explicitly granted per employee with four distinct flags:
  - `can_view`: Browse active quarries, folders, and documents.
  - `can_upload`: Upload documents, create versions, and create/rename folders.
  - `can_download`: Download document file payloads.
  - `can_delete`: Move documents to trash, delete empty folders. Evaluated independently of `can_upload`.
- **Company Storage Quota:** Enforced atomically on upload using single-document `$expr` updates `{ $lte: [{ $add: ['$used_bytes', sizeBytes] }, '$quota_bytes'] }` to eliminate race conditions and overselling.

### 2. Single Active Employee Session Enforcement
- **Policy:** Regular employees and Company Admins can have only **one** active session across devices. Logging in on a second device automatically invalidates any existing session.
- **Session Identification:** The backend generates a unique `active_session_id` (UUID) upon successful authentication and returns it to the client. Subsequent requests validate the session ID via the `X-Session-Id` HTTP header or JWT session claim.
- **Platform Admins:** Platform Admins are exempt from the single-session restriction and can maintain concurrent sessions across multiple management workstations.

### 3. Permanent User Deletion Without Content Loss
- When an administrator deletes an employee or user, the account is **permanently deleted** from the user database (`UserModel`), clearing all active sessions, permissions, and memberships.
- **Content Preservation:** To preserve institutional memory and legal records, all documents and folders created by the deleted user remain completely intact. Foreign references (`uploaded_by`, `deleted_by`) are safely set to `null`.
- **Last-Admin Safeguard:** The system strictly prevents deleting the last active Platform Administrator or the sole Company Administrator.

### 4. Server-Hosted APK Releases & Physical Removal
- **Direct Server Storage:** Mobile application releases (APK files) are uploaded directly through the Platform Admin dashboard and stored via Cloudflare R2 / persistent storage.
- **Automatic Metadata Extraction:** Version code, version name, upload timestamp, and checksum are automatically managed.
- **Physical Removal on Withdrawal/Deletion:**
  - Withdrawing a release immediately deletes the APK artifact from server storage and rejects subsequent download requests with 404.
  - Permanently deleting a release removes both the release metadata document from MongoDB and the physical APK artifact from storage.

### 5. 30-Day Trash & Document Recovery
- Deleting a document performs a soft delete: the document is marked with `deleted_at` and scheduled for purging after 30 days (`purge_at`).
- Soft-deleted documents can be restored by authorized administrators or the original deleter within the 30-day window.
- If the original parent folder was deleted while the document was in the trash, restoring the document automatically places it in the quarry root with clear logging.

---

## Backend Directory Structure (`backend/`)

```
backend/
├── src/
│   ├── app.ts                 # Express application factory, middleware, CORS, rate limiting
│   ├── server.ts              # HTTP server entrypoint
│   ├── config/                # Environment configuration & validation
│   ├── database/
│   │   ├── connection.ts      # MongoDB connection lifecycle
│   │   └── models/            # Mongoose schemas (Company, User, Document, Release, etc.)
│   ├── middleware/            # JWT authentication, role guards, error handling
│   ├── modules/
│   │   ├── auth/              # Authentication & password management
│   │   ├── companies/         # Company administration, employees, quarries
│   │   ├── documents/         # Uploads, versions, downloads, trash, restore
│   │   ├── folders/           # Folder hierarchy & duplicate detection
│   │   ├── platform/          # Superadmin operations, releases, telemetry
│   │   ├── storage/           # Cloudflare R2 adapter & local storage provider
│   │   ├── sync/              # Change feed with HMAC-signed cursors
│   │   ├── updates/           # App version checks and direct APK downloads
│   │   └── dashboard/         # Dashboard router redirecting to Admin Portal & public config
│   └── scripts/               # Operational CLIs (bootstrap, seed, DR backup/restore)
└── tests/                     # Vitest regression and integration suite
```

---

## Admin Web Application (`admin/`)

The Next.js 14 administrator dashboard provides:
- **Platform Administration:** Global tenant overview, company lifecycle, storage quota adjustments, platform admin management, and audit logs.
- **Office Administration:** Employee provisioning, granular quarry permission matrix, user directory, and temporary password resets.
- **App Release Center:** APK release upload, version tracking, withdrawal, and permanent deletion with physical file cleanup.
- **Document Center & Trash:** Document browsing, multi-level folder navigation, version history inspection, and 30-day trash recovery.
- **Full Arabic UI:** Native Arabic RTL interface designed specifically for operational workflows.

---

## Mobile Application (`android/`)

The Android Employee Application is built with Kotlin, Jetpack Compose, and OkHttp:
- **Contract Compatibility:** Communicates directly with the Node.js Express backend.
- **Single-Session Compliance:** Transmits `X-Session-Id` header with every authenticated request, cleanly handling session termination.
- **In-App Update Workflow:** Checks `/app/updates/latest`, downloads APK binaries directly from `/app/updates/download/:versionCode`, and prompts for installation.
- **Offline Scanner & Document Capture:** Integrated camera document scanner with edge detection and PDF generation.

---

## Verification & Testing

Every component includes comprehensive automated tests:

```bash
# 1. Backend Integration Tests (Vitest)
cd backend
npm run test
# Expected: 21 passed (21), 137 passed (137)

# 2. Backend TypeScript Compilation
npm run build
# Expected: tsc exits with code 0

# 3. Admin Next.js Production Build
cd ../admin
npm run build
# Expected: Compiled successfully, all static pages generated

# 4. Android Unit Tests
cd ../android
.\gradlew.bat test
# Expected: BUILD SUCCESSFUL
```
