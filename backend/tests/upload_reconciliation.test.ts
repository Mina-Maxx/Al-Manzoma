import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuditEventModel,
  ChangeLogModel,
  CompanyModel,
  DocumentModel,
  IdempotencyKeyModel,
  UploadReconciliationModel,
} from '../src/database/models/index.js';
import { auditService } from '../src/modules/audit/service.js';
import { reconcileUploadSideEffects } from '../src/services/uploadReconciliation.js';
import { createTestCompany, createTestQuarry, createTestUser } from './helpers.js';
import { DocumentStatus, IdempotencyStatus } from '../src/types/index.js';

describe('durable upload side-effect reconciliation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('preserves available document/quota after audit failure and retries without duplicate sync events', async () => {
    const company = await createTestCompany();
    const quarry = await createTestQuarry(company._id);
    const actor = await createTestUser();
    const sizeBytes = 321;
    await CompanyModel.updateOne({ _id: company._id }, { $set: { used_bytes: sizeBytes } });

    const document = await DocumentModel.create({
      company_id: company._id,
      quarry_id: quarry._id,
      display_name: 'reconcile.pdf',
      original_filename: 'reconcile.pdf',
      mime_type: 'application/pdf',
      size_bytes: sizeBytes,
      sha256: 'a'.repeat(64),
      storage_ref: `test/${company._id}/${quarry._id}/reconcile.pdf`,
      status: DocumentStatus.available,
      uploaded_by: actor._id,
      version: 1,
    });
    const idempotencyKey = await IdempotencyKeyModel.create({
      company_id: company._id,
      user_id: actor._id,
      quarry_id: quarry._id,
      key: `reconcile-${document._id}`,
      content_sha256: document.sha256,
      status: IdempotencyStatus.in_progress,
      owner_token: 'test-owner',
      lease_expires_at: new Date(Date.now() + 60_000),
    });
    const reconciliation = await UploadReconciliationModel.create({
      document_id: document._id,
      company_id: company._id,
      quarry_id: quarry._id,
      actor_user_id: actor._id,
      idempotency_key_id: idempotencyKey._id,
      storage_ref: document.storage_ref,
      display_name: document.display_name,
      folder_id: null,
      mime_type: document.mime_type,
      size_bytes: document.size_bytes,
      sha256: document.sha256,
      idempotency_status: 'pending',
      sync_status: 'pending',
      audit_status: 'pending',
      attempt_count: 0,
      next_attempt_at: new Date(0),
    });

    const auditFailure = vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('audit store unavailable'));
    const firstAttempt = await reconcileUploadSideEffects(reconciliation._id);
    expect(firstAttempt).toBe(false);
    expect(auditFailure).toHaveBeenCalledOnce();

    const stillAvailable = await DocumentModel.findById(document._id).lean();
    expect(stillAvailable?.status).toBe(DocumentStatus.available);
    expect((await CompanyModel.findById(company._id).lean())?.used_bytes).toBe(sizeBytes);
    expect(await ChangeLogModel.countDocuments({ company_id: company._id, event_key: `upload:${document._id}:created` })).toBe(1);
    expect((await UploadReconciliationModel.findById(reconciliation._id).lean())?.audit_status).toBe('pending');

    auditFailure.mockRestore();
    await UploadReconciliationModel.updateOne({ _id: reconciliation._id }, { $set: { next_attempt_at: new Date(0) } });
    const secondAttempt = await reconcileUploadSideEffects(reconciliation._id);
    expect(secondAttempt).toBe(true);

    expect(await ChangeLogModel.countDocuments({ company_id: company._id, event_key: `upload:${document._id}:created` })).toBe(1);
    expect(await AuditEventModel.countDocuments({ idempotency_key: `upload:${document._id}:audit` })).toBe(1);
    expect((await UploadReconciliationModel.findById(reconciliation._id).lean())?.audit_status).toBe('complete');
    expect((await IdempotencyKeyModel.findById(idempotencyKey._id).lean())?.status).toBe(IdempotencyStatus.completed);
    expect((await DocumentModel.findById(document._id).lean())?.status).toBe(DocumentStatus.available);
  });
});
