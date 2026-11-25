import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { signAccessToken, signRefreshToken } from '../src/modules/auth/router.js';
import { createTestCompany, createTestUser, createTestMembership } from './helpers.js';
import { MembershipRole } from '../src/types/index.js';

const app = createApp();

async function employee(tag: string) {
  const company = await createTestCompany({ name: `TK_${tag}` });
  const user = await createTestUser({ username: `tk_${tag}` });
  await createTestMembership(user._id, company._id, MembershipRole.employee);
  return user;
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-Client-Application': 'android' });
const base = (user: any) => ({ sub: user.auth_user_id, client_application: 'android' as const });
const legacy = (user: any, ttlSeconds: number, extra: Record<string, unknown> = {}) =>
  jwt.sign({ ...base(user), ...extra }, config.jwtSecret, {
    algorithm: 'HS256', issuer: config.jwtIssuer, audience: `${config.jwtAudience}:android`, expiresIn: ttlSeconds,
  });

describe('token type separation (round1 #1)', () => {
  it('issues token_use claims', async () => {
    const u = await employee('claims');
    expect((jwt.decode(signAccessToken(base(u))) as any).token_use).toBe('access');
    expect((jwt.decode(signRefreshToken(base(u))) as any).token_use).toBe('refresh');
  });

  it('a refresh token is not accepted as an access token', async () => {
    const u = await employee('r2a');
    const r = await request(app).get('/quarries').set(bearer(signRefreshToken(base(u))));
    expect(r.status).toBe(401);
  });

  it('an access token is not accepted at /auth/refresh', async () => {
    const u = await employee('a2r');
    const r = await request(app).post('/auth/refresh').send({ refresh_token: signAccessToken(base(u)) });
    expect(r.status).toBe(401);
  });

  it('proper tokens keep working', async () => {
    const u = await employee('ok');
    expect((await request(app).get('/quarries').set(bearer(signAccessToken(base(u))))).status).toBe(200);
    expect((await request(app).post('/auth/refresh').send({ refresh_token: signRefreshToken(base(u)) })).status).toBe(200);
  });

  it('legacy tokens issued before the claim existed still work for their own purpose only (no forced logout on deploy)', async () => {
    const u = await employee('legacy');
    const legacyAccess = legacy(u, 3600);
    const legacyRefresh = legacy(u, 30 * 24 * 3600);
    expect((await request(app).get('/quarries').set(bearer(legacyAccess))).status).toBe(200);
    expect((await request(app).get('/quarries').set(bearer(legacyRefresh))).status).toBe(401);
    expect((await request(app).post('/auth/refresh').send({ refresh_token: legacyRefresh })).status).toBe(200);
    expect((await request(app).post('/auth/refresh').send({ refresh_token: legacyAccess })).status).toBe(401);
  });
});

describe('issuer/audience are enforced without fallbacks (round1 #2)', () => {
  it('rejects wrong issuer, wrong audience and missing audience even when the signature is valid', async () => {
    const u = await employee('iss');
    const mk = (opts: jwt.SignOptions) => jwt.sign({ ...base(u), token_use: 'access' }, config.jwtSecret, { algorithm: 'HS256', expiresIn: 600, ...opts });
    const wrongIss = mk({ issuer: 'https://evil.example', audience: `${config.jwtAudience}:android` });
    const wrongAud = mk({ issuer: config.jwtIssuer, audience: 'some-other-service' });
    const noAud = mk({ issuer: config.jwtIssuer });
    const noIss = mk({ audience: `${config.jwtAudience}:android` });
    for (const t of [wrongIss, wrongAud, noAud, noIss]) {
      expect((await request(app).get('/quarries').set(bearer(t))).status).toBe(401);
    }
  });
});
