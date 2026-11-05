# QuarryVault — Backup, Recovery, and Disaster Management Guide

## 1. Overview & Service Level Targets

QuarryVault utilizes a decoupled storage and persistence architecture:
1. **Metadata & Entity Store:** MongoDB (Companies, Users, Memberships, Quarries, Permissions, Folders, Documents metadata, Idempotency keys, Audit trail, Sync change log).
2. **Binary Document Storage:** Cloudflare R2 (S3-compatible API, private bucket, encrypted at rest).
3. **Client State Cache:** SQLite / Room on Android mobile clients, localStorage on Next.js admin dashboard.

### Recovery Targets (Not Yet Verified Guarantees)
- **Recovery Time Objective (RTO):** target of **2 hours** from incident declaration to restored client operations.
- **Recovery Point Objective (RPO):** target of **4 hours** maximum data loss.

These are targets, not verified service guarantees. Do not claim they are met until scheduled backup jobs, job monitoring/alerting, replica-set oplog coverage, R2 object versioning, and timed restore drills have all been configured and evidenced in the actual deployment. This repository documentation alone does not prove those controls are running.

---

## 2. MongoDB Backup & Restoration Procedures

### 2.1 Scheduled Online Backup (`mongodump`)

Perform automated backups every 4 hours using `mongodump` with gzip compression and archive output:

```bash
# Full backup with oplog for point-in-time consistency (Runs every 4 hours via cron)
mongodump \
  --uri="mongodb://localhost:27017/quarryvault?replicaSet=rs0" \
  --archive="/backup/mongodb/quarryvault_$(date +%Y%m%d_%H%M%S).archive.gz" \
  --gzip \
  --oplog
```

### 2.2 Point-in-Time Recovery (`mongorestore`)

Validate a backup by restoring it into a new, isolated target database/cluster first. Confirm the target is empty and isolated, then compare collection/document counts and application-level invariants before any cutover.

**Destructive operation warning:** `mongorestore --drop` deletes existing collections in the selected target before restoring them. Never copy a restore command into production until the exact target URI/database has been independently verified, a current target backup exists, write traffic is stopped, and the change has explicit approval. A namespace-remapped isolated restore should be used for routine drills; production replacement requires a separately reviewed runbook.

---

## 3. Cloudflare R2 Object Store Backup & Disaster Recovery

### 3.1 Object Versioning & Retention
- **Versioning:** Cloudflare R2 supports bucket object versioning. Enable versioning to ensure soft-deleted or overwritten objects can be recovered.
- **Lifecycle Rules:** Set retention rules on the trash prefix or rely on application-level retention logic (`purge_at: 30 days`).

### 3.2 Offline Bucket Mirroring (rclone / AWS CLI)
Mirror documents to an isolated backup location or secondary bucket on a nightly schedule:

```bash
# Sync R2 bucket to encrypted secondary cold storage
aws s3 sync s3://quarryvault-documents s3://quarryvault-backup-replica \
  --endpoint-url="https://${CLOUDFLARE_R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
```

---

## 4. Timed Disaster Recovery Drill Runbook (RTO <= 2 Hours)

Execute this drill periodically in a staging environment to validate the 2-hour RTO:

```
[00:00 - 00:15] Step 1: Incident Declaration & Traffic Drain
                - Redirect edge DNS to 503 Maintenance Page.
                - Terminate active Node.js backend processes.

[00:15 - 00:45] Step 2: Storage Object Verification & Secondary Sync
                - Verify primary R2 bucket availability.
                - If primary R2 is degraded, repoint CLOUDFLARE_R2_BUCKET to secondary replica.

[00:45 - 01:25] Step 3: MongoDB Database Restoration
                - Fetch latest 4-hour mongodump archive.
                - Execute mongorestore with --oplogReplay and --drop.
                - Verify collection counts (Companies, Users, Documents, Quarries).

[01:25 - 01:40] Step 4: Storage Reference Reconciliation
                - Run reconciliation script to verify that storage_ref values in MongoDB
                  correspond to valid objects in the R2 bucket.

[01:40 - 02:00] Step 5: Service Health Verification & Traffic Restoration
                - Start Express backend and verify GET /health returns 200 { status: 'healthy' }.
                - Verify Next.js admin dashboard and Android client login.
                - Switch edge DNS back to live traffic.
```

---

## 5. 30-Day Trash Retention & Permanent Purge Routine

- **Approved Policy:**
  - Soft-deleted documents are retained for 30 days in `status: available` with `deleted_at` timestamp.
  - While in trash, files continue counting toward the company's 5 GiB storage quota.
  - Permitted users (the deleter or company admin) can restore the file within 30 days.
  - After 30 days, documents become eligible for permanent purging.
- **Scheduled Automated Purge:**
  Run the automated purge script daily via cron or Kubernetes CronJob:
  ```bash
  cd backend
  npm run purge -- --retention-days 30 --batch-size 100
  ```
  The script:
  1. Identifies documents with `deleted_at < now - 30 days`.
  2. Physically deletes the main file and all historical version files from Cloudflare R2 (`storage.delete`).
  3. Removes the document and version records from MongoDB.
  4. Atomically releases the company quota on `CompanyModel` (`releaseQuota`).
  5. Records an immutable audit log entry for `document.purge`.

---

## 6. PostgreSQL Decommissioning & Historical Archive Policy

### 6.1 Decommissioning Status
- The legacy Python/FastAPI/SQLAlchemy/PostgreSQL stack has been completely decommissioned from active service.
- The legacy PostgreSQL database dump is preserved untouched in `quarryvault_dev_verified.dump` as an immutable historical asset.
- Container `quarryvault-pg` and existing Docker volumes are retained safely without modification; no destructive drop operations were performed against the databases.

### 6.2 Primary Database Operation
MongoDB via container `quarryvault-mongodb` is the active, authoritative database for QuarryVault. All collections, indexes, and transactional validations run on MongoDB with automated backup and restore drills managed via `npm run backup:dr`.
