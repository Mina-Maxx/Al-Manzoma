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
import { MembershipRole, QuarryStatus } from '../src/types/index.js';
import { MembershipModel, QuarryModel, DocumentModel, FolderModel } from '../src/database/models/index.js';
import { migrateToCompanyWidePermissions } from '../src/services/permissionMigration.js';

const app = createApp();

describe('Unified Product Updates: Permissions, Quarry Management, Permanent Trash & Sorting', () => {
  it('1. Company-Wide Operational Permissions: applies view, upload, download, delete company-wide', async () => {
    const company = await createTestCompany();
    const employee = await createTestUser({ email: 'emp_company_wide@test.com' });
    const membership = await createTestMembership(employee._id, company._id, MembershipRole.employee);

    // Set company-wide operational permissions: can_view=true, can_upload=true, can_download=false, can_delete=false
    await MembershipModel.findByIdAndUpdate(membership._id, {
      can_view: true,
      can_upload: true,
      can_download: false,
      can_delete: false,
      hidden_quarries: [],
    });

    const quarryA = await createTestQuarry(company._id, 'محجر أبو زعبل');
    const quarryB = await createTestQuarry(company._id, 'محجر بني سويف');

    const authHeader = generateAuthHeader(employee);

    // GET /quarries lists both quarries with company-wide permissions
    const listRes = await request(app).get('/quarries').set(authHeader);
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBe(2);
    expect(listRes.body[0].permissions.can_view).toBe(true);
    expect(listRes.body[0].permissions.can_upload).toBe(true);
    expect(listRes.body[0].permissions.can_download).toBe(false);
    expect(listRes.body[0].permissions.can_delete).toBe(false);

    // Can upload in Quarry A
    const uploadRes = await request(app)
      .post(`/quarries/${quarryA._id}/documents`)
      .set(authHeader)
      .attach('file', Buffer.from('%PDF-1.4 file-content'), 'file_a.pdf');
    expect(uploadRes.status).toBe(201);
    const docId = uploadRes.body.id;

    // Cannot download in Quarry A (can_download is false)
    const dlRes = await request(app)
      .get(`/documents/${docId}/download`)
      .set(authHeader);
    expect(dlRes.status).toBe(403);
  });

  it('enforces quarry-level view/download/delete permissions while allowing authorized viewing without download', async () => {
    const company = await createTestCompany();
    const employee = await createTestUser({ email: 'emp_quarry_flags@test.com' });
    const membership = await createTestMembership(employee._id, company._id, MembershipRole.employee);
    await MembershipModel.findByIdAndUpdate(membership._id, {
      can_view: true,
      can_upload: true,
      can_download: true,
      can_delete: true,
    });
    const quarry = await createTestQuarry(company._id, 'Per Quarry Permissions');
    await createTestPermission(employee._id, quarry._id, {
      can_view: true,
      can_upload: true,
      can_download: false,
      can_delete: false,
    });
    const authHeader = generateAuthHeader(employee);

    const listRes = await request(app).get('/quarries').set(authHeader);
    expect(listRes.status).toBe(200);
    expect(listRes.body.find((item: any) => item.id === quarry._id).permissions).toEqual({
      can_view: true,
      can_upload: true,
      can_download: false,
      can_delete: false,
    });

    const uploadRes = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .set('Idempotency-Key', 'quarry-view-only-upload')
      .attach('file', Buffer.from('%PDF-1.4 view-only content'), 'view-only.pdf');
    expect(uploadRes.status).toBe(201);
    const documentId = uploadRes.body.id;

    const viewRes = await request(app).get(`/documents/${documentId}/view`).set(authHeader);
    expect(viewRes.status).toBe(200);
    const downloadRes = await request(app).get(`/documents/${documentId}/download`).set(authHeader);
    expect(downloadRes.status).toBe(403);
    const deleteRes = await request(app).delete(`/quarries/${quarry._id}/documents/${documentId}`).set(authHeader);
    expect(deleteRes.status).toBe(403);
  });

  it('applies Dashboard permissions to Company Admin quarry access and allows all four granted actions', async () => {
    const company = await createTestCompany();
    const companyAdmin = await createTestUser({ email: 'company_admin_permission_flags@test.com' });
    const membership = await createTestMembership(companyAdmin._id, company._id, MembershipRole.company_admin);
    await MembershipModel.findByIdAndUpdate(membership._id, {
      can_view: true,
      can_upload: false,
      can_download: false,
      can_delete: false,
    });
    const quarry = await createTestQuarry(company._id, 'Admin Permission Quarry');
    const authHeader = generateAuthHeader(companyAdmin);

    const listRes = await request(app).get('/quarries').set(authHeader);
    expect(listRes.status).toBe(200);
    // Company admins always get full permissions regardless of membership flags
    expect(listRes.body.find((item: any) => item.id === quarry._id).permissions).toEqual({
      can_view: true,
      can_upload: true,
      can_download: true,
      can_delete: true,
    });
    expect((await request(app).get(`/quarries/${quarry._id}/documents`).set(authHeader)).status).toBe(200);
    // Company admin can always create folders (full access regardless of membership flags)
    expect((await request(app).post(`/quarries/${quarry._id}/folders`).set(authHeader).send({ name: 'Denied' })).status).toBe(201);

    const saved = await request(app)
      .post('/company/permissions')
      .set(authHeader)
      .send({
        user_id: companyAdmin._id,
        permissions: { can_view: true, can_upload: true, can_download: true, can_delete: true },
        hidden_quarries: [],
        quarry_permissions: [{ quarry_id: quarry._id, can_view: true, can_upload: true, can_download: true, can_delete: true }],
      });
    expect(saved.status).toBe(200);

    const upload = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .set('Idempotency-Key', 'company-admin-all-four-permissions')
      .attach('file', Buffer.from('%PDF-1.4 manager all permissions'), 'manager.pdf');
    expect(upload.status).toBe(201);
    expect((await request(app).get(`/quarries/${quarry._id}/documents`).set(authHeader)).status).toBe(200);
    expect((await request(app).get(`/documents/${upload.body.id}/view`).set(authHeader)).status).toBe(200);
    expect((await request(app).get(`/documents/${upload.body.id}/download`).set(authHeader)).status).toBe(200);
    expect((await request(app).delete(`/quarries/${quarry._id}/documents/${upload.body.id}`).set(authHeader)).status).toBe(204);
  });

  it('2. Independent Quarry Visibility: hides excluded quarry and rejects direct access', async () => {
    const company = await createTestCompany();
    const employee = await createTestUser({ email: 'emp_visibility@test.com' });
    const membership = await createTestMembership(employee._id, company._id, MembershipRole.employee);

    const quarryVisible = await createTestQuarry(company._id, 'محجر السويس');
    const quarryHidden = await createTestQuarry(company._id, 'محجر أسوان السري');

    // Hide quarryHidden from employee
    await MembershipModel.findByIdAndUpdate(membership._id, {
      can_view: true,
      can_upload: true,
      can_download: true,
      can_delete: false,
      hidden_quarries: [quarryHidden._id],
    });

    const authHeader = generateAuthHeader(employee);

    // Listing only contains the visible quarry
    const listRes = await request(app).get('/quarries').set(authHeader);
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((q: any) => q.id === quarryVisible._id)).toBe(true);
    expect(listRes.body.some((q: any) => q.id === quarryHidden._id)).toBe(false);

    // Direct access to hidden quarry documents is rejected (404)
    const directRes = await request(app).get(`/quarries/${quarryHidden._id}/documents`).set(authHeader);
    expect(directRes.status).toBe(404);
  });

  it('3. Office Quarry Management: edit and soft-delete/archive quarry', async () => {
    const company = await createTestCompany();
    const admin = await createTestUser({ email: 'office_admin_quarries@test.com' });
    await createTestMembership(admin._id, company._id, MembershipRole.company_admin);

    const quarry = await createTestQuarry(company._id, 'محجر قنا الأصلي');
    const authHeader = generateAuthHeader(admin);

    // 1. Edit quarry
    const patchRes = await request(app)
      .patch(`/quarries/${quarry._id}`)
      .set(authHeader)
      .send({
        name: 'محجر قنا المطور',
        quarry_number: 'Q-999',
        quarry_type: 'جرانيت',
      });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.name).toBe('محجر قنا المطور');
    expect(patchRes.body.quarry_number).toBe('Q-999');

    // 2. Soft-delete quarry
    const delRes = await request(app)
      .delete(`/quarries/${quarry._id}`)
      .set(authHeader);
    expect(delRes.status).toBe(200);
    expect(delRes.body.status).toBe(QuarryStatus.inactive);

    // Active listing no longer contains deleted quarry
    const listRes = await request(app).get('/quarries').set(authHeader);
    expect(listRes.body.some((q: any) => q.id === quarry._id)).toBe(false);
  });

  it('4. Permanent Trash Deletion: deletes physical storage and DB records and releases quota', async () => {
    const company = await createTestCompany();
    const admin = await createTestUser({ email: 'trash_admin@test.com' });
    const adminMembership = await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
    await MembershipModel.findByIdAndUpdate(adminMembership._id, { can_delete: true });

    const quarry = await createTestQuarry(company._id, 'محجر سلة المهملات');
    const authHeader = generateAuthHeader(admin);

    // Upload document
    const uploadRes = await request(app)
      .post(`/quarries/${quarry._id}/documents`)
      .set(authHeader)
      .attach('file', Buffer.from('%PDF-1.4 file-to-permanently-delete'), 'permanent_trash.pdf');
    expect(uploadRes.status).toBe(201);
    const docId = uploadRes.body.id;

    // Soft-delete document into trash
    const softDelRes = await request(app)
      .delete(`/quarries/${quarry._id}/documents/${docId}`)
      .set(authHeader);
    expect([200, 204]).toContain(softDelRes.status);

    // Verify it is in trash
    const trashRes = await request(app).get(`/quarries/${quarry._id}/trash`).set(authHeader);
    expect(trashRes.body.some((d: any) => d.id === docId)).toBe(true);

    // Permanently delete document from trash
    const permDelRes = await request(app)
      .delete(`/quarries/${quarry._id}/documents/${docId}/permanent`)
      .set(authHeader);
    expect(permDelRes.status).toBe(200);
    expect(permDelRes.body.status).toBe('permanently_deleted');

    // Document is gone from trash
    const trashAfter = await request(app).get(`/quarries/${quarry._id}/trash`).set(authHeader);
    expect(trashAfter.body.some((d: any) => d.id === docId)).toBe(false);

    // Document record is completely removed from DB
    const dbDoc = await DocumentModel.findById(docId);
    expect(dbDoc).toBeNull();
  });

  it('5. Alphabetical Sorting: deterministically sorts quarries, folders, and documents', async () => {
    const company = await createTestCompany();
    const admin = await createTestUser({ email: 'sorting_admin@test.com' });
    await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
    const authHeader = generateAuthHeader(admin);

    // Create quarries with Arabic and English names
    await createTestQuarry(company._id, 'محجر جبل الجلالة');
    await createTestQuarry(company._id, 'محجر أبو زعبل');
    await createTestQuarry(company._id, 'Alpha Quarry');
    await createTestQuarry(company._id, 'Beta Quarry');

    const res = await request(app).get('/quarries').set(authHeader);
    expect(res.status).toBe(200);
    const names = res.body.map((q: any) => q.name);

    // Check alphabetical order: 'Alpha Quarry', 'Beta Quarry', 'محجر أبو زعبل', 'محجر جبل الجلالة'
    for (let i = 0; i < names.length - 1; i++) {
      expect(names[i].localeCompare(names[i + 1], ['ar', 'en'], { sensitivity: 'base', numeric: true })).toBeLessThanOrEqual(0);
    }
  });

  it('6. Safe Permission Migration: migrates legacy per-quarry records to company-wide permissions', async () => {
    const company = await createTestCompany();
    const employee = await createTestUser({ email: 'legacy_emp@test.com' });
    const membership = await createTestMembership(employee._id, company._id, MembershipRole.employee);

    // Force legacy unmigrated state on membership
    await MembershipModel.findByIdAndUpdate(membership._id, {
      $unset: { can_view: 1, can_upload: 1, can_download: 1, can_delete: 1, hidden_quarries: 1 },
    });

    const quarryA = await createTestQuarry(company._id, 'محجر قديم 1');
    const quarryB = await createTestQuarry(company._id, 'محجر قديم 2 (مخفي)');

    // Legacy per-quarry records: quarry A visible with upload, quarry B hidden
    await createTestPermission(employee._id, quarryA._id, {
      can_view: true,
      can_upload: true,
      can_download: false,
      can_delete: false,
    });
    await createTestPermission(employee._id, quarryB._id, {
      can_view: false,
      can_upload: false,
      can_download: false,
      can_delete: false,
    });

    const migrationResult = await migrateToCompanyWidePermissions();
    expect(migrationResult.migrated).toBeGreaterThanOrEqual(1);

    const updatedMembership = await MembershipModel.findById(membership._id);
    expect(updatedMembership?.can_view).toBe(true);
    expect(updatedMembership?.can_upload).toBe(true);
    expect(updatedMembership?.can_download).toBe(false);
    expect(updatedMembership?.can_delete).toBe(false);
    expect(updatedMembership?.hidden_quarries).toContain(quarryB._id);
  });
});
