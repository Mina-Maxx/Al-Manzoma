import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { backupService, formatBackupRecord, formatRestoreRecord } from './service.js';
import { applyRetentionPolicy } from './retention.js';
import {
  PlatformBackupModel,
  PlatformRestoreModel,
  PlatformBackupConfigModel,
  AuditEventModel,
} from '../../database/models/index.js';
import { authenticatePlatformAdmin } from '../../middleware/auth.js';
import { NotFoundError, DomainError } from '../../middleware/errors.js';
import { auditService } from '../audit/service.js';
import { pipeToResponse } from '../../utils/pipeResponse.js';
import { AuditResult } from '../../types/index.js';

export const backupRouter = Router();

// Strictly enforce platform admin authorization across all backup endpoints
backupRouter.use(authenticatePlatformAdmin);

/**
 * GET /platform/backups/overview
 * Returns disaster recovery KPIs, RPO/RTO metrics, and schedule info.
 */
backupRouter.get('/overview', async (_req: Request, res: Response, next) => {
  try {
    const overview = await backupService.getOverview();
    res.json(overview);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /platform/backups
 * Lists all platform backups with metadata.
 */
backupRouter.get('/', async (_req: Request, res: Response, next) => {
  try {
    const backups = await PlatformBackupModel.find().sort({ createdAt: -1 }).lean();
    res.json(backups.map(formatBackupRecord));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/backups
 * Triggers creation of a full platform backup.
 */
backupRouter.post('/', async (req: Request, res: Response, next) => {
  try {
    const ctx = (req as any).platformAdminContext || (req as any).authContext;
    const actorId = ctx?.adminId || ctx?.userId || 'unknown-admin';
    const actorEmail = ctx?.claims?.email || 'admin@quarryvault';

    const backup = await backupService.createBackup({
      type: req.body?.type || 'full',
      notes: req.body?.notes,
      isLocked: req.body?.is_locked,
      createdBy: actorId,
      createdByEmail: actorEmail,
    });

    res.status(201).json(formatBackupRecord(backup));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /platform/backups/schedule
 * Returns the current automated schedule and retention configuration.
 */
backupRouter.get('/schedule', async (_req: Request, res: Response, next) => {
  try {
    let cfg = await PlatformBackupConfigModel.findById('platform-backup-global-config').lean();
    if (!cfg) {
      cfg = (await PlatformBackupConfigModel.create({ _id: 'platform-backup-global-config' })).toObject();
    }
    res.json(cfg);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /platform/backups/schedule
 * Updates the automated schedule and retention configuration.
 */
backupRouter.patch('/schedule', async (req: Request, res: Response, next) => {
  try {
    const ctx = (req as any).platformAdminContext || (req as any).authContext;
    const actorEmail = ctx?.claims?.email || 'admin@quarryvault';

    let cfg = await PlatformBackupConfigModel.findById('platform-backup-global-config');
    if (!cfg) {
      cfg = new PlatformBackupConfigModel({ _id: 'platform-backup-global-config' });
    }

    if (req.body.is_scheduled_enabled !== undefined) {
      cfg.is_scheduled_enabled = Boolean(req.body.is_scheduled_enabled);
    }
    if (req.body.schedule_interval_hours !== undefined) {
      const hours = parseInt(req.body.schedule_interval_hours, 10);
      if (hours < 1 || hours > 168) {
        throw new DomainError('Schedule interval must be between 1 and 168 hours', 400);
      }
      cfg.schedule_interval_hours = hours;
    }
    if (req.body.retention_daily !== undefined) {
      cfg.retention_daily = Math.max(1, parseInt(req.body.retention_daily, 10));
    }
    if (req.body.retention_weekly !== undefined) {
      cfg.retention_weekly = Math.max(1, parseInt(req.body.retention_weekly, 10));
    }
    if (req.body.retention_monthly !== undefined) {
      cfg.retention_monthly = Math.max(1, parseInt(req.body.retention_monthly, 10));
    }
    if (req.body.encryption_enabled !== undefined) {
      cfg.encryption_enabled = Boolean(req.body.encryption_enabled);
    }

    cfg.updated_by = actorEmail;
    await cfg.save();

    res.json(cfg);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/backups/retention/prune
 * Triggers retention policy evaluation and safe pruning.
 */
backupRouter.post('/retention/prune', async (_req: Request, res: Response, next) => {
  try {
    let cfg = await PlatformBackupConfigModel.findById('platform-backup-global-config');
    const result = await applyRetentionPolicy({
      dailyRetention: cfg?.retention_daily || 7,
      weeklyRetention: cfg?.retention_weekly || 4,
      monthlyRetention: cfg?.retention_monthly || 3,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /platform/backups/audits
 * Retrieves recent backup and restore audit events.
 */
backupRouter.get('/audits', async (_req: Request, res: Response, next) => {
  try {
    const audits = await AuditEventModel.find({
      action: { $in: ['backup.create', 'backup.verify', 'backup.download', 'backup.delete', 'backup.retention_prune', 'restore.execute'] },
    })
      .sort({ created_at: -1 })
      .limit(50)
      .lean();

    res.json(audits);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /platform/backups/restores/history
 * Retrieves disaster recovery platform restore history.
 */
backupRouter.get('/restores/history', async (_req: Request, res: Response, next) => {
  try {
    const restores = await PlatformRestoreModel.find().sort({ started_at: -1 }).limit(50).lean();
    res.json(restores.map(formatRestoreRecord));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /platform/backups/:id
 * Retrieves details and manifest for a specific backup.
 */
backupRouter.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const backupId = req.params.id;
    const backup = await PlatformBackupModel.findOne({
      $or: [{ _id: backupId }, { backup_id: backupId }],
    }).lean();

    if (!backup) {
      throw new NotFoundError('Backup not found');
    }

    res.json(formatBackupRecord(backup));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /platform/backups/:id/download
 * Secure authenticated download of the backup archive file.
 */
backupRouter.get('/:id/download', async (req: Request, res: Response, next) => {
  try {
    const backupId = req.params.id;
    const ctx = (req as any).platformAdminContext || (req as any).authContext;
    const actorId = ctx?.adminId || ctx?.userId || 'unknown-admin';

    const backup = await PlatformBackupModel.findOne({
      $or: [{ _id: backupId }, { backup_id: backupId }],
    });

    if (!backup) {
      throw new NotFoundError('Backup not found');
    }

    if (!backup.archive_path || !fs.existsSync(backup.archive_path)) {
      throw new NotFoundError('Backup archive file not found on disk');
    }

    const stat = await fs.promises.stat(backup.archive_path);
    const filename = backup.archive_filename || path.basename(backup.archive_path);

    await auditService.record({
      action: 'backup.download',
      result: AuditResult.success,
      targetType: 'platform_backup',
      targetId: backup._id,
      meta: {
        backup_id: backup.backup_id,
        filename,
        size_bytes: stat.size,
        actor_user_id: actorId,
      },
      request: req,
    });

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'private, no-cache, no-store');

    const fileStream = fs.createReadStream(backup.archive_path);
    pipeToResponse(fileStream, res, next);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/backups/:id/verify
 * Runs an integrity verification on the backup archive.
 */
backupRouter.post('/:id/verify', async (req: Request, res: Response, next) => {
  try {
    const backupId = req.params.id;
    const backup = await PlatformBackupModel.findOne({
      $or: [{ _id: backupId }, { backup_id: backupId }],
    });

    if (!backup) {
      throw new NotFoundError('Backup not found');
    }

    const result = await backupService.verifyBackupArchive(backup._id);
    const updated = await PlatformBackupModel.findById(backup._id);
    res.json({
      status: updated?.status || (result.verified ? 'verified' : 'failed'),
      verification: result,
      message: result.message,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/backups/:id/restore
 * Initiates restore from a verified backup with explicit safety checks.
 */
backupRouter.post('/:id/restore', async (req: Request, res: Response, next) => {
  try {
    const backupId = req.params.id;
    const ctx = (req as any).platformAdminContext || (req as any).authContext;
    const actorId = ctx?.adminId || ctx?.userId || 'unknown-admin';
    const actorEmail = ctx?.claims?.email || 'admin@quarryvault';

    const backup = await PlatformBackupModel.findOne({
      $or: [{ _id: backupId }, { backup_id: backupId }],
    });

    if (!backup) {
      throw new NotFoundError('Backup not found');
    }

    const confirmationPhrase = String(req.body.confirmationPhrase || req.body.confirmation_phrase || '');
    const confirm = req.body.confirm !== undefined ? Boolean(req.body.confirm) : (confirmationPhrase === 'RESTORE-QUARRYVAULT');

    const restore = await backupService.restoreBackup(backup._id, {
      confirm,
      confirmationPhrase,
      createSafetyBackup: req.body.createSafetyBackup !== false,
      actorUserId: actorId,
      actorEmail: actorEmail,
    });

    res.status(200).json(formatRestoreRecord(restore));
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /platform/backups/:id
 * Deletes a backup archive while enforcing safety rules.
 */
backupRouter.delete('/:id', async (req: Request, res: Response, next) => {
  try {
    const backupId = req.params.id;
    const ctx = (req as any).platformAdminContext || (req as any).authContext;
    const actorId = ctx?.adminId || ctx?.userId || 'unknown-admin';
    const actorEmail = ctx?.claims?.email || 'admin@quarryvault';

    const backup = await PlatformBackupModel.findOne({
      $or: [{ _id: backupId }, { backup_id: backupId }],
    });

    if (!backup) {
      throw new NotFoundError('Backup not found');
    }

    await backupService.deleteBackup(backup._id, {
      actorUserId: actorId,
      actorEmail: actorEmail,
    });

    res.json({ success: true, message: `Backup ${backup.backup_id} deleted successfully.` });
  } catch (err) {
    next(err);
  }
});
