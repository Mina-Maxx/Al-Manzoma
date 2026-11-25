import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { UserModel } from '../src/database/models/index.js';
import { ensureUniqueUserIndexes } from '../src/scripts/ensureUniqueUserIndexes.js';
import { createTestCompany, createTestPlatformAdminDashboardSession } from './helpers.js';

const app = createApp();

describe('unique user indexes (B6)', () => {
  it('reports duplicates and changes nothing; creates indexes only when clean; then concurrent signups cannot duplicate', async () => {
    await UserModel.collection.dropIndex('uniq_normalized_username').catch(() => {});
    await UserModel.collection.dropIndex('uniq_email').catch(() => {});

    // 1) pre-existing duplicate -> report only, even with apply
    await UserModel.collection.insertMany([
      { _id: 'dup-1', auth_user_id: 'a1', normalized_username: 'same_name', username: 'Same_Name', status: 'active' },
      { _id: 'dup-2', auth_user_id: 'a2', normalized_username: 'same_name', username: 'same_name', status: 'active' },
    ] as any);
    const blocked = await ensureUniqueUserIndexes({ apply: true });
    const u = blocked.find((r) => r.field === 'normalized_username')!;
    expect(u.duplicates).toEqual([{ value: 'same_name', user_ids: expect.arrayContaining(['dup-1', 'dup-2']) }]);
    expect(u.created).toBe(false);

    // 2) clean data + dry run -> nothing created; apply -> created
    await UserModel.collection.deleteMany({});
    const dry = await ensureUniqueUserIndexes({ apply: false });
    expect(dry.every((r) => !r.created)).toBe(true);
    const applied = await ensureUniqueUserIndexes({ apply: true });
    expect(applied.every((r) => r.created)).toBe(true);

    // 3) the race from the audit (6 concurrent creates, same username) now yields exactly one account
    const { header } = await createTestPlatformAdminDashboardSession();
    const company = await createTestCompany({});
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => request(app).post('/platform/users').set(header)
      .send({ username: 'race_user', email: `race${i}@example.com`, password: 'Password#123', role: 'employee', company_id: company._id })));
    expect(await UserModel.countDocuments({ normalized_username: 'race_user' })).toBe(1);
    expect(rs.filter((r) => r.status === 201).length).toBe(1);
    expect(rs.filter((r) => r.status >= 500).length).toBe(0);
  });
});
