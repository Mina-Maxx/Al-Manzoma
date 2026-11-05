import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { createApp } from '../src/app.js';
import { backfillStandardFolders } from '../src/scripts/backfillStandardFolders.js';
import {
  QuarryModel,
  FolderModel,
  DocumentModel,
  PlatformAdminModel,
  UserModel,
  MembershipModel,
  QuarryPermissionModel,
} from '../src/database/models/index.js';
import {
  MembershipRole,
  UserStatus,
  DocumentStatus,
  STANDARD_FOLDERS,
  QuarryStatus,
} from '../src/types/index.js';
import {
  createTestCompany,
  createTestUser,
  createTestMembership,
  createTestQuarry,
  createTestPermission,
  createTestPlatformAdmin,
  generateAuthHeader,
} from './helpers.js';
import { storage } from '../src/modules/storage/index.js';

describe('QuarryVault Pre-Production Overhaul Backend Suite', () => {
  let app: any;

  beforeEach(() => {
    app = createApp();
  });

  it('1. POST /quarries enforces required name, quarry_number, and quarry_type', async () => {
    const company = await createTestCompany();
    const admin = await createTestUser();
    await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
    const authHeader = generateAuthHeader(admin);

    // Missing quarry_number
    const resNoNum = await request(app)
      .post('/quarries')
      .set(authHeader)
      .send({ name: 'محجر الأمل', quarry_type: 'جرانيت' });
    expect(resNoNum.status).toBe(400);

    // Missing quarry_type
    const resNoType = await request(app)
      .post('/quarries')
      .set(authHeader)
      .send({ name: 'محجر الأمل', quarry_number: 'Q-100' });
    expect(resNoType.status).toBe(400);

    // Valid creation
    const resSuccess = await request(app)
      .post('/quarries')
      .set(authHeader)
      .send({
        name: 'محجر النور والبركة',
        quarry_number: '104/أ',
        quarry_type: 'رخام',
      });
    expect(resSuccess.status).toBe(201);
    expect(resSuccess.body.name).toBe('محجر النور والبركة');
    expect(resSuccess.body.quarry_number).toBe('104/أ');
    expect(resSuccess.body.quarry_type).toBe('رخام');
    expect(resSuccess.body.display_name).toBe('محجر النور والبركة - رقم 104/أ (رخام)');
  });

  it('2. Enforces unique quarry_number per company (409 Conflict)', async () => {
    const company = await createTestCompany();
    const admin = await createTestUser();
    await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
    const authHeader = generateAuthHeader(admin);

    // Create first quarry
    await request(app)
      .post('/quarries')
      .set(authHeader)
      .send({
        name: 'محجر الشرق',
        quarry_number: 'Q-999',
        quarry_type: 'جرانيت',
      });

    // Attempt second quarry with same quarry_number in same company
    const dupRes = await request(app)
      .post('/quarries')
      .set(authHeader)
      .send({
        name: 'محجر الغرب',
        quarry_number: 'Q-999',
        quarry_type: 'حجر جيري',
      });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.detail).toContain('رقم المحجر مسجل بالفعل');
  });

  it('3. Automatically creates all 8 standard folders on quarry creation in exact order', async () => {
    const company = await createTestCompany();
    const admin = await createTestUser();
    await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
    const authHeader = generateAuthHeader(admin);

    const createRes = await request(app)
      .post('/quarries')
      .set(authHeader)
      .send({
        name: 'محجر وادي الملوك',
        quarry_number: 'WM-2026',
        quarry_type: 'بازلت',
      });
    expect(createRes.status).toBe(201);
    const quarryId = createRes.body.id;

    // Check folders via GET /quarries/:id/folders
    const foldersRes = await request(app)
      .get(`/quarries/${quarryId}/folders`)
      .set(authHeader);
    expect(foldersRes.status).toBe(200);
    expect(foldersRes.body.length).toBe(8);

    const expectedNames = STANDARD_FOLDERS.map((s) => s.name);
    const receivedNames = foldersRes.body.map((f: any) => f.name);
    expect(receivedNames).toEqual(expectedNames);

    // Verify all marked as standard with correct standard_order
    for (let i = 0; i < 8; i++) {
      expect(foldersRes.body[i].is_standard).toBe(true);
      expect(foldersRes.body[i].standard_order).toBe(i + 1);
    }
  });

  it('4. Standard folders: forbidden to rename (PATCH) and forbidden to delete for employee & company admin', async () => {
    const company = await createTestCompany();
    const admin = await createTestUser();
    await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
    const authHeader = generateAuthHeader(admin);

    const createRes = await request(app)
      .post('/quarries')
      .set(authHeader)
      .send({
        name: 'محجر الصفا',
        quarry_number: 'SF-1',
        quarry_type: 'رخام',
      });
    const quarryId = createRes.body.id;

    const folders = await FolderModel.find({ quarry_id: quarryId, is_standard: true }).lean();
    const standardFolder = folders[0];

    // Attempt PATCH rename
    const renameRes = await request(app)
      .patch(`/quarries/${quarryId}/folders/${standardFolder._id}`)
      .set(authHeader)
      .send({ name: 'اسم جديد غير مسموح' });
    expect(renameRes.status).toBe(403);
    expect(renameRes.body.detail).toContain('المجلدات القياسية محمية ولا يمكن تعديل اسمها');

    // Attempt DELETE by Company Admin
    const deleteRes = await request(app)
      .delete(`/quarries/${quarryId}/folders/${standardFolder._id}`)
      .set(authHeader);
    expect(deleteRes.status).toBe(403);
    expect(deleteRes.body.detail).toContain('المجلدات القياسية محمية ولا يمكن حذفها إلا من قبل مسؤولي لوحة الإدارة');
  });

  it('5. Standard folders: Platform Admin can delete, moving active documents safely into Trash', async () => {
    const company = await createTestCompany();
    const admin = await createTestUser();
    await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
    const compAuthHeader = generateAuthHeader(admin);

    const createRes = await request(app)
      .post('/quarries')
      .set(compAuthHeader)
      .send({
        name: 'محجر الجبل الأحمر',
        quarry_number: 'JR-55',
        quarry_type: 'جرانيت',
      });
    const quarryId = createRes.body.id;

    const folders = await FolderModel.find({ quarry_id: quarryId, is_standard: true }).lean();
    const standardFolder = folders[0];

    // Put an active document in that folder
    const doc = await DocumentModel.create({
      _id: uuidv4(),
      company_id: company._id,
      quarry_id: quarryId,
      folder_id: standardFolder._id,
      display_name: 'شهادة تسجيل أصلية.pdf',
      original_filename: 'شهادة تسجيل أصلية.pdf',
      mime_type: 'application/pdf',
      size_bytes: 2048,
      status: DocumentStatus.available,
      uploaded_by: admin._id,
      version: 1,
    });

    // Create Platform Admin
    const platformAdmin = await createTestPlatformAdmin();
    const platAuthHeader = {
      ...generateAuthHeader(platformAdmin),
      'x-company-id': company._id,
    };

    // Platform Admin deletes the standard folder
    const deleteRes = await request(app)
      .delete(`/quarries/${quarryId}/folders/${standardFolder._id}`)
      .set(platAuthHeader);
    expect(deleteRes.status).toBe(204);

    // Verify folder soft-deleted
    const updatedFolder = await FolderModel.findById(standardFolder._id);
    expect(updatedFolder?.deleted_at).not.toBeNull();

    // Verify document was moved into trash (soft-deleted, NOT destroyed)
    const updatedDoc = await DocumentModel.findById(doc._id);
    expect(updatedDoc?.deleted_at).not.toBeNull();
  });

  it('6. Centralized Company Trash: aggregates deleted documents across accessible quarries with location details', async () => {
    const company = await createTestCompany();
    const admin = await createTestUser();
    await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
    const authHeader = generateAuthHeader(admin);

    const quarry1 = await createTestQuarry(company._id, {
      name: 'محجر الفيروز',
      quarry_number: 'FZ-10',
      quarry_type: 'جرانيت',
    });
    const quarry2 = await createTestQuarry(company._id, {
      name: 'محجر العقيق',
      quarry_number: 'AQ-20',
      quarry_type: 'رخام',
    });

    const folder1 = await FolderModel.create({
      company_id: company._id,
      quarry_id: quarry1._id,
      name: 'شهريات',
      version: 1,
    });

    // Create 2 soft-deleted documents across the 2 quarries
    await DocumentModel.create({
      _id: uuidv4(),
      company_id: company._id,
      quarry_id: quarry1._id,
      folder_id: folder1._id,
      display_name: 'تقرير_شهر_يناير.pdf',
      original_filename: 'تقرير_شهر_يناير.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1024,
      status: DocumentStatus.available,
      deleted_at: new Date(),
      deleted_by: admin._id,
      version: 2,
    });

    await DocumentModel.create({
      _id: uuidv4(),
      company_id: company._id,
      quarry_id: quarry2._id,
      folder_id: null,
      display_name: 'صورة_موقع.jpg',
      original_filename: 'صورة_موقع.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 4096,
      status: DocumentStatus.available,
      deleted_at: new Date(),
      deleted_by: admin._id,
      version: 2,
    });

    // Call centralized company trash endpoint
    const trashRes = await request(app)
      .get('/company/trash')
      .set(authHeader);
    expect(trashRes.status).toBe(200);
    expect(trashRes.body.length).toBe(2);

    const item1 = trashRes.body.find((d: any) => d.display_name === 'تقرير_شهر_يناير.pdf');
    expect(item1).toBeDefined();
    expect(item1.quarry_name).toContain('محجر الفيروز');
    expect(item1.folder_name).toBe('شهريات');
    expect(item1.can_restore).toBe(true);

    const item2 = trashRes.body.find((d: any) => d.display_name === 'صورة_موقع.jpg');
    expect(item2).toBeDefined();
    expect(item2.quarry_name).toContain('محجر العقيق');
    expect(item2.folder_name).toBe('المجلد الرئيسي');
  });

  it('7. Centralized Trash Restoration: restores to exact original quarry & folder, rejects duplicate filename with 409', async () => {
    const company = await createTestCompany();
    const admin = await createTestUser();
    await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
    const authHeader = generateAuthHeader(admin);

    const quarry = await createTestQuarry(company._id, {
      name: 'محجر الزمرّد',
      quarry_number: 'ZM-7',
      quarry_type: 'رخام',
    });

    const folder = await FolderModel.create({
      company_id: company._id,
      quarry_id: quarry._id,
      name: 'كارت تشغيل',
      version: 1,
    });
    const deletedStorageRef = `company/${company._id}/quarry/${quarry._id}/restore-test-${uuidv4()}`;
    await storage.put(Buffer.from('%PDF-1.4 restorable fixture'), deletedStorageRef, {
      contentType: 'application/pdf',
      sizeBytes: 2048,
    });

    const deletedDoc = await DocumentModel.create({
      _id: uuidv4(),
      company_id: company._id,
      quarry_id: quarry._id,
      folder_id: folder._id,
      display_name: 'كارت_التشغيل_السنوي.pdf',
      original_filename: 'كارت_التشغيل_السنوي.pdf',
      mime_type: 'application/pdf',
      size_bytes: 2048,
      storage_ref: deletedStorageRef,
      status: DocumentStatus.available,
      deleted_at: new Date(),
      deleted_by: admin._id,
      version: 2,
    });

    // 1. Put an active document with the EXACT SAME display_name in that destination folder
    await DocumentModel.create({
      _id: uuidv4(),
      company_id: company._id,
      quarry_id: quarry._id,
      folder_id: folder._id,
      display_name: 'كارت_التشغيل_السنوي.pdf',
      original_filename: 'كارت_التشغيل_السنوي.pdf',
      mime_type: 'application/pdf',
      size_bytes: 2048,
      status: DocumentStatus.available,
      deleted_at: null,
      version: 1,
    });

    // Attempt restoration -> must be rejected with 409 Conflict
    const restoreConflictRes = await request(app)
      .post(`/company/trash/${deletedDoc._id}/restore`)
      .set(authHeader);
    expect(restoreConflictRes.status).toBe(409);
    expect(restoreConflictRes.body.detail).toContain('يوجد ملف بنفس الاسم');

    // 2. Rename active doc so there's no conflict, then restore succeeds
    await DocumentModel.updateOne(
      { display_name: 'كارت_التشغيل_السنوي.pdf', deleted_at: null },
      { display_name: 'كارت_التشغيل_السنوي_القديم.pdf' }
    );

    const restoreSuccessRes = await request(app)
      .post(`/company/trash/${deletedDoc._id}/restore`)
      .set(authHeader);
    expect(restoreSuccessRes.status).toBe(200);
    expect(restoreSuccessRes.body.id).toBe(deletedDoc._id);
    expect(restoreSuccessRes.body.folder_id).toBe(folder._id);
    expect(restoreSuccessRes.body.quarry_id).toBe(quarry._id);

    const docAfter = await DocumentModel.findById(deletedDoc._id);
    expect(docAfter?.deleted_at).toBeNull();
  });

  it('8. Alphabetical Arabic sorting in GET /quarries', async () => {
    const company = await createTestCompany();
    const admin = await createTestUser();
    await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
    const authHeader = generateAuthHeader(admin);

    // Create quarries with Arabic names in reverse alphabetical order
    await createTestQuarry(company._id, { name: 'ياسمين', quarry_number: 'Q-Y' });
    await createTestQuarry(company._id, { name: 'نور', quarry_number: 'Q-N' });
    await createTestQuarry(company._id, { name: 'بركة', quarry_number: 'Q-B' });
    await createTestQuarry(company._id, { name: 'أمل', quarry_number: 'Q-A' });

    const listRes = await request(app)
      .get('/quarries')
      .set(authHeader);
    expect(listRes.status).toBe(200);

    const names = listRes.body.map((q: any) => q.name);
    expect(names).toEqual(['أمل', 'بركة', 'نور', 'ياسمين']);
  });

  it('9. Legacy quarries with null quarry_number can coexist within same company (partialFilterExpression)', async () => {
    const company = await createTestCompany();
    await QuarryModel.init(); // ensure indexes are in place

    // Create multiple legacy quarries with null quarry_number in the same company
    const q1 = await QuarryModel.create({
      company_id: company._id,
      name: 'محجر قديم 1',
      quarry_number: null,
      quarry_type: null,
      status: QuarryStatus.active,
    });
    expect(q1._id).toBeDefined();

    const q2 = await QuarryModel.create({
      company_id: company._id,
      name: 'محجر قديم 2',
      quarry_number: null,
      quarry_type: null,
      status: QuarryStatus.active,
    });
    expect(q2._id).toBeDefined();

    // Verify distinct quarry numbers work in same company
    const q3 = await QuarryModel.create({
      company_id: company._id,
      name: 'محجر جديد 101',
      quarry_number: '101',
      quarry_type: 'جرانيت',
      status: QuarryStatus.active,
    });
    expect(q3._id).toBeDefined();

    // Duplicate quarry number in same company must be rejected
    await expect(
      QuarryModel.create({
        company_id: company._id,
        name: 'محجر مكرر 101',
        quarry_number: '101',
        quarry_type: 'رخام',
        status: QuarryStatus.active,
      })
    ).rejects.toThrow();
  });

  it('10. Quarry creation with regex special characters (e.g. Q+1, (جرانيت)) does not crash with 500', async () => {
    const company = await createTestCompany();
    const admin = await createTestUser();
    await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
    const authHeader = generateAuthHeader(admin);

    const res = await request(app)
      .post('/quarries')
      .set(authHeader)
      .send({
        name: 'محجر الأهرام (موقع +1)',
        quarry_number: 'Q+100?*',
        quarry_type: 'جرانيت [فاخر]',
      });
    expect(res.status).toBe(201);
    expect(res.body.quarry_number).toBe('Q+100?*');
  });

  it('11. Database E11000 duplicate key error is mapped to 409 Conflict', async () => {
    const company = await createTestCompany();
    const admin = await createTestUser();
    await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
    const authHeader = generateAuthHeader(admin);

    // Create quarry 1
    const res1 = await request(app)
      .post('/quarries')
      .set(authHeader)
      .send({
        name: 'محجر الزهور',
        quarry_number: 'ZH-01',
        quarry_type: 'رخام',
      });
    expect(res1.status).toBe(201);

    // Attempt to create duplicate name or number
    const resDup = await request(app)
      .post('/quarries')
      .set(authHeader)
      .send({
        name: 'محجر الزهور',
        quarry_number: 'ZH-02',
        quarry_type: 'رخام',
      });
    expect(resDup.status).toBe(409);
  });

  it('12. backfillStandardFolders idempotently creates missing standard folders for legacy quarries', async () => {
    const company = await createTestCompany();
    // Create a legacy quarry with no folders
    const quarry = await QuarryModel.create({
      company_id: company._id,
      name: 'محجر تراثي قديم',
      quarry_number: 'LEGACY-01',
      quarry_type: 'حجر جيري',
      status: QuarryStatus.active,
    });

    const initialFolders = await FolderModel.find({ quarry_id: quarry._id });
    expect(initialFolders.length).toBe(0);

    // Run backfill
    const result1 = await backfillStandardFolders({ dryRun: false });
    expect(result1.totalFoldersCreated).toBeGreaterThanOrEqual(8);

    const foldersAfter = await FolderModel.find({ quarry_id: quarry._id, is_standard: true });
    expect(foldersAfter.length).toBe(8);

    // Second run must be completely idempotent (0 new folders created)
    const result2 = await backfillStandardFolders({ dryRun: false });
    expect(result2.totalFoldersCreated).toBe(0);
  });
});
