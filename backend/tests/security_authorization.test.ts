import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  createTestCompany,
  createTestUser,
  createTestMembership,
  createTestQuarry,
  createTestPermission,
  createTestPlatformAdmin,
  generateAuthHeader,
} from './helpers.js';
import {
  AuditEventModel,
  DocumentModel,
  MembershipModel,
  QuarryPermissionModel,
  SupportGrantModel,
  UserModel,
} from '../src/database/models/index.js';
import {
  MembershipRole,
  UserStatus,
} from '../src/types/index.js';

const app = createApp();

async function approveSupportGrant(requester: any, approver: any, companyId: string, scopes: string[]) {
  const requested = await request(app)
    .post('/platform/support-grants')
    .set(generateAuthHeader(requester, 'platform_admin'))
    .send({ company_id: companyId, scopes, duration_seconds: 3600, reason: 'Approved support ticket QV-1234' });
  if (requested.status !== 201) throw new Error(`Support grant request failed: ${requested.status} ${requested.body.detail || ''}`);
  const approved = await request(app)
    .post(`/platform/support-grants/${requested.body.id}/approve`)
    .set(generateAuthHeader(approver, 'platform_admin'))
    .send({});
  if (approved.status !== 200) throw new Error(`Support grant approval failed: ${approved.status} ${approved.body.detail || ''}`);
  return approved.body;
}

describe('Focused Security Audit & Authorization Verification', () => {
  describe('1. Platform Administrator Document Access Policy', () => {
    it('allows an active Platform Admin cross-office download with explicit company context and audits it', async () => {
      const company = await createTestCompany({ name: 'Alpha Mining Corp' });
      const compAdmin = await createTestUser({ username: 'alpha_admin' });
      await createTestMembership(compAdmin._id, company._id, MembershipRole.company_admin);
      const quarry = await createTestQuarry(company._id, { name: 'Alpha Quarry 1' });
      const authHeaderAdmin = generateAuthHeader(compAdmin);

      // Upload a test document
      const uploadRes = await request(app)
        .post(`/quarries/${quarry._id}/documents`)
        .set(authHeaderAdmin)
        .attach('file', Buffer.from('%PDF-1.4 confidential mineral survey'), 'survey.pdf');
      expect(uploadRes.status).toBe(201);
      const docId = uploadRes.body.id;

      // Platform Admin account setup
      const superUser = await createTestUser({ username: 'platform_super' });
      const platformAdmin = await createTestPlatformAdmin({
        auth_user_id: superUser.auth_user_id,
        email: superUser.email,
        status: UserStatus.active,
      });
      const superToken = generateAuthHeader(superUser, 'platform_admin');
      // Cross-company access requires an explicit target company even when the caller is a Platform Admin.
      const deniedRes = await request(app)
        .get(`/documents/${docId}/download`)
        .set(superToken);
      expect(deniedRes.status).toBe(403);

      // Execute privileged download with explicit company context: succeeds with 200
      const res = await request(app)
        .get(`/documents/${docId}/download`)
        .set(superToken)
        .set('X-Company-Id', company._id);

      expect(res.status).toBe(200);
      expect(res.header['content-type']).toMatch(/application\/pdf/);
      expect(res.body.toString()).toContain('confidential mineral survey');

      // Verify audit record is logged specifically as platform.cross_office_content_access
      const auditLog = await AuditEventModel.findOne({
        action: 'platform.cross_office_content_access',
        target_id: docId,
        company_id: company._id,
        result: 'success',
      }).lean();

      expect(auditLog).toBeDefined();
      expect(auditLog?.result).toBe('success');
      expect(auditLog?.meta?.admin_id).toBe(platformAdmin._id);
      expect(auditLog?.meta?.filename).toBe('survey.pdf');
    });

    it('does not require a Support Grant for Platform Admin reads and still denies tenant quarry writes', async () => {
      const company = await createTestCompany();
      const quarry = await createTestQuarry(company._id);
      const requester = await createTestPlatformAdmin();
      const requesterToken = generateAuthHeader(requester, 'platform_admin');
      const documentsPath = `/quarries/${quarry._id}/documents`;
      const metadata = await request(app).get(documentsPath).set(requesterToken).set('X-Company-Id', company._id);
      expect(metadata.status).toBe(200);

      const write = await request(app)
        .post('/quarries')
        .set(requesterToken)
        .set('X-Company-Id', company._id)
        .send({ name: 'Unauthorized Quarry', quarry_number: 'QV-99', quarry_type: 'test' });
      expect(write.status).toBe(403);
    });

    it('keeps Platform Admin read authorization independent from expired or revoked Support Grants', async () => {
      const company = await createTestCompany();
      const quarry = await createTestQuarry(company._id);
      const approver = await createTestPlatformAdmin();

      const expiredAdmin = await createTestPlatformAdmin();
      const expiredGrant = await approveSupportGrant(expiredAdmin, approver, company._id, ['document_metadata_read']);
      await SupportGrantModel.updateOne({ _id: expiredGrant.id }, { $set: { expires_at: new Date(Date.now() - 1000) } });
      const expired = await request(app)
        .get(`/quarries/${quarry._id}/documents`)
        .set(generateAuthHeader(expiredAdmin, 'platform_admin'))
        .set('X-Company-Id', company._id);
      expect(expired.status).toBe(200);

      const revokedAdmin = await createTestPlatformAdmin();
      const revokedGrant = await approveSupportGrant(revokedAdmin, approver, company._id, ['document_metadata_read']);
      const revoke = await request(app)
        .delete(`/platform/support-grants/${revokedGrant.id}`)
        .set(generateAuthHeader(approver, 'platform_admin'));
      expect(revoke.status).toBe(200);
      const revoked = await request(app)
        .get(`/quarries/${quarry._id}/documents`)
        .set(generateAuthHeader(revokedAdmin, 'platform_admin'))
        .set('X-Company-Id', company._id);
      expect(revoked.status).toBe(200);
    });

    it('denies a grant for another company and denies metadata when only download scope was approved', async () => {
      const grantedCompany = await createTestCompany();
      const otherCompany = await createTestCompany();
      const quarry = await createTestQuarry(grantedCompany._id);
      const approver = await createTestPlatformAdmin();

      const wrongCompanyAdmin = await createTestPlatformAdmin();
      await approveSupportGrant(wrongCompanyAdmin, approver, grantedCompany._id, ['document_metadata_read']);
      const wrongCompany = await request(app)
        .get(`/quarries/${quarry._id}/documents`)
        .set(generateAuthHeader(wrongCompanyAdmin, 'platform_admin'))
        .set('X-Company-Id', otherCompany._id);
      expect(wrongCompany.status).toBe(404);

      const insufficientAdmin = await createTestPlatformAdmin();
      await approveSupportGrant(insufficientAdmin, approver, grantedCompany._id, ['document_download']);
      const insufficient = await request(app)
        .get(`/quarries/${quarry._id}/documents`)
        .set(generateAuthHeader(insufficientAdmin, 'platform_admin'))
        .set('X-Company-Id', grantedCompany._id);
      expect(insufficient.status).toBe(200);
    });

    it('rejects platform admin download when PlatformAdmin authority is disabled (403)', async () => {
      const company = await createTestCompany();
      const compAdmin = await createTestUser();
      await createTestMembership(compAdmin._id, company._id, MembershipRole.company_admin);
      const quarry = await createTestQuarry(company._id);

      const uploadRes = await request(app)
        .post(`/quarries/${quarry._id}/documents`)
        .set(generateAuthHeader(compAdmin))
        .attach('file', Buffer.from('%PDF-1.4 sample'), 'doc.pdf');
      const docId = uploadRes.body.id;

      // Inactive Platform Admin
      const disabledSuper = await createTestUser({ username: 'disabled_super' });
      await createTestPlatformAdmin({
        auth_user_id: disabledSuper.auth_user_id,
        status: UserStatus.inactive,
      });
      const disabledToken = generateAuthHeader(disabledSuper, 'platform_admin');

      const res = await request(app)
        .get(`/documents/${docId}/download`)
        .set(disabledToken);

      expect(res.status).toBe(403);
      expect(res.body.detail).toContain('administrator account is disabled');
    });

    it('rejects platform admin download when linked User account is disabled (403)', async () => {
      const company = await createTestCompany();
      const compAdmin = await createTestUser();
      await createTestMembership(compAdmin._id, company._id, MembershipRole.company_admin);
      const quarry = await createTestQuarry(company._id);

      const uploadRes = await request(app)
        .post(`/quarries/${quarry._id}/documents`)
        .set(generateAuthHeader(compAdmin))
        .attach('file', Buffer.from('%PDF-1.4 sample'), 'doc.pdf');
      const docId = uploadRes.body.id;

      // Linked user inactive
      const inactiveUser = await createTestUser({
        username: 'inactive_linked',
        status: UserStatus.inactive,
      });
      await createTestPlatformAdmin({
        auth_user_id: inactiveUser.auth_user_id,
        status: UserStatus.active,
      });
      const token = generateAuthHeader(inactiveUser, 'platform_admin');

      const res = await request(app)
        .get(`/documents/${docId}/download`)
        .set(token);

      expect(res.status).toBe(403);
    });

    it('rejects download if client supplies a mismatched X-Company-Id override (404)', async () => {
      const companyA = await createTestCompany({ name: 'Company A' });
      const companyB = await createTestCompany({ name: 'Company B' });

      const adminA = await createTestUser();
      await createTestMembership(adminA._id, companyA._id, MembershipRole.company_admin);
      const quarryA = await createTestQuarry(companyA._id);

      const uploadRes = await request(app)
        .post(`/quarries/${quarryA._id}/documents`)
        .set(generateAuthHeader(adminA))
        .attach('file', Buffer.from('%PDF-1.4 company A file'), 'fileA.pdf');
      const docId = uploadRes.body.id;

      // Platform admin tries downloading docId with X-Company-Id of Company B
      const superUser = await createTestUser({ username: 'super_tamper' });
      await createTestPlatformAdmin({ auth_user_id: superUser.auth_user_id, status: UserStatus.active });
      const superToken = generateAuthHeader(superUser, 'platform_admin');
      const approvingAdmin = await createTestPlatformAdmin();
      await approveSupportGrant(superUser, approvingAdmin, companyB._id, ['document_download']);

      const res = await request(app)
        .get(`/documents/${docId}/download`)
        .set(superToken)
        .set('X-Company-Id', companyB._id);

      expect(res.status).toBe(404);
      expect(res.body.detail).toBe('document not found');
    });

    it('rejects access if document belongs to an inactive quarry without disclosing content (403)', async () => {
      const company = await createTestCompany();
      const admin = await createTestUser();
      await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
      const quarry = await createTestQuarry(company._id);

      const uploadRes = await request(app)
        .post(`/quarries/${quarry._id}/documents`)
        .set(generateAuthHeader(admin))
        .attach('file', Buffer.from('%PDF-1.4 sample'), 'doc.pdf');
      const docId = uploadRes.body.id;

      // Inactivate quarry
      quarry.status = 'inactive' as any;
      await quarry.save();

      const superUser = await createTestUser();
      await createTestPlatformAdmin({ auth_user_id: superUser.auth_user_id });

      const res = await request(app)
        .get(`/documents/${docId}/download`)
        .set(generateAuthHeader(superUser, 'platform_admin'));

      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('sample');
    });
  });

  describe('2. Quarry Creation Authorization', () => {
    it('requires active same-company membership with can_upload for employees and retains Company Admin creation', async () => {
      const company = await createTestCompany();

      const uploader = await createTestUser({ username: 'quarry_creator' });
      await createTestMembership(uploader._id, company._id, MembershipRole.employee);
      const allowed = await request(app)
        .post('/quarries')
        .set(generateAuthHeader(uploader))
        .send({ name: 'Employee Quarry', quarry_number: 'EQ-1', quarry_type: 'granite' });
      expect(allowed.status).toBe(201);
      expect(allowed.body.name).toBe('Employee Quarry');

      const blockedEmployee = await createTestUser({ username: 'quarry_creator_blocked' });
      const blockedMembership = await createTestMembership(blockedEmployee._id, company._id, MembershipRole.employee);
      blockedMembership.can_upload = false;
      await blockedMembership.save();
      const denied = await request(app)
        .post('/quarries')
        .set(generateAuthHeader(blockedEmployee))
        .send({ name: 'Blocked Quarry', quarry_number: 'BQ-1', quarry_type: 'granite' });
      expect(denied.status).toBe(403);

      const companyAdmin = await createTestUser({ username: 'company_quarry_admin' });
      await createTestMembership(companyAdmin._id, company._id, MembershipRole.company_admin);
      const adminCreated = await request(app)
        .post('/quarries')
        .set(generateAuthHeader(companyAdmin))
        .send({ name: 'Admin Quarry', quarry_number: 'AQ-1', quarry_type: 'granite' });
      expect(adminCreated.status).toBe(201);
    });
  });

  describe('3. Initial Permission Delegation & Tenant Isolation', () => {
    it('prevents company admin from delegating permissions to foreign quarries during employee creation', async () => {
      const companyA = await createTestCompany({ name: 'Legit Company A' });
      const companyB = await createTestCompany({ name: 'Foreign Company B' });

      const adminA = await createTestUser({ username: 'admin_company_a' });
      await createTestMembership(adminA._id, companyA._id, MembershipRole.company_admin);

      const quarryA = await createTestQuarry(companyA._id, { name: 'Quarry A' });
      const foreignQuarryB = await createTestQuarry(companyB._id, { name: 'Quarry B' });

      const membershipCountBefore = await MembershipModel.countDocuments({ company_id: companyA._id });
      const quarryPermissionCountBefore = await QuarryPermissionModel.countDocuments();

      // Admin A tries to assign an employee to a quarry owned by another company.
      const res = await request(app)
        .post('/company/employees')
        .set(generateAuthHeader(adminA))
        .send({
          username: 'new_employee_a',
          password: 'Password123!',
          email: 'employee_a@test.com',
          quarry_permissions: [
            { quarry_id: quarryA._id, can_view: true, can_download: true },
            { quarry_id: foreignQuarryB._id, can_view: true, can_download: true },
          ],
        });

      expect(res.status).toBe(404);
      expect(await UserModel.findOne({ normalized_username: 'new_employee_a' })).toBeNull();
      expect(await MembershipModel.countDocuments({ company_id: companyA._id })).toBe(membershipCountBefore);
      expect(await QuarryPermissionModel.countDocuments()).toBe(quarryPermissionCountBefore);
    });

    it('prevents Company Admin A from managing Company B employees via password reset', async () => {
      const companyA = await createTestCompany({ name: 'Company A' });
      const companyB = await createTestCompany({ name: 'Company B' });

      const adminA = await createTestUser({ username: 'admin_a_scope' });
      await createTestMembership(adminA._id, companyA._id, MembershipRole.company_admin);

      const employeeB = await createTestUser({ username: 'employee_b_target' });
      await createTestMembership(employeeB._id, companyB._id, MembershipRole.employee);

      const res = await request(app)
        .post(`/company/employees/${employeeB._id}/reset-password`)
        .set(generateAuthHeader(adminA))
        .send({ temporary_password: 'NewPassword123!' });

      expect(res.status).toBe(403);
      expect(res.body.detail).toBe('Only Platform Admins can reset passwords');
    });
  });

  describe('4. File Recovery and Retention Policy Enforcement', () => {
    it('enforces that only the deleting employee or company admin can restore a document within 30 days', async () => {
      const company = await createTestCompany();
      const admin = await createTestUser({ username: 'recovery_admin' });
      await createTestMembership(admin._id, company._id, MembershipRole.company_admin);

      const deleterEmployee = await createTestUser({ username: 'deleter_emp' });
      const deleterMembership = await createTestMembership(deleterEmployee._id, company._id, MembershipRole.employee);
      deleterMembership.can_upload = true;
      deleterMembership.can_delete = true;
      await deleterMembership.save();

      const bystanderEmployee = await createTestUser({ username: 'bystander_emp' });
      const bystanderMembership = await createTestMembership(bystanderEmployee._id, company._id, MembershipRole.employee);
      bystanderMembership.can_upload = true;
      bystanderMembership.can_delete = false;
      await bystanderMembership.save();

      const quarry = await createTestQuarry(company._id);
      await createTestPermission(deleterEmployee._id, quarry._id, { can_view: true, can_upload: true, can_delete: true });
      await createTestPermission(bystanderEmployee._id, quarry._id, { can_view: true, can_upload: true, can_delete: true });

      // 1. Deleter employee uploads and deletes a document
      const uploadRes = await request(app)
        .post(`/quarries/${quarry._id}/documents`)
        .set(generateAuthHeader(deleterEmployee))
        .attach('file', Buffer.from('%PDF-1.4 file to delete'), 'recoverable.pdf');
      expect(uploadRes.status).toBe(201);
      const docId = uploadRes.body.id;

      const deletion = await request(app)
        .delete(`/quarries/${quarry._id}/documents/${docId}`)
        .set(generateAuthHeader(deleterEmployee));
      expect(deletion.status).toBe(204);

      // 2. Bystander employee (has can_view, but not deleter or admin) tries to restore -> 403 Forbidden
      const bystanderRestoreRes = await request(app)
        .post(`/quarries/${quarry._id}/documents/${docId}/restore`)
        .set(generateAuthHeader(bystanderEmployee));

      expect(bystanderRestoreRes.status).toBe(403);
      expect(bystanderRestoreRes.body.detail).toContain('only the deleting employee or a company administrator may restore');

      // 3. Deleter employee restores -> 200 OK
      const deleterRestoreRes = await request(app)
        .post(`/quarries/${quarry._id}/documents/${docId}/restore`)
        .set(generateAuthHeader(deleterEmployee));

      expect(deleterRestoreRes.status).toBe(200);
      expect(deleterRestoreRes.body.id).toBe(docId);

      // Verify restored document in DB
      const restoredDoc = await DocumentModel.findById(docId);
      expect(restoredDoc?.deleted_at).toBeNull();
      expect(restoredDoc?.deleted_by).toBeNull();
    });

    it('rejects restoration if 30-day retention period has expired (410 Gone)', async () => {
      const company = await createTestCompany();
      const admin = await createTestUser();
      await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
      const quarry = await createTestQuarry(company._id);

      const uploadRes = await request(app)
        .post(`/quarries/${quarry._id}/documents`)
        .set(generateAuthHeader(admin))
        .attach('file', Buffer.from('%PDF-1.4 expired'), 'expired.pdf');
      const docId = uploadRes.body.id;

      await request(app)
        .delete(`/quarries/${quarry._id}/documents/${docId}`)
        .set(generateAuthHeader(admin));

      // Backdate deleted_at to 31 days ago
      const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await DocumentModel.findByIdAndUpdate(docId, { deleted_at: thirtyOneDaysAgo });

      const res = await request(app)
        .post(`/quarries/${quarry._id}/documents/${docId}/restore`)
        .set(generateAuthHeader(admin));

      expect(res.status).toBe(410);
      expect(res.body.detail).toContain('document retention period has expired');
    });

    it('rejects restoration attempt using mismatched quarry ID (404 Not Found)', async () => {
      const company = await createTestCompany();
      const admin = await createTestUser();
      await createTestMembership(admin._id, company._id, MembershipRole.company_admin);

      const quarry1 = await createTestQuarry(company._id, { name: 'Quarry 1' });
      const quarry2 = await createTestQuarry(company._id, { name: 'Quarry 2' });

      const uploadRes = await request(app)
        .post(`/quarries/${quarry1._id}/documents`)
        .set(generateAuthHeader(admin))
        .attach('file', Buffer.from('%PDF-1.4 file in quarry 1'), 'q1.pdf');
      const docId = uploadRes.body.id;

      await request(app)
        .delete(`/quarries/${quarry1._id}/documents/${docId}`)
        .set(generateAuthHeader(admin));

      // Attempt restoring under quarry2
      const res = await request(app)
        .post(`/quarries/${quarry2._id}/documents/${docId}/restore`)
        .set(generateAuthHeader(admin));

      expect(res.status).toBe(404);
      expect(res.body.detail).toBe('document not found');
    });
  });
});
