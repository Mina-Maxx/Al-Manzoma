# QuarryVault — Production Deployment Checklist

This checklist defines all required operational, security, infrastructure, and configuration steps for deploying QuarryVault to production.

---

## 1. Environment Variables (Names Only — No Secrets)

### Backend (`backend/.env`)

- [ ] `PORT` (e.g. `8000`)
- [ ] `NODE_ENV` (`production`)
- [ ] `CORS_ORIGIN` (Comma-separated allowed origins, e.g. `https://admin.yourdomain.com`)
- [ ] `MONGODB_URI` (MongoDB connection URI targeting a replica set)
- [ ] `JWT_SECRET` (Cryptographically secure string, minimum 32 characters)
- [ ] `JWT_ISSUER` (Token issuer identifier)
- [ ] `JWT_AUDIENCE` (Token audience identifier)
- [ ] `SYNC_CURSOR_SECRET` (Cryptographically secure string, minimum 32 characters, for HMAC cursors)
- [ ] `STORAGE_BACKEND` (`r2`)
- [ ] `R2_ACCOUNT_ID` (Cloudflare account identifier)
- [ ] `R2_BUCKET_NAME` (Private Cloudflare R2 bucket name)
- [ ] `R2_ACCESS_KEY_ID` (Cloudflare R2 S3 API Access Key ID)
- [ ] `R2_SECRET_ACCESS_KEY` (Cloudflare R2 S3 API Secret Access Key)
- [ ] `R2_ENDPOINT` (Optional custom S3 endpoint URL)
- [ ] `R2_REGION` (`auto`)
- [ ] `DEFAULT_COMPANY_QUOTA_BYTES` (`5368709120` — 5 GiB)
- [ ] `DEFAULT_COMPANY_MAX_USERS` (`50`)
- [ ] `MAX_FILE_SIZE_BYTES` (`104857600` — 100 MiB)
- [ ] `IDEMPOTENCY_LEASE_SECONDS` (`300`)
- [ ] `INVITE_RATE_LIMIT_PER_MINUTE` (`10`)

### Admin Dashboard (`admin/.env.local` or environment)

- [ ] `NEXT_PUBLIC_API_URL` (Public URL of the Express backend API)
- [ ] `PORT` (`3001`)

### Android Application (`local.properties` or CI environment)

- [ ] `backend.base.url` (Public production backend URL)

---

## 2. Infrastructure & Database Prerequisites

- [ ] **MongoDB Replica Set:** Production MongoDB cluster must run as a Replica Set (`rs0`) to support change streams and distributed multi-document updates.
- [ ] **Unique Compound Indexes:** Verified automatically during Mongoose model initialization.
- [ ] **Cloudflare R2 Private Bucket:**
  - [ ] Ensure public read access is disabled.
  - [ ] Enable Bucket Versioning in the Cloudflare dashboard to safeguard against accidental overwrites.
  - [ ] Generate S3 API Token with read, write, and delete permissions.
- [ ] **Zero Local Storage in Production:** Ensure `STORAGE_BACKEND=r2`. Production startup will abort if `STORAGE_BACKEND=local` is set or if credentials are missing.

---

## 3. Security & Operational Hardening

- [ ] **Production Secret Validation:** Confirmed that `validateProductionConfig()` runs during server bootstrap, rejecting any dev placeholder strings.
- [ ] **Rate Limiting:** Verified that `loginLimiter` (30 req / 15 min) and `passwordLimiter` (15 req / 15 min) are active on authentication routes.
- [ ] **Security Headers:** Strict CSP, HSTS, X-Content-Type-Options (`nosniff`), X-Frame-Options (`DENY`), and Referrer-Policy configured via Helmet and custom middleware.
- [ ] **Audit Trail:** Confirm audit collection is populated and that passwords, access tokens, and storage keys are sanitized from audit metadata.

---

## 4. Backup & Disaster Recovery Prerequisites

- [ ] **RTO Target:** 2 hours maximum.
- [ ] **RPO Target:** 4 hours maximum.
- [ ] **Scheduled `mongodump`:** Configure automated cron job running every 4 hours with `--oplog` and `--archive` flags.
- [ ] **R2 Secondary Sync:** Configure nightly mirror sync of R2 bucket objects to secondary backup storage.
- [ ] **Automated Purge Routine:** Schedule `npm run purge` (via cron or Kubernetes CronJob) to run daily for permanent purging of documents soft-deleted more than 30 days ago.

---

## 5. Build & Verification Steps

1. **Backend Build & Verification:**
   ```bash
   cd backend
   npm install --omit=dev
   npm run build
   node dist/server.js
   ```
   Verify health response:
   ```bash
   curl http://localhost:8000/health
   ```
2. **Admin Web App Build:**
   ```bash
   cd admin
   npm install --omit=dev
   npm run build
   npm start
   ```
3. **Android Client Release Build:**
   ```bash
   cd android
   ./gradlew.bat assembleRelease
   ```
