import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { Readable } from 'stream';
import { createApp } from '../src/app.js';
import { storage } from '../src/modules/storage/index.js';
import { createTestCompany, createTestUser, createTestMembership, createTestQuarry, generateAuthHeader } from './helpers.js';
import { MembershipRole } from '../src/types/index.js';

const app = createApp();
afterEach(() => vi.restoreAllMocks());

async function uploaded() {
  const company = await createTestCompany({ name: 'STREAM' });
  const admin = await createTestUser({ username: 'stream_admin' });
  await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
  const quarry = await createTestQuarry(company._id, {});
  const h = generateAuthHeader(admin);
  const up = await request(app).post(`/quarries/${quarry._id}/documents`).set(h)
    .set('Idempotency-Key', 'stream-key-0001').attach('file', Buffer.from('%PDF-1.4 hello'), 'a.pdf');
  expect(up.status).toBe(201);
  return { h, id: up.body.id as string };
}

describe('storage stream errors do not hang or crash the request (round1 #4)', () => {
  it('error before the first byte -> clean 5xx response', async () => {
    const { h, id } = await uploaded();
    vi.spyOn(storage, 'get').mockResolvedValue({
      stream: new Readable({ read() { this.destroy(new Error('storage boom')); } }),
    } as any);
    const r = await request(app).get(`/documents/${id}/download`).set(h).timeout({ response: 3000, deadline: 4000 });
    expect(r.status).toBeGreaterThanOrEqual(500);
  });

  it('error mid-stream -> connection is terminated (no hang)', async () => {
    const { h, id } = await uploaded();
    vi.spyOn(storage, 'get').mockResolvedValue({
      stream: new Readable({ read() { this.push(Buffer.from('partial')); setImmediate(() => this.destroy(new Error('mid boom'))); } }),
    } as any);
    const started = Date.now();
    let settled = false;
    try {
      await request(app).get(`/documents/${id}/download`).set(h).timeout({ response: 3000, deadline: 4000 });
      settled = true;
    } catch {
      settled = true; // aborted/reset is the expected outcome for a truncated body
    }
    expect(settled).toBe(true);
    expect(Date.now() - started).toBeLessThan(3500);
  });
});
