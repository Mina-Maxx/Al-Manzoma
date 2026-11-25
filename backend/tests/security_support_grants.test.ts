import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { SupportGrantModel } from '../src/database/models/index.js';
import {
  createTestCompany, createTestUser, createTestMembership, createTestQuarry,
  createTestPlatformAdminDashboardSession, generateAuthHeader,
} from './helpers.js';
import { MembershipRole } from '../src/types/index.js';

const app = createApp();
const original = (config as any).supportGrantMode;
afterEach(() => { (config as any).supportGrantMode = original; });

async function seed() {
  const company = await createTestCompany({ name: 'SG' });
  const admin = await createTestUser({ username: 'sg_admin' });
  await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
  const emp = await createTestUser({ username: 'sg_emp' });
  await createTestMembership(emp._id, company._id, MembershipRole.employee);
  const quarry = await createTestQuarry(company._id, {});
  const up = await request(app).post(`/quarries/${quarry._id}/documents`).set(generateAuthHeader(admin))
    .set('Idempotency-Key', 'sg-key-00001').attach('file', Buffer.from('%PDF-1.4 tenant data'), 'c.pdf');
  expect(up.status).toBe(201);
  return { company, emp, quarry, docId: up.body.id as string };
}

async function grant(companyId: string, requester: string, approver: string | null, scopes: string[], over: Record<string, unknown> = {}) {
  return SupportGrantModel.create({
    company_id: companyId, requested_by_platform_admin_id: requester, approved_by_platform_admin_id: approver,
    scopes, requested_duration_seconds: 600, reason: 'support case', status: 'active',
    approved_at: approver ? new Date() : null, expires_at: new Date(Date.now() + 600_000), ...over,
  } as any);
}

describe('support grants gate tenant document access for platform admins (B1)', () => {
  it('enforce mode: no grant -> 403 on list, download, view and sync; tenant management routes stay available', async () => {
    (config as any).supportGrantMode = 'enforce';
    const t = await seed();
    const { header, admin } = await createTestPlatformAdminDashboardSession();
    const H = { ...header, 'X-Company-Id': t.company._id };
    expect((await request(app).get(`/quarries/${t.quarry._id}/documents`).set(H)).status).toBe(403);
    expect((await request(app).get(`/documents/${t.docId}/download`).set(H)).status).toBe(403);
    expect((await request(app).get(`/documents/${t.docId}/view`).set(H)).status).toBe(403);
    expect((await request(app).get('/sync/changes').set(H)).status).toBe(403);
    expect((await request(app).get('/company/employees').set(H)).status).toBe(200); // management is not grant-gated by design
    void admin;
  });

  it('enforce mode: grants are scoped, need a different approver, and expire', async () => {
    (config as any).supportGrantMode = 'enforce';
    const t = await seed();
    const { header, admin } = await createTestPlatformAdminDashboardSession();
    const { admin: other } = await createTestPlatformAdminDashboardSession();
    const H = { ...header, 'X-Company-Id': t.company._id };

    await grant(t.company._id, admin._id, other._id, ['document_metadata_read']);
    expect((await request(app).get(`/quarries/${t.quarry._id}/documents`).set(H)).status).toBe(200);
    expect((await request(app).get(`/documents/${t.docId}/download`).set(H)).status).toBe(403);

    await grant(t.company._id, admin._id, other._id, ['document_download']);
    expect((await request(app).get(`/documents/${t.docId}/download`).set(H)).status).toBe(200);
    expect((await request(app).get(`/documents/${t.docId}/view`).set(H)).status).toBe(200);

    await SupportGrantModel.updateMany({}, { $set: { expires_at: new Date(Date.now() - 1000) } });
    expect((await request(app).get(`/documents/${t.docId}/download`).set(H)).status).toBe(403);

    await grant(t.company._id, admin._id, admin._id, ['document_download']); // self-approved
    expect((await request(app).get(`/documents/${t.docId}/download`).set(H)).status).toBe(403);
  });

  it('audit mode (default) keeps access working but records the missing grant', async () => {
    (config as any).supportGrantMode = 'audit';
    const t = await seed();
    const { header } = await createTestPlatformAdminDashboardSession();
    const H = { ...header, 'X-Company-Id': t.company._id };
    expect((await request(app).get(`/documents/${t.docId}/download`).set(H)).status).toBe(200);
    const { AuditEventModel } = await import('../src/database/models/index.js');
    const rows = await AuditEventModel.find({ action: 'platform_admin.support_grant_missing' }).lean();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('tenant users are not affected', async () => {
    (config as any).supportGrantMode = 'enforce';
    const t = await seed();
    const r = await request(app).get(`/quarries/${t.quarry._id}/documents`).set(generateAuthHeader(t.emp));
    expect(r.status).toBe(200);
  });
});
