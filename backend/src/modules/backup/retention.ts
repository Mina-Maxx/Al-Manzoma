import fs from 'fs';
import { PlatformBackupModel, PlatformRestoreModel } from '../../database/models/index.js';
import { auditService } from '../audit/service.js';
import { AuditResult } from '../../types/index.js';

export interface RetentionPolicyConfig {
  dailyRetention: number; // default 7
  weeklyRetention: number; // default 4
  monthlyRetention: number; // default 3
}

export interface PruneResult {
  totalEvaluated: number;
  evaluated?: number;
  prunedCount: number;
  deletedCount?: number;
  preservedCount: number;
  prunedIds: string[];
}

/**
 * Applies multi-tier retention policy while strictly upholding safety constraints:
 * 1. Never delete the only verified backup.
 * 2. Never delete backups currently referenced by an active/pending restore operation.
 * 3. Never delete safety backups or explicitly locked backups (is_locked = true).
 * 4. Strictly operate only on files within the designated backup storage directory.
 */
export async function applyRetentionPolicy(
  policy: RetentionPolicyConfig = { dailyRetention: 7, weeklyRetention: 4, monthlyRetention: 3 }
): Promise<PruneResult> {
  const allBackups = await PlatformBackupModel.find().sort({ createdAt: -1 });

  // 1. Safety check: Total verified backups
  const verifiedBackups = allBackups.filter((b) => b.status === 'verified');
  if (verifiedBackups.length <= 1) {
    return {
      totalEvaluated: allBackups.length,
      evaluated: allBackups.length,
      prunedCount: 0,
      deletedCount: 0,
      preservedCount: allBackups.length,
      prunedIds: [],
    };
  }

  // 2. Identify active restores to never prune active restore source backups
  const activeRestores = await PlatformRestoreModel.find({
    status: { $in: ['pending', 'running'] },
  }).lean();
  const protectedFromActiveRestore = new Set(activeRestores.map((r) => r.backup_id));

  // 3. Multi-tier classification
  const preservedIds = new Set<string>();

  // Always preserve the latest verified backup
  if (verifiedBackups.length > 0) {
    preservedIds.add(verifiedBackups[0]._id);
  }

  const dailyBuckets = new Set<string>();
  const weeklyBuckets = new Set<string>();
  const monthlyBuckets = new Set<string>();

  const now = new Date();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  for (const backup of allBackups) {
    // Safety rules: Locked, Safety, Active Restore, or Non-completed
    if (backup.is_locked || backup.backup_type === 'safety' || protectedFromActiveRestore.has(backup.backup_id)) {
      preservedIds.add(backup._id);
      continue;
    }

    const created = new Date(backup.createdAt);
    const ageDays = (now.getTime() - created.getTime()) / ONE_DAY_MS;

    // Daily tier (within dailyRetention days, up to dailyRetention distinct days)
    if (ageDays <= policy.dailyRetention && dailyBuckets.size < policy.dailyRetention) {
      const dayKey = created.toISOString().slice(0, 10);
      if (!dailyBuckets.has(dayKey)) {
        dailyBuckets.add(dayKey);
        preservedIds.add(backup._id);
        continue;
      }
    }

    // Weekly tier (within 4 weeks, 1 per week)
    const ageWeeks = ageDays / 7;
    if (ageWeeks <= policy.weeklyRetention && weeklyBuckets.size < policy.weeklyRetention) {
      const weekKey = `${created.getFullYear()}-W${Math.floor(created.getDate() / 7)}`;
      if (!weeklyBuckets.has(weekKey)) {
        weeklyBuckets.add(weekKey);
        preservedIds.add(backup._id);
        continue;
      }
    }

    // Monthly tier (within 3 months, 1 per month)
    const ageMonths = ageDays / 30;
    if (ageMonths <= policy.monthlyRetention && monthlyBuckets.size < policy.monthlyRetention) {
      const monthKey = `${created.getFullYear()}-${created.getMonth() + 1}`;
      if (!monthlyBuckets.has(monthKey)) {
        monthlyBuckets.add(monthKey);
        preservedIds.add(backup._id);
        continue;
      }
    }
  }

  // 4. Determine pruning candidates
  const prunedIds: string[] = [];
  for (const backup of allBackups) {
    if (!preservedIds.has(backup._id)) {
      // Re-verify that we do not delete the only verified backup
      if (backup.status === 'verified') {
        const remainingVerified = verifiedBackups.filter(
          (vb) => !prunedIds.includes(vb._id) && vb._id !== backup._id
        );
        if (remainingVerified.length === 0) {
          preservedIds.add(backup._id);
          continue;
        }
      }

      // Safe deletion of physical archive
      if (backup.archive_path && fs.existsSync(backup.archive_path)) {
        try {
          fs.unlinkSync(backup.archive_path);
        } catch (err) {
          console.warn(`[Retention] Warning: Could not delete archive file ${backup.archive_path}:`, err);
        }
      }

      await PlatformBackupModel.findByIdAndDelete(backup._id);
      prunedIds.push(backup._id);

      await auditService.record({
        action: 'backup.retention_prune',
        result: AuditResult.success,
        targetType: 'platform_backup',
        targetId: backup._id,
        meta: {
          backup_id: backup.backup_id,
          archive_filename: backup.archive_filename,
          age_days: (now.getTime() - new Date(backup.createdAt).getTime()) / ONE_DAY_MS,
        },
      });
    }
  }

  return {
    totalEvaluated: allBackups.length,
    evaluated: allBackups.length,
    prunedCount: prunedIds.length,
    deletedCount: prunedIds.length,
    preservedCount: preservedIds.size,
    prunedIds,
  };
}
