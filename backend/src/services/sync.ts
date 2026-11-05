import crypto from 'crypto';
import { CompanySyncStateModel, ChangeLogModel } from '../database/models/index.js';
import { ChangeEntityType, ChangeType } from '../types/index.js';
import { config } from '../config/index.js';

export interface CursorPayload {
  v: number;
  company_id: string;
  feed_epoch: string;
  seq: number;
}

export function encodeCursor(payload: CursorPayload): string {
  const secret = config.syncCursorSecret;
  const jsonStr = JSON.stringify(payload);
  const dataB64 = Buffer.from(jsonStr).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(dataB64).digest('base64url');
  return `v1.${dataB64}.${signature}`;
}

export function decodeCursor(cursor: string, expectedCompanyId: string): CursorPayload {
  const parts = cursor.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('invalid_cursor');
  }

  const [, dataB64, signature] = parts;
  const secret = config.syncCursorSecret;
  const expectedSig = crypto.createHmac('sha256', secret).update(dataB64).digest('base64url');

  if (signature !== expectedSig) {
    throw new Error('invalid_cursor');
  }

  try {
    const payload: CursorPayload = JSON.parse(Buffer.from(dataB64, 'base64url').toString('utf8'));
    if (payload.company_id !== expectedCompanyId) {
      throw new Error('invalid_cursor');
    }
    return payload;
  } catch {
    throw new Error('invalid_cursor');
  }
}

/**
 * Appends a change event to the company's change feed, incrementing the sequence counter.
 */
export async function appendChange(
  companyId: string,
  entry: {
    quarryId: string;
    entityType: ChangeEntityType;
    entityId: string;
    changeType: ChangeType;
    entityVersion: number;
    payload?: Record<string, any>;
    eventKey?: string;
  }
): Promise<number> {
  if (entry.eventKey) {
    const existing = await ChangeLogModel.findOne({ company_id: companyId, event_key: entry.eventKey }).select({ seq: 1 }).lean();
    if (existing) return existing.seq;
  }

  const syncState = await CompanySyncStateModel.findOneAndUpdate(
    { company_id: companyId },
    { $inc: { last_seq: 1 }, $set: { updated_at: new Date() } },
    { new: true, upsert: true }
  );

  const seq = syncState.last_seq;

  try {
    await ChangeLogModel.create({
      company_id: companyId,
      seq,
      quarry_id: entry.quarryId,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      change_type: entry.changeType,
      entity_version: entry.entityVersion,
      ...(entry.eventKey ? { event_key: entry.eventKey } : {}),
      payload: entry.payload || {},
      created_at: new Date(),
    });
  } catch (error) {
    if (entry.eventKey && (error as any)?.code === 11000) {
      const existing = await ChangeLogModel.findOne({ company_id: companyId, event_key: entry.eventKey }).select({ seq: 1 }).lean();
      if (existing) return existing.seq;
    }
    throw error;
  }

  return seq;
}

/**
 * Retrieves sync changes for a company, filtered by the caller's authorized quarries.
 */
export async function getSyncChanges(
  companyId: string,
  cursorStr: string | null | undefined,
  limit: number = 100,
  allowedQuarryIds: string[]
) {
  let syncState = await CompanySyncStateModel.findOne({ company_id: companyId });
  if (!syncState) {
    syncState = await CompanySyncStateModel.create({
      company_id: companyId,
      last_seq: 0,
      min_valid_seq: 0,
    });
  }

  const highWater = syncState.last_seq;
  const boundedLimit = Math.max(1, Math.min(limit, 500));

  // Bootstrap mode: No cursor provided
  if (!cursorStr) {
    const nextCursor = encodeCursor({
      v: 1,
      company_id: companyId,
      feed_epoch: syncState.feed_epoch,
      seq: highWater,
    });

    return {
      changes: [],
      next_cursor: nextCursor,
      high_water: highWater,
      has_more: false,
      resync_required: true,
      bootstrap_required: true,
    };
  }

  // Parse and validate cursor
  const cursor = decodeCursor(cursorStr, companyId);
  if (cursor.feed_epoch !== syncState.feed_epoch || cursor.seq < syncState.min_valid_seq) {
    return {
      changes: [],
      next_cursor: encodeCursor({
        v: 1,
        company_id: companyId,
        feed_epoch: syncState.feed_epoch,
        seq: highWater,
      }),
      high_water: highWater,
      has_more: false,
      resync_required: true,
      bootstrap_required: false,
    };
  }

  const fromSeq = cursor.seq;
  const rawChanges = await ChangeLogModel.find({
    company_id: companyId,
    seq: { $gt: fromSeq, $lte: highWater },
  })
    .sort({ seq: 1 })
    .limit(boundedLimit)
    .lean();

  const allowedSet = new Set(allowedQuarryIds);
  const visibleChanges = rawChanges
    .filter((c) => allowedSet.has(c.quarry_id))
    .map((c) => ({
      seq: c.seq,
      entity_type: c.entity_type,
      entity_id: c.entity_id,
      quarry_id: c.quarry_id,
      change_type: c.change_type,
      entity_version: c.entity_version,
      changed_at: c.created_at,
      payload: c.payload,
    }));

  const lastProcessedSeq = rawChanges.length < boundedLimit
    ? highWater
    : rawChanges[rawChanges.length - 1].seq;
  const hasMore = lastProcessedSeq < highWater;

  const nextCursor = encodeCursor({
    v: 1,
    company_id: companyId,
    feed_epoch: syncState.feed_epoch,
    seq: lastProcessedSeq,
  });

  return {
    changes: visibleChanges,
    next_cursor: nextCursor,
    high_water: highWater,
    has_more: hasMore,
    resync_required: false,
    bootstrap_required: false,
  };
}
