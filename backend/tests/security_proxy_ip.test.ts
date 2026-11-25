import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { AuditEventModel } from '../src/database/models/index.js';
import { createTestUser } from './helpers.js';

async function lastLoginIp(app: any, xff?: string) {
  const user = await createTestUser({ username: `ip_${Math.random().toString(36).slice(2, 8)}` });
  const req = request(app).post('/auth/login').set('X-Client-Application', 'android');
  if (xff) req.set('X-Forwarded-For', xff);
  await req.send({ username: user.username, password: 'definitely-wrong-password' });
  const row = await AuditEventModel.findOne({ action: 'auth.login' }).sort({ createdAt: -1 }).lean();
  return row?.ip;
}

describe('client IP handling (round1 #5)', () => {
  it('without a trusted proxy a spoofed X-Forwarded-For is ignored in audit and rate-limit identity', async () => {
    (config as any).trustProxyHops = 0;
    const ip = await lastLoginIp(createApp(), '6.6.6.6');
    expect(ip).toBeTruthy();
    expect(ip).not.toBe('6.6.6.6');
  });

  it('behind one trusted proxy the proxy-appended client IP is used, not the attacker-supplied first entry', async () => {
    (config as any).trustProxyHops = 1;
    const ip = await lastLoginIp(createApp(), '6.6.6.6, 9.9.9.9');
    expect(ip).toBe('9.9.9.9');
    (config as any).trustProxyHops = 0;
  });
});
