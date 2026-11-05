import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompanyModel,
  DocumentModel,
  UploadReconciliationModel,
} from '../src/database/models/index.js';
import { uploadDocument } from '../src/modules/documents/service.js';
import { storage } from '../src/modules/storage/index.js';
import {
  createTestCompany,
  createTestMembership,
  createTestQuarry,
  createTestUser,
} from './helpers.js';
import { AuthContext, MembershipRole } from '../src/types/index.js';

const TEST_BYTES = Buffer.from('%PDF-1.4 fault-injection fixture');

describe('pre-availability upload fault injection', () => {
  afterEach(() => vi.restoreAllMocks());

  async function createFixture(quotaBytes = 1024) {
    const company = await createTestCompany({ quota_bytes: quotaBytes });
    const user = await createTestUser();
    const membership = await createTestMembership(user._id, company._id, MembershipRole.employee);
    const quarry = await createTestQuarry(company._id);
    const context = {
      user: user.toObject(),
      company: company.toObject(),
      membership: membership.toObject(),
      claims: { sub: user.auth_user_id },
      userId: user._id,
      companyId: company._id,
      role: MembershipRole.employee,
      authUserId: user.auth_user_id,
    } as unknown as AuthContext;
    const file = {
      originalname: 'fault-injection.pdf',
      mimetype: 'application/pdf',
      buffer: TEST_BYTES,
      size: TEST_BYTES.length,
    } as Express.Multer.File;
    return { company, user, quarry, context, file };
  }

  function metadata(idempotencyKey: string) {
    return { idempotencyKey };
  }

  it('does not create a pending document or touch storage when quota reservation is rejected', async () => {
    const { company, quarry, context, file } = await createFixture(1);
    const storagePut = vi.spyOn(storage, 'put');

    await expect(
      uploadDocument(context, quarry._id, file, metadata('quota-rejected'))
    ).rejects.toThrow();

    expect(storagePut).not.toHaveBeenCalled();
    expect(await DocumentModel.countDocuments({ company_id: company._id })).toBe(0);
    expect((await CompanyModel.findById(company._id).lean())?.used_bytes).toBe(0);
  });

  it('releases the quota reservation when pending document creation fails', async () => {
    const { company, quarry, context, file } = await createFixture();
    vi.spyOn(DocumentModel, 'create').mockRejectedValueOnce(new Error('injected document insert failure'));

    await expect(
      uploadDocument(context, quarry._id, file, metadata('pending-record-failed'))
    ).rejects.toThrow('injected document insert failure');

    expect(await DocumentModel.countDocuments({ company_id: company._id })).toBe(0);
    expect((await CompanyModel.findById(company._id).lean())?.used_bytes).toBe(0);
  });

  it('deletes a partially persisted object when storage.put fails after writing', async () => {
    const { company, quarry, context, file } = await createFixture();
    const originalPut = storage.put.bind(storage);
    let attemptedKey: string | undefined;
    const storagePut = vi.spyOn(storage, 'put').mockImplementation(async (content, key, options?) => {
      attemptedKey = key;
      await originalPut(content, key, options);
      throw new Error('injected response loss after object persistence');
    });

    await expect(
      uploadDocument(context, quarry._id, file, metadata('partial-storage-write'))
    ).rejects.toThrow('injected response loss after object persistence');

    expect(storagePut).toHaveBeenCalledOnce();
    expect(attemptedKey).toBeDefined();
    expect(await storage.exists(attemptedKey!)).toBe(false);
    expect(await DocumentModel.countDocuments({ company_id: company._id })).toBe(0);
    expect((await CompanyModel.findById(company._id).lean())?.used_bytes).toBe(0);
  });

  it('cleans the pending row, quota, and object when durable reconciliation intent cannot be created', async () => {
    const { company, quarry, context, file } = await createFixture();
    const originalPut = storage.put.bind(storage);
    let uploadedKey: string | undefined;
    vi.spyOn(storage, 'put').mockImplementation(async (content, key, options?) => {
      uploadedKey = key;
      return originalPut(content, key, options);
    });
    vi.spyOn(UploadReconciliationModel, 'create').mockRejectedValueOnce(
      new Error('injected reconciliation-intent insert failure')
    );

    await expect(
      uploadDocument(context, quarry._id, file, metadata('reconciliation-intent-failed'))
    ).rejects.toThrow('injected reconciliation-intent insert failure');

    expect(uploadedKey).toBeDefined();
    expect(await storage.exists(uploadedKey!)).toBe(false);
    expect(await DocumentModel.countDocuments({ company_id: company._id })).toBe(0);
    expect((await CompanyModel.findById(company._id).lean())?.used_bytes).toBe(0);
  });

  it('preserves object and quota after an ambiguous availability-write failure', async () => {
    const { company, quarry, context, file } = await createFixture();
    const originalPut = storage.put.bind(storage);
    let uploadedKey: string | undefined;
    vi.spyOn(storage, 'put').mockImplementation(async (content, key, options?) => {
      uploadedKey = key;
      return originalPut(content, key, options);
    });
    vi.spyOn(DocumentModel, 'findByIdAndUpdate').mockReturnValueOnce({
      lean: vi.fn().mockRejectedValue(new Error('injected lost availability-write response')),
    } as any);

    await expect(
      uploadDocument(context, quarry._id, file, metadata('availability-write-ambiguous'))
    ).rejects.toThrow('injected lost availability-write response');

    const pending = await DocumentModel.findOne({ company_id: company._id, status: 'pending' }).lean();
    expect(pending).not.toBeNull();
    expect(uploadedKey).toBeDefined();
    expect(await storage.exists(uploadedKey!)).toBe(true);
    expect((await CompanyModel.findById(company._id).lean())?.used_bytes).toBe(file.size);
    const retryIntent = await UploadReconciliationModel.findOne({ document_id: pending!._id }).lean();
    expect(retryIntent?.idempotency_status).toBe('pending');
    expect(retryIntent?.sync_status).toBe('pending');
    expect(retryIntent?.audit_status).toBe('pending');
    expect(retryIntent?.last_error).toContain('stored data was preserved');
  });
});
