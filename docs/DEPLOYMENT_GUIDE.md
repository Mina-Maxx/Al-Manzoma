# QuarryVault — Production Deployment & Operator's Guide

This guide details the deployment, configuration, and verification of QuarryVault's modernized architecture:
- **Backend:** Node.js (Express + TypeScript)
- **Database:** MongoDB (Mongoose with strict schema validation)
- **File Storage:** Cloudflare R2 (S3-compatible API with fallback to local disk)
- **Admin Web Application:** Next.js (TypeScript, Pages router, bilingual RTL/LTR)
- **Mobile Client:** Android (Kotlin + Jetpack Compose)

---

## 1. Prerequisites

- **Node.js:** v20.x or v22.x LTS (v24 compatible)
- **npm:** v10.x or v11.x
- **MongoDB:** v6.0+ or v7.0+ (replica set `rs0` enabled if transactions/change-streams are used)
- **Cloudflare Account:** Cloudflare R2 bucket enabled with an S3 API Token (Access Key ID and Secret Access Key)
- **Android SDK:** API 34+ for mobile build and execution

---

## 2. Environment Configuration

### 2.1 Backend Configuration (`backend/.env`)

Copy `backend/.env.example` to `backend/.env` and supply production values:

```env
# Server
PORT=8000
NODE_ENV=production
WEB_ORIGIN=https://admin.example.com

# MongoDB
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>/quarryvault?retryWrites=true&w=majority

# JWT & Authentication
JWT_SECRET=<random-secret-at-least-32-characters>
JWT_ISSUER=quarryvault
JWT_AUDIENCE=quarryvault
SYNC_CURSOR_SECRET=<stable-random-secret-at-least-32-characters>
# Configure these when accepting Supabase-issued JWTs
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_JWT_AUDIENCE=authenticated
SUPABASE_JWT_ALGORITHMS=RS256,ES256

# Storage backend (r2 | s3 | local)
STORAGE_BACKEND=r2

# Cloudflare R2 Configuration
R2_ACCOUNT_ID=<cloudflare-account-id>
R2_ACCESS_KEY_ID=<r2-access-key-id>
R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
R2_BUCKET_NAME=quarryvault-documents
R2_REGION=auto
# Optional custom R2 endpoint (defaults from R2_ACCOUNT_ID)
# R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com

# Local storage root (development only; rejected in production)
STORAGE_LOCAL_ROOT=.storage

# Quotas & Limits
DEFAULT_COMPANY_QUOTA_BYTES=5368709120  # 5 GiB
DEFAULT_COMPANY_MAX_USERS=10
MAX_FILE_SIZE_BYTES=10485760            # 10 MiB
```

### 2.2 Admin Web Application Configuration (`admin/.env.local`)

```env
# URL of the QuarryVault Express Backend
NEXT_PUBLIC_API_URL=http://localhost:8000
PORT=3001
```

---

## 3. Installation & Build Steps

### 3.1 Backend Build

```bash
cd backend
npm install
npm run build
```
The compiled output is emitted to `backend/dist/`.

To run database seeding (initial superadmin, company, and quarries):
```bash
npm run seed
```

To run the automated test suite:
```bash
npm test
```

### 3.2 Admin Web Application Build

```bash
cd admin
npm install
npm run build
```
The standalone optimized production build is emitted to `admin/.next/`.

### 3.3 Android Application Build

```bash
cd android
./gradlew.bat testDebugUnitTest
./gradlew.bat assembleDebug
```
The generated APK is located at:
`android/app/build/outputs/apk/debug/app-debug.apk`

---

## 4. Starting Production Services

### 4.1 Running with Node.js / Process Manager (PM2)

```bash
# Start Backend
cd backend
pm2 start dist/server.js --name "quarryvault-backend"

# Start Next.js Admin Web App
cd ../admin
pm2 start npm --name "quarryvault-admin" -- start -- -p 3001
```

### 4.2 System Health & Verification Endpoints

Verify operational status via curl or browser:

1. **Backend Health Check:**
   ```bash
   curl http://localhost:8000/health
   ```
   Expected response:
   ```json
   {
     "status": "healthy",
     "database": "connected",
     "storage": "connected",
     "timestamp": "2026-10-28T03:15:00.000Z"
   }
   ```

2. **Mobile App Configuration Endpoint:**
   ```bash
   curl http://localhost:8000/app/config
   ```

3. **Latest App Release Check:**
   ```bash
   curl http://localhost:8000/app/updates/latest
   ```

4. **Admin Dashboard:**
   Visit `http://localhost:3001` or `http://localhost:8000/dashboard` in your browser.

---

## 5. Security & Isolation Best Practices

1. **Private R2 Buckets:** Ensure public access is disabled on the R2 bucket. All access is controlled and signed by the backend application.
2. **Atomic Quota Enforcement:** Storage limits are enforced atomically in MongoDB using single-operation conditional updates (`$expr` with `$inc`), eliminating overselling during concurrent uploads.
3. **Session Revocation:** Role changes, temporary password enforcement, and manual session revocations take effect immediately on subsequent requests.
4. **Audit Trail:** All sensitive operations (creations, deletions, downloads, updates, quota changes, privilege modifications) are recorded with actor, IP, timestamp, and result in the security audit log.
