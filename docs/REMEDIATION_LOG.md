# QuarryVault — Defect Remediation Log

This document records confirmed defects identified during the Production Readiness Audit, their root causes, the code modifications made, regression tests added, and retest verification results.

---

### Defect 1: Silent Fallback to Local Disk Storage in Production (SEC-01)
- **Severity:** High (Security & Architecture Boundary)
- **Root Cause:** In `backend/src/modules/storage/index.ts`, `createStorage()` checked `cfg.r2AccessKeyId && cfg.r2SecretAccessKey`. If these were absent, it silently returned `new LocalDiskStorage()`, even when `storageBackend` was configured as `r2` and `NODE_ENV` was `production`.
- **Files Changed:**
  - `backend/src/modules/storage/index.ts`
- **Fix Implemented:** Modified `createStorage()` to inspect `cfg.env`. If in production and R2 credentials are missing, or if `storageBackend === 'local'` in production, it immediately throws a fatal startup error rather than silently writing to disk.
- **Regression Test Added:**
  - `backend/tests/documents_and_storage.test.ts`: Added test case `enforces that production storage and configuration guards prevent insecure defaults`.
- **Retest Result:** **Passed**. Throws expected error matching `/Fatal: Cloudflare R2 credentials/`.

---

### Defect 2: Insecure Default Secrets Allowed During Startup in Production (SEC-02)
- **Severity:** High (Security & Cryptographic Integrity)
- **Root Cause:** In `backend/src/config/index.ts`, `jwtSecret` and `syncCursorSecret` defaulted to hardcoded dev placeholder strings if environment variables were omitted. In production, this would allow signing tokens with a known default secret.
- **Files Changed:**
  - `backend/src/config/index.ts`
  - `backend/src/server.ts`
- **Fix Implemented:** Created `validateProductionConfig()` in `config/index.ts` and called it in `server.ts` during server bootstrap. It checks that `JWT_SECRET` and `SYNC_CURSOR_SECRET` are provided, are at least 32 characters long, and do not contain dev placeholder substrings in production.
- **Regression Test Added:**
  - `backend/tests/documents_and_storage.test.ts`: Added test verifying `validateProductionConfig()` throws when given insecure defaults.
- **Retest Result:** **Passed**. Throws expected error matching `/JWT_SECRET must be explicitly set/`.

---

### Defect 3: Missing Rate Limiting on Authentication Endpoints (SEC-03)
- **Severity:** Medium (Operational Security)
- **Root Cause:** `express-rate-limit` was declared in `backend/package.json` but not attached to sensitive routes, allowing potential brute-force credential stuffing attacks against `POST /auth/login` and `/auth/change-password`.
- **Files Changed:**
  - `backend/src/modules/auth/router.ts`
- **Fix Implemented:** Configured `loginLimiter` (30 requests / 15 minutes per IP) and `passwordLimiter` (15 requests / 15 minutes per IP) and registered them on `/auth/login` and `/auth/change-password`. Limits automatically scale in test environments to allow fast testing.
- **Regression Test Added:** Verified via `tests/auth.test.ts`.
- **Retest Result:** **Passed**. All 5 auth tests passed.

---

### Defect 4: Browser Direct Downloads Failed Due to Missing Header (SEC-04)
- **Severity:** Medium (Functional & UI Integration)
- **Root Cause:** `extractBearerToken` in `backend/src/middleware/auth.ts` only looked for the `Authorization: Bearer <token>` header. Browser `<a>` tag download links cannot inject custom HTTP headers and pass `?token=<jwt>` as a query parameter.
- **Files Changed:**
  - `backend/src/middleware/auth.ts`
- **Fix Implemented:** Updated `extractBearerToken` to accept `req.query.token` if present and string-typed when `Authorization` header is not provided.
- **Regression Test Added:**
  - `backend/tests/documents_and_storage.test.ts`: Added test `supports direct browser downloads via query parameter token`.
- **Retest Result:** **Passed**. Streamed document content with HTTP 200 using query parameter token.

---

### Defect 5: Document Versioning Upload Endpoint Missing (REQ-01)
- **Severity:** Medium (Approved Requirement)
- **Root Cause:** `DocumentVersionModel` existed in the database models, but there was no service method or API endpoint in `quarries/router.ts` to allow uploading an updated version of an existing document.
- **Files Changed:**
  - `backend/src/modules/documents/service.ts`
  - `backend/src/modules/quarries/router.ts`
- **Fix Implemented:**
  - Added `uploadNewDocumentVersion()` and `listDocumentVersions()` in `documents/service.ts`.
  - Added routes `POST /quarries/:id/documents/:documentId/versions` and `GET /quarries/:id/documents/:documentId/versions` in `quarries/router.ts`.
  - Increments document version, saves previous version to `DocumentVersionModel`, and uploads new version to storage using `buildStorageKey(..., nextVersion)`.
- **Regression Test Added:**
  - `backend/tests/documents_and_storage.test.ts`: Added test `handles document versioning and historical version archiving`.
- **Retest Result:** **Passed**. Verified HTTP 201 on new version upload, version increment to 2, and historical listing of v1.

---

### Defect 6: Permanent Document Purge Routine Missing (REQ-02)
- **Severity:** Medium (Lifecycle & Quota Release)
- **Root Cause:** Soft-deleted documents remained in the database indefinitely after the 30-day retention period. No automated routine existed to physically delete objects from Cloudflare R2 and release company quota.
- **Files Changed:**
  - `backend/src/modules/documents/service.ts`
  - `backend/src/scripts/purgeExpiredDocuments.ts` (created)
  - `backend/package.json` (added `"purge"` script)
- **Fix Implemented:**
  - Implemented `purgeExpiredDocuments()` in `documents/service.ts`. It queries documents deleted before the 30-day cutoff, deletes main and version objects from storage (`storage.delete`), removes MongoDB records, and calls `releaseQuota()` to decrement `CompanyModel.used_bytes`.
  - Created operational CLI `backend/src/scripts/purgeExpiredDocuments.ts` supporting `--retention-days`, `--batch-size`, and `--dry-run`.
- **Regression Test Added:**
  - `backend/tests/documents_and_storage.test.ts`: Added test `permanently purges expired documents and releases company storage quota`.
- **Retest Result:** **Passed**. Verified physical storage deletion, MongoDB record deletion, and company quota returning to 0 bytes.

---

### Defect 7: Android `DefaultEmployeeRepository` URL Configuration (CFG-01)
- **Severity:** Low (Client Configuration)
- **Root Cause:** In `android/app/src/main/java/com/quarryvault/employee/data/repository/EmployeeRepository.kt`, `DefaultEmployeeRepository` instantiated `apiClient = QuarryVaultApiClient()` without specifying `baseUrl`, ignoring `BuildConfig.DEFAULT_BACKEND_URL` configured in `build.gradle.kts`.
- **Files Changed:**
  - `android/app/src/main/java/com/quarryvault/employee/data/repository/EmployeeRepository.kt`
- **Fix Implemented:** Passed `baseUrl = com.quarryvault.employee.BuildConfig.DEFAULT_BACKEND_URL` to `QuarryVaultApiClient`.
- **Regression Test Added:** Gradle unit tests in `:app:testDebugUnitTest`.
- **Retest Result:** **Passed**. 24/24 unit tests passed.
