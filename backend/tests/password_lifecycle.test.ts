import { describe, it, expect } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
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
import { CompanyStatus, UserStatus, MembershipRole } from '../src/types/index.js';
import { PasswordResetTokenModel, UserModel } from '../src/database/models/index.js';
import type { Request } from 'express';
import { isMustChangePasswordAllowedRoute, isTokenRevoked } from '../src/middleware/auth.js';

const app = createApp();

describe('Mandatory password-change route allowlist', () => {
  const routeRequest = (originalUrl: string, path = originalUrl) =>
    ({ originalUrl, path } as Request);

  it('allows only the profile and password-change endpoints, ignoring query strings', () => {
    expect(isMustChangePasswordAllowedRoute(routeRequest('/me?tab=profile'))).toBe(true);
    expect(isMustChangePasswordAllowedRoute(routeRequest('/auth/change-password?next=/quarries'))).toBe(true);
    expect(isMustChangePasswordAllowedRoute(routeRequest('/auth/change-password/', '/change-password/'))).toBe(true);
  });

  it('does not allow unrelated routes just because they end in /change-password', () => {
    expect(isMustChangePasswordAllowedRoute(routeRequest('/platform/users/123/change-password'))).toBe(false);
    expect(isMustChangePasswordAllowedRoute(routeRequest('/auth/other/change-password'))).toBe(false);
    expect(isMustChangePasswordAllowedRoute(routeRequest('/not-me'))).toBe(false);
  });
});

describe('JWT revocation precision', () => {
  it('revokes tokens issued in the same second as the revocation timestamp', () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    expect(isTokenRevoked(issuedAt, new Date(issuedAt * 1000 + 1))).toBe(true);
    expect(isTokenRevoked(issuedAt + 1, new Date(issuedAt * 1000 + 1))).toBe(false);
  });
});

describe('Password Recovery & Lifecycle Security Suite', () => {
  describe('1. Self-Service Password Recovery Policy Enforcement', () => {
    it('disables self-service password recovery (/auth/recover) per security policy', async () => {
      const res = await request(app)
        .post('/auth/recover')
        .send({ identifier: 'recover_user@example.com' });

      expect(res.status).toBe(403);
      expect(res.body.detail).toContain('disabled');
      expect(res.body.detail).toContain('Platform Administrator');
    });

    it('disables self-service forgot password (/auth/forgot-password) per security policy', async () => {
      const res = await request(app)
        .post('/auth/forgot-password')
        .send({ email: 'user@example.com' });

      expect(res.status).toBe(403);
      expect(res.body.detail).toContain('disabled');
    });

    it('disables self-service password reset token consumption (/auth/reset-password) per security policy', async () => {
      const res = await request(app)
        .post('/auth/reset-password')
        .send({
          token: 'some_token',
          new_password: 'ValidPassword123!',
          confirm_password: 'ValidPassword123!',
        });

      expect(res.status).toBe(403);
      expect(res.body.detail).toContain('disabled');
    });
  });

  describe('2. Administrative Temporary Password Reset & Delivery', () => {
    it('platform admin reset accepts an explicit temporary password, revokes old tokens, and requires a change', async () => {
      const admin = await createTestPlatformAdmin();
      const adminUser = await createTestUser({ auth_user_id: admin.auth_user_id });
      const adminAuth = generateAuthHeader(adminUser, 'platform_admin');

      const company = await createTestCompany();
      const employee = await createTestUser({ password: 'InitialPass123!' });
      await createTestMembership(employee._id, company._id);

      const tempPass = 'AdminResetTemp123!';
      const resetRes = await request(app)
        .post(`/platform/users/${employee._id}/reset-password`)
        .set(adminAuth)
        .send({ temporary_password: tempPass, confirm_password: tempPass });

      expect(resetRes.status).toBe(200);
      expect(resetRes.body).not.toHaveProperty('temporary_password');

      // Verify employee record has must_change_password: true and tokens_revoked_at set
      const updatedEmp = await UserModel.findById(employee._id);
      expect(updatedEmp!.must_change_password).toBe(true);
      expect(updatedEmp!.tokens_revoked_at).not.toBeNull();

      // Employee logs in with temporary password
      await waitForFreshJwtIat(updatedEmp!.tokens_revoked_at!);
      const loginRes = await request(app)
        .post('/auth/login')
        .send({ username: employee.username, password: tempPass });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.user.must_change_password).toBe(true);
    });

    it('denies company-admin password resets without changing any account', async () => {
      const company1 = await createTestCompany();
      const companyAdmin = await createTestUser();
      await createTestMembership(companyAdmin._id, company1._id, MembershipRole.company_admin);
      const companyAdminAuth = generateAuthHeader(companyAdmin);

      const employee1 = await createTestUser();
      await createTestMembership(employee1._id, company1._id, MembershipRole.employee);

      const company2 = await createTestCompany();
      const employee2 = await createTestUser();
      await createTestMembership(employee2._id, company2._id, MembershipRole.employee);

      const passwordHashBefore = (await UserModel.findById(employee1._id))!.password_hash;
      const resetRes = await request(app)
        .post(`/company/employees/${employee1._id}/reset-password`)
        .set(companyAdminAuth)
        .send({ temporary_password: 'CustomTempPass123!' });
      expect(resetRes.status).toBe(403);
      expect(resetRes.body.detail).toBe('Only Platform Admins can reset passwords');

      const unchangedEmployee = await UserModel.findById(employee1._id);
      expect(unchangedEmployee!.password_hash).toBe(passwordHashBefore);
      expect(unchangedEmployee!.must_change_password).toBe(false);
      expect(unchangedEmployee!.tokens_revoked_at).toBeNull();

      // The same restriction applies to targets in other companies.
      const foreignResetRes = await request(app)
        .post(`/company/employees/${employee2._id}/reset-password`)
        .set(companyAdminAuth)
        .send({ temporary_password: 'CustomTempPass123!' });
      expect(foreignResetRes.status).toBe(403);
    });
  });

  describe('3. Temporary Password to Permanent Password Lifecycle & Invalidation', () => {
    it('enforces mandatory password change, blocks protected routes, and validates change-password rules', async () => {
      const company = await createTestCompany();
      const tempPass = 'TemporaryPassword123!';
      const user = await createTestUser({ password: tempPass, must_change_password: true });
      await createTestMembership(user._id, company._id, MembershipRole.employee);

      // Login with temporary password
      const loginRes = await request(app)
        .post('/auth/login')
        .send({ username: user.username, password: tempPass });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.user.must_change_password).toBe(true);

      const tempToken = loginRes.body.access_token;
      const tempAuth = { Authorization: `Bearer ${tempToken}` };

      // Protected route /quarries returns 403 password change required
      const quarriesRes = await request(app)
        .get('/quarries')
        .set(tempAuth);
      expect(quarriesRes.status).toBe(403);
      expect(quarriesRes.body.detail).toBe('password change required');

      // /me is allowed
      const meRes = await request(app)
        .get('/me')
        .set(tempAuth);
      expect(meRes.status).toBe(200);
      expect(meRes.body.user.must_change_password).toBe(true);

      // Reject wrong current password with 401
      const missingCurrentRes = await request(app)
        .post('/auth/change-password')
        .set(tempAuth)
        .send({
          new_password: 'NewPermanentPassword123!',
          confirm_password: 'NewPermanentPassword123!',
        });
      expect(missingCurrentRes.status).toBe(400);
      expect(missingCurrentRes.body.detail).toBe('Current password is required');

      const wrongCurrentRes = await request(app)
        .post('/auth/change-password')
        .set(tempAuth)
        .send({
          current_password: 'WrongCurrentPassword999!',
          new_password: 'NewPermanentPassword123!',
          confirm_password: 'NewPermanentPassword123!',
        });
      expect(wrongCurrentRes.status).toBe(401);
      expect(wrongCurrentRes.body.detail).toContain('incorrect');

      // Reject confirmation mismatch with 400
      const mismatchRes = await request(app)
        .post('/auth/change-password')
        .set(tempAuth)
        .send({
          current_password: tempPass,
          new_password: 'NewPermanentPassword123!',
          confirm_password: 'DifferentPassword123!',
        });
      expect(mismatchRes.status).toBe(400);
      expect(mismatchRes.body.detail).toContain('match');

      // Reject re-using the same temporary password with 400
      const samePassRes = await request(app)
        .post('/auth/change-password')
        .set(tempAuth)
        .send({
          current_password: tempPass,
          new_password: tempPass,
          confirm_password: tempPass,
        });
      expect(samePassRes.status).toBe(400);
      expect(samePassRes.body.detail).toContain('different from the current password');

      // Reject weak password with 400
      const weakRes = await request(app)
        .post('/auth/change-password')
        .set(tempAuth)
        .send({
          current_password: tempPass,
          new_password: 'weak',
          confirm_password: 'weak',
        });
      expect(weakRes.status).toBe(400);

      // Wait 1.05s so JWT iat (integer second timestamp) is strictly earlier than revocation timestamp
      await new Promise((resolve) => setTimeout(resolve, 1050));

      // Successful password change
      const permPass = 'PermanentSecurePassword2026!';
      const successRes = await request(app)
        .post('/auth/change-password')
        .set(tempAuth)
        .send({
          current_password: tempPass,
          new_password: permPass,
          confirm_password: permPass,
        });
      expect(successRes.status).toBe(200);
      expect(successRes.body.status).toBe('ok');

      // Verify database state: must_change_password is now false
      const updatedUser = await UserModel.findById(user._id);
      expect(updatedUser!.must_change_password).toBe(false);
      expect(updatedUser!.tokens_revoked_at).toBeNull();
      expect(updatedUser!.active_session_id).toBeTruthy();

      // Verify old temporary session token is now revoked (returns 401)
      const oldSessionRes = await request(app)
        .get('/quarries')
        .set(tempAuth);
      expect(oldSessionRes.status).toBe(401);

      // Logging in with old temporary password fails (401)
      const oldLoginRes = await request(app)
        .post('/auth/login')
        .send({ username: user.username, password: tempPass });
      expect(oldLoginRes.status).toBe(401);

      // Logging in with new permanent password succeeds
      await waitForFreshJwtIat(updatedUser!.tokens_revoked_at!);
      const newLoginRes = await request(app)
        .post('/auth/login')
        .send({ username: user.username, password: permPass });
      expect(newLoginRes.status).toBe(200);
      expect(newLoginRes.body.user.must_change_password).toBe(false);

      // Protected endpoints are now fully unblocked with new permanent session
      const newAuth = { Authorization: `Bearer ${newLoginRes.body.access_token}` };
      const unblockedRes = await request(app)
        .get('/quarries')
        .set(newAuth);
      expect(unblockedRes.status).toBe(200);
    });
  });
});
