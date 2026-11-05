import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { createApp } from '../src/app.js';
import {
  createTestCompany,
  createTestUser,
  createTestPlatformAdmin,
  createTestMembership,
  createTestQuarry,
  generateAuthHeader,
} from './helpers.js';
import {
  CompanyModel,
  UserModel,
  MembershipModel,
  QuarryModel,
  QuarryPermissionModel,
  AppReleaseModel,
  DocumentModel,
  AuditEventModel,
} from '../src/database/models/index.js';
import { MembershipRole, QuarryStatus, UserStatus, DocumentStatus } from '../src/types/index.js';

const app = createApp();

describe('Comprehensive Workflows & Full Endpoint Coverage Suite', () => {
  describe('1. Authentication & Token Refresh Flow', () => {
    it('authenticates, issues refresh token, refreshes session, and revokes properly', async () => {
      const user = await createTestUser({ password: 'Password123!' });
      const company = await createTestCompany();
      await createTestMembership(user._id, company._id, MembershipRole.employee);

      // 1. Login to get initial tokens
      const loginRes = await request(app)
        .post('/auth/login')
        .send({ username: user.username, password: 'Password123!' });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.access_token).toBeDefined();
      expect(loginRes.body.refresh_token).toBeDefined();

      const initialRefreshToken = loginRes.body.refresh_token;

      // 2. Call /auth/refresh with valid token
      const refreshRes = await request(app)
        .post('/auth/refresh')
        .send({ refresh_token: initialRefreshToken });
      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.access_token).toBeDefined();
      expect(refreshRes.body.refresh_token).toBeDefined();
      expect(refreshRes.body.token_type).toBe('bearer');

      // New access token works
      const meRes = await request(app)
        .get('/me')
        .set({ Authorization: `Bearer ${refreshRes.body.access_token}` });
      expect(meRes.status).toBe(200);

      // 3. Rejects missing refresh token with 400
      const missingTokenRes = await request(app)
        .post('/auth/refresh')
        .send({});
      expect(missingTokenRes.status).toBe(400);

      // 4. Rejects bogus/tampered refresh token with 401
      const badTokenRes = await request(app)
        .post('/auth/refresh')
        .send({ refresh_token: 'bogus.invalid.jwt' });
      expect(badTokenRes.status).toBe(401);

      // 5. Revoking tokens invalidates subsequent refresh calls
      user.tokens_revoked_at = new Date();
      await user.save();

      const revokedRefreshRes = await request(app)
        .post('/auth/refresh')
        .send({ refresh_token: refreshRes.body.refresh_token });
      expect(revokedRefreshRes.status).toBe(401);
    });
  });

  describe('2. Mobile App Releases & Updates Workflow', () => {
    it('publishes APK, serves version check, downloads binary, configures limits, and handles withdrawal', async () => {
      const superAdmin = await createTestPlatformAdmin();
      const adminHeader = generateAuthHeader(superAdmin, 'platform_admin');

      // 1. Initial config endpoint
      const configRes = await request(app).get('/app/config');
      expect(configRes.status).toBe(200);
      expect(configRes.body.features.document_scanner).toBe(true);
      expect(configRes.body.features.trash_recovery).toBe(true);
      expect(configRes.body.limits.max_file_size_bytes).toBe(10485760);

      // 2. Publish a new Android APK release
      const dummyApk = Buffer.from('PK\x03\x04DummyApkContent123456');
      const publishRes = await request(app)
        .post('/platform/releases')
        .set(adminHeader)
        .field('version_code', '105')
        .field('version_name', 'v1.5.0')
        .field('minimum_supported_version_code', '100')
        .field('update_required', 'false')
        .field('release_notes', 'Critical security patch & offline scanner improvements')
        .attach('file', dummyApk, 'quarryvault-v1.5.0.apk');

      expect(publishRes.status).toBe(201);
      expect(publishRes.body.version_code).toBe(105);
      expect(publishRes.body.version_name).toBe('v1.5.0');
      const releaseId = publishRes.body._id;

      // 3. List platform releases
      const listReleasesRes = await request(app)
        .get('/platform/releases')
        .set(adminHeader);
      expect(listReleasesRes.status).toBe(200);
      expect(listReleasesRes.body.length).toBeGreaterThan(0);
      const found = listReleasesRes.body.find((r: any) => r.version_code === 105);
      expect(found).toBeDefined();
      expect(found.is_withdrawn).toBe(false);

      // 4. Mobile app checks for updates (client version = 104 -> update optional)
      const updateCheckRes1 = await request(app)
        .get('/app/updates/latest?current_version_code=104');
      expect(updateCheckRes1.status).toBe(200);
      expect(updateCheckRes1.body.version_code).toBe(105);
      expect(updateCheckRes1.body.update_required).toBe(false);
      expect(updateCheckRes1.body.apk_url).toContain('/app/updates/download/105');

      // 5. Mobile app with obsolete version (version = 90 < minimum 100 -> update required)
      const updateCheckRes2 = await request(app)
        .get('/app/updates/latest?current_version_code=90');
      expect(updateCheckRes2.status).toBe(200);
      expect(updateCheckRes2.body.update_required).toBe(true);

      // 6. Download APK stream
      const downloadRes = await request(app)
        .get('/app/updates/download/105')
        .buffer()
        .parse((res, cb) => {
          const chunks: any[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(downloadRes.status).toBe(200);
      expect(downloadRes.header['content-type']).toContain('application/vnd.android.package-archive');
      expect(downloadRes.body.toString()).toBe(dummyApk.toString());

      // 7. Withdraw the release
      const withdrawRes = await request(app)
        .post(`/platform/releases/${releaseId}/withdraw`)
        .set(adminHeader);
      expect(withdrawRes.status).toBe(200);
      expect(withdrawRes.body.is_withdrawn).toBe(true);

      // 8. After withdrawal, withdrawn release is not served as latest
      const afterWithdrawCheck = await request(app)
        .get('/app/updates/latest?current_version_code=100');
      expect(afterWithdrawCheck.status).toBe(404);
    });
  });

  describe('3. Company Administration & Employee Lifecycle', () => {
    it('manages employee disable, enable, update, deletion, and prevents company admin from resetting passwords', async () => {
      const company = await createTestCompany();
      const compAdmin = await createTestUser();
      await createTestMembership(compAdmin._id, company._id, MembershipRole.company_admin);
      const compAdminHeader = generateAuthHeader(compAdmin);

      // 1. Create employee
      const empUsername = `emp_${uuidv4().substring(0, 8)}`;
      const createEmpRes = await request(app)
        .post('/company/employees')
        .set(compAdminHeader)
        .send({
          username: empUsername,
          password: 'TemporaryEmployeePassword1!',
          full_name: 'Ahmed Samir',
          email: `${empUsername}@company.example`,
        });
      expect(createEmpRes.status).toBe(201);
      const empId = createEmpRes.body.id;

      // 2. Company Admin cannot reset password (returns 403)
      const forbiddenResetRes = await request(app)
        .post(`/company/employees/${empId}/reset-password`)
        .set(compAdminHeader);
      expect(forbiddenResetRes.status).toBe(403);
      expect(forbiddenResetRes.body.detail).toContain('Platform Admins');

      // 3. Disable employee
      const disableRes = await request(app)
        .post(`/company/employees/${empId}/disable`)
        .set(compAdminHeader);
      expect(disableRes.status).toBe(200);
      expect(disableRes.body.status).toBe('inactive');

      // Disabled employee cannot log in
      const disabledLogin = await request(app)
        .post('/auth/login')
        .send({ username: empUsername, password: 'TemporaryEmployeePassword1!' });
      expect(disabledLogin.status).toBe(401);

      // 4. Enable employee
      const enableRes = await request(app)
        .post(`/company/employees/${empId}/enable`)
        .set(compAdminHeader);
      expect(enableRes.status).toBe(200);
      expect(enableRes.body.status).toBe('active');

      // 5. Update employee details via PATCH
      const patchRes = await request(app)
        .patch(`/company/employees/${empId}`)
        .set(compAdminHeader)
        .send({ full_name: 'Ahmed Samir Updated' });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.full_name).toBe('Ahmed Samir Updated');

      // 6. Delete employee
      const deleteRes = await request(app)
        .delete(`/company/employees/${empId}`)
        .set(compAdminHeader);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.status).toBe('inactive');

      // Employee is removed from company
      const memberships = await MembershipModel.find({ user_id: empId });
      expect(memberships.length).toBe(0);
    });
  });

  describe('4. Quarry Deactivation & Reactivation Workflow', () => {
    it('deactivates and reactivates a quarry, filtering it from active lists when deactivated', async () => {
      const company = await createTestCompany();
      const compAdmin = await createTestUser();
      await createTestMembership(compAdmin._id, company._id, MembershipRole.company_admin);
      const compAdminHeader = generateAuthHeader(compAdmin);

      const employee = await createTestUser();
      await createTestMembership(employee._id, company._id, MembershipRole.employee);
      const empHeader = generateAuthHeader(employee);

      // 1. Create quarry
      const quarry = await createTestQuarry(company._id);
      await QuarryPermissionModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: quarry._id,
        user_id: employee._id,
        can_view: true,
      });

      // Employee sees it active
      const empListBefore = await request(app)
        .get('/quarries')
        .set(empHeader);
      expect(empListBefore.body.some((q: any) => q.id === quarry._id)).toBe(true);

      // 2. Edit quarry details via PATCH
      const editQuarryRes = await request(app)
        .patch(`/company/quarries/${quarry._id}`)
        .set(compAdminHeader)
        .send({ name: 'Updated Quarry Name Alpha' });
      expect(editQuarryRes.status).toBe(200);
      expect(editQuarryRes.body.name).toBe('Updated Quarry Name Alpha');

      // 3. Deactivate quarry
      const deactRes = await request(app)
        .post(`/company/quarries/${quarry._id}/deactivate`)
        .set(compAdminHeader);
      expect(deactRes.status).toBe(200);
      expect(deactRes.body.status).toBe(QuarryStatus.inactive);

      // Employee no longer sees deactivated quarry
      const empListAfterDeact = await request(app)
        .get('/quarries')
        .set(empHeader);
      expect(empListAfterDeact.body.some((q: any) => q.id === quarry._id)).toBe(false);

      // 4. Reactivate quarry
      const reactRes = await request(app)
        .post(`/company/quarries/${quarry._id}/reactivate`)
        .set(compAdminHeader);
      expect(reactRes.status).toBe(200);
      expect(reactRes.body.status).toBe(QuarryStatus.active);

      // Employee sees it again
      const empListAfterReact = await request(app)
        .get('/quarries')
        .set(empHeader);
      expect(empListAfterReact.body.some((q: any) => q.id === quarry._id)).toBe(true);
    });
  });

  describe('5. Granular Quarry Permission Matrix Lifecycle', () => {
    it('updates company-wide employee permissions transactionally', async () => {
      const company = await createTestCompany();
      const compAdmin = await createTestUser();
      await createTestMembership(compAdmin._id, company._id, MembershipRole.company_admin);
      const compAdminHeader = generateAuthHeader(compAdmin);
      const employee = await createTestUser();
      const membership = await createTestMembership(employee._id, company._id, MembershipRole.employee);
      const quarry = await createTestQuarry(company._id);

      const res = await request(app)
        .post('/company/permissions')
        .set(compAdminHeader)
        .send({
          user_id: employee._id,
          permissions: { can_view: true, can_upload: false, can_download: true, can_delete: false },
          hidden_quarries: [],
          quarry_permissions: [{
            quarry_id: quarry._id,
            can_view: true,
            can_upload: false,
            can_download: true,
            can_delete: false,
          }],
        });

      expect(res.status).toBe(200);
      expect(res.body.permissions).toEqual({ can_view: true, can_upload: false, can_download: true, can_delete: false });
      const updatedMembership = await MembershipModel.findById(membership._id).lean();
      expect(updatedMembership?.can_upload).toBe(false);
      const override = await QuarryPermissionModel.findOne({ user_id: employee._id, quarry_id: quarry._id }).lean();
      expect(override?.can_download).toBe(true);
      expect(await AuditEventModel.countDocuments({ action: 'permission.company_and_quarry_update' })).toBe(1);
    });

    it('queries and updates granular permissions via PUT and POST endpoints', async () => {
      const company = await createTestCompany();
      const compAdmin = await createTestUser();
      await createTestMembership(compAdmin._id, company._id, MembershipRole.company_admin);
      const compAdminHeader = generateAuthHeader(compAdmin);

      const employee = await createTestUser();
      await createTestMembership(employee._id, company._id, MembershipRole.employee);
      const quarry = await createTestQuarry(company._id);

      // 1. Get permissions matrix
      const matrixRes = await request(app)
        .get('/company/permissions')
        .set(compAdminHeader);
      expect(matrixRes.status).toBe(200);
      expect(matrixRes.body.members).toBeDefined();
      expect(matrixRes.body.quarries).toBeDefined();
      expect(matrixRes.body.permissions).toBeDefined();

      // 2. Set permission via PUT /company/quarries/:id/permissions/:userId
      const putPermRes = await request(app)
        .put(`/company/quarries/${quarry._id}/permissions/${employee._id}`)
        .set(compAdminHeader)
        .send({
          can_view: true,
          can_upload: true,
          can_download: false,
          can_delete: false,
        });
      expect(putPermRes.status).toBe(200);
      expect(putPermRes.body.can_upload).toBe(true);
      expect(putPermRes.body.can_download).toBe(false);

      // 3. Update permission via POST /company/permissions
      const postPermRes = await request(app)
        .post('/company/permissions')
        .set(compAdminHeader)
        .send({
          quarry_id: quarry._id,
          user_id: employee._id,
          can_view: true,
          can_upload: true,
          can_download: true,
          can_delete: true,
        });
      expect(postPermRes.status).toBe(200);
      expect(postPermRes.body.can_delete).toBe(true);
    });
  });

  describe('6. Company Usage & Audit Scoped Feeds', () => {
    it('retrieves company-scoped storage usage and isolated audit trails', async () => {
      const company = await createTestCompany();
      const compAdmin = await createTestUser();
      await createTestMembership(compAdmin._id, company._id, MembershipRole.company_admin);
      const compAdminHeader = generateAuthHeader(compAdmin);

      // 1. Check /company/usage
      const usageRes = await request(app)
        .get('/company/usage')
        .set(compAdminHeader);
      expect(usageRes.status).toBe(200);
      expect(usageRes.body.quota_bytes).toBe(company.quota_bytes);
      expect(usageRes.body.used_bytes).toBeDefined();

      // 2. Check /company/audit
      const auditRes = await request(app)
        .get('/company/audit')
        .set(compAdminHeader);
      expect(auditRes.status).toBe(200);
      expect(auditRes.body.total).toBeDefined();
      expect(Array.isArray(auditRes.body.items)).toBe(true);
    });
  });

  describe('7. Platform Alerts & Global Administration', () => {
    it('serves operational alerts and allows updating user roles and revoking sessions', async () => {
      const superAdmin = await createTestPlatformAdmin();
      const adminHeader = generateAuthHeader(superAdmin, 'platform_admin');

      // 1. GET /platform/alerts
      const alertsRes = await request(app)
        .get('/platform/alerts')
        .set(adminHeader);
      expect(alertsRes.status).toBe(200);
      expect(alertsRes.body.checked_at).toBeDefined();
      expect(Array.isArray(alertsRes.body.items)).toBe(true);

      // 2. PATCH /platform/users/:id/role
      const targetUser = await createTestUser();
      const roleRes = await request(app)
        .patch(`/platform/users/${targetUser._id}/role`)
        .set(adminHeader)
        .send({ role: 'company_admin' });
      expect(roleRes.status).toBe(200);
      expect(roleRes.body.role).toBe('company_admin');

      // 3. POST /platform/users/:id/revoke-sessions
      const revokeRes = await request(app)
        .post(`/platform/users/${targetUser._id}/revoke-sessions`)
        .set(adminHeader);
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.status).toBe('ok');
    });
  });
});
