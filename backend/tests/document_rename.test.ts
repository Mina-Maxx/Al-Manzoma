import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { createApp } from '../src/app.js';
import {
  createTestCompany,
  createTestUser,
  createTestMembership,
  createTestQuarry,
  createTestPlatformAdmin,
  generateAuthHeader,
} from './helpers.js';
import {
  DocumentModel,
  DocumentVersionModel,
  QuarryPermissionModel,
  AuditEventModel,
  CompanyModel,
} from '../src/database/models/index.js';
import {
  MembershipRole,
  DocumentStatus,
  AuditResult,
} from '../src/types/index.js';
import { storage } from '../src/modules/storage/index.js';

const app = createApp();

describe('Feature: Rename Quarry Documents (Rename Only)', () => {
  let company: any;
  let quarry: any;
  let adminUser: any;
  let adminHeader: { Authorization: string };
  let employeeUser: any;
  let employeeHeader: { Authorization: string };
  let initialDoc: any;
  let storageKey: string;

  beforeEach(async () => {
    company = await createTestCompany({ name: 'شركة التعدين الأولى' });
    quarry = await createTestQuarry(company._id, { name: 'محجر الجرانيت رقم 1' });

    // Admin setup
    adminUser = await createTestUser({ email: 'admin@quarrytest.com' });
    await createTestMembership(adminUser._id, company._id, MembershipRole.company_admin);
    adminHeader = generateAuthHeader(adminUser);

    // Employee setup (default: can_view=true)
    employeeUser = await createTestUser({ email: 'employee@quarrytest.com' });
    await createTestMembership(employeeUser._id, company._id, MembershipRole.employee);
    employeeHeader = generateAuthHeader(employeeUser);

    // Create initial test document in storage and DB
    const testContent = Buffer.from('%PDF-1.4 Initial test file contents');
    storageKey = `company/${company._id}/quarry/${quarry._id}/test-doc-1`;
    await storage.put(testContent, storageKey, {
      contentType: 'application/pdf',
      sizeBytes: testContent.length,
    });

    initialDoc = await DocumentModel.create({
      _id: uuidv4(),
      company_id: company._id,
      quarry_id: quarry._id,
      folder_id: null,
      display_name: 'عقد_المحجر_الأصلي.pdf',
      original_filename: 'عقد_المحجر_الأصلي.pdf',
      mime_type: 'application/pdf',
      size_bytes: testContent.length,
      sha256: 'initialsha256hash1234567890abcdef',
      storage_ref: storageKey,
      status: DocumentStatus.available,
      uploaded_by: adminUser._id,
      version: 1,
      deleted_at: null,
    });
  });

  it('1. Employee authorized with can_view can successfully rename a document', async () => {
    const res = await request(app)
      .patch(`/quarries/${quarry._id}/documents/${initialDoc._id}/rename`)
      .set(employeeHeader)
      .send({ name: 'عقد_المحجر_المعدل_بواسطة_الموظف.pdf' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(initialDoc._id);
    expect(res.body.display_name).toBe('عقد_المحجر_المعدل_بواسطة_الموظف.pdf');
    expect(res.body.original_filename).toBe('عقد_المحجر_المعدل_بواسطة_الموظف.pdf');
    expect(res.body.version).toBe(2);

    // Check database state
    const docInDb = await DocumentModel.findById(initialDoc._id).lean();
    expect(docInDb!.display_name).toBe('عقد_المحجر_المعدل_بواسطة_الموظف.pdf');
    expect(docInDb!.original_filename).toBe('عقد_المحجر_المعدل_بواسطة_الموظف.pdf');
    expect(docInDb!.storage_ref).toBe(storageKey); // Stored object reference unchanged
    expect(docInDb!.size_bytes).toBe(initialDoc.size_bytes);
    expect(docInDb!.sha256).toBe('initialsha256hash1234567890abcdef');
    expect(docInDb!.uploaded_by).toBe(adminUser._id); // Uploader unchanged
  });

  it('2. Company Admin can successfully rename an accessible document', async () => {
    const res = await request(app)
      .patch(`/quarries/${quarry._id}/documents/${initialDoc._id}/rename`)
      .set(adminHeader)
      .send({ name: 'Contract_2026_Final.pdf' });

    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Contract_2026_Final.pdf');
    expect(res.body.original_filename).toBe('Contract_2026_Final.pdf');

    const docInDb = await DocumentModel.findById(initialDoc._id).lean();
    expect(docInDb!.display_name).toBe('Contract_2026_Final.pdf');
  });

  it('3. Dedicated /documents/:id/rename endpoint works without quarry ID in URL', async () => {
    const res = await request(app)
      .patch(`/documents/${initialDoc._id}/rename`)
      .set(employeeHeader)
      .send({ display_name: 'Direct_Route_Rename.pdf' });

    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Direct_Route_Rename.pdf');
  });

  it('4. Platform Admin can rename documents across companies', async () => {
    const platformAuthId = 'auth-platform-admin-rename';
    const platformAdminUser = await createTestUser({
      auth_user_id: platformAuthId,
      email: 'super@platform.gov',
    });
    await createTestPlatformAdmin({
      user_id: platformAdminUser._id,
      auth_user_id: platformAuthId,
      email: platformAdminUser.email,
    });
    const platformHeader = generateAuthHeader(platformAdminUser, 'platform_admin');

    const res = await request(app)
      .patch(`/documents/${initialDoc._id}/rename`)
      .set(platformHeader)
      .send({ name: 'Platform_Supervised_Document.pdf' });

    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Platform_Supervised_Document.pdf');
  });

  it('5. User without can_view permission is rejected with 403 Forbidden', async () => {
    // Explicitly revoke can_view permission for employeeUser in this quarry
    await QuarryPermissionModel.create({
      _id: uuidv4(),
      user_id: employeeUser._id,
      quarry_id: quarry._id,
      can_view: false,
      can_upload: false,
      can_download: false,
      can_delete: false,
    });

    const res = await request(app)
      .patch(`/quarries/${quarry._id}/documents/${initialDoc._id}/rename`)
      .set(employeeHeader)
      .send({ name: 'Unauthorized_Rename.pdf' });

    expect(res.status).toBe(403);

    // Verify document was not modified
    const docInDb = await DocumentModel.findById(initialDoc._id).lean();
    expect(docInDb!.display_name).toBe('عقد_المحجر_الأصلي.pdf');
  });

  it('6. Cross-company rename attempt is rejected with 404 Not Found', async () => {
    // Create an attacker user from another company
    const otherCompany = await createTestCompany({ name: 'شركة المنافسين' });
    const rogueUser = await createTestUser({ email: 'rogue@othercompany.com' });
    await createTestMembership(rogueUser._id, otherCompany._id, MembershipRole.company_admin);
    const rogueHeader = generateAuthHeader(rogueUser);

    const res = await request(app)
      .patch(`/documents/${initialDoc._id}/rename`)
      .set(rogueHeader)
      .send({ name: 'Hacked_Filename.pdf' });

    expect(res.status).toBe(404);

    // Verify document unchanged
    const docInDb = await DocumentModel.findById(initialDoc._id).lean();
    expect(docInDb!.display_name).toBe('عقد_المحجر_الأصلي.pdf');
  });

  it('7. Cross-quarry mismatch attempt is rejected with 404 Not Found', async () => {
    const otherQuarry = await createTestQuarry(company._id, { name: 'محجر آخر' });

    const res = await request(app)
      .patch(`/quarries/${otherQuarry._id}/documents/${initialDoc._id}/rename`)
      .set(adminHeader)
      .send({ name: 'Mismatched_Quarry.pdf' });

    expect(res.status).toBe(404);
  });

  it('8. Filename validation: rejects empty or whitespace-only names', async () => {
    const resEmpty = await request(app)
      .patch(`/documents/${initialDoc._id}/rename`)
      .set(adminHeader)
      .send({ name: '' });
    expect(resEmpty.status).toBe(400);

    const resWhitespace = await request(app)
      .patch(`/documents/${initialDoc._id}/rename`)
      .set(adminHeader)
      .send({ name: '     ' });
    expect(resWhitespace.status).toBe(400);
  });

  it('9. Filename validation: rejects directory separators and path traversal', async () => {
    const attempts = [
      'subfolder/test.pdf',
      '..\\traversal.pdf',
      '../../secret.pdf',
      'foo\0bar.pdf',
    ];

    for (const badName of attempts) {
      const res = await request(app)
        .patch(`/documents/${initialDoc._id}/rename`)
        .set(adminHeader)
        .send({ name: badName });
      expect(res.status).toBe(400);
    }
  });

  it('10. Filename validation: rejects invalid filesystem characters (: * ? " < > |)', async () => {
    const badChars = ['file:name.pdf', 'file*name.pdf', 'file?name.pdf', 'file"name.pdf', 'file<name.pdf', 'file|name.pdf'];
    for (const badName of badChars) {
      const res = await request(app)
        .patch(`/documents/${initialDoc._id}/rename`)
        .set(adminHeader)
        .send({ name: badName });
      expect(res.status).toBe(400);
    }
  });

  it('11. Extension preservation: automatically appends existing extension if user omits it', async () => {
    const res = await request(app)
      .patch(`/documents/${initialDoc._id}/rename`)
      .set(adminHeader)
      .send({ name: 'New_Report_Without_Extension' });

    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('New_Report_Without_Extension');
    expect(res.body.original_filename).toBe('New_Report_Without_Extension.pdf');
  });

  it('12. Extension preservation: rejects altering file extension', async () => {
    const res = await request(app)
      .patch(`/documents/${initialDoc._id}/rename`)
      .set(adminHeader)
      .send({ name: 'Malicious_Image.png' }); // Existing is .pdf

    expect(res.status).toBe(400);
    expect(res.body.detail || res.body.message).toMatch(/extension/i);
  });

  it('13. Arabic filenames with spaces, parentheses, and numbers are accepted', async () => {
    const arabicName = 'تقرير جيولوجي رقم (105) لسنة 2026.pdf';
    const res = await request(app)
      .patch(`/documents/${initialDoc._id}/rename`)
      .set(employeeHeader)
      .send({ name: arabicName });

    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe(arabicName);
    expect(res.body.original_filename).toBe(arabicName);

    const docInDb = await DocumentModel.findById(initialDoc._id).lean();
    expect(docInDb!.display_name).toBe(arabicName);
    expect(docInDb!.original_filename).toBe(arabicName);
  });

  it('14. Duplicate filename in the same quarry and folder is rejected with 409 Conflict', async () => {
    // Create a second document in the same quarry
    await DocumentModel.create({
      _id: uuidv4(),
      company_id: company._id,
      quarry_id: quarry._id,
      folder_id: null,
      display_name: 'existing_other_document.pdf',
      original_filename: 'existing_other_document.pdf',
      mime_type: 'application/pdf',
      size_bytes: 2048,
      storage_ref: `company/${company._id}/quarry/${quarry._id}/test-doc-2`,
      status: DocumentStatus.available,
      version: 1,
      deleted_at: null,
    });

    // Try to rename initialDoc to 'existing_other_document.pdf'
    const res = await request(app)
      .patch(`/documents/${initialDoc._id}/rename`)
      .set(adminHeader)
      .send({ name: 'existing_other_document.pdf' });

    expect(res.status).toBe(409);
  });

  it('15. Critical requirements: File contents, storage object, DocumentVersion count, quota, and document ID remain unchanged', async () => {
    const initialVersionsCount = await DocumentVersionModel.countDocuments();
    const initialCompanyDoc = await CompanyModel.findById(company._id).lean();
    const initialUsedBytes = initialCompanyDoc?.used_bytes || 0;

    const res = await request(app)
      .patch(`/documents/${initialDoc._id}/rename`)
      .set(employeeHeader)
      .send({ name: 'Renamed_Verify_Immutability.pdf' });

    expect(res.status).toBe(200);

    // 1. Document ID unchanged
    expect(res.body.id).toBe(initialDoc._id);

    // 2. Storage object ref unchanged
    const docInDb = await DocumentModel.findById(initialDoc._id).lean();
    expect(docInDb!.storage_ref).toBe(storageKey);

    // 3. Stored content unchanged (verify stream bytes from storage)
    const storedItem = await storage.get(storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of storedItem.stream) {
      chunks.push(Buffer.from(chunk));
    }
    const retrievedContent = Buffer.concat(chunks).toString('utf8');
    expect(retrievedContent).toBe('%PDF-1.4 Initial test file contents');

    // 4. No new DocumentVersionModel created
    const postVersionsCount = await DocumentVersionModel.countDocuments();
    expect(postVersionsCount).toBe(initialVersionsCount);

    // 5. Quota usage unchanged
    const postCompanyDoc = await CompanyModel.findById(company._id).lean();
    expect(postCompanyDoc?.used_bytes || 0).toBe(initialUsedBytes);
  });

  it('16. Download flow works with updated filename in Content-Disposition', async () => {
    const newArabicFilename = 'بيانات_المحجر_2026.pdf';
    await request(app)
      .patch(`/documents/${initialDoc._id}/rename`)
      .set(adminHeader)
      .send({ name: newArabicFilename });

    const downloadRes = await request(app)
      .get(`/documents/${initialDoc._id}/download`)
      .set(adminHeader);

    expect(downloadRes.status).toBe(200);
    const disposition = downloadRes.headers['content-disposition'];
    expect(disposition).toBeDefined();
    // RFC 5987 / UTF-8 filename* check
    expect(disposition).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(disposition)).toContain(newArabicFilename);
  });

  it('17. Audit log event is recorded with action document.rename and previous/new filenames', async () => {
    await request(app)
      .patch(`/documents/${initialDoc._id}/rename`)
      .set(employeeHeader)
      .send({ name: 'Audit_Logged_Rename.pdf' });

    const auditEvent = await AuditEventModel.findOne({
      action: 'document.rename',
      target_id: initialDoc._id,
    }).lean();

    expect(auditEvent).toBeDefined();
    expect(auditEvent!.result).toBe(AuditResult.success);
    expect(auditEvent!.actor_user_id).toBe(employeeUser._id);
    expect(auditEvent!.company_id).toBe(company._id);
    expect(auditEvent!.meta?.previous_filename).toBe('عقد_المحجر_الأصلي.pdf');
    expect(auditEvent!.meta?.new_filename).toBe('Audit_Logged_Rename.pdf');
    expect(auditEvent!.meta?.quarry_id).toBe(quarry._id);
  });
});
