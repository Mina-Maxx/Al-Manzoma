import { describe, it, expect } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import {
  createTestCompany,
  createTestUser,
  createTestMembership,
  createTestPlatformAdmin,
  generateAuthHeader,
  waitForFreshJwtIat,
} from './helpers.js';
import { MembershipRole } from '../src/types/index.js';
import { UserModel } from '../src/database/models/index.js';

const app = createApp();

describe('Exact Reproduction & Regression Verification Suite', () => {
  it('1. Mandatory Password Change Sequence: Platform Admin reset -> Login -> Permanent Password', async () => {
    const admin = await createTestPlatformAdmin();
    const adminUser = await createTestUser({ auth_user_id: admin.auth_user_id, username: 'plat_admin_1' });
    const adminAuth = generateAuthHeader(adminUser, 'platform_admin');

    const company = await createTestCompany({ name: 'Testing Co' });
    const employee = await createTestUser({
      username: 'target_emp_1',
      email: 'target_emp_1@testing.com',
      password: 'InitialPassword123!',
    });
    await createTestMembership(employee._id, company._id, MembershipRole.employee);

    // STEP 1: Platform Admin resets an employee's password
    const resetRes = await request(app)
      .post(`/platform/users/${employee._id}/reset-password`)
      .set(adminAuth)
      .send({
        temporary_password: 'AdminResetPassword123!',
        confirm_password: 'AdminResetPassword123!',
      });

    expect(resetRes.status).toBe(200);
    expect(resetRes.body).not.toHaveProperty('temporary_password');
    const tempPassword = 'AdminResetPassword123!';

    // STEP 2: Employee signs in using the temporary password
    const resetUser = await UserModel.findById(employee._id);
    await waitForFreshJwtIat(resetUser!.tokens_revoked_at!);
    const loginRes = await request(app)
      .post('/auth/login')
      .send({
        username: employee.username,
        password: tempPassword,
      });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.access_token).toBeDefined();
    expect(loginRes.body.user.must_change_password).toBe(true);
    const tempAccessToken = loginRes.body.access_token;
    const tempAuth = { Authorization: `Bearer ${tempAccessToken}` };

    // STEP 2b: Verify direct navigation to protected endpoints returns 403 Forbidden
    const directQuarriesRes = await request(app).get('/quarries').set(tempAuth);
    expect(directQuarriesRes.status).toBe(403);
    expect(directQuarriesRes.body.detail).toBe('password change required');

    const directSyncRes = await request(app).get('/sync/changes').set(tempAuth);
    expect(directSyncRes.status).toBe(403);
    expect(directSyncRes.body.detail).toBe('password change required');

    const directPlatformRes = await request(app).get('/platform/overview').set(tempAuth);
    expect(directPlatformRes.status).toBe(403);

    // Endpoint /me IS permitted to allow user to inspect their profile and status
    const meRes = await request(app).get('/me').set(tempAuth);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.must_change_password).toBe(true);

    // STEP 3: Employee submits a new permanent password
    const newPermanentPassword = 'BrandNewPermanentPass2026!';
    const changeRes = await request(app)
      .post('/auth/change-password')
      .set(tempAuth)
      .send({
        current_password: tempPassword,
        new_password: newPermanentPassword,
        confirm_password: newPermanentPassword,
      });

    expect(changeRes.status).toBe(200);
    expect(changeRes.body.status).toBe('ok');
    expect(changeRes.body.session_id).toBeTruthy();

    const changedProfile = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${changeRes.body.access_token}`)
      .set('X-Session-Id', changeRes.body.session_id);
    expect(changedProfile.status).toBe(200);

    const revokedTemporarySession = await request(app)
      .get('/me')
      .set(tempAuth);
    expect(revokedTemporarySession.status).toBe(401);

    // STEP 4: Verify exact API response and persistence
    const empInDb = await UserModel.findById(employee._id);
    expect(empInDb!.must_change_password).toBe(false);
    const isNewHash = await bcrypt.compare(newPermanentPassword, empInDb!.password_hash!);
    expect(isNewHash).toBe(true);

    // STEP 5: Verify temporary password fails and new password succeeds
    const failLoginRes = await request(app)
      .post('/auth/login')
      .send({
        username: employee.username,
        password: tempPassword,
      });
    expect(failLoginRes.status).toBe(401);

    const freshLoginRes = await request(app)
      .post('/auth/login')
      .send({
        username: employee.username,
        password: newPermanentPassword,
      });
    expect(freshLoginRes.status).toBe(200);
    expect(freshLoginRes.body.user.must_change_password).toBe(false);

    // Now protected endpoints are unblocked
    const freshAuth = { Authorization: `Bearer ${freshLoginRes.body.access_token}` };
    const unblockedRes = await request(app).get('/quarries').set(freshAuth);
    expect(unblockedRes.status).toBe(200);
  });

  it('2. Platform Admin with must_change_password can access /auth/change-password without company context', async () => {
    const admin = await createTestPlatformAdmin();
    const tempPassword = 'AdminTempPass123!';
    const adminUser = await createTestUser({
      auth_user_id: admin.auth_user_id,
      password: tempPassword,
      must_change_password: true,
    });

    const loginRes = await request(app).post('/auth/login').send({
      username: adminUser.username,
      password: tempPassword,
    });
    expect(loginRes.status).toBe(200);
    const adminTempToken = loginRes.body.access_token;
    const adminTempAuth = { Authorization: `Bearer ${adminTempToken}` };

    // Navigation to platform overview is blocked with 403
    const overviewRes = await request(app).get('/platform/overview').set(adminTempAuth);
    expect(overviewRes.status).toBe(403);
    expect(overviewRes.body.detail).toBe('password change required');

    // /auth/change-password MUST succeed without requiring X-Company-Id
    const newAdminPass = 'PermanentAdminPass2026!';
    const changeRes = await request(app)
      .post('/auth/change-password')
      .set(adminTempAuth)
      .send({
        current_password: tempPassword,
        new_password: newAdminPass,
        confirm_password: newAdminPass,
      });

    console.log('Admin change password status:', changeRes.status);
    expect(changeRes.status).toBe(200);
  });
});
