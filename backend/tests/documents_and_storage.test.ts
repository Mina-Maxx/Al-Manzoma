import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  createTestCompany,
  createTestUser,
  createTestMembership,
  createTestQuarry,
  createTestPermission,
  generateAuthHeader,
} from './helpers.js';
import { MembershipRole } from '../src/types/index.js';
import { MembershipModel } from '../src/database/models/index.js';

const app = createApp();

describe('Documents & Cloudflare R2 Storage Workflows', () => {
  it('uploads document, computes SHA256, streams download, and handles idempotency', async () => {
    const company = await createTestCompany();
    const user = await createTestUser();
    await createTestMembership(user._id, company._id, MembershipRole.employee);
    const quarry = await createTestQuarry(company._id);

    await createTestPermission(user._id, quarry._id, {
      can_view: true,
      can_upload: true,
      can_download: true,
      can_delete: true,
    });

    const authHeader = generateAuthHeader(user);
    const fileContent = Buffer.from('%PDF-1.4 Sample Quarry Contract Document');

    // 1. Initial Upload
    const uploadRes = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .set('Idempotency-Key', 'unique-upload-key-001')
      .field('display_name', 'Sample Contract')
      .attach('file', fileContent, 'contract.pdf');

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.id).toBeDefined();
    expect(uploadRes.body.display_name).toBe('Sample Contract');
    expect(uploadRes.body.sha256).toBeDefined();
    expect(uploadRes.body.size_bytes).toBe(fileContent.length);

    const docId = uploadRes.body.id;

    // 2. Idempotent Retry: Same Key + Same Content -> Returns existing document (HTTP 200, no duplicate)
    const retryRes = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .set('Idempotency-Key', 'unique-upload-key-001')
      .attach('file', fileContent, 'contract.pdf');

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.id).toBe(docId);

    // 3. Idempotent Conflict: Same Key + Different Content -> Returns HTTP 409 Conflict
    const differentContent = Buffer.from('%PDF-1.4 Different content body');
    const conflictRes = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .set('Idempotency-Key', 'unique-upload-key-001')
      .attach('file', differentContent, 'contract.pdf');

    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.detail).toContain('Idempotency-Key was already used with a different request');

    // 4. Download document
    const downloadRes = await request(app)
      .get(`/documents/${docId}/download`)
      .set(authHeader);

    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers['content-type']).toBe('application/pdf');
    expect(downloadRes.headers['content-disposition']).toContain('contract.pdf');
    expect(downloadRes.body.toString()).toBe(fileContent.toString());
  });

  it('manages document soft delete, trash listing, and restoration within 30-day retention', async () => {
    const company = await createTestCompany();
    const adminUser = await createTestUser();
    const membership = await createTestMembership(adminUser._id, company._id, MembershipRole.company_admin);
    await MembershipModel.findByIdAndUpdate(membership._id, { can_delete: true });
    const quarry = await createTestQuarry(company._id);

    const authHeader = generateAuthHeader(adminUser);

    // Upload
    const uploadRes = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .set('Idempotency-Key', 'trash-test-key-01')
      .attach('file', Buffer.from('%PDF-1.4 Plan to trash'), 'plan.pdf');
    expect(uploadRes.status).toBe(201);
    const docId = uploadRes.body.id;

    // Active listing shows the document
    const listBefore = await request(app).get(`/quarries/${quarry._id}/documents`).set(authHeader);
    expect(listBefore.body.some((d: any) => d.id === docId)).toBe(true);

    // Soft Delete document
    const deleteRes = await request(app)
      .delete(`/quarries/${quarry._id}/documents/${docId}`)
      .set(authHeader);
    expect(deleteRes.status).toBe(204);

    // Active listing no longer shows the document
    const listAfter = await request(app).get(`/quarries/${quarry._id}/documents`).set(authHeader);
    expect(listAfter.body.some((d: any) => d.id === docId)).toBe(false);

    // Trash listing shows the soft-deleted document
    const trashList = await request(app).get(`/quarries/${quarry._id}/trash`).set(authHeader);
    expect(trashList.status).toBe(200);
    const trashDoc = trashList.body.find((d: any) => d.id === docId);
    expect(trashDoc).toBeDefined();
    expect(trashDoc.can_restore).toBe(true);
    expect(trashDoc.deleted_at).toBeDefined();

    // Restore document
    const restoreRes = await request(app)
      .post(`/quarries/${quarry._id}/documents/${docId}/restore`)
      .set(authHeader);
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.id).toBe(docId);

    // Document is visible in active documents again
    const listRestored = await request(app).get(`/quarries/${quarry._id}/documents`).set(authHeader);
    expect(listRestored.body.some((d: any) => d.id === docId)).toBe(true);
  });

  it('supports direct browser downloads via query parameter token', async () => {
    const company = await createTestCompany();
    const user = await createTestUser();
    await createTestMembership(user._id, company._id, MembershipRole.employee);
    const quarry = await createTestQuarry(company._id);

    await createTestPermission(user._id, quarry._id, {
      can_view: true,
      can_upload: true,
      can_download: true,
    });

    const authHeader = generateAuthHeader(user);
    const rawToken = authHeader.Authorization.split(' ')[1];
    const fileContent = Buffer.from('%PDF-1.4 Browser Direct Download Content');

    const uploadRes = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .set('Idempotency-Key', 'browser-dl-key')
      .attach('file', fileContent, 'browser-download.pdf');
    expect(uploadRes.status).toBe(201);
    const docId = uploadRes.body.id;

    // Download WITHOUT Authorization header, using ?token= query param
    const downloadRes = await request(app).get(`/documents/${docId}/download?token=${rawToken}`);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers['content-type']).toBe('application/pdf');
    expect(downloadRes.body.toString()).toBe(fileContent.toString());
  });

  it('handles document versioning and historical version archiving', async () => {
    const company = await createTestCompany();
    const user = await createTestUser();
    await createTestMembership(user._id, company._id, MembershipRole.employee);
    const quarry = await createTestQuarry(company._id);

    await createTestPermission(user._id, quarry._id, {
      can_view: true,
      can_upload: true,
      can_download: true,
    });

    const authHeader = generateAuthHeader(user);
    const v1Content = Buffer.from('%PDF-1.4 Initial Version 1');
    const v2Content = Buffer.from('%PDF-1.4 Updated Version 2 with more content');

    // Upload v1
    const v1Res = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .set('Idempotency-Key', 'versioning-test-v1')
      .attach('file', v1Content, 'doc.pdf');
    expect(v1Res.status).toBe(201);
    const docId = v1Res.body.id;
    expect(v1Res.body.version).toBe(1);

    // Upload v2
    const v2Res = await request(app)
      .post(`/quarries/${quarry._id}/documents/${docId}/versions`)
      .set(authHeader)
      .attach('file', v2Content, 'doc_v2.pdf');
    expect(v2Res.status).toBe(201);
    expect(v2Res.body.version).toBe(2);
    expect(v2Res.body.size_bytes).toBe(v2Content.length);

    // List versions
    const versionsRes = await request(app)
      .get(`/quarries/${quarry._id}/documents/${docId}/versions`)
      .set(authHeader);
    expect(versionsRes.status).toBe(200);
    expect(versionsRes.body.length).toBe(1);
    expect(versionsRes.body[0].version).toBe(1);
    expect(versionsRes.body[0].size_bytes).toBe(v1Content.length);
  });

  it('permanently purges expired documents and releases company storage quota', async () => {
    const { DocumentModel, CompanyModel } = await import('../src/database/models/index.js');
    const { purgeExpiredDocuments } = await import('../src/modules/documents/service.js');

    const company = await createTestCompany({ quota_bytes: 5 * 1024 * 1024 });
    const user = await createTestUser();
    await createTestMembership(user._id, company._id, MembershipRole.company_admin);
    const quarry = await createTestQuarry(company._id);

    const authHeader = generateAuthHeader(user);
    const fileContent = Buffer.from('%PDF-1.4 File to be permanently purged');

    const uploadRes = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .set('Idempotency-Key', 'purge-lifecycle-test-key')
      .attach('file', fileContent, 'to_purge.pdf');
    expect(uploadRes.status).toBe(201);
    const docId = uploadRes.body.id;

    // Quota should reflect uploaded file size
    const compBefore = await CompanyModel.findById(company._id);
    expect(compBefore?.used_bytes).toBe(fileContent.length);

    // Soft delete document
    await request(app)
      .delete(`/quarries/${quarry._id}/documents/${docId}`)
      .set(authHeader);

    // Manually backdate deleted_at to 35 days ago (past the 30-day retention cutoff)
    const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    await DocumentModel.findByIdAndUpdate(docId, { deleted_at: thirtyFiveDaysAgo });

    // Run permanent purge
    const report = await purgeExpiredDocuments({ retentionDays: 30, dryRun: false });
    expect(report.purgedCount).toBe(1);
    expect(report.freedBytes).toBe(fileContent.length);

    // Document must be removed from DB
    const docAfter = await DocumentModel.findById(docId);
    expect(docAfter).toBeNull();

    // Company quota must be released
    const compAfter = await CompanyModel.findById(company._id);
    expect(compAfter?.used_bytes).toBe(0);
  });

  it('enforces that production storage and configuration guards prevent insecure defaults', async () => {
    const { createStorage } = await import('../src/modules/storage/index.js');
    const { validateProductionConfig } = await import('../src/config/index.js');

    const originalWebOrigin = process.env.WEB_ORIGIN;
    delete process.env.WEB_ORIGIN;
    try {
      expect(() => {
        validateProductionConfig({
          env: 'production',
          webOrigin: 'http://localhost:3001',
        } as any);
      }).toThrow(/WEB_ORIGIN must be explicitly set/);
    } finally {
      process.env.WEB_ORIGIN = originalWebOrigin || 'http://localhost:3001';
    }

    // 1. Silent fallback to local disk in production must throw
    expect(() => {
      createStorage({
        env: 'production',
        storageBackend: 'r2',
        r2BucketName: 'test-bucket',
        r2Region: 'auto',
        storageLocalRoot: '.storage',
      } as any);
    }).toThrow(/Fatal: Cloudflare R2 credentials/);

    // 2. STORAGE_BACKEND=local in production must throw
    expect(() => {
      createStorage({
        env: 'production',
        storageBackend: 'local',
        r2BucketName: 'test-bucket',
        r2Region: 'auto',
        storageLocalRoot: '.storage',
      } as any);
    }).toThrow(/Fatal: STORAGE_BACKEND=local is not permitted in production/);

    // 3. Insecure JWT secret in production must throw
    expect(() => {
      validateProductionConfig({
        env: 'production',
        webOrigin: 'https://admin.example.com',
        jwtSecret: 'dev-insecure-secret-placeholder',
        syncCursorSecret: 'real-32-char-secure-secret-here-1234',
        storageBackend: 'r2',
        r2AccessKeyId: 'valid-key',
        r2SecretAccessKey: 'valid-secret',
      } as any);
    }).toThrow(/JWT_SECRET must be explicitly set/);
  });

  it('allows editing document metadata (display_name) and increments version with audit/sync', async () => {
    const company = await createTestCompany();
    const adminUser = await createTestUser();
    await createTestMembership(adminUser._id, company._id, MembershipRole.company_admin);
    const quarry = await createTestQuarry(company._id);
    const authHeader = generateAuthHeader(adminUser);

    const uploadRes = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .attach('file', Buffer.from('%PDF-1.4 Initial document content'), 'initial.pdf');
    expect(uploadRes.status).toBe(201);
    const docId = uploadRes.body.id;

    // Update display_name
    const patchRes = await request(app)
      .patch(`/quarries/${quarry._id}/documents/${docId}`)
      .set(authHeader)
      .send({ display_name: 'Updated Contract Name' });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.display_name).toBe('Updated Contract Name');
    expect(patchRes.body.version).toBe(2);

    // Re-query list to verify persistence
    const listRes = await request(app)
      .get(`/quarries/${quarry._id}/documents`)
      .set(authHeader);
    const updatedDoc = listRes.body.find((d: any) => d.id === docId);
    expect(updatedDoc.display_name).toBe('Updated Contract Name');
  });

  it('supports downloading historical document versions via ?version=', async () => {
    const company = await createTestCompany();
    const adminUser = await createTestUser();
    await createTestMembership(adminUser._id, company._id, MembershipRole.company_admin);
    const quarry = await createTestQuarry(company._id);
    const authHeader = generateAuthHeader(adminUser);

    const v1Content = Buffer.from('%PDF-1.4 Version 1 Content');
    const v2Content = Buffer.from('%PDF-1.4 Version 2 Content - Revised');

    // 1. Upload initial version (v1)
    const uploadRes = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .attach('file', v1Content, 'doc.pdf');
    expect(uploadRes.status).toBe(201);
    const docId = uploadRes.body.id;

    // 2. Upload new version (v2)
    const v2Res = await request(app)
      .post(`/quarries/${quarry._id}/documents/${docId}/versions`)
      .set(authHeader)
      .attach('file', v2Content, 'doc_v2.pdf');
    expect(v2Res.status).toBe(201);
    expect(v2Res.body.version).toBe(2);

    // 3. Download v1 explicitly
    const dlV1Res = await request(app)
      .get(`/documents/${docId}/download?version=1`)
      .set(authHeader);
    expect(dlV1Res.status).toBe(200);
    expect(dlV1Res.body.toString()).toBe(v1Content.toString());

    // 4. Download v2 explicitly
    const dlV2Res = await request(app)
      .get(`/documents/${docId}/download?version=2`)
      .set(authHeader);
    expect(dlV2Res.status).toBe(200);
    expect(dlV2Res.body.toString()).toBe(v2Content.toString());

    // 5. Default download without query serves current version (v2)
    const dlCurrentRes = await request(app)
      .get(`/documents/${docId}/download`)
      .set(authHeader);
    expect(dlCurrentRes.status).toBe(200);
    expect(dlCurrentRes.body.toString()).toBe(v2Content.toString());

    // 6. Requesting non-existent version returns 404
    const dlNonExistent = await request(app)
      .get(`/documents/${docId}/download?version=999`)
      .set(authHeader);
    expect(dlNonExistent.status).toBe(404);
  });
});
