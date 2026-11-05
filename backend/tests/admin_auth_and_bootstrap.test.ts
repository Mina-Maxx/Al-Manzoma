import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  createTestCompany,
  createTestUser,
  createTestMembership,
  createTestPlatformAdmin,
  createTestPlatformAdminDashboardSession,
  createTestQuarry,
  generateAuthHeader,
  waitForFreshJwtIat,
} from './helpers.js';
import { CompanyStatus, UserStatus, MembershipRole, AuditResult } from '../src/types/index.js';
import { UserModel, PlatformAdminModel, AuditEventModel } from '../src/database/models/index.js';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { bootstrapAdmin } from '../src/scripts/bootstrapAdmin.js';
import { signAccessToken, signRefreshToken } from '../src/modules/auth/router.js';

const app = createApp();

describe('Admin Authentication & Authorization Regressions', () => {
  // Scenario 1: Valid Platform Admin
  it('1. permits Valid Platform Admin to access /me and /platform/overview without company membership', async () => {
    const authUserId = `auth-platform-admin-${uuidv4().substring(0, 8)}`;
    const previousSessionId = `previous-session-${uuidv4()}`;
    const user = await createTestUser({
      username: 'platform_superadmin',
      auth_user_id: authUserId,
      password: 'PlatformPassword123!',
      active_session_id: previousSessionId,
    });
    const platformAdmin = await createTestPlatformAdmin({
      auth_user_id: authUserId,
      email: user.email,
    });

    // 1a. Login response returns access_token, token, and indicates role platform_admin
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ username: 'platform_superadmin', password: 'PlatformPassword123!' });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.access_token).toBeDefined();
    expect(loginRes.body.token).toBe(loginRes.body.access_token);
    expect(loginRes.body.user.role).toBe('platform_admin');
    expect(loginRes.body.user.isSuperAdmin).toBe(true);
    expect(loginRes.body.user.mustChangePassword).toBe(false);
    expect(loginRes.body.session_id).toBeTruthy();

    const persistedUser = await UserModel.findById(user._id).lean();
    expect(persistedUser?.active_session_id).toBe(loginRes.body.session_id);
    expect(persistedUser?.active_session_id).not.toBe(previousSessionId);

    // 1b. Profile endpoint /me returns role platform_admin and company: null
    const authHeader = {
      Authorization: `Bearer ${loginRes.body.access_token}`,
      'X-Client-Application': 'platform_admin_dashboard',
      'X-Session-Id': loginRes.body.session_id,
    };
    const meRes = await request(app).get('/me').set(authHeader);
    expect(meRes.status).toBe(200);
    expect(meRes.body.role).toBe('platform_admin');
    expect(meRes.body.company).toBeNull();
    expect(meRes.body.user.username).toBe('platform_superadmin');

    const previousToken = signAccessToken({
      sub: authUserId,
      role: 'platform_admin',
      client_application: 'platform_admin_dashboard',
      session_id: previousSessionId,
    });
    const previousSessionRes = await request(app).get('/me').set({
      Authorization: `Bearer ${previousToken}`,
      'X-Client-Application': 'platform_admin_dashboard',
      'X-Session-Id': previousSessionId,
    });
    expect(previousSessionRes.status).toBe(401);

    const legacyTokenWithoutSession = signAccessToken({
      sub: authUserId,
      role: 'platform_admin',
      client_application: 'platform_admin_dashboard',
    });
    const missingSessionRes = await request(app).get('/me').set({
      Authorization: `Bearer ${legacyTokenWithoutSession}`,
      'X-Client-Application': 'platform_admin_dashboard',
    });
    expect(missingSessionRes.status).toBe(401);

    const previousRefreshToken = signRefreshToken({
      sub: authUserId,
      client_application: 'platform_admin_dashboard',
      session_id: previousSessionId,
      sid: previousSessionId,
    });
    const previousRefreshRes = await request(app)
      .post('/auth/refresh')
      .set('X-Client-Application', 'platform_admin_dashboard')
      .send({ refresh_token: previousRefreshToken, session_id: previousSessionId });
    expect(previousRefreshRes.status).toBe(401);

    // 1c. Platform Admin endpoint /platform/overview succeeds
    const overviewRes = await request(app).get('/platform/overview').set(authHeader);
    expect(overviewRes.status).toBe(200);
    expect(overviewRes.body.backend_health).toBe('healthy');
  });

  // Scenario 2: Ordinary user without a company membership
  it('2. rejects ordinary user without a company membership with 403 on protected tenant endpoints', async () => {
    const user = await createTestUser({ username: 'homeless_user' });
    const authHeader = generateAuthHeader(user);

    // Ordinary user has no company membership -> /me should fail with 403
    const meRes = await request(app).get('/me').set(authHeader);
    expect(meRes.status).toBe(403);
    expect(meRes.body.detail).toContain('no company membership');

    // /quarries should also fail with 403
    const quarriesRes = await request(app).get('/quarries').set(authHeader);
    expect(quarriesRes.status).toBe(403);
    expect(quarriesRes.body.detail).toContain('no company membership');
  });

  // Scenario 3: Company admin
  it('3. permits company admin to access their own company resources but blocks them from /platform/*', async () => {
    const company = await createTestCompany({ name: 'Alpha Marble Co' });
    const user = await createTestUser({ username: 'company_admin_alpha' });
    await createTestMembership(user._id, company._id, MembershipRole.company_admin);
    const quarry = await createTestQuarry(company._id, { name: 'Alpha Quarry 1' });

    const authHeader = generateAuthHeader(user);

    // /me succeeds with company context
    const meRes = await request(app).get('/me').set(authHeader);
    expect(meRes.status).toBe(200);
    expect(meRes.body.role).toBe(MembershipRole.company_admin);
    expect(meRes.body.company.name).toBe('Alpha Marble Co');

    // /quarries succeeds
    const quarriesRes = await request(app).get('/quarries').set(authHeader);
    expect(quarriesRes.status).toBe(200);
    expect(quarriesRes.body.length).toBe(1);
    expect(quarriesRes.body[0].name).toBe('Alpha Quarry 1');

    // /platform/overview MUST be blocked (403 forbidden)
    const platformRes = await request(app).get('/platform/overview').set(authHeader);
    expect(platformRes.status).toBe(403);
    expect(platformRes.body.detail).toContain('not a platform administrator');
  });

  // Scenario 4: Employee
  it('4. permits employee to access permitted quarries but enforces role and permissions', async () => {
    const company = await createTestCompany({ name: 'Beta Quarry Co' });
    const user = await createTestUser({ username: 'beta_employee' });
    await createTestMembership(user._id, company._id, MembershipRole.employee);

    const authHeader = generateAuthHeader(user);

    const meRes = await request(app).get('/me').set(authHeader);
    expect(meRes.status).toBe(200);
    expect(meRes.body.role).toBe(MembershipRole.employee);
    expect(meRes.body.company.name).toBe('Beta Quarry Co');

    // Employee cannot access platform admin endpoints
    const platformRes = await request(app).get('/platform/overview').set(authHeader);
    expect(platformRes.status).toBe(403);
    expect(platformRes.body.detail).toContain('not a platform administrator');
  });

  // Scenario 5: Invalid or revoked token
  it('5. rejects invalid or revoked tokens with 401', async () => {
    const company = await createTestCompany();
    const user = await createTestUser({ username: 'revoked_user' });
    await createTestMembership(user._id, company._id);

    // 5a. Bad token string
    const badTokenRes = await request(app)
      .get('/me')
      .set({ Authorization: 'Bearer totally-invalid-token-string' });
    expect(badTokenRes.status).toBe(401);
    expect(badTokenRes.body.detail).toBe('invalid credentials');

    // 5b. Missing token
    const missingTokenRes = await request(app).get('/me');
    expect(missingTokenRes.status).toBe(401);
    expect(missingTokenRes.body.detail).toBe('missing credentials');

    // 5c. Revoked token (token issued prior to tokens_revoked_at)
    const validHeader = generateAuthHeader(user);
    // Simulate session revocation by updating tokens_revoked_at in DB
    await UserModel.findByIdAndUpdate(user._id, { tokens_revoked_at: new Date(Date.now() + 10000) });

    const revokedRes = await request(app).get('/me').set(validHeader);
    expect(revokedRes.status).toBe(401);
    expect(revokedRes.body.detail).toContain('revoked');
  });

  // Scenario 6: User who attempts to access another tenant
  it('6. strictly denies tenant cross-access: Company A user cannot access Company B resources', async () => {
    const companyA = await createTestCompany({ name: 'Tenant A' });
    const companyB = await createTestCompany({ name: 'Tenant B' });

    const userA = await createTestUser({ username: 'user_tenant_a' });
    await createTestMembership(userA._id, companyA._id, MembershipRole.company_admin);

    const quarryB = await createTestQuarry(companyB._id, { name: 'Tenant B Exclusive Quarry' });

    const authHeaderA = generateAuthHeader(userA);

    // Accessing Quarry B with User A's token returns 404 (multi-tenant boundary)
    const crossAccessRes = await request(app)
      .get(`/quarries/${quarryB._id}`)
      .set(authHeaderA);

    expect(crossAccessRes.status).toBe(404);
  });

  // Scenario 7: Ordinary user attempting to access platform-admin endpoints
  it('7. ordinary user with company membership attempting to access platform-admin endpoints is strictly denied', async () => {
    const company = await createTestCompany();
    const user = await createTestUser({ username: 'ordinary_user_attack' });
    await createTestMembership(user._id, company._id, MembershipRole.company_admin);

    const authHeader = generateAuthHeader(user);

    const p1 = await request(app).get('/platform/overview').set(authHeader);
    expect(p1.status).toBe(403);
    expect(p1.body.detail).toContain('not a platform administrator');

    const p2 = await request(app).get('/platform/companies').set(authHeader);
    expect(p2.status).toBe(403);

    const p3 = await request(app).get('/platform/users').set(authHeader);
    expect(p3.status).toBe(403);
  });

  // Scenario 8: Platform Admin tenant resource access without X-Company-Id
  it('8. Platform Admin cannot query tenant quarries without providing X-Company-Id header', async () => {
    const authUserId = `auth-pa-tenant-${uuidv4().substring(0, 8)}`;
    const user = await createTestUser({ username: 'pa_no_tenant', auth_user_id: authUserId });
    await createTestPlatformAdmin({ auth_user_id: authUserId });

    const authHeader = generateAuthHeader(user, 'platform_admin');

    // /quarries requires company context
    const res = await request(app).get('/quarries').set(authHeader);
    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('company context required; specify X-Company-Id');
  });

  it('9. audit log paginates, distinguishes denied results, and searches company names', async () => {
    const { admin, header } = await createTestPlatformAdminDashboardSession();
    const company = await createTestCompany({ name: `Audit Search Company ${uuidv4().substring(0, 8)}` });
    const createdAt = Date.now();
    await AuditEventModel.create([
      {
        _id: uuidv4(), company_id: company._id, actor_user_id: admin.auth_user_id,
        action: 'auth.login', target_type: 'user', target_id: admin.auth_user_id,
        result: AuditResult.success, created_at: new Date(createdAt - 3000),
      },
      {
        _id: uuidv4(), company_id: company._id, actor_user_id: admin.auth_user_id,
        action: 'auth.login', target_type: 'user', target_id: admin.auth_user_id,
        result: AuditResult.denied, created_at: new Date(createdAt - 2000),
      },
      {
        _id: uuidv4(), company_id: company._id, actor_user_id: admin.auth_user_id,
        action: 'auth.logout', target_type: 'user', target_id: admin.auth_user_id,
        result: AuditResult.failure, created_at: new Date(createdAt - 1000),
      },
    ]);

    const firstPage = await request(app)
      .get(`/platform/audit?company_id=${company._id}&limit=2&page=1`)
      .set(header);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.total).toBe(3);
    expect(firstPage.body.page).toBe(1);
    expect(firstPage.body.pages).toBe(2);
    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body.items[0].company_name).toBe(company.name);
    expect(firstPage.body.items[0].actor_name).toBe('Platform Super Admin');

    const secondPage = await request(app)
      .get(`/platform/audit?company_id=${company._id}&limit=2&page=2`)
      .set(header);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.page).toBe(2);
    expect(secondPage.body.items).toHaveLength(1);
    expect(secondPage.body.items[0].id).not.toBe(firstPage.body.items[0].id);

    const deniedOnly = await request(app)
      .get(`/platform/audit?company_id=${company._id}&result=denied`)
      .set(header);
    expect(deniedOnly.status).toBe(200);
    expect(deniedOnly.body.total).toBe(1);
    expect(deniedOnly.body.items[0].result).toBe('denied');

    const byCompanyName = await request(app)
      .get(`/platform/audit?search=${encodeURIComponent(company.name)}&limit=10`)
      .set(header);
    expect(byCompanyName.status).toBe(200);
    expect(byCompanyName.body.total).toBe(3);
  });
});

describe('Platform Admin Bootstrap & Legacy Username Regressions', () => {
  it('1. Existing user + generated temporary password: saved hash matches generated password and must_change_password is true', async () => {
    const originalPassword = 'InitialOldPassword123!';
    const user = await createTestUser({
      username: 'temp_pass_admin',
      password: originalPassword,
      must_change_password: false,
    });

    const result = await bootstrapAdmin({
      username: user.username!,
      resetPassword: true,
    });

    expect(result.passwordUpdated).toBe(true);
    expect(result.mustChangePassword).toBe(true);
    expect(result.generatedPassword).toBeDefined();

    // Verify database document
    const updatedUser = await UserModel.findById(user._id);
    expect(updatedUser!.must_change_password).toBe(true);
    const matchesGenerated = await bcrypt.compare(result.generatedPassword!, updatedUser!.password_hash!);
    expect(matchesGenerated).toBe(true);

    // Old password must fail
    const oldLogin = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: originalPassword });
    expect(oldLogin.status).toBe(401);

    // New generated password must succeed
    await waitForFreshJwtIat(updatedUser!.tokens_revoked_at!);
    const newLogin = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: result.generatedPassword! });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.user.must_change_password).toBe(true);
  });

  it('2. Existing user + explicitly supplied password: saved hash matches that password and must_change_password is false', async () => {
    const user = await createTestUser({
      username: 'custom_pass_admin',
      password: 'OldPasswordBeforeReset123!',
      must_change_password: true,
    });

    const customNewPassword = 'BrandNewExplicitPassword999!';
    const result = await bootstrapAdmin({
      username: user.username!,
      password: customNewPassword,
    });

    expect(result.passwordUpdated).toBe(true);
    expect(result.mustChangePassword).toBe(false);

    // Verify database document
    const updatedUser = await UserModel.findById(user._id);
    expect(updatedUser!.must_change_password).toBe(false);
    const matchesCustom = await bcrypt.compare(customNewPassword, updatedUser!.password_hash!);
    expect(matchesCustom).toBe(true);

    // Login with new custom password succeeds
    await waitForFreshJwtIat(updatedUser!.tokens_revoked_at!);
    const newLogin = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: customNewPassword });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.user.must_change_password).toBe(false);
  });

  it('3. Existing user with missing normalized_username can log in by username and field is self-healed', async () => {
    const rawUsername = 'LegacyUnnormalizedUser';
    const password = 'LegacyUserPassword123!';
    const passwordHash = await bcrypt.hash(password, 10);

    // Create a legacy user with normalized_username explicitly null
    const legacyUser = await UserModel.create({
      _id: uuidv4(),
      auth_user_id: `auth-legacy-${uuidv4().substring(0, 8)}`,
      username: rawUsername,
      normalized_username: null, // missing/null in legacy records
      email: 'legacy@example.com',
      password_hash: passwordHash,
      status: UserStatus.active,
      must_change_password: false,
    });
    const company = await createTestCompany();
    await createTestMembership(legacyUser._id, company._id, MembershipRole.employee);

    // Verify normalized_username is indeed null
    const checkBefore = await UserModel.findById(legacyUser._id);
    expect(checkBefore!.normalized_username).toBeNull();

    // Login by lowercase username
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ username: 'legacyunnormalizeduser', password });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.access_token).toBeDefined();

    // Verify that login self-healed normalized_username
    const checkAfter = await UserModel.findById(legacyUser._id);
    expect(checkAfter!.normalized_username).toBe('legacyunnormalizeduser');
  });

  it('4. Invalid password still returns 401 with standard error detail', async () => {
    const user = await createTestUser({
      username: 'test_wrong_pwd',
      password: 'CorrectPassword123!',
    });
    const company = await createTestCompany();
    await createTestMembership(user._id, company._id);

    const loginRes = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: 'WrongPassword456!' });

    expect(loginRes.status).toBe(401);
    expect(loginRes.body.detail).toBe('Invalid username or password');
  });

  it('5. PlatformAdmin authority repair does not accidentally reset password unless explicitly requested', async () => {
    const preservedPassword = 'OriginalSecretDoNotReset!';
    const user = await createTestUser({
      username: 'authority_repair_only',
      password: preservedPassword,
      must_change_password: false,
    });

    // Ensure no PlatformAdmin document exists initially
    const preCheck = await PlatformAdminModel.findOne({ auth_user_id: user.auth_user_id });
    expect(preCheck).toBeNull();

    // Run bootstrap without password and without resetPassword
    const result = await bootstrapAdmin({
      username: user.username!,
    });

    expect(result.isNewUser).toBe(false);
    expect(result.passwordUpdated).toBe(false);
    expect(result.generatedPassword).toBeUndefined();

    // Authority document was created
    const authorityDoc = await PlatformAdminModel.findOne({ auth_user_id: user.auth_user_id });
    expect(authorityDoc).toBeDefined();
    expect(authorityDoc!.status).toBe(UserStatus.active);

    // Stored password hash was preserved unchanged
    const checkUser = await UserModel.findById(user._id);
    const stillMatchesOriginal = await bcrypt.compare(preservedPassword, checkUser!.password_hash!);
    expect(stillMatchesOriginal).toBe(true);

    // Login with original password succeeds
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: preservedPassword });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.role).toBe('platform_admin');
  });
});
