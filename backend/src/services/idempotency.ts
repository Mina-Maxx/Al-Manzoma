import { v4 as uuidv4 } from 'uuid';
import { IdempotencyKeyModel } from '../database/models/index.js';
import { IdempotencyStatus } from '../types/index.js';
import { ConflictError } from '../middleware/errors.js';
import { config } from '../config/index.js';

class ActiveOwnerRegistry {
  private owners: Map<string, string> = new Map();

  register(keyId: string, ownerToken: string): void {
    this.owners.set(keyId, ownerToken);
  }

  unregister(keyId: string, ownerToken: string): void {
    if (this.owners.get(keyId) === ownerToken) {
      this.owners.delete(keyId);
    }
  }

  isActive(keyId: string): boolean {
    return this.owners.has(keyId);
  }
}

export const activeOwners = new ActiveOwnerRegistry();

export interface ClaimAttemptResult {
  keyId: string;
  ownerToken: string;
  documentId?: string | null;
  storageRef?: string | null;
  isCompleted: boolean;
}

export async function beginIdempotencyAttempt(
  companyId: string,
  userId: string,
  quarryId: string,
  key: string,
  contentSha256: string
): Promise<ClaimAttemptResult> {
  const existing = await IdempotencyKeyModel.findOne({
    company_id: companyId,
    user_id: userId,
    key: key,
  });

  const ownerToken = uuidv4();
  const leaseExpiresAt = new Date(Date.now() + config.idempotencyLeaseSeconds * 1000);

  if (existing) {
    // Check request identity
    if (existing.quarry_id !== quarryId || existing.content_sha256 !== contentSha256) {
      throw new ConflictError('Idempotency-Key was already used with a different request');
    }

    if (existing.status === IdempotencyStatus.completed && existing.document_id) {
      return {
        keyId: existing._id,
        ownerToken: existing.owner_token || ownerToken,
        documentId: existing.document_id,
        storageRef: existing.storage_ref,
        isCompleted: true,
      };
    }

    // Check if another worker/attempt is actively running
    if (activeOwners.isActive(existing._id)) {
      throw new ConflictError('an upload with this Idempotency-Key is in progress');
    }

    const isExpired = existing.lease_expires_at ? existing.lease_expires_at < new Date() : false;
    const isFailed = Boolean(existing.failed_at);

    if (!isExpired && !isFailed) {
      throw new ConflictError('an upload with this Idempotency-Key is in progress');
    }

    // Takeover attempt - atomic conditional update
    const updated = await IdempotencyKeyModel.findOneAndUpdate(
      {
        _id: existing._id,
        owner_token: existing.owner_token,
        status: { $ne: IdempotencyStatus.completed },
        $or: [
          { lease_expires_at: { $lt: new Date() } },
          { failed_at: { $ne: null } },
        ],
      },
      {
        $set: {
          owner_token: ownerToken,
          lease_expires_at: leaseExpiresAt,
          failed_at: null,
          status: IdempotencyStatus.in_progress,
        },
      },
      { new: true }
    );

    if (!updated) {
      throw new ConflictError('an upload with this Idempotency-Key is in progress');
    }

    return {
      keyId: updated._id,
      ownerToken: ownerToken,
      documentId: updated.document_id,
      storageRef: updated.storage_ref,
      isCompleted: false,
    };
  }

  // Create new key
  try {
    const created = await IdempotencyKeyModel.create({
      company_id: companyId,
      user_id: userId,
      quarry_id: quarryId,
      key,
      content_sha256: contentSha256,
      status: IdempotencyStatus.in_progress,
      owner_token: ownerToken,
      lease_expires_at: leaseExpiresAt,
    });

    return {
      keyId: created._id,
      ownerToken: ownerToken,
      isCompleted: false,
    };
  } catch (err: any) {
    if (err.code === 11000) {
      // Concurrent insert race
      return beginIdempotencyAttempt(companyId, userId, quarryId, key, contentSha256);
    }
    throw err;
  }
}

export async function completeIdempotencyKey(
  keyId: string,
  documentId: string,
  storageRef: string
): Promise<void> {
  await IdempotencyKeyModel.findByIdAndUpdate(keyId, {
    status: IdempotencyStatus.completed,
    document_id: documentId,
    storage_ref: storageRef,
    failed_at: null,
    lease_expires_at: null,
  });
}

export async function failIdempotencyKey(keyId: string): Promise<void> {
  await IdempotencyKeyModel.findByIdAndUpdate(keyId, {
    failed_at: new Date(),
    lease_expires_at: null,
  });
}
