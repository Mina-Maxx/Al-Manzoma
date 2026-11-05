import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  CompanyModel,
  UserModel,
  MembershipModel,
  QuarryModel,
  QuarryPermissionModel,
  FolderModel,
  DocumentModel,
  DocumentVersionModel,
  AuditEventModel,
} from '../src/database/models/index.js';
import { storage, buildStorageKey } from '../src/modules/storage/index.js';
import {
  createTestCompany,
  createTestUser,
  createTestMembership,
  createTestQuarry,
  createTestPermission,
  createTestPlatformAdminDashboardSession,
  generateAuthHeader,
} from './helpers.js';
import { MembershipRole, CompanyStatus, AuditResult, UserStatus, QuarryStatus } from '../src/types/index.js';

const app = createApp();

describe('Storage Quotas & Administration Workflows', () => {
  it('enforces company storage quota: rejects upload exceeding quota with 409', async () => {
    // Setup company with tiny quota (100 bytes)
    const company = await createTestCompany({ quota_bytes: 100 });
    const user = await createTestUser();
    await createTestMembership(user._id, company._id, MembershipRole.company_admin);
    const quarry = await createTestQuarry(company._id);

    const authHeader = generateAuthHeader(user);
    const oversizeBuffer = Buffer.alloc(200, '%PDF-1.4 over quota');

    const res = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .set('Idempotency-Key', 'quota-test-key-01')
      .attach('file', oversizeBuffer, 'big.pdf');

    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('company storage quota exceeded');
  });

  it('allows Platform Admin to manage companies and audit events', async () => {
    const { header: adminHeader } = await createTestPlatformAdminDashboardSession();

    // 1. Create Company
    const createCompRes = await request(app)
      .post('/platform/companies')
      .set(adminHeader)
      .send({
        name: 'New Platform Managed Company',
        quota_bytes: 5368709120,
        max_users: 15,
      });

    expect(createCompRes.status).toBe(201);
    const companyId = createCompRes.body.id;

    // 2. Suspend Company
    const suspendRes = await request(app)
      .post(`/platform/companies/${companyId}/suspend`)
      .set(adminHeader);
    expect(suspendRes.status, JSON.stringify(suspendRes.body)).toBe(200);
    expect(suspendRes.body.status).toBe(CompanyStatus.suspended);

    // 3. Reactivate Company
    const reactivateRes = await request(app)
      .post(`/platform/companies/${companyId}/reactivate`)
      .set(adminHeader);
    expect(reactivateRes.status).toBe(200);
    expect(reactivateRes.body.status).toBe(CompanyStatus.active);

    // 4. Inspect Audit Trail
    const auditRes = await request(app)
      .get('/platform/audit')
      .set(adminHeader);
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.items.length).toBeGreaterThan(0);
  });

  it('supports dashboard company status updates and safely deletes a whole company', async () => {
    const { header: adminHeader } = await createTestPlatformAdminDashboardSession();
    const company = await createTestCompany({ name: 'Office to delete' });
    const otherCompany = await createTestCompany({ name: 'Office to keep' });
    const soleMember = await createTestUser();
    const sharedMember = await createTestUser();
    await createTestMembership(soleMember._id, company._id, MembershipRole.company_admin);
    await createTestMembership(sharedMember._id, company._id, MembershipRole.employee);
    await createTestMembership(sharedMember._id, otherCompany._id, MembershipRole.employee);
    const quarry = await createTestQuarry(company._id);
    const otherQuarry = await createTestQuarry(otherCompany._id);
    await createTestPermission(sharedMember._id, quarry._id);
    const otherPermission = await createTestPermission(sharedMember._id, otherQuarry._id);

    const documentKey = buildStorageKey(company._id, quarry._id, 'delete-company-document');
    const versionKey = buildStorageKey(company._id, quarry._id, 'delete-company-document', 2);
    await storage.put(Buffer.from('company document fixture'), documentKey);
    await storage.put(Buffer.from('company document version fixture'), versionKey);
    const document = await DocumentModel.create({
      company_id: company._id,
      quarry_id: quarry._id,
      display_name: 'fixture.pdf',
      original_filename: 'fixture.pdf',
      mime_type: 'application/pdf',
      size_bytes: 24,
      storage_ref: documentKey,
      uploaded_by: soleMember._id,
    });
    await DocumentVersionModel.create({
      document_id: document._id,
      company_id: company._id,
      quarry_id: quarry._id,
      version: 2,
      size_bytes: 32,
      sha256: 'a'.repeat(64),
      storage_ref: versionKey,
      mime_type: 'application/pdf',
      uploaded_by: soleMember._id,
    });
    await FolderModel.create({
      company_id: company._id,
      quarry_id: quarry._id,
      name: 'Company folder fixture',
    });

    const suspendRes = await request(app)
      .patch(`/platform/companies/${company._id}/status`)
      .set(adminHeader)
      .send({ status: CompanyStatus.suspended });
    expect(suspendRes.status, JSON.stringify(suspendRes.body)).toBe(200);
    expect(suspendRes.body.status).toBe(CompanyStatus.suspended);

    const reactivateRes = await request(app)
      .patch(`/platform/companies/${company._id}/status`)
      .set(adminHeader)
      .send({ status: CompanyStatus.active });
    expect(reactivateRes.status).toBe(200);

    const rejectedDelete = await request(app)
      .delete(`/platform/companies/${company._id}`)
      .set(adminHeader)
      .send({ confirmation: 'wrong name' });
    expect(rejectedDelete.status).toBe(409);
    expect(await CompanyModel.findById(company._id)).not.toBeNull();

    const deleteRes = await request(app)
      .delete(`/platform/companies/${company._id}`)
      .set(adminHeader)
      .send({ confirmation: company.name });
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.status).toBe('deleted');
    expect(await CompanyModel.findById(company._id)).toBeNull();
    expect(await QuarryModel.findById(quarry._id)).toBeNull();
    expect(await DocumentModel.findById(document._id)).toBeNull();
    expect(await DocumentVersionModel.countDocuments({ company_id: company._id })).toBe(0);
    expect(await FolderModel.countDocuments({ company_id: company._id })).toBe(0);
    expect(await QuarryPermissionModel.findById(otherPermission._id)).not.toBeNull();
    expect(await MembershipModel.findOne({ user_id: sharedMember._id, company_id: otherCompany._id })).not.toBeNull();
    expect((await UserModel.findById(soleMember._id))?.status).toBe(UserStatus.inactive);
    expect((await UserModel.findById(sharedMember._id))?.status).toBe(UserStatus.active);
    expect(await storage.exists(documentKey)).toBe(false);
    expect(await storage.exists(versionKey)).toBe(false);
    expect(await AuditEventModel.countDocuments({ action: 'platform.company.delete' })).toBe(1);
  });

  it('lets Platform Admin restore an archived quarry and permanently delete only that quarry', async () => {
    const company = await createTestCompany();
    const otherCompany = await createTestCompany();
    const { header: dashboardHeader } = await createTestPlatformAdminDashboardSession();
    const adminHeader = { ...dashboardHeader, 'X-Company-Id': company._id };
    const companyAdmin = await createTestUser();
    const membership = await createTestMembership(companyAdmin._id, company._id, MembershipRole.company_admin);
    const quarry = await createTestQuarry(company._id, { status: QuarryStatus.inactive });
    membership.hidden_quarries = [quarry._id];
    await membership.save();
    const otherQuarry = await createTestQuarry(otherCompany._id);
    const otherPermission = await createTestPermission(companyAdmin._id, otherQuarry._id);
    await CompanyModel.findByIdAndUpdate(company._id, { used_bytes: 80 });

    const documentKey = buildStorageKey(company._id, quarry._id, 'quarry-delete-document');
    const versionKey = buildStorageKey(company._id, quarry._id, 'quarry-delete-document', 2);
    await storage.put(Buffer.from('quarry fixture document'), documentKey);
    await storage.put(Buffer.from('quarry fixture version'), versionKey);
    const document = await DocumentModel.create({
      company_id: company._id,
      quarry_id: quarry._id,
      display_name: 'quarry-fixture.pdf',
      original_filename: 'quarry-fixture.pdf',
      mime_type: 'application/pdf',
      size_bytes: 24,
      storage_ref: documentKey,
    });
    await DocumentVersionModel.create({
      document_id: document._id,
      company_id: company._id,
      quarry_id: quarry._id,
      version: 2,
      size_bytes: 32,
      sha256: 'b'.repeat(64),
      storage_ref: versionKey,
      mime_type: 'application/pdf',
    });

    const companyAdminDelete = await request(app)
      .delete(`/company/quarries/${quarry._id}/permanent`)
      .set({ ...generateAuthHeader(companyAdmin), 'X-Company-Id': company._id })
      .send({ confirmation: quarry.name });
    expect(companyAdminDelete.status).toBe(403);

    const restoreRes = await request(app)
      .post(`/company/quarries/${quarry._id}/reactivate`)
      .set(adminHeader)
      .send({});
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.status).toBe(QuarryStatus.active);

    const wrongConfirmation = await request(app)
      .delete(`/company/quarries/${quarry._id}/permanent`)
      .set(adminHeader)
      .send({ confirmation: 'wrong quarry' });
    expect(wrongConfirmation.status).toBe(409);
    expect(await QuarryModel.findById(quarry._id)).not.toBeNull();

    const deleteRes = await request(app)
      .delete(`/company/quarries/${quarry._id}/permanent`)
      .set(adminHeader)
      .send({ confirmation: quarry.name });
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.status).toBe('deleted');
    expect(await QuarryModel.findById(quarry._id)).toBeNull();
    expect(await DocumentModel.findById(document._id)).toBeNull();
    expect(await DocumentVersionModel.countDocuments({ quarry_id: quarry._id })).toBe(0);
    expect((await MembershipModel.findById(membership._id))?.hidden_quarries).not.toContain(quarry._id);
    expect((await CompanyModel.findById(company._id))?.used_bytes).toBe(24);
    expect(await QuarryModel.findById(otherQuarry._id)).not.toBeNull();
    expect(await QuarryPermissionModel.findById(otherPermission._id)).not.toBeNull();
    expect(await storage.exists(documentKey)).toBe(false);
    expect(await storage.exists(versionKey)).toBe(false);
    expect(await AuditEventModel.countDocuments({ action: 'quarry.permanent_delete' })).toBe(1);
  });

  it('allows Company Admin to create employees and protects last admin from being disabled', async () => {
    const company = await createTestCompany({ max_users: 5 });
    const adminUser = await createTestUser({ username: 'sole_admin' });
    await createTestMembership(adminUser._id, company._id, MembershipRole.company_admin);
    const quarry = await createTestQuarry(company._id);

    const authHeader = generateAuthHeader(adminUser);

    // 1. Create Employee
    const createEmpRes = await request(app)
      .post('/company/employees')
      .set(authHeader)
      .send({
        username: 'new_employee_01',
        password: 'temporaryPassword123',
        email: 'emp01@example.com',
        full_name: 'Employee One',
        quarry_permissions: [
          { quarry_id: quarry._id, can_view: true, can_upload: true, can_download: false, can_delete: false },
        ],
      });

    expect(createEmpRes.status).toBe(201);
    expect(createEmpRes.body.username).toBe('new_employee_01');
    expect(createEmpRes.body.must_change_password).toBe(true);

    const empId = createEmpRes.body.id;

    // 2. Disable Employee (should succeed)
    const disableEmpRes = await request(app)
      .post(`/company/employees/${empId}/disable`)
      .set(authHeader);
    expect(disableEmpRes.status).toBe(200);

    // 3. Attempt to disable the SOLE company administrator (must fail with 409)
    const disableAdminRes = await request(app)
      .post(`/company/employees/${adminUser._id}/disable`)
      .set(authHeader);
    expect(disableAdminRes.status).toBe(409);
    expect(disableAdminRes.body.detail).toContain('cannot disable the last company administrator');
  });

  it('guarantees that audit logs never record plaintext passwords or secrets', async () => {
    const company = await createTestCompany();
    const adminUser = await createTestUser();
    await createTestMembership(adminUser._id, company._id, MembershipRole.company_admin);

    const authHeader = generateAuthHeader(adminUser);
    const sensitivePassword = 'SuperSecretPassword999!';

    await request(app)
      .post('/company/employees')
      .set(authHeader)
      .send({
        username: 'secret_test_user',
        password: sensitivePassword,
        full_name: 'Secret User',
      });

    const auditRecords = await AuditEventModel.find().lean();
    for (const record of auditRecords) {
      const recordStr = JSON.stringify(record);
      expect(recordStr).not.toContain(sensitivePassword);
    }
  });
});
