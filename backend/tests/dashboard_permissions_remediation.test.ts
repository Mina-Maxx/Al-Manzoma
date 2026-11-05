import { describe, it, expect, beforeEach } from 'vitest';
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
  QuarryPermissionModel,
  DocumentModel,
  UserModel,
  QuarryModel,
} from '../src/database/models/index.js';
import { MembershipRole, DocumentStatus } from '../src/types/index.js';
import { v4 as uuidv4 } from 'uuid';

const app = createApp();

describe('Dashboard, Permissions & Profile Remediation Suite', () => {
  let platformAdminHeader: { Authorization: string };
  let employeeHeader: { Authorization: string };
  let companyId: string;
  let employeeUserId: string;
  let quarryAId: string;
  let quarryBId: string;

  beforeEach(async () => {
    // 1. Setup Platform Admin
    const adminAuthUserId = `auth-platform-${uuidv4().substring(0, 8)}`;
    const adminUser = await createTestUser({
      username: 'platform_super_rem',
      auth_user_id: adminAuthUserId,
      password: 'AdminPassword123!',
    });
    await createTestPlatformAdmin({
      user_id: adminUser._id,
      auth_user_id: adminAuthUserId,
      email: adminUser.email,
    });

    const adminLoginRes = await request(app)
      .post('/auth/login')
      .send({ username: 'platform_super_rem', password: 'AdminPassword123!' });
    expect(adminLoginRes.status).toBe(200);
    platformAdminHeader = { Authorization: `Bearer ${adminLoginRes.body.access_token}` };

    // 2. Setup Company & Quarries
    const company = await createTestCompany({ name: 'شركة الوادي للتعدين' });
    companyId = company._id;

    const quarryA = await createTestQuarry(companyId, {
      name: 'محجر الجرانيت رقم 1',
      quarry_number: 'GR-101',
      quarry_type: 'جرانيت رمادي',
    });
    quarryAId = quarryA._id;

    const quarryB = await createTestQuarry(companyId, {
      name: 'محجر البازلت المحظور',
      quarry_number: 'BZ-202',
      quarry_type: 'بازلت أسود',
    });
    quarryBId = quarryB._id;

    // 3. Setup Employee
    const empAuthUserId = `auth-emp-${uuidv4().substring(0, 8)}`;
    const empUser = await createTestUser({
      username: 'emp_remediation',
      auth_user_id: empAuthUserId,
      password: 'EmpPassword123!',
      full_name: 'أحمد الموظف التجريبي',
    });
    employeeUserId = empUser._id;

    await createTestMembership(employeeUserId, companyId, MembershipRole.employee);

    const empLoginRes = await request(app)
      .post('/auth/login')
      .send({ username: 'emp_remediation', password: 'EmpPassword123!' });
    expect(empLoginRes.status).toBe(200);
    employeeHeader = { Authorization: `Bearer ${empLoginRes.body.access_token}` };
  });

  it('creates Dashboard quarries through the Company Admin route with optional quarry metadata', async () => {
    const companyAdmin = await createTestUser({ username: `company_admin_${uuidv4().slice(0, 8)}` });
    await createTestMembership(companyAdmin._id, companyId, MembershipRole.company_admin);

    const response = await request(app)
      .post('/company/quarries')
      .set(generateAuthHeader(companyAdmin))
      .send({
        name: 'Dashboard Quarry',
        quarry_number: 'DB-204',
        quarry_type: 'granite',
      });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe('Dashboard Quarry');
    expect(response.body.quarry_number).toBe('DB-204');
    expect(response.body.quarry_type).toBe('granite');
    const stored = await QuarryModel.findOne({ _id: response.body.id, company_id: companyId });
    expect(stored).not.toBeNull();
  });

  it('1. GET /platform/overview returns real dynamic health checks, camelCase + snake_case, and telemetry counts', async () => {
    const res = await request(app)
      .get('/platform/overview')
      .set(platformAdminHeader);

    expect(res.status).toBe(200);

    // Verification of snake_case fields
    expect(res.body).toHaveProperty('total_offices');
    expect(res.body).toHaveProperty('active_offices');
    expect(res.body).toHaveProperty('total_users');
    expect(res.body).toHaveProperty('active_users');
    expect(res.body).toHaveProperty('total_quarries');
    expect(res.body).toHaveProperty('active_documents');
    expect(res.body).toHaveProperty('total_used_bytes');
    expect(res.body).toHaveProperty('total_quota_bytes');
    expect(res.body).toHaveProperty('backend_health');
    expect(res.body).toHaveProperty('database_health');
    expect(res.body).toHaveProperty('storage_health');
    expect(res.body.backend_health).toBe('healthy');
    expect(res.body.database_health).toBe('healthy');

    // Verification of camelCase fields (for Next.js frontend binding)
    expect(res.body).toHaveProperty('totalOffices');
    expect(res.body).toHaveProperty('activeOffices');
    expect(res.body).toHaveProperty('totalUsers');
    expect(res.body).toHaveProperty('activeUsers');
    expect(res.body).toHaveProperty('totalQuarries');
    expect(res.body).toHaveProperty('activeDocs');
    expect(res.body).toHaveProperty('storageUsageBytes');
    expect(res.body).toHaveProperty('storageQuotaBytes');
    expect(res.body).toHaveProperty('backendHealth');
    expect(res.body).toHaveProperty('databaseHealth');
    expect(res.body).toHaveProperty('storageHealth');
    expect(res.body.backendHealth).toBe('healthy');
    expect(res.body.databaseHealth).toBe('healthy');
    expect(res.body.telemetry).toBeDefined();
    expect(typeof res.body.telemetry.uploadsCount).toBe('number');
  });

  it('2. PATCH /me updates full_name and rejects privilege escalation attempts', async () => {
    // Attempt privilege escalation
    const malRes = await request(app)
      .patch('/me')
      .set(employeeHeader)
      .send({ full_name: 'أحمد محمود', role: 'platform_admin' });
    expect(malRes.status).toBe(403);

    // Short name (< 2 chars)
    const shortRes = await request(app)
      .patch('/me')
      .set(employeeHeader)
      .send({ full_name: ' ' });
    expect(shortRes.status).toBe(400);

    // Valid update
    const validRes = await request(app)
      .patch('/me')
      .set(employeeHeader)
      .send({ full_name: 'أحمد محمود مصطفى' });
    expect(validRes.status).toBe(200);
    expect(validRes.body.user.full_name).toBe('أحمد محمود مصطفى');

    // Verify persisted in DB
    const updatedUser = await UserModel.findById(employeeUserId);
    expect(updatedUser?.full_name).toBe('أحمد محمود مصطفى');
  });

  it('3. GET /me returns effective default permissions', async () => {
    const res = await request(app)
      .get('/me')
      .set(employeeHeader);

    expect(res.status).toBe(200);
    expect(res.body.permissions).toEqual({
      can_view: true,
      can_upload: true,
      can_download: true,
      can_delete: false,
    });
  });

  it('4. Default Employee Permissions: employee has default view/upload/download across quarries without explicit records', async () => {
    // No records exist in QuarryPermissionModel for this employee yet
    const permsCount = await QuarryPermissionModel.countDocuments({ user_id: employeeUserId });
    expect(permsCount).toBe(0);

    // 1. Listing quarries returns active quarries with default permissions
    const listRes = await request(app)
      .get('/quarries')
      .set(employeeHeader)
      .set('X-Company-Id', companyId);

    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBeGreaterThanOrEqual(2);

    const qA = listRes.body.find((q: any) => q.id === quarryAId);
    expect(qA).toBeDefined();
    expect(qA.permissions).toEqual({
      can_view: true,
      can_upload: true,
      can_download: true,
      can_delete: false,
    });

    // 2. Can access folders in Quarry A by default
    const foldersRes = await request(app)
      .get(`/quarries/${quarryAId}/folders`)
      .set(employeeHeader)
      .set('X-Company-Id', companyId);
    expect(foldersRes.status).toBe(200);
  });

  it('5. Exception Override: explicit QuarryPermission with can_view: false hides the quarry and denies access', async () => {
    // Create explicit restriction on Quarry B
    await QuarryPermissionModel.create({
      company_id: companyId,
      user_id: employeeUserId,
      quarry_id: quarryBId,
      can_view: false,
      can_upload: false,
      can_download: false,
      can_delete: false,
    });

    // Listing quarries must NOT include Quarry B
    const listRes = await request(app)
      .get('/quarries')
      .set(employeeHeader)
      .set('X-Company-Id', companyId);

    expect(listRes.status).toBe(200);
    const qB = listRes.body.find((q: any) => q.id === quarryBId);
    expect(qB).toBeUndefined(); // Hidden!

    // Attempting direct access to hidden Quarry B must return 403 Forbidden
    const directRes = await request(app)
      .get(`/quarries/${quarryBId}/folders`)
      .set(employeeHeader)
      .set('X-Company-Id', companyId);
    expect(directRes.status).toBe(403);
  });

  it('6. Document metadata: GET /quarries/:id/documents returns uploaded_by_name and quarry_name', async () => {
    // Create a sample document uploaded by the employee
    const doc = await DocumentModel.create({
      company_id: companyId,
      quarry_id: quarryAId,
      folder_id: null,
      display_name: 'عقد توريد الجرانيت 2026',
      original_filename: 'granite_contract_2026.pdf',
      mime_type: 'application/pdf',
      size_bytes: 10240,
      status: DocumentStatus.available,
      uploaded_by: employeeUserId,
      version: 1,
    });

    const docListRes = await request(app)
      .get(`/quarries/${quarryAId}/documents`)
      .set(employeeHeader)
      .set('X-Company-Id', companyId);

    expect(docListRes.status).toBe(200);
    const found = docListRes.body.find((d: any) => d.id === doc._id);
    expect(found).toBeDefined();
    expect(found.uploaded_by_name).toBe('أحمد الموظف التجريبي');
    expect(found.quarry_name).toContain('محجر الجرانيت رقم 1');
    expect(found.created_at).toBeDefined();
  });
});
