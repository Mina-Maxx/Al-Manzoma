import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { MembershipModel } from '../src/database/models/index.js';
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

describe('Multi-Tenant Isolation & Granular Permissions', () => {
  it('strictly isolates companies: user in Company A cannot access Company B quarry (returns 404)', async () => {
    // Setup Company A
    const companyA = await createTestCompany({ name: 'Company Alpha' });
    const userA = await createTestUser({ username: 'alpha_emp' });
    await createTestMembership(userA._id, companyA._id, MembershipRole.employee);
    const quarryA = await createTestQuarry(companyA._id, { name: 'Alpha Quarry' });
    await createTestPermission(userA._id, quarryA._id, { can_view: true });

    // Setup Company B
    const companyB = await createTestCompany({ name: 'Company Beta' });
    const userB = await createTestUser({ username: 'beta_emp' });
    await createTestMembership(userB._id, companyB._id, MembershipRole.employee);
    const quarryB = await createTestQuarry(companyB._id, { name: 'Beta Quarry' });
    await createTestPermission(userB._id, quarryB._id, { can_view: true });

    const authHeaderA = generateAuthHeader(userA);

    // User A can access Quarry A documents
    const resOwn = await request(app)
      .get(`/quarries/${quarryA._id}/documents`)
      .set(authHeaderA);
    expect(resOwn.status).toBe(200);

    // User A attempting to access Quarry B returns 404 Not Found (indistinguishable from non-existent)
    const resCrossTenant = await request(app)
      .get(`/quarries/${quarryB._id}/documents`)
      .set(authHeaderA);
    expect(resCrossTenant.status).toBe(404);
    expect(resCrossTenant.body.detail).toBe('quarry not found');
  });

  it('enforces that can_delete is STRICTLY independent of can_upload', async () => {
    const company = await createTestCompany();
    const user = await createTestUser();
    await createTestMembership(user._id, company._id, MembershipRole.employee);
    const quarry = await createTestQuarry(company._id);

    // Grant can_view and can_upload, but EXPLICITLY can_delete = false
    await createTestPermission(user._id, quarry._id, {
      can_view: true,
      can_upload: true,
      can_delete: false,
    });

    const authHeader = generateAuthHeader(user);

    // 1. Upload a document (should succeed because can_upload = true)
    const uploadRes = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .set('Idempotency-Key', 'test-idemp-key-delete-perm')
      .attach('file', Buffer.from('%PDF-1.4 test content'), 'test.pdf');

    expect(uploadRes.status).toBe(201);
    const docId = uploadRes.body.id;

    // 2. Attempt to delete the document (must fail with 403 Forbidden because can_delete = false)
    const deleteRes = await request(app)
      .delete(`/quarries/${quarry._id}/documents/${docId}`)
      .set(authHeader);

    expect(deleteRes.status).toBe(403);
    expect(deleteRes.body.detail).toBe('permission denied');
  });

  it('allows document deletion when can_delete is granted', async () => {
    const company = await createTestCompany();
    const user = await createTestUser();
    const membership = await createTestMembership(user._id, company._id, MembershipRole.employee);
    await MembershipModel.findByIdAndUpdate(membership._id, { can_delete: true });
    const quarry = await createTestQuarry(company._id);

    await createTestPermission(user._id, quarry._id, {
      can_view: true,
      can_upload: true,
      can_delete: true,
    });

    const authHeader = generateAuthHeader(user);

    // Upload
    const uploadRes = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .set('Idempotency-Key', 'test-idemp-key-can-delete-true')
      .attach('file', Buffer.from('%PDF-1.4 test content 2'), 'test2.pdf');

    expect(uploadRes.status).toBe(201);
    const docId = uploadRes.body.id;

    // Delete
    const deleteRes = await request(app)
      .delete(`/quarries/${quarry._id}/documents/${docId}`)
      .set(authHeader);

    expect(deleteRes.status).toBe(204);
  });

  it('allows document deletion with can_delete even when can_upload is denied', async () => {
    const company = await createTestCompany();
    const uploader = await createTestUser({ username: 'delete_independent_uploader' });
    await createTestMembership(uploader._id, company._id, MembershipRole.company_admin);
    const employee = await createTestUser({ username: 'delete_only_employee' });
    const membership = await createTestMembership(employee._id, company._id, MembershipRole.employee);
    await MembershipModel.findByIdAndUpdate(membership._id, { can_view: true, can_upload: false, can_delete: true });
    const quarry = await createTestQuarry(company._id);
    await createTestPermission(employee._id, quarry._id, {
      can_view: true,
      can_upload: false,
      can_delete: true,
    });

    const uploadRes = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(generateAuthHeader(uploader))
      .set('Idempotency-Key', 'upload-for-delete-only-employee')
      .attach('file', Buffer.from('%PDF-1.4 delete-only content'), 'delete-only.pdf');
    expect(uploadRes.status).toBe(201);

    const deleteRes = await request(app)
      .delete(`/quarries/${quarry._id}/documents/${uploadRes.body.id}`)
      .set(generateAuthHeader(employee));
    expect(deleteRes.status).toBe(204);
  });
});
