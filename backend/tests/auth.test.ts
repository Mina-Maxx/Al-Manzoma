import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  createTestCompany,
  createTestUser,
  createTestMembership,
  generateAuthHeader,
} from './helpers.js';
import { CompanyStatus, UserStatus, MembershipRole } from '../src/types/index.js';
import { UserModel } from '../src/database/models/index.js';

const app = createApp();

describe('Authentication & Authorization Flow', () => {
  it('authenticates user with valid credentials via POST /auth/login', async () => {
    const company = await createTestCompany();
    const user = await createTestUser({ username: 'valid_user', password: 'securePassword123' });
    await createTestMembership(user._id, company._id, MembershipRole.employee);

    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'valid_user', password: 'securePassword123' });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeDefined();
    expect(res.body.refresh_token).toBeDefined();
    expect(res.body.token_type).toBe('bearer');
    expect(res.body.user.username).toBe('valid_user');
  });

  it('rejects invalid password with 401', async () => {
    const company = await createTestCompany();
    const user = await createTestUser({ username: 'user_pwd_test', password: 'correctPassword' });
    await createTestMembership(user._id, company._id);

    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'user_pwd_test', password: 'wrongPassword' });

    expect(res.status).toBe(401);
    expect(res.body.detail).toContain('Invalid username or password');
  });

  it('denies inactive / disabled users on login and on token requests', async () => {
    const company = await createTestCompany();
    const user = await createTestUser({ status: UserStatus.inactive, password: 'password123' });
    await createTestMembership(user._id, company._id);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: 'password123' });
    expect(loginRes.status).toBe(401);

    const authHeader = generateAuthHeader(user);
    const meRes = await request(app).get('/me').set(authHeader);
    expect(meRes.status).toBe(403);
    expect(meRes.body.detail).toBe('user is not active');
  });

  it('denies users belonging to suspended companies', async () => {
    const company = await createTestCompany({ status: CompanyStatus.suspended });
    const user = await createTestUser();
    await createTestMembership(user._id, company._id);

    const authHeader = generateAuthHeader(user);
    const meRes = await request(app).get('/me').set(authHeader);
    expect(meRes.status).toBe(403);
    expect(meRes.body.detail).toBe('company is not active');
  });

  it('enforces forced password change: blocks protected endpoints until password changed', async () => {
    const company = await createTestCompany();
    const user = await createTestUser({ must_change_password: true });
    await createTestMembership(user._id, company._id);
    const authHeader = generateAuthHeader(user);

    // /me is permitted so user can inspect status
    const meRes = await request(app).get('/me').set(authHeader);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.must_change_password).toBe(true);

    // /quarries should be blocked with 403 password change required
    const quarriesRes = await request(app).get('/quarries').set(authHeader);
    expect(quarriesRes.status).toBe(403);
    expect(quarriesRes.body.detail).toBe('password change required');

    // Change password via /auth/change-password
    const changeRes = await request(app)
      .post('/auth/change-password')
      .set(authHeader)
      .send({
        current_password: 'password123',
        new_password: 'brandNewPassword123',
        confirm_password: 'brandNewPassword123',
      });
    expect(changeRes.status).toBe(200);

    // Password change revokes the old token; a fresh login restores access.
    const revokedSessionRes = await request(app).get('/quarries').set(authHeader);
    expect(revokedSessionRes.status).toBe(401);

    const updatedUser = await UserModel.findById(user._id);
    expect(updatedUser!.tokens_revoked_at).toBeNull();
    expect(updatedUser!.active_session_id).toBeTruthy();
    const freshLogin = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: 'brandNewPassword123' });

    expect(freshLogin.status).toBe(200);
    const freshAuthHeader = { Authorization: `Bearer ${freshLogin.body.access_token}`, 'X-Client-Application': 'android', 'X-Session-Id': freshLogin.body.session_id };
    const quarriesRes2 = await request(app).get('/quarries').set(freshAuthHeader);
    expect(quarriesRes2.status).toBe(200);
  });
});
