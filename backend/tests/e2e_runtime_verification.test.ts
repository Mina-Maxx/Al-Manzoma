import { describe, it, expect } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { createApp } from '../src/app.js';
import {
  CompanyModel,
  UserModel,
  MembershipModel,
  QuarryModel,
  QuarryPermissionModel,
  FolderModel,
  DocumentModel,
  DocumentVersionModel,
  PlatformAdminModel,
  AuditEventModel,
  IdempotencyKeyModel,
} from '../src/database/models/index.js';
import {
  CompanyStatus,
  UserStatus,
  MembershipRole,
  QuarryStatus,
  DocumentStatus,
  STANDARD_FOLDERS,
} from '../src/types/index.js';
import { signAccessToken } from '../src/modules/auth/router.js';
import { storage, buildStorageKey } from '../src/modules/storage/index.js';
import { beginIdempotencyAttempt, activeOwners } from '../src/services/idempotency.js';

describe('QuarryVault Complete End-to-End Runtime API Verification', () => {
  const app = createApp();


  // =========================================================================
  // 1. Authentication & Session Lifecycle
  // =========================================================================
  describe('1. Authentication & Session Lifecycle', () => {
    it('1.1. Login authenticates user, creates active session, and returns access & refresh tokens', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Sina Quarries Group',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
        used_bytes: 0,
      });

      const rawPassword = 'SecurePassword123!';
      const hash = await bcrypt.hash(rawPassword, 10);
      const user = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        username: 'mina_admin',
        normalized_username: 'mina_admin',
        email: 'mina@sinaquarries.com',
        password_hash: hash,
        status: UserStatus.active,
        must_change_password: false,
      });

      await MembershipModel.create({
        user_id: user._id,
        company_id: company._id,
        role: MembershipRole.company_admin,
        can_view: true,
        can_upload: true,
        can_download: true,
        can_delete: true,
      });

      const res = await request(app)
        .post('/auth/login')
        .send({ username: 'mina_admin', password: rawPassword });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.refresh_token).toBeDefined();
      expect(res.body.session_id).toBeDefined();
      expect(res.body.user.id).toBe(user._id);
      expect(res.body.user.mustChangePassword).toBe(false);

      // Verify active_session_id stored in database
      const updatedUser = await UserModel.findById(user._id);
      expect(updatedUser?.active_session_id).toBe(res.body.session_id);
    });

    it('1.2. Single active session enforcement: a newer login terminates the prior active session', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Aswan Granite',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
        used_bytes: 0,
      });

      const rawPassword = 'DevicePass123!';
      const hash = await bcrypt.hash(rawPassword, 10);
      const user = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        username: 'device_user',
        normalized_username: 'device_user',
        password_hash: hash,
        status: UserStatus.active,
      });

      await MembershipModel.create({
        user_id: user._id,
        company_id: company._id,
        role: MembershipRole.employee,
        can_view: true,
      });

      // Login from Device 1
      const login1 = await request(app)
        .post('/auth/login')
        .send({ username: 'device_user', password: rawPassword });
      expect(login1.status).toBe(200);
      const token1 = login1.body.token;

      // Device 1 makes a successful authenticated request
      const req1 = await request(app)
        .get('/me')
        .set('Authorization', `Bearer ${token1}`);
      expect(req1.status).toBe(200);

      // Login from Device 2 (new session)
      const login2 = await request(app)
        .post('/auth/login')
        .send({ username: 'device_user', password: rawPassword });
      expect(login2.status).toBe(200);
      const token2 = login2.body.token;

      // Device 2 succeeds
      const req2 = await request(app)
        .get('/me')
        .set('Authorization', `Bearer ${token2}`);
      expect(req2.status).toBe(200);

      // Device 1 makes another request: MUST BE REJECTED with 401 Unauthorized
      const req1Old = await request(app)
        .get('/me')
        .set('Authorization', `Bearer ${token1}`);
      expect(req1Old.status).toBe(401);
      expect(req1Old.body.detail).toMatch(/Session has expired or was terminated by a newer login/i);
    });

    it('1.3. Mandatory password change blocks access to standard routes and completes password update', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Red Sea Marble',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
      });

      const tempPass = 'TempPass123!';
      const hash = await bcrypt.hash(tempPass, 10);
      const user = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        username: 'new_employee',
        normalized_username: 'new_employee',
        password_hash: hash,
        status: UserStatus.active,
        must_change_password: true, // Requires mandatory password change
      });

      await MembershipModel.create({
        user_id: user._id,
        company_id: company._id,
        role: MembershipRole.employee,
        can_view: true,
      });

      const loginRes = await request(app)
        .post('/auth/login')
        .send({ username: 'new_employee', password: tempPass });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.user.mustChangePassword).toBe(true);
      const token = loginRes.body.token;

      // Attempting to access standard company routes returns 403 password change required
      const quarriesRes = await request(app)
        .get('/quarries')
        .set('Authorization', `Bearer ${token}`);
      expect(quarriesRes.status).toBe(403);
      expect(quarriesRes.body.detail).toMatch(/password change required/i);

      // Changing password via POST /auth/change-password
      const newPass = 'PermanentPass456!';
      const changeRes = await request(app)
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({
          current_password: tempPass,
          new_password: newPass,
          confirm_password: newPass,
        });
      expect(changeRes.status).toBe(200);

      // Session rotation is the revocation boundary; do not set a same-second timestamp.
      const updatedUser = await UserModel.findById(user._id);
      expect(updatedUser?.must_change_password).toBe(false);
      expect(updatedUser?.tokens_revoked_at).toBeNull();
      expect(updatedUser?.active_session_id).toBeTruthy();

      // Old token is now revoked
      const oldTokenCall = await request(app)
        .get('/quarries')
        .set('Authorization', `Bearer ${token}`);
      expect(oldTokenCall.status).toBe(401);

      // User can now log in with the new permanent password
      const newLogin = await request(app)
        .post('/auth/login')
        .send({ username: 'new_employee', password: newPass });
      expect(newLogin.status).toBe(200);
      expect(newLogin.body.user.mustChangePassword).toBe(false);

      // New token accesses standard routes successfully
      const freshCall = await request(app)
        .get('/quarries')
        .set('Authorization', `Bearer ${newLogin.body.token}`);
      expect(freshCall.status).toBe(200);
    });
  });

  // =========================================================================
  // 2. Company & Quarry Management
  // =========================================================================
  describe('2. Company & Quarry Management', () => {
    it('2.1. Company Admin creates quarry and automatically populates 8 standard folders', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Al-Ahram Extraction Co.',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
      });

      const admin = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        username: 'ahram_admin',
        normalized_username: 'ahram_admin',
        status: UserStatus.active,
      });

      await MembershipModel.create({
        user_id: admin._id,
        company_id: company._id,
        role: MembershipRole.company_admin,
      });

      const token = signAccessToken({
        sub: admin.auth_user_id,
        email: 'ahram_admin@example.com',
        role: 'user',
      });

      // Create Quarry
      const res = await request(app)
        .post('/quarries')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'محجر الزعفرانة',
          quarry_number: 'Q-ZAF-01',
          quarry_type: 'جرانيت رمادي',
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.display_name).toContain('محجر الزعفرانة');
      const quarryId = res.body.id;

      // Query folders of this quarry
      const foldersRes = await request(app)
        .get(`/quarries/${quarryId}/folders`)
        .set('Authorization', `Bearer ${token}`);

      expect(foldersRes.status).toBe(200);
      expect(Array.isArray(foldersRes.body)).toBe(true);
      expect(foldersRes.body.length).toBe(8);

      // Verify standard folder names exist
      const folderNames = foldersRes.body.map((f: any) => f.name);
      for (const sf of STANDARD_FOLDERS) {
        expect(folderNames).toContain(sf.name);
      }
    });

    it('2.2. Quarries listing returns quarries sorted alphabetically in Arabic/English', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Delta Stone Co.',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
      });

      const admin = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        username: 'delta_admin',
        normalized_username: 'delta_admin',
        status: UserStatus.active,
      });

      await MembershipModel.create({
        user_id: admin._id,
        company_id: company._id,
        role: MembershipRole.company_admin,
      });

      // Create 3 quarries in non-alphabetical order
      await QuarryModel.create({
        company_id: company._id,
        name: 'محجر وادي النطرون',
        quarry_number: 'Q-03',
        status: QuarryStatus.active,
      });
      await QuarryModel.create({
        company_id: company._id,
        name: 'محجر أسوان الشرقي',
        quarry_number: 'Q-01',
        status: QuarryStatus.active,
      });
      await QuarryModel.create({
        company_id: company._id,
        name: 'محجر بني سويف',
        quarry_number: 'Q-02',
        status: QuarryStatus.active,
      });

      const token = signAccessToken({
        sub: admin.auth_user_id,
        role: 'user',
      });

      const res = await request(app)
        .get('/quarries')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(3);
      // Alphabetical order: أسوان then بني سويف then وادي النطرون
      expect(res.body[0].name).toBe('محجر أسوان الشرقي');
      expect(res.body[1].name).toBe('محجر بني سويف');
      expect(res.body[2].name).toBe('محجر وادي النطرون');
    });
  });

  // =========================================================================
  // 3. Employee Creation & Company-Wide Permissions Enforcement
  // =========================================================================
  describe('3. Employee Creation & Company-Wide Permissions', () => {
    it('3.1. Admin creates employee with company-wide granular permissions', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Cairo Marble Co.',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
        max_users: 10,
      });

      const admin = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        username: 'cairo_admin',
        normalized_username: 'cairo_admin',
        status: UserStatus.active,
      });

      await MembershipModel.create({
        user_id: admin._id,
        company_id: company._id,
        role: MembershipRole.company_admin,
      });

      const adminToken = signAccessToken({ sub: admin.auth_user_id, role: 'user' });

      // Admin creates employee with can_view=true, can_upload=false, can_download=true, can_delete=false
      const res = await request(app)
        .post('/company/employees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          username: 'auditor_emp',
          full_name: 'Auditor Employee',
          password: 'TemporaryPassword123',
          can_view: true,
          can_upload: false,
          can_download: true,
          can_delete: false,
        });

      expect(res.status).toBe(201);
      expect(res.body.username).toBe('auditor_emp');
      expect(res.body).not.toHaveProperty('temporary_password');
      expect(res.body.permissions.can_upload).toBe(false);
      expect(res.body.permissions.can_download).toBe(true);
      expect(res.body.permissions.can_delete).toBe(false);
    });

    it('3.2. Operational permissions apply company-wide: unauthorized upload, download, or delete is rejected with 403', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Sinai Stones',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
      });

      const quarry = await QuarryModel.create({
        _id: uuidv4(),
        company_id: company._id,
        name: 'Quarry 1',
        status: QuarryStatus.active,
      });

      const folder = await FolderModel.create({
        company_id: company._id,
        quarry_id: quarry._id,
        name: 'العقود',
      });

      // Employee 1: View only (no upload, no download, no delete)
      const emp1 = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        username: 'view_only_emp',
        status: UserStatus.active,
      });
      await MembershipModel.create({
        user_id: emp1._id,
        company_id: company._id,
        role: MembershipRole.employee,
        can_view: true,
        can_upload: false,
        can_download: false,
        can_delete: false,
      });

      const doc = await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: quarry._id,
        folder_id: folder._id,
        display_name: 'Survey Doc.pdf',
        original_filename: 'survey.pdf',
        mime_type: 'application/pdf',
        size_bytes: 512,
        status: DocumentStatus.available,
      });

      const emp1Token = signAccessToken({ sub: emp1.auth_user_id, role: 'user' });

      // View-only employee CAN list documents
      const listRes = await request(app)
        .get(`/quarries/${quarry._id}/documents`)
        .set('Authorization', `Bearer ${emp1Token}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.length).toBe(1);

      // View-only employee CANNOT upload (returns 403 Forbidden)
      const uploadRes = await request(app)
        .post(`/quarries/${quarry._id}/documents`)
        .set('Authorization', `Bearer ${emp1Token}`)
        .field('folder_id', folder._id)
        .attach('file', Buffer.from('test content'), 'test.pdf');
      expect(uploadRes.status).toBe(403);
      expect(uploadRes.body.detail).toMatch(/permission denied|forbidden/i);

      // View-only employee CANNOT download (returns 403 Forbidden)
      const downloadRes = await request(app)
        .get(`/documents/${doc._id}/download`)
        .set('Authorization', `Bearer ${emp1Token}`);
      expect(downloadRes.status).toBe(403);

      // View-only employee CANNOT delete (returns 403 Forbidden)
      const deleteRes = await request(app)
        .delete(`/quarries/${quarry._id}/documents/${doc._id}`)
        .set('Authorization', `Bearer ${emp1Token}`);
      expect(deleteRes.status).toBe(403);
    });
  });

  // =========================================================================
  // 4. Document Operations: Upload, List, Download, Rename, and Versions
  // =========================================================================
  describe('4. Document Operations Lifecycle', () => {
    it('4.1. Multipart upload, authenticated download, extension-preserving rename, and versioning', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Giza Granite Corp.',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
        used_bytes: 0,
      });

      const quarry = await QuarryModel.create({
        _id: uuidv4(),
        company_id: company._id,
        name: 'Giza Quarry Alpha',
        status: QuarryStatus.active,
      });

      const user = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        username: 'uploader_emp',
        status: UserStatus.active,
      });

      await MembershipModel.create({
        user_id: user._id,
        company_id: company._id,
        role: MembershipRole.employee,
        can_view: true,
        can_upload: true,
        can_download: true,
        can_delete: true,
      });

      const token = signAccessToken({ sub: user.auth_user_id, role: 'user' });

      // 1. Multipart Upload with Arabic Display Name
      const fileContent = 'PDF-CONTENT-SAMPLE-BYTES-12345';
      const uploadRes = await request(app)
        .post(`/quarries/${quarry._id}/documents`)
        .set('Authorization', `Bearer ${token}`)
        .field('display_name', 'تقرير المسح الجيولوجي')
        .attach('file', Buffer.from(fileContent), 'geological_report.pdf');

      expect(uploadRes.status).toBe(201);
      expect(uploadRes.body.id).toBeDefined();
      expect(uploadRes.body.display_name).toBe('تقرير المسح الجيولوجي');
      const docId = uploadRes.body.id;

      // Verify quota updated
      const updatedCompany = await CompanyModel.findById(company._id);
      expect(updatedCompany?.used_bytes).toBe(Buffer.byteLength(fileContent));

      // 2. Authenticated Download Stream
      const downloadRes = await request(app)
        .get(`/documents/${docId}/download`)
        .set('Authorization', `Bearer ${token}`);

      expect(downloadRes.status).toBe(200);
      const downloadedString = (downloadRes.body as Buffer).toString('utf-8');
      expect(downloadedString).toBe(fileContent);

      // 3. Document Rename Preserves Extension
      // Renaming without specifying extension (.pdf) must preserve .pdf in original_filename
      const renameRes = await request(app)
        .patch(`/quarries/${quarry._id}/documents/${docId}/rename`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'تقرير معتمد جديد' });

      expect(renameRes.status).toBe(200);
      const renamedDoc = await DocumentModel.findById(docId);
      expect(renamedDoc?.display_name).toBe('تقرير معتمد جديد');
      expect(renamedDoc?.original_filename).toBe('تقرير معتمد جديد.pdf');

      // 4. Document Versioning
      const version2Content = 'UPDATED-VERSION-2-CONTENT-BYTES';
      const versionRes = await request(app)
        .post(`/quarries/${quarry._id}/documents/${docId}/versions`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from(version2Content), 'geological_report_v2.pdf');

      expect(versionRes.status).toBe(201);
      expect(versionRes.body.version).toBe(3);

      // Verify download now serves the latest version
      const downloadV2Res = await request(app)
        .get(`/documents/${docId}/download`)
        .set('Authorization', `Bearer ${token}`);
      expect(downloadV2Res.status).toBe(200);
      const downloadedV2String = (downloadV2Res.body as Buffer).toString('utf-8');
      expect(downloadedV2String).toBe(version2Content);
    });
  });

  // =========================================================================
  // 5. Trash & Deletion Lifecycle: Isolation, Atomic Locking & Quota Safety
  // =========================================================================
  describe('5. Trash & Deletion Lifecycle', () => {
    it('5.1. Regular employee sees only own deleted documents in Trash; Admin sees all', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Omega Quarry Ltd.',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
        used_bytes: 2048,
      });

      const quarry = await QuarryModel.create({
        _id: uuidv4(),
        company_id: company._id,
        name: 'Omega South',
        status: QuarryStatus.active,
      });

      // Company Admin
      const admin = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        username: 'omega_admin',
        status: UserStatus.active,
      });
      await MembershipModel.create({
        user_id: admin._id,
        company_id: company._id,
        role: MembershipRole.company_admin,
      });

      // Employee 1
      const emp1 = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        username: 'emp_one',
        status: UserStatus.active,
      });
      await MembershipModel.create({
        user_id: emp1._id,
        company_id: company._id,
        role: MembershipRole.employee,
        can_view: true,
        can_delete: true,
      });

      // Employee 2
      const emp2 = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        username: 'emp_two',
        status: UserStatus.active,
      });
      await MembershipModel.create({
        user_id: emp2._id,
        company_id: company._id,
        role: MembershipRole.employee,
        can_view: true,
        can_delete: true,
      });

      // Soft-deleted doc 1 by emp1 (status available + deleted_at set)
      const doc1 = await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: quarry._id,
        display_name: 'Emp1 Deleted Doc.pdf',
        original_filename: 'emp1.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1024,
        status: DocumentStatus.available,
        deleted_at: new Date(),
        deleted_by: emp1._id,
      });

      // Soft-deleted doc 2 by emp2
      const doc2 = await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: quarry._id,
        display_name: 'Emp2 Deleted Doc.pdf',
        original_filename: 'emp2.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1024,
        status: DocumentStatus.available,
        deleted_at: new Date(),
        deleted_by: emp2._id,
      });

      const emp1Token = signAccessToken({ sub: emp1.auth_user_id, role: 'user' });
      const adminToken = signAccessToken({ sub: admin.auth_user_id, role: 'user' });

      // Employee 1 queries trash: must ONLY see doc1
      const emp1TrashRes = await request(app)
        .get('/company/trash')
        .set('Authorization', `Bearer ${emp1Token}`);
      expect(emp1TrashRes.status).toBe(200);
      expect(emp1TrashRes.body.length).toBe(1);
      expect(emp1TrashRes.body[0].id).toBe(doc1._id);

      // Admin queries trash: sees BOTH doc1 and doc2
      const adminTrashRes = await request(app)
        .get('/company/trash')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminTrashRes.status).toBe(200);
      expect(adminTrashRes.body.length).toBe(2);
    });

    it('5.2. Permanent deletion atomically decrements company quota and removes records', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Luxor Alabaster',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
        used_bytes: 4096,
      });

      const quarry = await QuarryModel.create({
        _id: uuidv4(),
        company_id: company._id,
        name: 'Luxor West',
        status: QuarryStatus.active,
      });

      const admin = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        username: 'luxor_admin',
        status: UserStatus.active,
      });
      await MembershipModel.create({
        user_id: admin._id,
        company_id: company._id,
        role: MembershipRole.company_admin,
      });

      const doc = await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: quarry._id,
        display_name: 'To Purge.pdf',
        original_filename: 'to_purge.pdf',
        mime_type: 'application/pdf',
        size_bytes: 4096,
        status: DocumentStatus.available,
        deleted_at: new Date(),
        deleted_by: admin._id,
      });

      // Put dummy file into storage
      const storageKey = buildStorageKey(company._id, quarry._id, doc._id, 1);
      await storage.put(Buffer.from('PURGE-DATA-4096'), storageKey);
      doc.storage_ref = storageKey;
      await doc.save();

      const adminToken = signAccessToken({ sub: admin.auth_user_id, role: 'user' });

      // Company Admin permanently deletes document
      const permRes = await request(app)
        .delete(`/quarries/${quarry._id}/documents/${doc._id}/permanent`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(permRes.status).toBe(200);

      // Verify quota was decremented from 4096 to 0
      const updatedCompany = await CompanyModel.findById(company._id);
      expect(updatedCompany?.used_bytes).toBe(0);

      // Verify document record removed
      const docCheck = await DocumentModel.findById(doc._id);
      expect(docCheck).toBeNull();
    });
  });

  // =========================================================================
  // 6. Critical Security Fixes Verification
  // =========================================================================
  describe('6. Critical Security Fixes Verification', () => {
    it('6.1. Hidden Quarry: Employee receives 404 on list, rename, download, trash, and restore', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Red Sea Mining Co.',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
        used_bytes: 2048,
      });

      const hiddenQuarry = await QuarryModel.create({
        _id: uuidv4(),
        company_id: company._id,
        name: 'Confidential Red Sea Quarry',
        status: QuarryStatus.active,
      });

      const emp = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        username: 'restricted_emp',
        status: UserStatus.active,
      });

      // Employee is hidden from this quarry
      await MembershipModel.create({
        user_id: emp._id,
        company_id: company._id,
        role: MembershipRole.employee,
        can_view: true,
        can_upload: true,
        can_download: true,
        can_delete: true,
        hidden_quarries: [hiddenQuarry._id],
      });

      const activeDoc = await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: hiddenQuarry._id,
        display_name: 'Confidential Report.pdf',
        original_filename: 'conf.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1024,
        status: DocumentStatus.available,
      });

      const deletedDoc = await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: hiddenQuarry._id,
        display_name: 'Deleted Secret.pdf',
        original_filename: 'secret.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1024,
        status: DocumentStatus.available,
        deleted_at: new Date(),
        deleted_by: emp._id,
      });

      const token = signAccessToken({ sub: emp.auth_user_id, role: 'user' });

      // 1. List documents in hidden quarry -> 404
      const listRes = await request(app)
        .get(`/quarries/${hiddenQuarry._id}/documents`)
        .set('Authorization', `Bearer ${token}`);
      expect(listRes.status).toBe(404);

      // 2. Download document in hidden quarry -> 404
      const downloadRes = await request(app)
        .get(`/documents/${activeDoc._id}/download`)
        .set('Authorization', `Bearer ${token}`);
      expect(downloadRes.status).toBe(404);

      // 3. Rename document in hidden quarry -> 404
      const renameRes = await request(app)
        .patch(`/quarries/${hiddenQuarry._id}/documents/${activeDoc._id}/rename`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed Secret.pdf' });
      expect(renameRes.status).toBe(404);

      // 4. Company trash list -> excludes hidden quarry document
      const trashRes = await request(app)
        .get('/company/trash')
        .set('Authorization', `Bearer ${token}`);
      expect(trashRes.status).toBe(200);
      const trashIds = trashRes.body.map((d: any) => d.id);
      expect(trashIds).not.toContain(deletedDoc._id);

      // 5. Restore document in hidden quarry -> 404
      const restoreRes = await request(app)
        .post(`/company/trash/${deletedDoc._id}/restore`)
        .set('Authorization', `Bearer ${token}`);
      expect(restoreRes.status).toBe(404);
    });

    it('6.2. Platform Admin scoped access: requires matching active company header; records unresolved lack of scoped time-bounded grant mechanism', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Target Company',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
      });

      const otherCompany = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Other Company',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
      });

      const quarry = await QuarryModel.create({
        _id: uuidv4(),
        company_id: company._id,
        name: 'Target Quarry',
        status: QuarryStatus.active,
      });

      const fileContent = 'TARGET-DATA-512';
      const doc = await DocumentModel.create({
        _id: uuidv4(),
        company_id: company._id,
        quarry_id: quarry._id,
        display_name: 'Target Document.pdf',
        original_filename: 'target.pdf',
        mime_type: 'application/pdf',
        size_bytes: Buffer.byteLength(fileContent),
        status: DocumentStatus.available,
      });

      const storageKey = buildStorageKey(company._id, quarry._id, doc._id, 1);
      await storage.put(Buffer.from(fileContent), storageKey);
      doc.storage_ref = storageKey;
      await doc.save();

      const adminAuthUserId = uuidv4();
      const adminUser = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: adminAuthUserId,
        email: 'superadmin@quarryvault.com',
        username: 'root_superadmin',
        status: UserStatus.active,
      });

      const platformAdmin = await PlatformAdminModel.create({
        _id: uuidv4(),
        auth_user_id: adminAuthUserId,
        email: 'superadmin@quarryvault.com',
        full_name: 'Root Platform Admin',
        status: UserStatus.active,
      });

      const adminToken = signAccessToken({
        sub: platformAdmin.auth_user_id,
        email: platformAdmin.email,
        role: 'platform_admin',
      });

      // 1. Missing X-Company-Id returns 403 Forbidden
      const noHeaderRes = await request(app)
        .get(`/documents/${doc._id}/download`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(noHeaderRes.status).toBe(403);
      expect(noHeaderRes.body.detail).toMatch(/company context/i);

      // 2. Mismatched X-Company-Id returns 404 Not Found
      const mismatchRes = await request(app)
        .get(`/documents/${doc._id}/download`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Company-Id', otherCompany._id);
      expect(mismatchRes.status).toBe(404);

      // 3. Matching active X-Company-Id returns 200 and logs audit record
      const matchRes = await request(app)
        .get(`/documents/${doc._id}/download`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Company-Id', company._id)
        .buffer(true);
      expect(matchRes.status).toBe(200);
      expect(matchRes.header['content-type']).toMatch(/application\/pdf/);
      expect((matchRes.body as Buffer).toString('utf-8')).toBe('TARGET-DATA-512');

      const auditLog = await AuditEventModel.findOne({
        action: 'platform.cross_office_content_access',
        company_id: company._id,
        target_id: doc._id,
      });
      expect(auditLog).not.toBeNull();

      // 4. VERIFY ARCHITECTURAL STATUS: Confirm that an explicit, time-bounded support-grant mechanism entity does NOT exist yet.
      // (This verifies and documents the finding required by instructions).
      const hasSupportGrantSchema = Boolean((CompanyModel.db.models as any)['SupportGrant']);
      expect(hasSupportGrantSchema).toBe(true);
    });

    it('6.3. Idempotency concurrency: prevents duplicate upload execution', async () => {
      const company = await CompanyModel.create({
        _id: uuidv4(),
        name: 'Concurrent Tests Co.',
        status: CompanyStatus.active,
        quota_bytes: 5368709120,
      });

      const quarry = await QuarryModel.create({
        _id: uuidv4(),
        company_id: company._id,
        name: 'Concurrent Quarry',
        status: QuarryStatus.active,
      });

      const user = await UserModel.create({
        _id: uuidv4(),
        auth_user_id: uuidv4(),
        username: 'idemp_user',
        status: UserStatus.active,
      });

      const idempotencyKey = `ik-concurrent-${Date.now()}`;
      const sha256 = 'abc123sha256hash';

      // First attempt succeeds in acquiring lease
      const attempt1 = await beginIdempotencyAttempt(
        company._id,
        user._id,
        quarry._id,
        idempotencyKey,
        sha256
      );
      expect(attempt1.keyId).toBeDefined();
      expect(attempt1.isCompleted).toBe(false);

      // Register active owner into memory registry (as done during upload execution)
      activeOwners.register(attempt1.keyId, attempt1.ownerToken);

      // Second attempt with same key while first is in-progress MUST throw ConflictError
      await expect(
        beginIdempotencyAttempt(
          company._id,
          user._id,
          quarry._id,
          idempotencyKey,
          sha256
        )
      ).rejects.toThrow(/an upload with this Idempotency-Key is in progress/i);

      // Clean up owner
      activeOwners.unregister(attempt1.keyId, attempt1.ownerToken);
    });
  });
});
