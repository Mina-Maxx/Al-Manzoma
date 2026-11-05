import { v4 as uuidv4 } from 'uuid';
import {
  DocumentModel,
  UploadReconciliationModel,
} from '../database/models/index.js';
import { DocumentStatus, ChangeEntityType, ChangeType, AuditResult } from '../types/index.js';
import { completeIdempotencyKey } from './idempotency.js';
import { appendChange } from './sync.js';
import { auditService } from '../modules/audit/service.js';

const LEASE_MS = 60_000;
const MAX_BATCH_SIZE = 100;

export async function reconcileUploadSideEffects(reconciliationId: string): Promise<boolean> {
  const now = new Date();
  const leaseOwner = uuidv4();
  const claimed = await UploadReconciliationModel.findOneAndUpdate(
    {
      _id: reconciliationId,
      next_attempt_at: { $lte: now },
      $and: [
        { $or: [{ idempotency_status: 'pending' }, { sync_status: 'pending' }, { audit_status: 'pending' }] },
        { $or: [{ lease_expires_at: null }, { lease_expires_at: { $lte: now } }] },
      ],
    },
    { $set: { lease_owner: leaseOwner, lease_expires_at: new Date(now.getTime() + LEASE_MS) } },
    { new: true }
  ).lean();
  if (!claimed) return false;

  try {
    const document = await DocumentModel.findOne({ _id: claimed.document_id, status: DocumentStatus.available }).lean();
    if (!document) throw new Error('available document record is not yet present');

    if (claimed.idempotency_status === 'pending') {
      await completeIdempotencyKey(claimed.idempotency_key_id, claimed.document_id, claimed.storage_ref);
      await UploadReconciliationModel.updateOne(
        { _id: claimed._id, lease_owner: leaseOwner },
        { $set: { idempotency_status: 'complete' } }
      );
    }

    if (claimed.sync_status === 'pending') {
      await appendChange(claimed.company_id, {
        quarryId: claimed.quarry_id,
        entityType: ChangeEntityType.document,
        entityId: claimed.document_id,
        changeType: ChangeType.created,
        entityVersion: 1,
        eventKey: `upload:${claimed.document_id}:created`,
        payload: {
          display_name: claimed.display_name,
          folder_id: claimed.folder_id || null,
          mime_type: claimed.mime_type,
          size_bytes: claimed.size_bytes,
          sha256: claimed.sha256,
        },
      });
      await UploadReconciliationModel.updateOne(
        { _id: claimed._id, lease_owner: leaseOwner },
        { $set: { sync_status: 'complete' } }
      );
    }

    if (claimed.audit_status === 'pending') {
      await auditService.record({
        action: 'document.upload',
        result: AuditResult.success,
        companyId: claimed.company_id,
        actorUserId: claimed.actor_user_id,
        targetType: 'document',
        targetId: claimed.document_id,
        idempotencyKey: `upload:${claimed.document_id}:audit`,
        meta: {
          display_name: claimed.display_name,
          size_bytes: claimed.size_bytes,
          quarry_id: claimed.quarry_id,
        },
        raiseOnFailure: true,
      });
      await UploadReconciliationModel.updateOne(
        { _id: claimed._id, lease_owner: leaseOwner },
        { $set: { audit_status: 'complete' } }
      );
    }

    const current = await UploadReconciliationModel.findById(claimed._id).lean();
    const completed = Boolean(current && current.idempotency_status === 'complete' && current.sync_status === 'complete' && current.audit_status === 'complete');
    await UploadReconciliationModel.updateOne(
      { _id: claimed._id, lease_owner: leaseOwner },
      {
        $set: {
          lease_owner: null,
          lease_expires_at: null,
          last_error: null,
          ...(completed ? {} : { next_attempt_at: new Date(Date.now() + 1000) }),
        },
      }
    );
    return completed;
  } catch (error) {
    const attemptCount = claimed.attempt_count + 1;
    const retryDelayMs = Math.min(60 * 60 * 1000, 1000 * 2 ** Math.min(attemptCount, 12));
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown reconciliation error';
    await UploadReconciliationModel.updateOne(
      { _id: claimed._id, lease_owner: leaseOwner },
      {
        $set: {
          attempt_count: attemptCount,
          last_error: message.slice(0, 500),
          next_attempt_at: new Date(Date.now() + retryDelayMs),
          lease_owner: null,
          lease_expires_at: null,
        },
      }
    );
    return false;
  }
}

export async function reconcilePendingUploadSideEffects(limit = 25): Promise<{ examined: number; completed: number }> {
  const boundedLimit = Math.max(1, Math.min(limit, MAX_BATCH_SIZE));
  const dueRecords = await UploadReconciliationModel.find({
    next_attempt_at: { $lte: new Date() },
    $or: [{ idempotency_status: 'pending' }, { sync_status: 'pending' }, { audit_status: 'pending' }],
  })
    .select({ _id: 1 })
    .sort({ next_attempt_at: 1, createdAt: 1 })
    .limit(boundedLimit)
    .lean();

  let completed = 0;
  for (const record of dueRecords) {
    if (await reconcileUploadSideEffects(record._id)) completed += 1;
  }
  return { examined: dueRecords.length, completed };
}
