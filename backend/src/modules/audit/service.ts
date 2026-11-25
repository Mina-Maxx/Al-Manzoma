import { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { AuditEventModel } from '../../database/models/index.js';
import { AuditResult } from '../../types/index.js';

export interface AuditRecordOptions {
  action: string;
  result: AuditResult;
  companyId?: string | null;
  actorUserId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  meta?: Record<string, any> | null;
  idempotencyKey?: string;
  request?: Request;
  raiseOnFailure?: boolean;
  session?: ClientSession;
}

export class AuditService {
  /**
   * Sanitizes metadata to guarantee that secrets, tokens, and passwords are never recorded.
   */
  private sanitizeMeta(meta?: Record<string, any> | null): Record<string, any> | null {
    if (!meta) return null;
    const sanitized: Record<string, any> = {};
    const sensitiveKeys = new Set([
      'password',
      'current_password',
      'new_password',
      'confirm_password',
      'temporary_password',
      'access_token',
      'refresh_token',
      'token',
      'secret',
      'authorization',
      'apikey',
      'service_role_key',
    ]);

    for (const [key, value] of Object.entries(meta)) {
      if (sensitiveKeys.has(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeMeta(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  async record(opts: AuditRecordOptions): Promise<void> {
    try {
      if (opts.idempotencyKey) {
        const existingQuery = AuditEventModel.findOne({ idempotency_key: opts.idempotencyKey }).select({ _id: 1 });
        if (opts.session) existingQuery.session(opts.session);
        const existing = await existingQuery.lean();
        if (existing) return;
      }
      let ip: string | undefined = undefined;
      let userAgent: string | undefined = undefined;

      if (opts.request) {
        // req.ip honours the configured `trust proxy` hop count; the raw X-Forwarded-For header is client-controlled.
        ip = opts.request.ip || opts.request.socket?.remoteAddress;
        userAgent = opts.request.headers['user-agent'];
      }

      const safeMeta = this.sanitizeMeta(opts.meta);

      const auditRecord = {
        action: opts.action,
        result: opts.result,
        company_id: opts.companyId || null,
        actor_user_id: opts.actorUserId || null,
        target_type: opts.targetType || null,
        target_id: opts.targetId ? String(opts.targetId) : null,
        ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {}),
        ip: ip || null,
        user_agent: userAgent || null,
        meta: safeMeta,
        created_at: new Date(),
      };
      if (opts.session) {
        await AuditEventModel.create([auditRecord], { session: opts.session });
      } else {
        await AuditEventModel.create(auditRecord);
      }
    } catch (err) {
      if (opts.idempotencyKey && (err as any)?.code === 11000) return;
      console.error('[AuditService] Failed to persist audit record:', err);
      if (opts.raiseOnFailure) {
        throw err;
      }
    }
  }
}

export const auditService = new AuditService();
