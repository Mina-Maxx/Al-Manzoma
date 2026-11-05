import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  createTestCompany,
  createTestUser,
  createTestMembership,
  createTestQuarry,
  createTestPermission,
  generateAuthHeader,
} from './helpers.js';
import { MembershipRole } from '../src/types/index.js';

const app = createApp();

describe('Concurrency & Quota Atomicity', () => {
  it('prevents concurrent uploads from overselling company storage quota', async () => {
    // 300 bytes quota
    const company = await createTestCompany({ quota_bytes: 300 });
    const user = await createTestUser();
    await createTestMembership(user._id, company._id, MembershipRole.employee);
    const quarry = await createTestQuarry(company._id);
    await createTestPermission(user._id, quarry._id, { can_view: true, can_upload: true });

    const authHeader = generateAuthHeader(user);
    const payloadBuffer = Buffer.alloc(200, '%PDF-1.4 file of 200 bytes');

    // Fire 2 concurrent uploads of 200 bytes each (Total 400 bytes, which exceeds 300 bytes quota)
    const [res1, res2] = await Promise.all([
      request(app)
        .post(`/quarries/${quarry._id}/documents`)
        .set(authHeader)
        .set('Idempotency-Key', 'concurrent-quota-key-1')
        .attach('file', payloadBuffer, 'file1.pdf'),
      request(app)
        .post(`/quarries/${quarry._id}/documents`)
        .set(authHeader)
        .set('Idempotency-Key', 'concurrent-quota-key-2')
        .attach('file', payloadBuffer, 'file2.pdf'),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // One must succeed (201) and one must be rejected (409) due to quota limit!
    expect(statuses).toEqual([201, 409]);
  });
});
