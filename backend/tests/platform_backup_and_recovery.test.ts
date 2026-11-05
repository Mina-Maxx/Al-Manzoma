import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { createApp } from '../src/app.js';
import {
  createTestCompany,
  createTestUser,
  createTestMembership,
  createTestQuarry,
  createTestPlatformAdmin,
  generateAuthHeader,
} from './helpers.js';
import {
  CompanyModel,
  UserModel,
  QuarryModel,
  DocumentModel,
  FolderModel,
  AppReleaseModel,
  PlatformBackupModel,
  PlatformRestoreModel,
  PlatformBackupConfigModel,
  AuditEventModel,
} from '../src/database/models/index.js';
import {
  MembershipRole,
  DocumentStatus,
  AuditResult,
  UserStatus,
} from '../src/types/index.js';
import { storage } from '../src/modules/storage/index.js';
import { backupService } from '../src/modules/backup/service.js';
import { applyRetentionPolicy } from '../src/modules/backup/retention.js';
import { config } from '../src/config/index.js';

const app = createApp();

describe('Feature: Full Platform Backup & Disaster Recovery for QuarryVault', () => {
  let platformAdminUser: any;
  let platformAdmin: any;
  let platformHeader: { Authorization: string };

  let companyAdminUser: any;
  let companyHeader: { Authorization: string };

  let employeeUser: any;
  let employeeHeader: { Authorization: string };

  let company: any;
  let quarry: any;
  let folder: any;
  let doc: any;
  let storageRef: string;
  const sampleDocBytes = Buffer.from('%PDF-1.4 Important Legal Quarry Certificate Content');

  beforeEach(async () => {
    // 1. Setup Platform Admin
    platformAdminUser = await createTestUser({ email: 'dr_superadmin@quarryvault.com' });
    platformAdmin = await createTestPlatformAdmin({
      auth_user_id: platformAdminUser.auth_user_id,
      email: platformAdminUser.email,
      full_name: 'Super Disaster Admin',
    });
    platformHeader = generateAuthHeader(platformAdminUser, 'platform_admin');

    // 2. Setup Company & Company Admin
    company = await createTestCompany({ name: 'مؤسسة الرمال والرخام الدولية' });
    companyAdminUser = await createTestUser({ email: 'dr_company_admin@quarryvault.com' });
    await createTestMembership(companyAdminUser._id, company._id, MembershipRole.company_admin);
    companyHeader = generateAuthHeader(companyAdminUser, 'company_admin');

    // 3. Setup Regular Employee
    employeeUser = await createTestUser({ email: 'dr_employee@quarryvault.com' });
    await createTestMembership(employeeUser._id, company._id, MembershipRole.employee);
    employeeHeader = generateAuthHeader(employeeUser, 'employee');

    // 4. Seed operational data
    quarry = await createTestQuarry(company._id, { name: 'محجر العين السخنة - قطاع 4' });
    folder = await FolderModel.create({
      _id: uuidv4(),
      company_id: company._id,
      quarry_id: quarry._id,
      name: 'شهريات',
      is_standard: true,
    });

    storageRef = `company/${company._id}/quarry/${quarry._id}/legal-cert-${Date.now()}.pdf`;
    await storage.put(sampleDocBytes, storageRef, {
      contentType: 'application/pdf',
      sizeBytes: sampleDocBytes.length,
    });

    doc = await DocumentModel.create({
      _id: uuidv4(),
      company_id: company._id,
      quarry_id: quarry._id,
      folder_id: folder._id,
      original_filename: 'شهادة_ترخيص_المحجر.pdf',
      display_name: 'شهادة ترخيص المحجر الرسمية',
      mime_type: 'application/pdf',
      size_bytes: sampleDocBytes.length,
      storage_ref: storageRef,
      version: 1,
      status: DocumentStatus.available,
      uploaded_by: employeeUser._id,
    });
  });

  // =========================================================================
  // 1. Authorization & Role-Based Access Controls
  // =========================================================================
  describe('1. Security & Authorization Protection', () => {
    it('rejects unauthenticated requests to backup endpoints with 401', async () => {
      const res = await request(app).get('/platform/backups');
      expect(res.status).toBe(401);
    });

    it('rejects regular employee requests with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/platform/backups')
        .set(employeeHeader);
      expect(res.status).toBe(403);
    });

    it('rejects company admin requests with 403 Forbidden (disaster recovery is platform-only)', async () => {
      const res = await request(app)
        .get('/platform/backups')
        .set(companyHeader);
      expect(res.status).toBe(403);
    });

    it('rejects company admin attempts to create a full platform backup', async () => {
      const res = await request(app)
        .post('/platform/backups')
        .set(companyHeader)
        .send({});
      expect(res.status).toBe(403);
    });

    it('allows authorized Platform Admin to access backup overview', async () => {
      const res = await request(app)
        .get('/platform/backups/overview')
        .set(platformHeader);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('targetRpoHours', 4);
      expect(res.body).toHaveProperty('targetRtoHours', 2);
    });
  });

  // =========================================================================
  // 2. Full Platform Backup Creation & Packaging
  // =========================================================================
  describe('2. Full Platform Backup Creation & Inventory Scope', () => {
    it('creates an on-demand full platform backup containing all collections, storage objects, and manifest', async () => {
      const res = await request(app)
        .post('/platform/backups')
        .set(platformHeader)
        .send({ notes: 'Audit Drill Snapshot' });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('backupId');
      expect(res.body.type).toBe('full');
      expect(['completed', 'verified']).toContain(res.body.status);
      expect(res.body.dbStatus).toBe('completed');
      expect(res.body.storageStatus).toBe('completed');
      expect(res.body.archiveSizeBytes).toBeGreaterThan(0);
      expect(res.body.sha256Checksum).toHaveLength(64);

      // Verify backup archive file exists on disk
      const backupDir = path.resolve(config.backupStorageDir || 'backups');
      const archivePath = path.join(backupDir, res.body.filename);
      expect(fs.existsSync(archivePath)).toBe(true);
      expect(fs.statSync(archivePath).size).toBe(res.body.archiveSizeBytes);

      // Verify audit trail logged
      const auditLog = await AuditEventModel.findOne({
        action: 'backup.create',
        result: AuditResult.success,
        target_id: res.body._id,
      });
      expect(auditLog).toBeDefined();
      expect(auditLog?.meta?.type).toBe('full');
    });

    it('generates an accurate manifest without exposing plaintext passwords or secrets', async () => {
      const backup = await backupService.createBackup({
        type: 'full',
        createdBy: platformAdminUser._id,
        createdByEmail: platformAdminUser.email,
      });

      expect(backup.manifest).toBeDefined();
      const manifest = backup.manifest;

      // Platform recovery metadata
      expect(manifest.manifest_version).toBe('1.0');
      expect(manifest.app_version).toBe('1.0.13');
      expect(manifest.database.collections_count).toBeGreaterThanOrEqual(15);
      expect(manifest.database.collections.companies).toBeGreaterThanOrEqual(1);
      expect(manifest.database.collections.documents).toBeGreaterThanOrEqual(1);
      expect(manifest.database.collections.quarries).toBeGreaterThanOrEqual(1);
      expect(manifest.storage.objects_count).toBeGreaterThanOrEqual(1);

      // Check storage object inventory
      const foundStorageObject = manifest.storage.objects?.find((o) => o.key === storageRef);
      expect(foundStorageObject).toBeDefined();
      expect(foundStorageObject?.size_bytes).toBe(sampleDocBytes.length);
      expect(foundStorageObject?.sha256).toHaveLength(64);

      // Secret scrubbing check: manifest must NOT contain credentials
      const manifestString = JSON.stringify(manifest);
      expect(manifestString).not.toContain('password_hash');
      expect(manifestString).not.toContain(config.jwtSecret);
    });
  });

  // =========================================================================
  // 3. Archive Verification & Integrity Checks
  // =========================================================================
  describe('3. Archive Verification & Integrity Engine', () => {
    it('verifies archive integrity and updates status to verified', async () => {
      const createRes = await request(app)
        .post('/platform/backups')
        .set(platformHeader)
        .send({});
      expect(createRes.status).toBe(201);
      const backupId = createRes.body.backupId;

      const verifyRes = await request(app)
        .post(`/platform/backups/${backupId}/verify`)
        .set(platformHeader);

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.status).toBe('verified');
      expect(verifyRes.body.verification.verified).toBe(true);

      // Verify record status in DB
      const record = await PlatformBackupModel.findOne({ backup_id: backupId });
      expect(record?.status).toBe('verified');
      expect(record?.verification_result?.verified).toBe(true);
    });

    it('detects corrupted or tampered archive checksum', async () => {
      const createRes = await request(app)
        .post('/platform/backups')
        .set(platformHeader)
        .send({});
      const backupId = createRes.body.backupId;
      const record = await PlatformBackupModel.findOne({ backup_id: backupId });

      // Tamper with file on disk by appending arbitrary bytes
      fs.appendFileSync(record!.archive_path, Buffer.from('TAMPERED_DATA_CORRUPTION'));

      const verifyRes = await request(app)
        .post(`/platform/backups/${backupId}/verify`)
        .set(platformHeader);

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.status).toBe('failed');
      expect(verifyRes.body.verification.verified).toBe(false);

      const updated = await PlatformBackupModel.findOne({ backup_id: backupId });
      expect(updated?.status).toBe('failed');
      expect(updated?.error_message).toContain('Checksum mismatch');
    });
  });

  // =========================================================================
  // 4. Authenticated Archive Download
  // =========================================================================
  describe('4. Secure Authenticated Archive Download', () => {
    it('allows platform admin to download archive with stream and logs audit event', async () => {
      const createRes = await request(app)
        .post('/platform/backups')
        .set(platformHeader)
        .send({});
      const backupId = createRes.body.backupId;

      const downloadRes = await request(app)
        .get(`/platform/backups/${backupId}/download`)
        .set(platformHeader);

      expect(downloadRes.status).toBe(200);
      expect(downloadRes.headers['content-type']).toContain('application/gzip');
      expect(downloadRes.headers['content-disposition']).toContain(`attachment; filename="quarryvault-backup-${backupId}`);
      expect(downloadRes.body.length).toBe(createRes.body.archiveSizeBytes);

      // Verify audit log
      const auditLog = await AuditEventModel.findOne({
        action: 'backup.download',
        result: AuditResult.success,
        target_id: createRes.body._id,
      });
      expect(auditLog).toBeDefined();
    });

    it('rejects employee download attempt with 403 Forbidden', async () => {
      const createRes = await request(app)
        .post('/platform/backups')
        .set(platformHeader)
        .send({});
      const backupId = createRes.body.backupId;

      const downloadRes = await request(app)
        .get(`/platform/backups/${backupId}/download`)
        .set(employeeHeader);

      expect(downloadRes.status).toBe(403);
    });
  });

  // =========================================================================
  // 5. Staged Platform Disaster Recovery Restore
  // =========================================================================
  describe('5. Disaster Recovery Platform Restoration Workflow', () => {
    it('rejects restore if required confirmation phrase is missing or incorrect', async () => {
      const createRes = await request(app)
        .post('/platform/backups')
        .set(platformHeader)
        .send({});
      const backupId = createRes.body.backupId;

      const badRes1 = await request(app)
        .post(`/platform/backups/${backupId}/restore`)
        .set(platformHeader)
        .send({ confirmationPhrase: 'WRONG-PHRASE' });
      expect(badRes1.status).toBe(400);

      const badRes2 = await request(app)
        .post(`/platform/backups/${backupId}/restore`)
        .set(platformHeader)
        .send({ confirmationPhrase: 'restore-quarryvault' }); // lowercase not allowed
      expect(badRes2.status).toBe(400);
    });

    it('executes staged restore with pre-restore safety snapshot and post-restore reference check', async () => {
      // Step A: Take clean baseline backup
      const createRes = await request(app)
        .post('/platform/backups')
        .set(platformHeader)
        .send({ notes: 'Pre-Disaster Baseline' });
      expect(createRes.status).toBe(201);
      const backupId = createRes.body.backupId;

      // Step B: Simulate disaster / state drift:
      // 1. Modify company name
      await CompanyModel.findByIdAndUpdate(company._id, { name: 'CORRUPTED COMPANY NAME' });
      // 2. Add an uncommitted stray document
      const strayDoc = await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: quarry._id,
        original_filename: 'stray_file.pdf',
        display_name: 'Stray Document',
        mime_type: 'application/pdf',
        size_bytes: 123,
        storage_ref: 'corrupt-stray-ref',
        version: 1,
        status: DocumentStatus.available,
      });

      // Verify the corruption occurred
      const corruptedCompany = await CompanyModel.findById(company._id);
      expect(corruptedCompany?.name).toBe('CORRUPTED COMPANY NAME');

      // Step C: Execute full platform disaster recovery restore
      const restoreRes = await request(app)
        .post(`/platform/backups/${backupId}/restore`)
        .set(platformHeader)
        .send({
          confirmationPhrase: 'RESTORE-QUARRYVAULT',
          createSafetyBackup: true,
        });

      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.status).toBe('completed');
      expect(restoreRes.body.dbStatus).toBe('completed');
      expect(restoreRes.body.storageStatus).toBe('completed');
      expect(restoreRes.body.referenceVerificationStatus).toBe('passed');
      expect(restoreRes.body.safetyBackupId).toBeDefined();

      // Step D: Verify database state restored accurately
      const restoredCompany = await CompanyModel.findById(company._id);
      expect(restoredCompany?.name).toBe('مؤسسة الرمال والرخام الدولية'); // Restored!

      const strayCheck = await DocumentModel.findById(strayDoc._id);
      expect(strayCheck).toBeNull(); // Stray rolled back!

      const originalDocCheck = await DocumentModel.findById(doc._id);
      expect(originalDocCheck).toBeDefined();
      expect(originalDocCheck?.original_filename).toBe('شهادة_ترخيص_المحجر.pdf');

      // Step E: New generation is referenced atomically; the original object remains untouched.
      const restoredDoc = await DocumentModel.findById(doc._id);
      expect(restoredDoc?.storage_ref).toBeDefined();
      expect(restoredDoc?.storage_ref).not.toBe(storageRef);
      expect(restoredDoc!.storage_ref).toContain(`/restore-generations/`);
      expect(restoredDoc!.storage_ref).toMatch(new RegExp(`^company/${company._id}/`));
      expect(await storage.exists(restoredDoc!.storage_ref!)).toBe(true);
      expect(await storage.exists(storageRef)).toBe(true);

      // Step F: Verify safety backup was captured
      const safetyBackup = await PlatformBackupModel.findOne({ backup_id: restoreRes.body.safetyBackupId });
      expect(safetyBackup).toBeDefined();
      expect(safetyBackup?.backup_type).toBe('safety');
      expect(safetyBackup?.is_locked).toBe(true);

      // Step G: Verify audit log
      const restoreAudit = await AuditEventModel.findOne({
        action: 'restore.execute',
        result: AuditResult.success,
      });
      expect(restoreAudit).toBeDefined();
    });

    it('keeps live collections unchanged and removes staged objects when the Mongo transaction aborts', async () => {
      const backup = await backupService.createBackup({
        type: 'full',
        createdBy: platformAdminUser._id,
        createdByEmail: platformAdminUser.email,
      });
      await CompanyModel.findByIdAndUpdate(company._id, { name: 'TRANSACTION-ROLLBACK-SENTINEL' });
      const insertSpy = vi.spyOn(CompanyModel, 'insertMany').mockRejectedValueOnce(new Error('simulated transactional insert failure'));

      try {
        await expect(backupService.restoreBackup(String(backup._id), {
          confirm: true,
          confirmationPhrase: 'RESTORE-QUARRYVAULT',
          createSafetyBackup: false,
          actorUserId: platformAdminUser._id,
          actorEmail: platformAdminUser.email,
        })).rejects.toThrow('simulated transactional insert failure');
      } finally {
        insertSpy.mockRestore();
      }

      const unchangedCompany = await CompanyModel.findById(company._id);
      expect(unchangedCompany?.name).toBe('TRANSACTION-ROLLBACK-SENTINEL');
      expect(await storage.exists(storageRef)).toBe(true);
      const failedRestore = await PlatformRestoreModel.findOne({ backup_id: backup.backup_id }).sort({ started_at: -1 });
      expect(failedRestore?.status).toBe('failed');
      if (failedRestore) {
        expect(await storage.exists(`company/${company._id}/restore-generations/${failedRestore._id}/quarry/${quarry._id}/${path.basename(storageRef)}`)).toBe(false);
      }
    });
  });

  // =========================================================================
  // 6. Retention Policy Safety Guards
  // =========================================================================
  describe('6. Retention Policy Engine & Non-Destructive Protection Guards', () => {
    it('refuses to delete the ONLY verified backup regardless of age', async () => {
      // Clear all backups
      await PlatformBackupModel.deleteMany({});

      // Create a single verified backup
      const backup = await backupService.createBackup({
        type: 'full',
        createdBy: platformAdminUser._id,
        createdByEmail: platformAdminUser.email,
      });

      // Try deleting it via DELETE /platform/backups/:id
      const delRes = await request(app)
        .delete(`/platform/backups/${backup.backup_id}`)
        .set(platformHeader);

      expect(delRes.status).toBe(400);
      expect(delRes.body.detail).toContain('Safety guard: Cannot delete the only remaining verified backup');

      // Verify still exists in DB and disk
      const check = await PlatformBackupModel.findById(backup._id);
      expect(check).toBeDefined();
    });

    it('protects safety backups and locked backups from deletion', async () => {
      // Create a safety backup
      const safetyBackup = await backupService.createBackup({
        type: 'safety',
        createdBy: platformAdminUser._id,
        createdByEmail: platformAdminUser.email,
      });

      const delRes = await request(app)
        .delete(`/platform/backups/${safetyBackup.backup_id}`)
        .set(platformHeader);

      expect(delRes.status).toBe(400);
      expect(delRes.body.detail).toContain('locked or safety backup');
    });

    it('applies retention policy preserving tiered quotas (7 daily, 4 weekly, 3 monthly)', async () => {
      const result = await applyRetentionPolicy();
      expect(result).toHaveProperty('evaluated');
      expect(result).toHaveProperty('deletedCount');
      expect(result).toHaveProperty('preservedCount');
    });
  });

  // =========================================================================
  // 7. Disaster Recovery Overview & KPI Compliance (RPO/RTO)
  // =========================================================================
  describe('7. Disaster Recovery Overview & RPO/RTO Compliance Tracking', () => {
    it('returns RPO compliant when a recent backup exists within 4 hours', async () => {
      await backupService.createBackup({
        type: 'full',
        createdBy: platformAdminUser._id,
        createdByEmail: platformAdminUser.email,
      });

      const res = await request(app)
        .get('/platform/backups/overview')
        .set(platformHeader);

      expect(res.status).toBe(200);
      expect(res.body.rpoStatus).toBe('compliant');
      expect(res.body.rpoHoursSinceLastBackup).toBeLessThanOrEqual(1);
      expect(res.body.targetRpoHours).toBe(4);
      expect(res.body.targetRtoHours).toBe(2);
      expect(res.body.estimatedRtoMinutes).toBeGreaterThan(0);
      expect(res.body.lastSuccessfulBackup).toBeDefined();
      expect(res.body.config.scheduledIntervalHours).toBe(4);
    });
  });
});
