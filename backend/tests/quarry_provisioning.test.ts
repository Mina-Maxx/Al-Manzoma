import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  AuditEventModel,
  FolderModel,
  MembershipModel,
  QuarryModel,
} from '../src/database/models/index.js';
import { auditService } from '../src/modules/audit/service.js';
import { AuditResult, MembershipRole, STANDARD_FOLDERS } from '../src/types/index.js';
import {
  createTestCompany,
  createTestMembership,
  createTestUser,
  generateAuthHeader,
} from './helpers.js';

const app = createApp();

describe('Atomic quarry provisioning', () => {
  it('allows a same-company employee with can_upload and returns membership-resolved permissions', async () => {
    const company = await createTestCompany();
    const employee = await createTestUser({ username: 'provision_uploader' });
    const membership = await createTestMembership(employee._id, company._id, MembershipRole.employee);
    membership.can_view = true;
    membership.can_upload = true;
    membership.can_download = false;
    membership.can_delete = false;
    await membership.save();

    const response = await request(app)
      .post('/quarries')
      .set(generateAuthHeader(employee))
      .send({ name: 'Employee Provisioned Quarry', quarry_number: 'EMP-P1', quarry_type: 'granite' });

    expect(response.status).toBe(201);
    expect(response.body.permissions).toEqual({
      can_view: true,
      can_upload: true,
      can_download: false,
      can_delete: false,
    });
    const quarry = await QuarryModel.findById(response.body.id).lean();
    expect(quarry?.company_id).toBe(company._id);
    expect(await FolderModel.countDocuments({ quarry_id: response.body.id, company_id: company._id })).toBe(STANDARD_FOLDERS.length);
    expect(await AuditEventModel.countDocuments({ action: 'quarry.create', target_id: response.body.id, result: AuditResult.success })).toBe(1);
  });

  it('uses the same provisioning service for the Company Admin route', async () => {
    const company = await createTestCompany();
    const admin = await createTestUser({ username: 'provision_company_admin' });
    await createTestMembership(admin._id, company._id, MembershipRole.company_admin);

    const response = await request(app)
      .post('/company/quarries')
      .set(generateAuthHeader(admin))
      .send({ name: 'Dashboard Provisioned Quarry' });

    expect(response.status).toBe(201);
    expect(response.body.permissions).toEqual({ can_view: true, can_upload: true, can_download: true, can_delete: true });
    expect(await FolderModel.countDocuments({ quarry_id: response.body.id, company_id: company._id })).toBe(STANDARD_FOLDERS.length);
    expect(await AuditEventModel.countDocuments({ action: 'quarry.create', target_id: response.body.id, result: AuditResult.success })).toBe(1);
  });

  it('honors the selected company membership and refuses a selected company without membership', async () => {
    const companyA = await createTestCompany();
    const companyB = await createTestCompany();
    const multiCompanyEmployee = await createTestUser({ username: 'provision_multi_company' });
    const membershipA = await createTestMembership(multiCompanyEmployee._id, companyA._id, MembershipRole.employee);
    membershipA.can_upload = false;
    await membershipA.save();
    const membershipB = await createTestMembership(multiCompanyEmployee._id, companyB._id, MembershipRole.employee);
    membershipB.can_upload = true;
    await membershipB.save();

    const selected = await request(app)
      .post('/quarries')
      .set(generateAuthHeader(multiCompanyEmployee))
      .set('X-Company-Id', companyB._id)
      .send({ name: 'Selected Membership Quarry', quarry_number: 'SELECTED-B', quarry_type: 'granite' });
    expect(selected.status).toBe(201);
    expect((await QuarryModel.findById(selected.body.id).lean())?.company_id).toBe(companyB._id);

    const unrelatedEmployee = await createTestUser({ username: 'provision_unrelated_company' });
    const unrelatedMembership = await createTestMembership(unrelatedEmployee._id, companyA._id, MembershipRole.employee);
    unrelatedMembership.can_upload = true;
    await unrelatedMembership.save();
    const companyBCount = await QuarryModel.countDocuments({ company_id: companyB._id });
    const denied = await request(app)
      .post('/quarries')
      .set(generateAuthHeader(unrelatedEmployee))
      .set('X-Company-Id', companyB._id)
      .send({ name: 'Must Not Cross Company', quarry_number: 'CROSS-B', quarry_type: 'granite' });
    expect(denied.status).toBe(403);
    expect(await QuarryModel.countDocuments({ company_id: companyB._id })).toBe(companyBCount);
  });

  it('rejects an employee without can_upload before creating quarry, folders, or membership records', async () => {
    const company = await createTestCompany();
    const employee = await createTestUser({ username: 'provision_denied' });
    const membership = await createTestMembership(employee._id, company._id, MembershipRole.employee);
    membership.can_upload = false;
    await membership.save();
    const quarryCount = await QuarryModel.countDocuments({ company_id: company._id });
    const folderCount = await FolderModel.countDocuments({ company_id: company._id });
    const membershipCount = await MembershipModel.countDocuments({ company_id: company._id });

    const response = await request(app)
      .post('/quarries')
      .set(generateAuthHeader(employee))
      .send({ name: 'Must Not Exist', quarry_number: 'DENIED-P1', quarry_type: 'granite' });

    expect(response.status).toBe(403);
    expect(await QuarryModel.countDocuments({ company_id: company._id })).toBe(quarryCount);
    expect(await FolderModel.countDocuments({ company_id: company._id })).toBe(folderCount);
    expect(await MembershipModel.countDocuments({ company_id: company._id })).toBe(membershipCount);
  });

  it('rolls back the quarry when standard folder creation fails', async () => {
    const company = await createTestCompany();
    const employee = await createTestUser({ username: 'provision_folder_failure' });
    const membership = await createTestMembership(employee._id, company._id, MembershipRole.employee);
    membership.can_upload = true;
    await membership.save();
    const quarryCount = await QuarryModel.countDocuments({ company_id: company._id });
    const folderCount = await FolderModel.countDocuments({ company_id: company._id });
    const folderInsert = vi.spyOn(FolderModel, 'insertMany').mockRejectedValueOnce(new Error('injected folder insert failure'));

    try {
      const response = await request(app)
        .post('/quarries')
        .set(generateAuthHeader(employee))
        .send({ name: 'Atomic Folder Failure', quarry_number: 'FOLDER-FAIL', quarry_type: 'granite' });

      expect(response.status).toBe(500);
      expect(await QuarryModel.countDocuments({ company_id: company._id })).toBe(quarryCount);
      expect(await FolderModel.countDocuments({ company_id: company._id })).toBe(folderCount);
      expect(await AuditEventModel.countDocuments({ action: 'quarry.create', company_id: company._id, result: AuditResult.success })).toBe(0);
    } finally {
      folderInsert.mockRestore();
    }
  });

  it('rolls back quarry and folders when success-audit persistence fails', async () => {
    const company = await createTestCompany();
    const admin = await createTestUser({ username: 'provision_audit_failure' });
    await createTestMembership(admin._id, company._id, MembershipRole.company_admin);
    const quarryCount = await QuarryModel.countDocuments({ company_id: company._id });
    const folderCount = await FolderModel.countDocuments({ company_id: company._id });
    const originalRecord = auditService.record.bind(auditService);
    const auditSpy = vi.spyOn(auditService, 'record').mockImplementation(async (options) => {
      if (options.action === 'quarry.create' && options.result === AuditResult.success) {
        throw new Error('injected success-audit failure');
      }
      await originalRecord(options);
    });

    try {
      const response = await request(app)
        .post('/company/quarries')
        .set(generateAuthHeader(admin))
        .send({ name: 'Atomic Audit Failure' });

      expect(response.status).toBe(500);
      expect(await QuarryModel.countDocuments({ company_id: company._id })).toBe(quarryCount);
      expect(await FolderModel.countDocuments({ company_id: company._id })).toBe(folderCount);
      expect(await AuditEventModel.countDocuments({ action: 'quarry.create', company_id: company._id, result: AuditResult.success })).toBe(0);
      expect(auditSpy).toHaveBeenCalled();
    } finally {
      auditSpy.mockRestore();
    }
  });
});
