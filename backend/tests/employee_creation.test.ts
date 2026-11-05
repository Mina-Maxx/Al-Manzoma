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
import { UserModel, MembershipModel, QuarryPermissionModel } from '../src/database/models/index.js';
import { MembershipRole, UserStatus } from '../src/types/index.js';

const app = createApp();

describe('Employee Creation & Management Flow (Company & Platform Admin)', () => {
  it('1. Authorized company admin can create an employee via POST /company/employees', async () => {
    const company = await createTestCompany();
    const adminUser = await createTestUser({ username: 'comp_admin_alpha' });
    await createTestMembership(adminUser._id, company._id, MembershipRole.company_admin);
    const quarry1 = await createTestQuarry(company._id, { name: 'North Quarry' });
    const quarry2 = await createTestQuarry(company._id, { name: 'South Quarry' });

    const authHeader = generateAuthHeader(adminUser);

    const res = await request(app)
      .post('/company/employees')
      .set(authHeader)
      .send({
        username: 'emp_alpha_01',
        email: 'emp_alpha_01@company.com',
        fullName: 'Alpha Employee',
        password: 'TemporaryPassword123',
        quarry_permissions: [
          { quarry_id: quarry1._id, can_view: true, can_upload: true, can_download: false, can_delete: false },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.username).toBe('emp_alpha_01');
    expect(res.body.email).toBe('emp_alpha_01@company.com');
    expect(res.body.role).toBe(MembershipRole.employee);
    expect(res.body.must_change_password).toBe(true);
    expect(res.body).not.toHaveProperty('temporary_password');

    // Verify database records
    const membership = await MembershipModel.findOne({ user_id: res.body.id, company_id: company._id });
    expect(membership).toBeDefined();
    expect(membership!.role).toBe(MembershipRole.employee);

    // Verify quarry permissions
    const perms = await QuarryPermissionModel.find({ user_id: res.body.id }).lean();
    expect(perms.length).toBe(1);
    expect(perms[0].quarry_id).toBe(quarry1._id);
    expect(perms[0].can_view).toBe(true);
    expect(perms[0].can_upload).toBe(true);
    expect(perms[0].can_delete).toBe(false);
  });

  it('creates a listed employee who completes the forced password-change login flow with a rotated session', async () => {
    const company = await createTestCompany();
    const adminUser = await createTestUser({ username: 'onboarding_admin' });
    await createTestMembership(adminUser._id, company._id, MembershipRole.company_admin);
    const adminHeader = generateAuthHeader(adminUser);

    const created = await request(app)
      .post('/company/employees')
      .set(adminHeader)
      .send({
        username: 'onboarding_employee',
        email: 'onboarding@example.com',
        full_name: 'Onboarding Employee',
        password: 'TemporaryPassword123',
      });
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty('temporary_password');

    const employeeList = await request(app).get('/company/employees').set(adminHeader);
    expect(employeeList.status).toBe(200);
    expect(employeeList.body.some((employee: { id: string }) => employee.id === created.body.id)).toBe(true);

    const login = await request(app)
      .post('/auth/login')
      .send({ username: 'onboarding_employee', password: 'TemporaryPassword123' });
    expect(login.status).toBe(200);
    expect(login.body.user.must_change_password).toBe(true);

    const passwordChange = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .set('X-Client-Application', 'android')
      .set('X-Session-Id', login.body.session_id)
      .send({
        current_password: 'TemporaryPassword123',
        new_password: 'PermanentPassword123!',
        confirm_password: 'PermanentPassword123!',
      });
    expect(passwordChange.status).toBe(200);
    expect(passwordChange.body.session_id).toBeTruthy();
    expect(passwordChange.body.access_token).toBeTruthy();

    const profile = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${passwordChange.body.access_token}`)
      .set('X-Client-Application', 'android')
      .set('X-Session-Id', passwordChange.body.session_id);
    expect(profile.status).toBe(200);

    const refreshedSession = await request(app)
      .post('/auth/refresh')
      .set('X-Client-Application', 'android')
      .send({ refresh_token: passwordChange.body.refresh_token, session_id: passwordChange.body.session_id });
    expect(refreshedSession.status).toBe(200);
    expect(refreshedSession.body.session_id).toBe(passwordChange.body.session_id);

    const oldSession = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .set('X-Client-Application', 'android')
      .set('X-Session-Id', login.body.session_id);
    expect(oldSession.status).toBe(401);
  });

  it('allows an Android employee to perform each action enabled in Dashboard permissions', async () => {
    const company = await createTestCompany();
    const adminUser = await createTestUser({ username: 'permissions_admin' });
    await createTestMembership(adminUser._id, company._id, MembershipRole.company_admin);
    const adminHeader = generateAuthHeader(adminUser);
    const quarry = await createTestQuarry(company._id, { name: 'Four Permission Quarry' });

    const created = await request(app)
      .post('/company/employees')
      .set(adminHeader)
      .send({
        username: 'four_permissions_employee',
        email: 'four-permissions@example.com',
        full_name: 'Four Permissions Employee',
        password: 'TemporaryPassword123',
        permissions: { can_view: false, can_upload: false, can_download: false, can_delete: false },
        quarry_permissions: [{ quarry_id: quarry._id, can_view: false, can_upload: false, can_download: false, can_delete: false }],
      });
    expect(created.status).toBe(201);

    const savedByDashboard = await request(app)
      .post('/company/permissions')
      .set(adminHeader)
      .send({
        user_id: created.body.id,
        permissions: { can_view: true, can_upload: true, can_download: true, can_delete: true },
        hidden_quarries: [],
        quarry_permissions: [{ quarry_id: quarry._id, can_view: true, can_upload: true, can_download: true, can_delete: true }],
      });
    expect(savedByDashboard.status).toBe(200);

    const login = await request(app)
      .post('/auth/login')
      .set('X-Client-Application', 'android')
      .send({ username: 'four_permissions_employee', password: 'TemporaryPassword123', client_application: 'android' });
    expect(login.status).toBe(200);
    const passwordChange = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .set('X-Client-Application', 'android')
      .set('X-Session-Id', login.body.session_id)
      .send({
        current_password: 'TemporaryPassword123',
        new_password: 'PermanentPassword123!',
        confirm_password: 'PermanentPassword123!',
      });
    expect(passwordChange.status).toBe(200);

    const employeeHeaders = {
      Authorization: `Bearer ${passwordChange.body.access_token}`,
      'X-Client-Application': 'android',
      'X-Session-Id': passwordChange.body.session_id,
    };
    const quarryList = await request(app).get('/quarries').set(employeeHeaders);
    expect(quarryList.status).toBe(200);
    const listedQuarry = quarryList.body.find((item: { id: string }) => item.id === quarry._id);
    expect(listedQuarry.permissions).toEqual({ can_view: true, can_upload: true, can_download: true, can_delete: true });

    const upload = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(employeeHeaders)
      .set('Idempotency-Key', 'all-four-dashboard-permissions')
      .attach('file', Buffer.from('%PDF-1.4 all four permissions'), 'four-permissions.pdf');
    expect(upload.status).toBe(201);

    const documents = await request(app).get(`/quarries/${quarry._id}/documents`).set(employeeHeaders);
    expect(documents.status).toBe(200);
    expect(documents.body.some((document: { id: string }) => document.id === upload.body.id)).toBe(true);

    const view = await request(app).get(`/documents/${upload.body.id}/view`).set(employeeHeaders);
    expect(view.status).toBe(200);
    const download = await request(app).get(`/documents/${upload.body.id}/download`).set(employeeHeaders);
    expect(download.status).toBe(200);
    const deletion = await request(app).delete(`/quarries/${quarry._id}/documents/${upload.body.id}`).set(employeeHeaders);
    expect(deletion.status).toBe(204);
  });

  it('2. Missing or invalid authentication is rejected with 401', async () => {
    // Missing credentials on company endpoint
    const resNoAuth = await request(app)
      .post('/company/employees')
      .send({ username: 'unauth_user', password: 'Password123' });
    expect(resNoAuth.status).toBe(401);

    // Missing credentials on platform endpoint
    const resNoAuthPlatform = await request(app)
      .post('/platform/users')
      .send({ username: 'unauth_user', email: 'unauth@test.com', password: 'Password123' });
    expect(resNoAuthPlatform.status).toBe(401);
  });

  it('3. Regular employee cannot create other employees (403 Forbidden)', async () => {
    const company = await createTestCompany();
    const regularEmployee = await createTestUser({ username: 'regular_emp' });
    await createTestMembership(regularEmployee._id, company._id, MembershipRole.employee);

    const authHeader = generateAuthHeader(regularEmployee);

    const res = await request(app)
      .post('/company/employees')
      .set(authHeader)
      .send({
        username: 'sub_employee',
        email: 'sub@company.com',
        password: 'Password123',
      });

    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('company administrator role required');
  });

  it('4. Invalid input returns intended validation errors rather than 404', async () => {
    const company = await createTestCompany();
    const adminUser = await createTestUser({ username: 'validation_admin' });
    await createTestMembership(adminUser._id, company._id, MembershipRole.company_admin);
    const authHeader = generateAuthHeader(adminUser);

    const missingPasswordRes = await request(app)
      .post('/company/employees')
      .set(authHeader)
      .send({ username: 'missing_password_emp', email: 'missing-password@example.com' });
    expect(missingPasswordRes.status).toBe(400);
    expect(missingPasswordRes.body.detail).toContain('password is required');

    // Password too short (< 8 chars)
    const shortPwdRes = await request(app)
      .post('/company/employees')
      .set(authHeader)
      .send({
        username: 'short_pwd_emp',
        password: 'short',
      });
    expect(shortPwdRes.status).toBe(400);
    expect(shortPwdRes.body.detail).toContain('password must be at least 8 characters');
  });

  it('5. Duplicate usernames or emails return 409 Conflict', async () => {
    const company = await createTestCompany();
    const adminUser = await createTestUser({ username: 'conflict_admin' });
    await createTestMembership(adminUser._id, company._id, MembershipRole.company_admin);
    const authHeader = generateAuthHeader(adminUser);

    // Create first employee
    await request(app)
      .post('/company/employees')
      .set(authHeader)
      .send({
        username: 'unique_candidate',
        email: 'candidate@company.com',
        password: 'Password123',
      });

    // Attempt duplicate username
    const dupUsernameRes = await request(app)
      .post('/company/employees')
      .set(authHeader)
      .send({
        username: 'UNIQUE_CANDIDATE',
        email: 'other_candidate@company.com',
        password: 'Password123',
      });
    expect(dupUsernameRes.status).toBe(409);
    expect(dupUsernameRes.body.detail).toContain('username is already taken');

    // Attempt duplicate email
    const dupEmailRes = await request(app)
      .post('/company/employees')
      .set(authHeader)
      .send({
        username: 'different_username',
        email: 'CANDIDATE@company.com',
        password: 'Password123',
      });
    expect(dupEmailRes.status).toBe(409);
    expect(dupEmailRes.body.detail).toContain('email is already registered');
  });

  it('6. Enforces company max_users quota limit (409 Conflict)', async () => {
    const company = await createTestCompany({ max_users: 1 });
    const adminUser = await createTestUser({ username: 'sole_member' });
    await createTestMembership(adminUser._id, company._id, MembershipRole.company_admin);
    const authHeader = generateAuthHeader(adminUser);

    // Company already has 1 user (adminUser), max_users is 1
    const res = await request(app)
      .post('/company/employees')
      .set(authHeader)
      .send({
        username: 'overflow_user',
        email: 'overflow@company.com',
        password: 'Password123',
      });

    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('company has reached maximum users capacity');
  });

  it('7. Platform Admin can provision users via POST /platform/users (User Directory action)', async () => {
    const company = await createTestCompany();
    const platformAdmin = await createTestPlatformAdmin({ full_name: 'super_prov_admin' });
    await createTestUser({ auth_user_id: platformAdmin.auth_user_id, full_name: platformAdmin.full_name });
    const authHeader = generateAuthHeader(platformAdmin);
    const quarry = await createTestQuarry(company._id, { name: 'Main Quarry' });

    // Provision an employee account directly from Platform view
    const res = await request(app)
      .post('/platform/users')
      .set(authHeader)
      .send({
        username: 'platform_created_emp',
        email: 'plat_emp@test.com',
        fullName: 'Platform Employee',
        password: 'SecurePassword123',
        role: 'employee',
        company_id: company._id,
      });

    expect(res.status).toBe(201);
    expect(res.body.username).toBe('platform_created_emp');
    expect(res.body.role).toBe('employee');
    expect(res.body.company_id).toBe(company._id);
    expect(res.body.company_name).toBe(company.name);
    expect(res.body).not.toHaveProperty('temporary_password');

    // Verify employee was assigned view permissions on company's active quarry
    const perms = await QuarryPermissionModel.find({ user_id: res.body.id }).lean();
    expect(perms.length).toBe(1);
    expect(perms[0].quarry_id).toBe(quarry._id);
    expect(perms[0].can_view).toBe(true);

    // Non-platform admin is rejected on POST /platform/users with 403
    const normalUser = await createTestUser();
    const normalAuth = generateAuthHeader(normalUser);
    const rejectRes = await request(app)
      .post('/platform/users')
      .set(normalAuth)
      .send({
        username: 'hack_attempt',
        email: 'hack@test.com',
        role: 'platform_admin',
      });
    expect(rejectRes.status).toBe(403);
  });
});
