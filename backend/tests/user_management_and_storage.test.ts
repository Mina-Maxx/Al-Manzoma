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
import { UserModel, MembershipModel, QuarryPermissionModel, PlatformAdminModel, DocumentModel } from '../src/database/models/index.js';
import { MembershipRole, UserStatus } from '../src/types/index.js';

const app = createApp();

describe('User Management, File Uploads, & Platform Admin Cross-Access', () => {
  it('1. Platform admin can update a user via PATCH /platform/users/:id', async () => {
    const adminUser = await createTestUser({ username: 'super_editor' });
    await createTestPlatformAdmin({ auth_user_id: adminUser.auth_user_id, email: adminUser.email });

    const company1 = await createTestCompany({ name: 'Alpha Minerals' });
    const company2 = await createTestCompany({ name: 'Beta Quarrying' });

    const targetUser = await createTestUser({
      username: 'worker_john',
      email: 'john@alpha.internal',
      full_name: 'John Old',
    });
    await createTestMembership(targetUser._id, company1._id, MembershipRole.employee);

    const adminHeader = generateAuthHeader(adminUser, 'platform_admin');

    // Update user: name, email, role, and transfer company
    const res = await request(app)
      .patch(`/platform/users/${targetUser._id}`)
      .set(adminHeader)
      .send({
        full_name: 'John Doe Senior',
        email: 'john.doe@beta.internal',
        role: 'company_admin',
        company_id: company2._id,
      });

    expect(res.status).toBe(200);
    expect(res.body.full_name).toBe('John Doe Senior');
    expect(res.body.email).toBe('john.doe@beta.internal');
    expect(res.body.role).toBe(MembershipRole.company_admin);
    expect(res.body.company_id).toBe(company2._id);
    expect(res.body.company_name).toBe('Beta Quarrying');

    // Verify DB update
    const updatedUser = await UserModel.findById(targetUser._id);
    expect(updatedUser?.full_name).toBe('John Doe Senior');
    expect(updatedUser?.email).toBe('john.doe@beta.internal');
    expect(updatedUser?.tokens_revoked_at).not.toBeNull();

    const membership = await MembershipModel.findOne({ user_id: targetUser._id });
    expect(membership?.company_id).toBe(company2._id);
    expect(membership?.role).toBe(MembershipRole.company_admin);
  });

  it('2. Platform admin cannot delete their own account', async () => {
    const adminUser = await createTestUser({ username: 'super_self' });
    await createTestPlatformAdmin({ auth_user_id: adminUser.auth_user_id, email: adminUser.email });
    const adminHeader = generateAuthHeader(adminUser, 'platform_admin');

    const res = await request(app)
      .delete(`/platform/users/${adminUser._id}`)
      .set(adminHeader);

    expect(res.status).toBe(409);
    expect(res.body.detail || res.body.error).toMatch(/cannot delete your own account/i);
  });

  it('3. Platform admin can delete another user: soft deletes, revokes tokens, removes membership', async () => {
    const adminUser = await createTestUser({ username: 'super_deleter' });
    await createTestPlatformAdmin({ auth_user_id: adminUser.auth_user_id, email: adminUser.email });

    const company = await createTestCompany();
    const targetUser = await createTestUser({ username: 'user_to_delete' });
    await createTestMembership(targetUser._id, company._id, MembershipRole.employee);

    const adminHeader = generateAuthHeader(adminUser, 'platform_admin');

    const res = await request(app)
      .delete(`/platform/users/${targetUser._id}`)
      .set(adminHeader);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(UserStatus.inactive);

    // Verify user is marked inactive and tokens revoked
    const userDoc = await UserModel.findById(targetUser._id);
    expect(userDoc?.status).toBe(UserStatus.inactive);
    expect(userDoc?.tokens_revoked_at).not.toBeNull();

    // Verify memberships and permissions were cleared
    const membership = await MembershipModel.findOne({ user_id: targetUser._id });
    expect(membership).toBeNull();
  });

  it('4. Company admin can edit an employee via PATCH /company/employees/:id', async () => {
    const company = await createTestCompany();
    const adminUser = await createTestUser({ username: 'company_boss' });
    await createTestMembership(adminUser._id, company._id, MembershipRole.company_admin);

    const employee = await createTestUser({ username: 'staff_jimmy' });
    await createTestMembership(employee._id, company._id, MembershipRole.employee);

    const authHeader = generateAuthHeader(adminUser);

    const res = await request(app)
      .patch(`/company/employees/${employee._id}`)
      .set(authHeader)
      .send({
        full_name: 'Jimmy Updated',
        email: 'jimmy.updated@company.internal',
      });

    expect(res.status).toBe(200);
    expect(res.body.full_name).toBe('Jimmy Updated');
    expect(res.body.email).toBe('jimmy.updated@company.internal');

    const dbUser = await UserModel.findById(employee._id);
    expect(dbUser?.full_name).toBe('Jimmy Updated');
  });

  it('5. Document upload without Idempotency-Key header auto-generates key and succeeds', async () => {
    const company = await createTestCompany();
    const adminUser = await createTestUser({ username: 'uploader_admin' });
    await createTestMembership(adminUser._id, company._id, MembershipRole.company_admin);
    const quarry = await createTestQuarry(company._id, { name: 'Auto Idempotency Pit' });

    const authHeader = generateAuthHeader(adminUser);

    const res = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .attach('file', Buffer.from('%PDF-1.4 test content'), 'auto_key_document.pdf');

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.display_name).toBe('auto_key_document.pdf');
    expect(res.body.title).toBe('auto_key_document.pdf');
    expect(res.body.original_filename).toBe('auto_key_document.pdf');
    expect(res.body.file_name).toBe('auto_key_document.pdf');
    expect(res.body.size_bytes).toBeGreaterThan(0);
    expect(res.body.file_size).toBeGreaterThan(0);
  });

  it('6. Platform admin requires explicit company context (X-Company-Id or query company_id) to download document', async () => {
    const company = await createTestCompany();
    const adminUser = await createTestUser({ username: 'company_uploader' });
    await createTestMembership(adminUser._id, company._id, MembershipRole.company_admin);
    const quarry = await createTestQuarry(company._id, { name: 'Cross Access Quarry' });

    const authHeader = generateAuthHeader(adminUser);

    // Upload a document
    const uploadRes = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .attach('file', Buffer.from('%PDF-1.4 sample document bytes'), 'statement.pdf');

    expect(uploadRes.status).toBe(201);
    const docId = uploadRes.body.id;

    // Platform admin without membership in that company
    const superAdmin = await createTestUser({ username: 'super_downloader' });
    await createTestPlatformAdmin({ auth_user_id: superAdmin.auth_user_id, email: superAdmin.email });
    const superTokenHeader = generateAuthHeader(superAdmin, 'platform_admin');

    // Download with bearer header (no X-Company-Id) is rejected with 403 Forbidden
    const deniedDlRes = await request(app)
      .get(`/documents/${docId}/download`)
      .set(superTokenHeader);
    expect(deniedDlRes.status).toBe(403);

    // Download with bearer header and explicit X-Company-Id succeeds
    const dlRes = await request(app)
      .get(`/documents/${docId}/download`)
      .set(superTokenHeader)
      .set('X-Company-Id', company._id);

    expect(dlRes.status).toBe(200);
    expect(dlRes.header['content-type']).toMatch(/application\/pdf/);

    // Download via ?token=... and &company_id=... query param
    const rawToken = superTokenHeader.Authorization.replace('Bearer ', '');
    const queryDlRes = await request(app)
      .get(`/documents/${docId}/download?token=${encodeURIComponent(rawToken)}&company_id=${company._id}`);

    expect(queryDlRes.status).toBe(200);
    expect(queryDlRes.header['content-type']).toMatch(/application\/pdf/);
  });
});
