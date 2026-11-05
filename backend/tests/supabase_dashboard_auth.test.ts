import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import {
  createTestCompany,
  createTestUser,
  createTestMembership,
  createTestPlatformAdmin,
  generateAuthHeader,
} from './helpers.js';
import { CompanyStatus, UserStatus, MembershipRole } from '../src/types/index.js';
import { UserModel, PlatformAdminModel, MembershipModel } from '../src/database/models/index.js';
import { config } from '../src/config/index.js';

const app = createApp();

describe('Supabase Dashboard Authentication & Role Resolution Suite', () => {
  it('1. GET /dashboard/config serves public Supabase URL and anon key without authentication', async () => {
    const res = await request(app).get('/dashboard/config');
    expect(res.status).toBe(200);
    expect(res.body.supabase_url).toBe(config.supabaseUrl);
    expect(res.body.supabase_anon_key).toBe(config.supabaseAnonKey);
  });

  it('2. verifyToken accepts Supabase tokens with aud: "authenticated" and local tokens with aud: "quarryvault-dev"', async () => {
    const company = await createTestCompany();
    const user = await createTestUser({ email: 'supabase_user@quarryvault.com' });
    await createTestMembership(user._id, company._id, MembershipRole.company_admin);

    // Create a token simulated as Supabase Auth (aud: "authenticated", HS256 for local test)
    const supabaseToken = jwt.sign(
      {
        sub: user.auth_user_id,
        email: user.email,
        aud: 'authenticated',
        iss: 'https://htoloebtdqjqtptqjddx.supabase.co/auth/v1',
      },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: '1h' }
    );

    const res = await request(app)
      .get('/me')
      .set({ Authorization: `Bearer ${supabaseToken}` });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(user.email);
    expect(res.body.role).toBe('company_admin');

    // Also verify standard quarryvault-dev token works
    const devToken = jwt.sign(
      {
        sub: user.auth_user_id,
        email: user.email,
        aud: 'quarryvault-dev',
        iss: config.jwtIssuer,
      },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: '1h' }
    );

    const devRes = await request(app)
      .get('/me')
      .set({ Authorization: `Bearer ${devToken}` });

    expect(devRes.status).toBe(200);
  });

  it('3. Rejects automatic email hijacking: unmapped Supabase sub cannot access Platform Admin even if email matches', async () => {
    const adminEmail = 'platform_supa_admin@quarryvault.internal';
    const legitimateAuthId = 'stable-platform-admin-uuid-111';
    const rogueSupabaseSub = 'attacker-rogue-sub-999';

    await PlatformAdminModel.create({
      _id: 'admin_security_test_id',
      auth_user_id: legitimateAuthId,
      email: adminEmail,
      full_name: 'Supabase Platform Admin',
      status: UserStatus.active,
    });
    await createTestUser({
      auth_user_id: legitimateAuthId,
      email: adminEmail,
      username: 'platform_supa_linked_admin',
    });

    // Token issued with matching email but arbitrary unmapped sub
    const rogueToken = jwt.sign(
      {
        sub: rogueSupabaseSub,
        email: adminEmail,
        aud: 'authenticated',
        iss: 'https://htoloebtdqjqtptqjddx.supabase.co/auth/v1',
      },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: '1h' }
    );

    // Must be rejected with 403 Forbidden (not a platform admin)
    const res = await request(app)
      .get('/platform/companies')
      .set({ Authorization: `Bearer ${rogueToken}` });

    expect(res.status).toBe(403);
    expect(res.body.detail).toBe('not a platform administrator');

    // Verify legitimate admin's auth_user_id was NOT overwritten
    const adminDoc = await PlatformAdminModel.findOne({ email: adminEmail });
    expect(adminDoc!.auth_user_id).toBe(legitimateAuthId);

    // Legitimate admin's token succeeds
    const legitToken = jwt.sign(
      {
        sub: legitimateAuthId,
        email: adminEmail,
        aud: `${config.jwtAudience || 'quarryvault-dev'}:platform_admin_dashboard`,
        iss: 'https://htoloebtdqjqtptqjddx.supabase.co/auth/v1',
        client_application: 'platform_admin_dashboard',
      },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: '1h' }
    );

    const legitRes = await request(app)
      .get('/platform/companies')
      .set({ Authorization: `Bearer ${legitToken}` });

    expect(legitRes.status).toBe(200);
  });

  it('4. Company Admin role resolution: returns 403 on /platform/companies (NOT 401) and 200 on /me', async () => {
    const company = await createTestCompany({ name: 'Quarry Company Alpha' });
    const userEmail = 'office_admin@quarrycompany.com';
    const supabaseSub = 'supabase-uuid-office-admin-4444';

    const user = await createTestUser({
      auth_user_id: supabaseSub,
      email: userEmail,
      username: 'office_admin_alpha',
    });
    await createTestMembership(user._id, company._id, MembershipRole.company_admin);

    const token = jwt.sign(
      {
        sub: supabaseSub,
        email: userEmail,
        aud: 'authenticated',
        iss: 'https://htoloebtdqjqtptqjddx.supabase.co/auth/v1',
      },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: '1h' }
    );

    // Step 1 of dashboard resolveRole(): /platform/companies
    // MUST return 403 Forbidden (not a platform admin), NOT 401 Unauthorized!
    // A 401 would falsely trigger handleSessionExpired() in the frontend.
    const platformRes = await request(app)
      .get('/platform/companies')
      .set({ Authorization: `Bearer ${token}` });

    expect(platformRes.status).toBe(403);
    expect(platformRes.body.detail).toBe('not a platform administrator');

    // Step 2 of dashboard resolveRole(): /me
    // MUST succeed (200) for mapped company admin
    const meRes = await request(app)
      .get('/me')
      .set({ Authorization: `Bearer ${token}` });

    expect(meRes.status).toBe(200);
    expect(meRes.body.role).toBe('company_admin');
    expect(meRes.body.company.name).toBe('Quarry Company Alpha');

    // Step 3: Page refresh simulation (subsequent requests use the linked sub)
    const refreshMeRes = await request(app)
      .get('/me')
      .set({ Authorization: `Bearer ${token}` });

    expect(refreshMeRes.status).toBe(200);
    expect(refreshMeRes.body.role).toBe('company_admin');
  });

  it('5. Unprovisioned Supabase account returns 403 on /platform/companies and 403 on /me (never 401 session expired)', async () => {
    const unprovisionedSub = 'supabase-unknown-uuid-9999';
    const unprovisionedEmail = 'unregistered@unknown.com';

    const token = jwt.sign(
      {
        sub: unprovisionedSub,
        email: unprovisionedEmail,
        aud: 'authenticated',
        iss: 'https://htoloebtdqjqtptqjddx.supabase.co/auth/v1',
      },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: '1h' }
    );

    const platformRes = await request(app)
      .get('/platform/companies')
      .set({ Authorization: `Bearer ${token}` });
    expect(platformRes.status).toBe(403);

    const meRes = await request(app)
      .get('/me')
      .set({ Authorization: `Bearer ${token}` });
    expect(meRes.status).toBe(403);
    expect(meRes.body.detail).toBe('user not provisioned');
  });
});
