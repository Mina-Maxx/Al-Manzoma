import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MembershipModel, PlatformAdminModel, UserModel } from '../src/database/models/index.js';
import {
  createTestCompany, createTestUser, createTestMembership, createTestPlatformAdminDashboardSession,
} from './helpers.js';
import { MembershipRole, UserStatus } from '../src/types/index.js';

const app = createApp();

describe('platform user status (B2)', () => {
  it('only accepts active/disabled/inactive; anything else is 400 and never enables the account', async () => {
    const { header } = await createTestPlatformAdminDashboardSession();
    const company = await createTestCompany({});
    const emp = await createTestUser({ username: 'b2_emp', status: UserStatus.inactive });
    await createTestMembership(emp._id, company._id, MembershipRole.employee);

    for (const body of [{ status: 'suspended' }, {}, { status: 'ACTIVE ' }]) {
      const r = await request(app).patch(`/platform/users/${emp._id}/status`).set(header).send(body);
      expect(r.status).toBe(400);
      expect((await UserModel.findById(emp._id).lean())?.status).toBe(UserStatus.inactive);
    }
    const inactive = await request(app).patch(`/platform/users/${emp._id}/status`).set(header).send({ status: 'inactive' });
    expect(inactive.status).toBe(200);
    expect(inactive.body.status).toBe(UserStatus.inactive);
    const active = await request(app).patch(`/platform/users/${emp._id}/status`).set(header).send({ status: 'active' });
    expect(active.body.status).toBe(UserStatus.active);
    const disabled = await request(app).post(`/platform/users/${emp._id}/status`).set(header).send({ status: 'disabled' });
    expect(disabled.body.status).toBe(UserStatus.inactive);
  });
});

describe('platform admin lockout and demotion (B3, B7, B8)', () => {
  it('a platform admin cannot disable or demote their own account', async () => {
    const { header, admin } = await createTestPlatformAdminDashboardSession();
    const me = await UserModel.findOne({ auth_user_id: admin.auth_user_id }).lean();
    const company = await createTestCompany({});
    const dis = await request(app).post(`/platform/users/${me!._id}/status`).set(header).send({ status: 'disabled' });
    expect(dis.status).toBe(409);
    const demote = await request(app).patch(`/platform/users/${me!._id}`).set(header).send({ role: 'employee', company_id: company._id });
    expect(demote.status).toBe(409);
    expect(await PlatformAdminModel.countDocuments({ auth_user_id: admin.auth_user_id })).toBe(1);
    expect((await request(app).get('/platform/overview').set(header)).status).toBe(200);
  });

  it('/role demotion really removes platform admin rights (and refuses when there is no membership to fall back to)', async () => {
    const { header } = await createTestPlatformAdminDashboardSession();
    const { admin: victim } = await createTestPlatformAdminDashboardSession();
    const victimUser = await UserModel.findOne({ auth_user_id: victim.auth_user_id }).lean();

    const noMembership = await request(app).patch(`/platform/users/${victimUser!._id}/role`).set(header).send({ role: 'employee' });
    expect(noMembership.status).toBe(400);
    expect(await PlatformAdminModel.countDocuments({ auth_user_id: victim.auth_user_id })).toBe(1);

    const company = await createTestCompany({});
    await createTestMembership(victimUser!._id, company._id, MembershipRole.company_admin);
    const ok = await request(app).patch(`/platform/users/${victimUser!._id}/role`).set(header).send({ role: 'employee' });
    expect(ok.status).toBe(200);
    expect(await PlatformAdminModel.countDocuments({ auth_user_id: victim.auth_user_id })).toBe(0);
    expect((await MembershipModel.findOne({ user_id: victimUser!._id }).lean())?.role).toBe(MembershipRole.employee);
  });
});
