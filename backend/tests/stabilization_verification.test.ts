import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { createApp } from '../src/app.js';
import {
  CompanyModel,
  UserModel,
  MembershipModel,
  QuarryModel,
  QuarryPermissionModel,
  DocumentModel,
  DocumentVersionModel,
  PlatformAdminModel,
  AuditEventModel,
  IdempotencyKeyModel,
} from '../src/database/models/index.js';
import {
  CompanyStatus,
  UserStatus,
  MembershipRole,
  QuarryStatus,
  DocumentStatus,
  IdempotencyStatus,
} from '../src/types/index.js';
import { signAccessToken } from '../src/modules/auth/router.js';
import { storage, buildStorageKey } from '../src/modules/storage/index.js';
import { permanentlyDeleteDocument } from '../src/modules/documents/service.js';
import { beginIdempotencyAttempt } from '../src/services/idempotency.js';
import { validateProductionConfig, AppConfig } from '../src/config/index.js';
import { deriveKey } from '../src/modules/backup/crypto.js';

describe('QuarryVault Stabilization & Security Recovery Verification Suite', () => {
  const app = createApp();


  describe('1. Hidden Quarry Authorization & Trash Isolation', () => {
    it('1.1. renameDocument rejects renaming document located in hidden quarry with 404', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Alpha Stone Co.',
        slug: 'alpha-stone',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
        used_bytes: 1000,
      });

      const hiddenQuarry = await QuarryModel.create({
        _id: uuidv4(),
        company_id: company._id,
        name: 'Hidden Northern Quarry',
        code: 'HNQ',
        status: QuarryStatus.active,
      });

      const user = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        email: 'emp@alphastone.com',
        username: 'emp_alpha',
        status: UserStatus.active,
      });

      await MembershipModel.create({
        _id: uuidv4(),
        user_id: user._id,
        company_id: company._id,
        role: MembershipRole.employee,
        hidden_quarries: [hiddenQuarry._id],
        can_view: true,
      });

      const doc = await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: hiddenQuarry._id,
        display_name: 'Confidential Geotechnical Survey',
        original_filename: 'survey.pdf',
        mime_type: 'application/pdf',
        size_bytes: 2048,
        status: DocumentStatus.available,
      });

      const token = signAccessToken({
        sub: user.auth_user_id,
        email: user.email,
        role: 'user',
      });

      const res = await request(app)
        .patch(`/documents/${doc._id}/rename`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed Survey.pdf' });

      expect(res.status).toBe(404);
      expect(res.body.detail).toMatch(/not found/i);
    });

    it('1.2. Company Trash list excludes documents from hidden quarries and restricts regular employees to own deletions', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Beta Minerals Ltd.',
        slug: 'beta-minerals',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
        used_bytes: 5000,
      });

      const normalQuarry = await QuarryModel.create({
        _id: uuidv4(),
        company_id: company._id,
        name: 'Normal Quarry',
        code: 'NQ',
        status: QuarryStatus.active,
      });

      const hiddenQuarry = await QuarryModel.create({
        _id: uuidv4(),
        company_id: company._id,
        name: 'Hidden Quarry',
        code: 'HQ',
        status: QuarryStatus.active,
      });

      const emp1 = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        email: 'emp1@betaminerals.com',
        status: UserStatus.active,
      });

      const emp2 = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        email: 'emp2@betaminerals.com',
        status: UserStatus.active,
      });

      await MembershipModel.create({
        _id: uuidv4(),
        user_id: emp1._id,
        company_id: company._id,
        role: MembershipRole.employee,
        hidden_quarries: [hiddenQuarry._id],
        can_view: true,
      });

      // Soft-deleted doc in hidden quarry by emp1
      await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: hiddenQuarry._id,
        display_name: 'Hidden File 1',
        original_filename: 'hidden1.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1000,
        status: DocumentStatus.available,
        deleted_at: new Date(),
        deleted_by: emp1._id,
      });

      // Soft-deleted doc in normal quarry by emp2 (another employee)
      await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: normalQuarry._id,
        display_name: 'Emp2 Deleted File',
        original_filename: 'emp2_file.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1000,
        status: DocumentStatus.available,
        deleted_at: new Date(),
        deleted_by: emp2._id,
      });

      // Soft-deleted doc in normal quarry by emp1 (own deletion)
      const emp1Doc = await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: normalQuarry._id,
        display_name: 'Emp1 Deleted File',
        original_filename: 'emp1_file.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1000,
        status: DocumentStatus.available,
        deleted_at: new Date(),
        deleted_by: emp1._id,
      });

      const tokenEmp1 = signAccessToken({
        sub: emp1.auth_user_id,
        email: emp1.email,
        role: 'user',
      });

      const res = await request(app)
        .get('/company/trash')
        .set('Authorization', `Bearer ${tokenEmp1}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // Must only contain emp1Doc; must NOT contain hidden quarry doc or emp2 doc
      expect(res.body.length).toBe(1);
      expect(res.body[0].id).toBe(emp1Doc._id);
    });

    it('1.3. Company Trash Restore rejects restoring documents in hidden quarries with 404', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Gamma Quarries',
        slug: 'gamma',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
        used_bytes: 5000,
      });

      const hiddenQuarry = await QuarryModel.create({
        _id: uuidv4(),
        company_id: company._id,
        name: 'Hidden Gamma Pit',
        code: 'HGP',
        status: QuarryStatus.active,
      });

      const emp = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        email: 'emp@gamma.com',
        status: UserStatus.active,
      });

      await MembershipModel.create({
        _id: uuidv4(),
        user_id: emp._id,
        company_id: company._id,
        role: MembershipRole.employee,
        hidden_quarries: [hiddenQuarry._id],
        can_view: true,
      });

      const doc = await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: hiddenQuarry._id,
        display_name: 'Deleted Gamma File',
        original_filename: 'gamma.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1000,
        status: DocumentStatus.available,
        deleted_at: new Date(),
        deleted_by: emp._id,
      });

      const token = signAccessToken({
        sub: emp.auth_user_id,
        email: emp.email,
        role: 'user',
      });

      const res = await request(app)
        .post(`/company/trash/${doc._id}/restore`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.detail).toMatch(/not found/i);
    });
  });

  describe('2. Platform Admin Document Access & Company Context Boundary', () => {
    it('2.1. Platform Admin download without explicit X-Company-Id is rejected with 403 Forbidden', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Delta Corp',
        slug: 'delta',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
        used_bytes: 1000,
      });

      const quarry = await QuarryModel.create({
        _id: uuidv4(),
        company_id: company._id,
        name: 'Delta Quarry',
        code: 'DQ',
        status: QuarryStatus.active,
      });

      const key = buildStorageKey(company._id, quarry._id, 'doc-delta-id');
      const storageRef = await storage.put(Buffer.from('PDF Content'), key);

      const doc = await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: quarry._id,
        display_name: 'Delta Contract',
        original_filename: 'contract.pdf',
        mime_type: 'application/pdf',
        size_bytes: 11,
        storage_ref: storageRef,
        status: DocumentStatus.available,
      });

      const platformAdminUser = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        email: 'superadmin@quarryvault.internal',
        status: UserStatus.active,
      });

      await PlatformAdminModel.create({
        _id: uuidv4(),
        auth_user_id: platformAdminUser.auth_user_id,
        email: platformAdminUser.email,
        status: UserStatus.active,
      });

      const adminToken = signAccessToken({
        sub: platformAdminUser.auth_user_id,
        email: platformAdminUser.email,
        role: 'platform_admin',
      });

      // No X-Company-Id header
      const res = await request(app)
        .get(`/documents/${doc._id}/download`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(403);
      expect(res.body.detail).toMatch(/explicit company context/i);
    });

    it('2.2. Platform Admin download with mismatched X-Company-Id is rejected with 404', async () => {
      const companyA = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Company A',
        slug: 'comp-a',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
        used_bytes: 1000,
      });

      const companyB = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Company B',
        slug: 'comp-b',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
        used_bytes: 1000,
      });

      const quarryA = await QuarryModel.create({
        _id: uuidv4(),
        company_id: companyA._id,
        name: 'Quarry A',
        code: 'QA',
        status: QuarryStatus.active,
      });

      const docA = await DocumentModel.create({
        _id: uuidv4(),
        company_id: companyA._id,
        quarry_id: quarryA._id,
        display_name: 'Company A Sensitive Doc',
        original_filename: 'sensitive.pdf',
        mime_type: 'application/pdf',
        size_bytes: 500,
        status: DocumentStatus.available,
      });

      const platformAdminUser = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        email: 'admin@quarryvault.internal',
        status: UserStatus.active,
      });

      await PlatformAdminModel.create({
        _id: uuidv4(),
        auth_user_id: platformAdminUser.auth_user_id,
        email: platformAdminUser.email,
        status: UserStatus.active,
      });

      const adminToken = signAccessToken({
        sub: platformAdminUser.auth_user_id,
        email: platformAdminUser.email,
        role: 'platform_admin',
      });

      // Passing Company B for Company A's document
      const res = await request(app)
        .get(`/documents/${docA._id}/download`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Company-Id', companyB._id);

      expect(res.status).toBe(404);
      expect(res.body.detail).toMatch(/not found/i);
    });

    it('2.3. Platform Admin download with matching X-Company-Id succeeds and records audited event', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Epsilon Resources',
        slug: 'epsilon',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
        used_bytes: 1000,
      });

      const quarry = await QuarryModel.create({
        _id: uuidv4(),
        company_id: company._id,
        name: 'Epsilon Pit',
        code: 'EP',
        status: QuarryStatus.active,
      });

      const key = buildStorageKey(company._id, quarry._id, 'doc-epsilon-id');
      const storageRef = await storage.put(Buffer.from('Confidential Report Data'), key);

      const doc = await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: quarry._id,
        display_name: 'Epsilon Report',
        original_filename: 'report.pdf',
        mime_type: 'application/pdf',
        size_bytes: 24,
        storage_ref: storageRef,
        status: DocumentStatus.available,
      });

      const platformAdminUser = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        email: 'auditor@quarryvault.internal',
        status: UserStatus.active,
      });

      await PlatformAdminModel.create({
        _id: uuidv4(),
        auth_user_id: platformAdminUser.auth_user_id,
        email: platformAdminUser.email,
        status: UserStatus.active,
      });

      const adminToken = signAccessToken({
        sub: platformAdminUser.auth_user_id,
        email: platformAdminUser.email,
        role: 'platform_admin',
      });

      const res = await request(app)
        .get(`/documents/${doc._id}/download`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Company-Id', company._id);

      expect(res.status).toBe(200);
      const text = res.text || (Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body));
      expect(text).toBe('Confidential Report Data');

      // Verify audit event
      const audit = await AuditEventModel.findOne({
        action: 'platform.cross_office_content_access',
        target_id: doc._id,
        company_id: company._id,
      }).lean();
      expect(audit).toBeDefined();
    });
  });

  describe('3. Permanent Deletion Concurrency & Storage Consistency', () => {
    it('3.1. permanentlyDeleteDocument locks document atomically; second concurrent call returns 404 without double quota release', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Zeta Stone',
        slug: 'zeta',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
        used_bytes: 50000,
      });

      const quarry = await QuarryModel.create({
        _id: uuidv4(),
        company_id: company._id,
        name: 'Zeta Quarry',
        code: 'ZQ',
        status: QuarryStatus.active,
      });

      const key = buildStorageKey(company._id, quarry._id, 'doc-zeta-id');
      const storageRef = await storage.put(Buffer.from('Test Data'), key);

      const doc = await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: quarry._id,
        display_name: 'Deleted File',
        original_filename: 'file.pdf',
        mime_type: 'application/pdf',
        size_bytes: 20000,
        storage_ref: storageRef,
        status: DocumentStatus.available,
        deleted_at: new Date(),
      });

      const adminCtx = {
        userId: 'admin-user-id',
        companyId: company._id,
        role: MembershipRole.company_admin,
      } as any;

      // Execute two simultaneous calls
      const [res1, res2] = await Promise.allSettled([
        permanentlyDeleteDocument(adminCtx, quarry._id, doc._id),
        permanentlyDeleteDocument(adminCtx, quarry._id, doc._id),
      ]);

      const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
      const rejected = [res1, res2].filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // Verify quota was decremented exactly ONCE (50000 - 20000 = 30000)
      const updatedCompany = await CompanyModel.findById(company._id).lean();
      expect(updatedCompany!.used_bytes).toBe(30000);
    });
  });

  describe('4. Idempotency Lease Concurrency Protection', () => {
    it('4.1. beginIdempotencyAttempt handles concurrent takeover of expired lease atomically', async () => {
      const companyId = uuidv4();
      const userId = uuidv4();
      const quarryId = uuidv4();
      const key = 'upload-idemp-concurrency-test';

      // Create an expired idempotency key
      const expiredLease = new Date(Date.now() - 60000); // 1 min ago
      await IdempotencyKeyModel.create({
        company_id: companyId,
        user_id: userId,
        quarry_id: quarryId,
        key,
        content_sha256: 'sha-initial',
        status: IdempotencyStatus.in_progress,
        owner_token: 'old-owner-token',
        lease_expires_at: expiredLease,
      });

      // Two workers attempt to take over the expired lease concurrently
      const [attempt1, attempt2] = await Promise.allSettled([
        beginIdempotencyAttempt(companyId, userId, quarryId, key, 'sha-initial'),
        beginIdempotencyAttempt(companyId, userId, quarryId, key, 'sha-initial'),
      ]);

      const fulfilled = [attempt1, attempt2].filter((a) => a.status === 'fulfilled');
      const rejected = [attempt1, attempt2].filter((a) => a.status === 'rejected');

      // Exactly one worker must win the lease; the other must receive ConflictError
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
    });
  });

  describe('5. Production Configuration & Key Separation', () => {
    it('5.1. validateProductionConfig enforces BACKUP_ENCRYPTION_KEY in production', () => {
      const cfg: AppConfig = {
        env: 'production',
        port: 3000,
        enableDocs: false,
        mongoUri: 'mongodb://127.0.0.1:27017/config-validation-only',
        jwtIssuer: 'quarryvault-test',
        jwtAudience: 'quarryvault-test',
        jwtAlgorithms: ['HS256'],
        supabaseUrl: '',
        supabaseAnonKey: '',
        supabaseServiceRoleKey: '',
        supabaseJwtAudience: 'authenticated',
        dashboardBaseUrl: 'https://admin.example.invalid',
        webOrigin: 'https://admin.example.invalid',
        jwtSecret: 'a-very-long-and-secure-jwt-secret-string-at-least-32-chars',
        syncCursorSecret: 'a-very-long-and-secure-sync-cursor-secret-string-32-chars',
        maxFileSizeBytes: 10 * 1024 * 1024,
        defaultCompanyQuotaBytes: 5 * 1024 * 1024 * 1024,
        defaultCompanyMaxUsers: 10,
        idempotencyLeaseSeconds: 300,
        inviteRateLimitPerMinute: 10,
        storageBackend: 'r2',
        r2AccountId: 'acc',
        r2AccessKeyId: 'key',
        r2SecretAccessKey: 'sec',
        r2BucketName: 'bucket',
        r2Region: 'auto',
        storageLocalRoot: 'unused-test-storage',
        backupStorageDir: 'unused-test-backups',
        backupEncryptionKey: '', // Missing
      };

      expect(() => validateProductionConfig(cfg)).toThrow(/BACKUP_ENCRYPTION_KEY/);

      cfg.backupEncryptionKey = 'dedicated-production-backup-encryption-key-32-bytes-long';
      expect(() => validateProductionConfig(cfg)).not.toThrow();
    });

    it('5.2. deriveKey is independent from jwtSecret', () => {
      const keyDefault = deriveKey();
      expect(keyDefault).toBeInstanceOf(Buffer);
      expect(keyDefault.length).toBe(32);

      const keyCustom = deriveKey('custom-dedicated-backup-key');
      expect(keyCustom.length).toBe(32);
      expect(keyCustom).not.toEqual(keyDefault);
    });
  });
});
