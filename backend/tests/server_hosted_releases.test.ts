import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../src/app.js';
import { AppReleaseModel, AuditEventModel } from '../src/database/models/index.js';
import { storage } from '../src/modules/storage/index.js';
import { createTestPlatformAdmin, createTestUser, createTestCompany, createTestMembership, generateAuthHeader } from './helpers.js';

describe('Server-Hosted App Releases and Direct APK Downloads Suite', () => {
  let app: any;
  let adminHeader: { Authorization: string };
  let adminUser: any;

  // Minimal valid ZIP / APK buffer (starts with PK\x03\x04 magic bytes)
  const createMockApkBuffer = (content: string = 'test-apk-payload'): Buffer => {
    const magic = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const payload = Buffer.from(content, 'utf-8');
    return Buffer.concat([magic, payload]);
  };

  beforeEach(async () => {
    app = createApp();
    adminUser = await createTestPlatformAdmin();
    adminHeader = generateAuthHeader(adminUser, 'platform_admin');
  });

  it('1. Upload valid APK stores artifact on server and creates release with 201', async () => {
    const apkBuffer = createMockApkBuffer('quarryvault-v105-binary');
    const expectedSha256 = crypto.createHash('sha256').update(apkBuffer).digest('hex');

    const res = await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer, 'quarryvault-v105.apk')
      .field('version_code', '105')
      .field('version_name', '1.5.0')
      .field('minimum_supported_version_code', '100')
      .field('release_notes', 'تحديث تجريبي مع إصلاحات التنزيل المباشر')
      .field('update_required', 'false');

    expect(res.status).toBe(201);
    expect(res.body.version_code).toBe(105);
    expect(res.body.version_name).toBe('1.5.0');
    expect(res.body.release_notes).toBe('تحديث تجريبي مع إصلاحات التنزيل المباشر');
    expect(res.body.sha256).toBe(expectedSha256);
    expect(res.body.sha256_checksum).toBe(expectedSha256);
    expect(res.body.apk_size_bytes).toBe(apkBuffer.length);
    expect(res.body.download_url).toBe('/app/updates/download/105');
    expect(res.body.apk_url).toBe('/app/updates/download/105');
    expect(res.body.is_withdrawn).toBe(false);

    // Verify stored in DB
    const saved = await AppReleaseModel.findOne({ version_code: 105 });
    expect(saved).not.toBeNull();
    expect(saved!.storage_ref).toBe('releases/105/quarryvault-v105.apk');

    // Verify audit log
    const audit = await AuditEventModel.findOne({
      action: 'app_release.publish',
      target_id: String(saved!._id),
    });
    expect(audit).not.toBeNull();
    expect(audit!.meta?.version_code).toBe(105);
  });

  it('2. Rejects upload when APK file is missing', async () => {
    const res = await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .field('version_code', '106')
      .field('version_name', '1.6.0');

    expect(res.status).toBe(400);
    expect(res.body.detail || res.body.message).toMatch(/APK file is required/i);
  });

  it('3. Rejects upload when file is not a valid ZIP/APK (invalid magic bytes)', async () => {
    const fakeBuffer = Buffer.from('NOT A ZIP FILE HEADER HERE', 'utf-8');

    const res = await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', fakeBuffer, 'fake.apk')
      .field('version_code', '107')
      .field('version_name', '1.7.0');

    expect(res.status).toBe(400);
    expect(res.body.detail || res.body.message).toMatch(/Invalid APK file format/i);
  });

  it('4. Rejects upload when file does not have .apk extension', async () => {
    const apkBuffer = createMockApkBuffer('valid-bytes-wrong-extension');

    const res = await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer, 'malicious_script.exe')
      .field('version_code', '108')
      .field('version_name', '1.8.0');

    expect(res.status).toBe(400);
    expect(res.body.detail || res.body.message).toMatch(/\.apk extension/i);
  });

  it('5. Rejects upload with duplicate version_code with 409 Conflict', async () => {
    const apkBuffer = createMockApkBuffer('first-release-v109');

    const res1 = await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer, 'app-109.apk')
      .field('version_code', '109')
      .field('version_name', '1.9.0');
    expect(res1.status).toBe(201);

    const res2 = await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer, 'app-109-dup.apk')
      .field('version_code', '109')
      .field('version_name', '1.9.0-conflict');
    expect(res2.status).toBe(409);
    expect(res2.body.detail || res2.body.message).toMatch(/already exists/i);
  });

  it('6. Rejects upload when minimum_supported_version_code > version_code', async () => {
    const apkBuffer = createMockApkBuffer('invalid-min-code');

    const res = await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer, 'app-110.apk')
      .field('version_code', '110')
      .field('version_name', '1.10.0')
      .field('minimum_supported_version_code', '115');

    expect(res.status).toBe(400);
    expect(res.body.detail || res.body.message).toMatch(/cannot exceed version_code/i);
  });

  it('7. Rejects upload with non-positive version_code', async () => {
    const apkBuffer = createMockApkBuffer('negative-version');

    const res = await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer, 'app-neg.apk')
      .field('version_code', '0')
      .field('version_name', '0.0.0');

    expect(res.status).toBe(400);
    expect(res.body.detail || res.body.message).toMatch(/Valid positive version_code/i);
  });

  it('8. Rejects unauthenticated or unauthorized access to release endpoints', async () => {
    const apkBuffer = createMockApkBuffer('unauth-check');

    // Unauthenticated
    const resUnauth = await request(app)
      .post('/platform/releases')
      .attach('file', apkBuffer, 'app-111.apk')
      .field('version_code', '111')
      .field('version_name', '1.11.0');
    expect(resUnauth.status).toBe(401);

    // Regular company employee / admin (not platform_admin)
    const regularUser = await createTestUser();
    const userHeader = generateAuthHeader(regularUser, 'user');

    const resForbidden = await request(app)
      .post('/platform/releases')
      .set(userHeader)
      .attach('file', apkBuffer, 'app-111.apk')
      .field('version_code', '111')
      .field('version_name', '1.11.0');
    expect(resForbidden.status).toBe(403);
  });

  it('9. GET /app/updates/latest returns latest active release with server-hosted download URL', async () => {
    const apkBuffer = createMockApkBuffer('latest-active-release');
    const hash = crypto.createHash('sha256').update(apkBuffer).digest('hex');

    await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer, 'quarryvault-v112.apk')
      .field('version_code', '112')
      .field('version_name', '1.12.0')
      .field('minimum_supported_version_code', '100')
      .field('release_notes', 'ملاحظات الإصدار الأحدث')
      .field('update_required', 'true');

    const res = await request(app)
      .get('/app/updates/latest?current_version_code=100');

    expect(res.status).toBe(200);
    expect(res.body.version_code).toBe(112);
    expect(res.body.version_name).toBe('1.12.0');
    expect(res.body.release_notes).toBe('ملاحظات الإصدار الأحدث');
    expect(res.body.update_required).toBe(true);
    expect(res.body.apk_url).toBe('/app/updates/download/112');
    expect(res.body.sha256).toBe(hash);
    expect(res.body.apk_size_bytes).toBe(apkBuffer.length);
  });

  it('10. GET /app/updates/download/:versionCode streams APK file directly with correct headers', async () => {
    const apkBuffer = createMockApkBuffer('streamable-apk-binary-content-12345');
    const hash = crypto.createHash('sha256').update(apkBuffer).digest('hex');

    await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer, 'quarryvault-v113.apk')
      .field('version_code', '113')
      .field('version_name', '1.13.0');

    const res = await request(app)
      .get('/app/updates/download/113')
      .buffer(true)
      .parse((r, cb) => {
        const bufs: Buffer[] = [];
        r.on('data', (c) => bufs.push(c));
        r.on('end', () => cb(null, Buffer.concat(bufs)));
      })
      .expect(200);

    expect(res.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(res.headers['content-disposition']).toContain('quarryvault-v113.apk');
    expect(res.headers['content-length']).toBe(String(apkBuffer.length));
    expect(res.headers['etag']).toBe(`"${hash}"`);
    expect(res.headers['cache-control']).toContain('public');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body).toEqual(apkBuffer);

    // Verify download audit event
    const audit = await AuditEventModel.findOne({
      action: 'app_release.download',
      'meta.version_code': 113,
    });
    expect(audit).not.toBeNull();
  });

  it('11. GET /app/updates/download/:versionCode returns 404 for nonexistent version', async () => {
    const res = await request(app)
      .get('/app/updates/download/99999');

    expect(res.status).toBe(404);
    expect(res.body.detail || res.body.message).toMatch(/not found/i);
  });

  it('12. POST /platform/releases/:id/withdraw withdraws release and disables download', async () => {
    const apkBuffer = createMockApkBuffer('to-be-withdrawn');

    const uploadRes = await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer, 'quarryvault-v114.apk')
      .field('version_code', '114')
      .field('version_name', '1.14.0');

    const releaseId = uploadRes.body.id;

    // Withdraw release
    const withdrawRes = await request(app)
      .post(`/platform/releases/${releaseId}/withdraw`)
      .set(adminHeader);

    expect(withdrawRes.status).toBe(200);
    expect(withdrawRes.body.is_withdrawn).toBe(true);

    // Download should now return 404
    const downloadRes = await request(app)
      .get('/app/updates/download/114');
    expect(downloadRes.status).toBe(404);

    // Latest update should not return withdrawn release
    const latestRes = await request(app)
      .get('/app/updates/latest?current_version_code=100');
    if (latestRes.status === 200) {
      expect(latestRes.body.version_code).not.toBe(114);
    }
  });

  it('13. Failed metadata creation compensates by deleting stored artifact from storage', async () => {
    const apkBuffer = createMockApkBuffer('rollback-test-binary');
    const storageKey = 'releases/115/rollback-test.apk';

    // Mock AppReleaseModel.create to throw a database error
    const createSpy = vi.spyOn(AppReleaseModel, 'create').mockRejectedValueOnce(new Error('Simulated DB Failure'));

    const res = await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer, 'rollback-test.apk')
      .field('version_code', '115')
      .field('version_name', '1.15.0');

    expect(res.status).toBe(500);

    // Verify artifact was cleaned up from storage
    const exists = await storage.exists(storageKey);
    expect(exists).toBe(false);

    createSpy.mockRestore();
  });

  it('14. New release defaults to optional policy and update_required=false', async () => {
    const apkBuffer = createMockApkBuffer('optional-default-check');

    const res = await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer, 'quarryvault-v116.apk')
      .field('version_code', '116')
      .field('version_name', '1.16.0');

    expect(res.status).toBe(201);
    expect(res.body.update_policy).toBe('optional');
    expect(res.body.update_required).toBe(false);
    expect(res.body.is_mandatory).toBe(false);

    // GET /app/updates/latest for older client code 110
    const checkRes = await request(app)
      .get('/app/updates/latest?current_version_code=110');

    expect(checkRes.status).toBe(200);
    expect(checkRes.body.version_code).toBe(116);
    expect(checkRes.body.update_policy).toBe('optional');
    expect(checkRes.body.update_required).toBe(false);
    expect(checkRes.body.is_mandatory).toBe(false);
  });

  it('15. Explicit mandatory release creation sets update_policy=mandatory and update_required=true', async () => {
    const apkBuffer = createMockApkBuffer('mandatory-check-binary');

    const res = await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer, 'quarryvault-v117.apk')
      .field('version_code', '117')
      .field('version_name', '1.17.0')
      .field('update_policy', 'mandatory');

    expect(res.status).toBe(201);
    expect(res.body.update_policy).toBe('mandatory');
    expect(res.body.update_required).toBe(true);
    expect(res.body.is_mandatory).toBe(true);

    // GET /app/updates/latest for older client code 116
    const checkRes = await request(app)
      .get('/app/updates/latest?current_version_code=116');

    expect(checkRes.status).toBe(200);
    expect(checkRes.body.version_code).toBe(117);
    expect(checkRes.body.update_policy).toBe('mandatory');
    expect(checkRes.body.update_required).toBe(true);
  });

  it('16. Administrator can toggle policy via PATCH /platform/releases/:id with audit logging', async () => {
    const apkBuffer = createMockApkBuffer('policy-toggle-binary');

    // Create initially optional release
    const createRes = await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer, 'quarryvault-v118.apk')
      .field('version_code', '118')
      .field('version_name', '1.18.0')
      .field('update_policy', 'optional');

    const releaseId = createRes.body.id;
    expect(createRes.body.update_policy).toBe('optional');

    // Patch to mandatory
    const patchRes1 = await request(app)
      .patch(`/platform/releases/${releaseId}`)
      .set(adminHeader)
      .send({ update_policy: 'mandatory' });

    expect(patchRes1.status).toBe(200);
    expect(patchRes1.body.update_policy).toBe('mandatory');
    expect(patchRes1.body.update_required).toBe(true);
    expect(patchRes1.body.is_mandatory).toBe(true);

    // Verify audit log for policy change
    const audit1 = await AuditEventModel.findOne({
      action: 'app_release.update_policy',
      target_id: releaseId,
    }).sort({ created_at: -1 });
    expect(audit1).not.toBeNull();
    expect(audit1!.meta?.new_policy).toBe('mandatory');
    expect(audit1!.meta?.previous_policy).toBe('optional');

    // Patch back to optional
    const patchRes2 = await request(app)
      .patch(`/platform/releases/${releaseId}`)
      .set(adminHeader)
      .send({ update_policy: 'optional' });

    expect(patchRes2.status).toBe(200);
    expect(patchRes2.body.update_policy).toBe('optional');
    expect(patchRes2.body.update_required).toBe(false);
    expect(patchRes2.body.is_mandatory).toBe(false);
  });

  it('17. Unauthorized users cannot change release policies', async () => {
    const apkBuffer = createMockApkBuffer('auth-protection-binary');

    const createRes = await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer, 'quarryvault-v119.apk')
      .field('version_code', '119')
      .field('version_name', '1.19.0');

    const releaseId = createRes.body.id;

    // Unauthenticated request -> 401
    const unauthRes = await request(app)
      .patch(`/platform/releases/${releaseId}`)
      .send({ update_policy: 'mandatory' });
    expect(unauthRes.status).toBe(401);

    // Regular user request -> 403
    const regularUser = await createTestUser();
    const userHeader = generateAuthHeader(regularUser, 'user');

    const forbiddenRes = await request(app)
      .patch(`/platform/releases/${releaseId}`)
      .set(userHeader)
      .send({ update_policy: 'mandatory' });
    expect(forbiddenRes.status).toBe(403);
  });

  it('18. Legacy release record without update_policy defaults to optional and does not force update', async () => {
    // Insert a raw legacy release into DB without update_policy and with update_required: false
    await AppReleaseModel.create({
      version_code: 120,
      version_name: '1.20.0',
      minimum_supported_version_code: 1,
      update_required: false,
      apk_filename: 'legacy-120.apk',
      apk_size_bytes: 1024,
      sha256: 'deadbeef120',
      storage_ref: 'releases/120/legacy-120.apk',
      is_withdrawn: false,
    });

    const checkRes = await request(app)
      .get('/app/updates/latest?current_version_code=100');

    expect(checkRes.status).toBe(200);
    expect(checkRes.body.version_code).toBe(120);
    expect(checkRes.body.update_policy).toBe('optional');
    expect(checkRes.body.update_required).toBe(false);
  });

  it('19. Optional release cannot set minimum_supported_version_code equal to or greater than version_code', async () => {
    const apkBuffer = createMockApkBuffer('min-code-guard-check');

    const res = await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer, 'quarryvault-v121.apk')
      .field('version_code', '121')
      .field('version_name', '1.21.0')
      .field('update_policy', 'optional')
      .field('minimum_supported_version_code', '121');

    expect(res.status).toBe(400);
    expect(res.body.detail || res.body.message).toMatch(/cannot set minimum_supported_version_code equal to or greater than version_code/i);
  });

  it('20. Protected API header check allows older version on optional release but blocks on mandatory release', async () => {
    const company = await createTestCompany();
    const regularUser = await createTestUser();
    await createTestMembership(regularUser._id, company._id);
    const userHeader = generateAuthHeader(regularUser, 'user');

    // 1. Publish optional release 122 with minSupported 1
    const apkBuffer1 = createMockApkBuffer('optional-auth-check');
    await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer1, 'quarryvault-v122.apk')
      .field('version_code', '122')
      .field('version_name', '1.22.0')
      .field('update_policy', 'optional');

    // Call protected /me with older client version code 100 -> succeeds (200)
    const authResOptional = await request(app)
      .get('/me')
      .set(userHeader)
      .set('X-App-Version-Code', '100');
    expect(authResOptional.status).toBe(200);

    // 2. Publish mandatory release 123 with minSupported 123
    const apkBuffer2 = createMockApkBuffer('mandatory-auth-check');
    await request(app)
      .post('/platform/releases')
      .set(adminHeader)
      .attach('file', apkBuffer2, 'quarryvault-v123.apk')
      .field('version_code', '123')
      .field('version_name', '1.23.0')
      .field('minimum_supported_version_code', '123')
      .field('update_policy', 'mandatory');

    // Call protected /me with older client version code 100 -> blocked with 426 Upgrade Required
    const authResMandatory = await request(app)
      .get('/me')
      .set(userHeader)
      .set('X-App-Version-Code', '100');
    expect(authResMandatory.status).toBe(426);
    expect(authResMandatory.body.code).toBe('UPGRADE_REQUIRED');
  });
});
