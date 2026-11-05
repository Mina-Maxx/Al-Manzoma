import { describe, it, expect } from 'vitest';
import request from 'supertest';
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
  UserModel,
  DocumentModel,
  AppReleaseModel,
  PlatformAdminModel,
  MembershipModel,
} from '../src/database/models/index.js';
import { MembershipRole, UserStatus } from '../src/types/index.js';
import { storage } from '../src/modules/storage/index.js';

const app = createApp();

describe('Session, Deletion, and Release Parity Suite', () => {

  describe('1. Single Active Employee Session Policy', () => {
    it('enforces single active session for regular employee: second login invalidates first session', async () => {
      const company = await createTestCompany();
      const worker = await createTestUser({
        username: 'worker1',
        password: 'Password123!',
      });
      await createTestMembership(worker._id, company._id, MembershipRole.employee);

      // Device A Login
      const loginA = await request(app)
        .post('/auth/login')
        .send({ username: 'worker1', password: 'Password123!' });
      expect(loginA.status).toBe(200);
      expect(loginA.body.access_token).toBeDefined();
      expect(loginA.body.session_id).toBeDefined();
      const tokenA = loginA.body.access_token;
      const sessionA = loginA.body.session_id;

      // Device A accesses /me
      const meA1 = await request(app)
        .get('/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('X-Session-Id', sessionA);
      expect(meA1.status).toBe(200);

      // Wait 1.1s so JWT iat advances cleanly
      await new Promise((r) => setTimeout(r, 1100));

      // Device B Login (same employee)
      const loginB = await request(app)
        .post('/auth/login')
        .send({ username: 'worker1', password: 'Password123!' });
      expect(loginB.status).toBe(200);
      expect(loginB.body.session_id).toBeDefined();
      expect(loginB.body.session_id).not.toBe(sessionA);
      const tokenB = loginB.body.access_token;
      const sessionB = loginB.body.session_id;

      // Device A is now rejected (both due to mismatched session_id and revoked token)
      const meA2 = await request(app)
        .get('/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('X-Session-Id', sessionA);
      expect(meA2.status).toBe(401);

      // Device B succeeds
      const meB = await request(app)
        .get('/me')
        .set('Authorization', `Bearer ${tokenB}`)
        .set('X-Session-Id', sessionB);
      expect(meB.status).toBe(200);
    });

    it('enforces single active session for company admin', async () => {
      const company = await createTestCompany();
      const admin = await createTestUser({
        username: 'comp_admin',
        password: 'Password123!',
      });
      await createTestMembership(admin._id, company._id, MembershipRole.company_admin);

      const login1 = await request(app)
        .post('/auth/login')
        .send({ username: 'comp_admin', password: 'Password123!' });
      expect(login1.status).toBe(200);
      const session1 = login1.body.session_id;

      await new Promise((r) => setTimeout(r, 1100));

      const login2 = await request(app)
        .post('/auth/login')
        .send({ username: 'comp_admin', password: 'Password123!' });
      expect(login2.status).toBe(200);
      const session2 = login2.body.session_id;

      expect(session2).not.toBe(session1);

      // Session 1 rejected
      const res1 = await request(app)
        .get('/me')
        .set('Authorization', `Bearer ${login1.body.access_token}`)
        .set('X-Session-Id', session1);
      expect(res1.status).toBe(401);

      // Session 2 succeeds
      const res2 = await request(app)
        .get('/me')
        .set('Authorization', `Bearer ${login2.body.access_token}`)
        .set('X-Session-Id', session2);
      expect(res2.status).toBe(200);
    });

    it('invalidates the previous Platform Admin session after a newer login', async () => {
      const paUser = await createTestUser({
        username: 'superadmin_test',
        password: 'Password123!',
      });
      await createTestPlatformAdmin({
        auth_user_id: paUser.auth_user_id,
        email: paUser.email,
      });

      const login1 = await request(app)
        .post('/auth/login')
        .send({ username: 'superadmin_test', password: 'Password123!' });
      expect(login1.status).toBe(200);

      const login2 = await request(app)
        .post('/auth/login')
        .send({ username: 'superadmin_test', password: 'Password123!' });
      expect(login2.status).toBe(200);

      // Platform Admin sessions use the same active-session rotation boundary.
      const check1 = await request(app)
        .get('/me')
        .set('Authorization', `Bearer ${login1.body.access_token}`)
        .set('X-Client-Application', 'platform_admin_dashboard')
        .set('X-Session-Id', login1.body.session_id);
      expect(check1.status).toBe(401);

      const check2 = await request(app)
        .get('/me')
        .set('Authorization', `Bearer ${login2.body.access_token}`)
        .set('X-Client-Application', 'platform_admin_dashboard')
        .set('X-Session-Id', login2.body.session_id);
      expect(check2.status).toBe(200);
    });

    it('logout clears active session and revokes tokens', async () => {
      const company = await createTestCompany();
      const worker = await createTestUser({
        username: 'worker_logout',
        password: 'Password123!',
      });
      await createTestMembership(worker._id, company._id, MembershipRole.employee);

      const login = await request(app)
        .post('/auth/login')
        .send({ username: 'worker_logout', password: 'Password123!' });
      expect(login.status).toBe(200);
      const token = login.body.access_token;
      const sid = login.body.session_id;

      // Logout
      const logoutRes = await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Session-Id', sid);
      expect(logoutRes.status).toBe(200);

      // Verify active_session_id is cleared
      const updatedUser = await UserModel.findById(worker._id);
      expect(updatedUser?.active_session_id).toBeNull();

      // Subsequent request rejected
      const meRes = await request(app)
        .get('/me')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Session-Id', sid);
      expect(meRes.status).toBe(401);
    });
  });

  describe('2. Permanent User Deletion Without Content Loss', () => {
    it('company admin permanently deletes employee without deleting documents or folders', async () => {
      const company = await createTestCompany();
      const compAdmin = await createTestUser({ username: 'comp_adm_del' });
      await createTestMembership(compAdmin._id, company._id, MembershipRole.company_admin);

      const worker = await createTestUser({ username: 'worker_to_del' });
      await createTestMembership(worker._id, company._id, MembershipRole.employee);

      const quarry = await createTestQuarry(company._id);

      // Worker uploaded a document
      const doc = await DocumentModel.create({
        company_id: company._id,
        quarry_id: quarry._id,
        display_name: 'Geological Report',
        original_filename: 'report.pdf',
        storage_ref: `company/${company._id}/quarry/${quarry._id}/doc-1`,
        size_bytes: 1024,
        sha256: 'abc123hash',
        mime_type: 'application/pdf',
        uploaded_by: worker._id,
      });

      // Delete employee via company admin endpoint
      const delRes = await request(app)
        .delete(`/company/employees/${worker._id}?permanent=true`)
        .set(generateAuthHeader(compAdmin));
      expect(delRes.status).toBe(200);
      expect(delRes.body.status).toBe('deleted');

      // User record is permanently deleted
      const foundUser = await UserModel.findById(worker._id);
      expect(foundUser).toBeNull();

      // Document is preserved, with uploaded_by safely nulled
      const foundDoc = await DocumentModel.findById(doc._id);
      expect(foundDoc).not.toBeNull();
      expect(foundDoc?.uploaded_by).toBeNull();
      expect(foundDoc?.display_name).toBe('Geological Report');
    });

    it('prevents deleting the last company admin', async () => {
      const company = await createTestCompany();
      const soleAdmin = await createTestUser({ username: 'sole_admin' });
      await createTestMembership(soleAdmin._id, company._id, MembershipRole.company_admin);

      // Try self deletion (rejected by self-delete check or last admin check)
      const res = await request(app)
        .delete(`/company/employees/${soleAdmin._id}?permanent=true`)
        .set(generateAuthHeader(soleAdmin));
      expect(res.status).toBe(409);
    });

    it('platform admin permanently deletes user globally while preserving documents', async () => {
      const pa = await createTestPlatformAdmin();
      const company = await createTestCompany();
      const worker = await createTestUser({ username: 'global_worker_del' });
      await createTestMembership(worker._id, company._id, MembershipRole.employee);

      const quarry = await createTestQuarry(company._id);
      const doc = await DocumentModel.create({
        company_id: company._id,
        quarry_id: quarry._id,
        display_name: 'Survey',
        original_filename: 'survey.pdf',
        storage_ref: `company/${company._id}/quarry/${quarry._id}/survey-1`,
        size_bytes: 2048,
        sha256: 'hash456',
        mime_type: 'application/pdf',
        uploaded_by: worker._id,
      });

      const delRes = await request(app)
        .delete(`/platform/users/${worker._id}?permanent=true`)
        .set(generateAuthHeader(pa, 'platform_admin'));
      expect(delRes.status).toBe(200);
      expect(delRes.body.status).toBe('deleted');

      // User permanently deleted
      expect(await UserModel.findById(worker._id)).toBeNull();

      // Document intact
      const preservedDoc = await DocumentModel.findById(doc._id);
      expect(preservedDoc).not.toBeNull();
      expect(preservedDoc?.uploaded_by).toBeNull();
    });
  });

  describe('3. Physical APK Release Removal', () => {
    it('withdraw physically deletes APK artifact and download rejects with 404', async () => {
      const pa = await createTestPlatformAdmin();

      // Upload release
      const dummyApk = Buffer.from('PK\x03\x04DummyApkContent123');
      const uploadRes = await request(app)
        .post('/platform/releases')
        .set(generateAuthHeader(pa, 'platform_admin'))
        .field('version_code', '301')
        .field('version_name', '3.0.1')
        .field('minimum_supported_version_code', '1')
        .attach('file', dummyApk, 'app-v301.apk');
      expect(uploadRes.status).toBe(201);
      const relId = uploadRes.body.id;

      const release = await AppReleaseModel.findById(relId);
      expect(release).not.toBeNull();
      expect(await storage.exists(release!.storage_ref)).toBe(true);

      // Withdraw release
      const withdrawRes = await request(app)
        .post(`/platform/releases/${relId}/withdraw`)
        .set(generateAuthHeader(pa, 'platform_admin'));
      expect(withdrawRes.status).toBe(200);
      expect(withdrawRes.body.is_withdrawn).toBe(true);

      // APK physically deleted from storage
      expect(await storage.exists(release!.storage_ref)).toBe(false);

      // Download returns 404
      const dlRes = await request(app).get(`/app/updates/download/301`);
      expect(dlRes.status).toBe(404);
    });

    it('delete release permanently removes record and physically removes APK artifact', async () => {
      const pa = await createTestPlatformAdmin();

      const dummyApk = Buffer.from('PK\x03\x04DummyApkContentDeleteTest');
      const uploadRes = await request(app)
        .post('/platform/releases')
        .set(generateAuthHeader(pa, 'platform_admin'))
        .field('version_code', '302')
        .field('version_name', '3.0.2')
        .field('minimum_supported_version_code', '1')
        .attach('file', dummyApk, 'app-v302.apk');
      expect(uploadRes.status).toBe(201);
      const relId = uploadRes.body.id;

      const release = await AppReleaseModel.findById(relId);
      expect(release).not.toBeNull();
      expect(await storage.exists(release!.storage_ref)).toBe(true);

      // Permanently delete release
      const delRes = await request(app)
        .delete(`/platform/releases/${relId}`)
        .set(generateAuthHeader(pa, 'platform_admin'));
      expect(delRes.status).toBe(200);
      expect(delRes.body.status).toBe('deleted');

      // Record is gone
      expect(await AppReleaseModel.findById(relId)).toBeNull();

      // Physical APK is deleted
      expect(await storage.exists(release!.storage_ref)).toBe(false);

      // Download returns 404
      const dlRes = await request(app).get(`/app/updates/download/302`);
      expect(dlRes.status).toBe(404);
    });
  });
});
