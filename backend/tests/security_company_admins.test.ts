import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MembershipModel, UserModel } from '../src/database/models/index.js';
import { createTestCompany, createTestUser, createTestMembership, generateAuthHeader } from './helpers.js';
import { MembershipRole, UserStatus } from '../src/types/index.js';

const app = createApp();

async function twoAdmins(tag: string, secondStatus: UserStatus = UserStatus.active) {
  const company = await createTestCompany({ name: `LA_${tag}` });
  const a = await createTestUser({ username: `la_a_${tag}` });
  const b = await createTestUser({ username: `la_b_${tag}`, status: secondStatus });
  await createTestMembership(a._id, company._id, MembershipRole.company_admin);
  await createTestMembership(b._id, company._id, MembershipRole.company_admin);
  return { company, a, b, ha: generateAuthHeader(a), hb: generateAuthHeader(b) };
}

async function activeAdminCount(companyId: string) {
  const ms = await MembershipModel.find({ company_id: companyId, role: MembershipRole.company_admin }).lean();
  return UserModel.countDocuments({ _id: { $in: ms.map((m) => m.user_id) }, status: UserStatus.active });
}

describe('last company admin protection (A6, A7)', () => {
  it('cannot disable the only ACTIVE admin even if an inactive admin exists', async () => {
    const t = await twoAdmins('inactive2nd', UserStatus.inactive);
    const r = await request(app).post(`/company/employees/${t.a._id}/disable`).set(t.ha);
    expect(r.status).toBe(409);
    expect(await activeAdminCount(t.company._id)).toBe(1);
  });

  it('two admins disabling each other concurrently never leaves zero active admins', async () => {
    const t = await twoAdmins('race');
    for (let i = 0; i < 8; i++) {
      await UserModel.updateMany({ _id: { $in: [t.a._id, t.b._id] } }, { $set: { status: UserStatus.active, tokens_revoked_at: null } });
      const [r1, r2] = await Promise.all([
        request(app).post(`/company/employees/${t.b._id}/disable`).set(t.ha),
        request(app).post(`/company/employees/${t.a._id}/disable`).set(t.hb),
      ]);
      expect([r1.status, r2.status].filter((s) => s === 200).length).toBeLessThanOrEqual(1);
      expect(await activeAdminCount(t.company._id)).toBeGreaterThanOrEqual(1);
    }
  });

  it('two admins deleting each other concurrently never leaves zero admins', async () => {
    const t = await twoAdmins('racedel');
    const [r1, r2] = await Promise.all([
      request(app).delete(`/company/employees/${t.b._id}`).set(t.ha),
      request(app).delete(`/company/employees/${t.a._id}`).set(t.hb),
    ]);
    expect([r1.status, r2.status].filter((s) => s === 200).length).toBeLessThanOrEqual(1);
    expect(await MembershipModel.countDocuments({ company_id: t.company._id, role: MembershipRole.company_admin })).toBeGreaterThanOrEqual(1);
  });
});
