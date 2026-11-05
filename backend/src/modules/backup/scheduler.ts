import { PlatformBackupConfigModel, PlatformBackupModel } from '../../database/models/index.js';
import { backupService } from './service.js';
import { applyRetentionPolicy } from './retention.js';

let schedulerInterval: NodeJS.Timeout | null = null;

/**
 * Executes a single scheduled backup check and retention cycle.
 */
export async function runScheduledBackupCycle(): Promise<void> {
  try {
    let config = await PlatformBackupConfigModel.findById('platform-backup-global-config');
    if (!config) {
      config = await PlatformBackupConfigModel.create({
        _id: 'platform-backup-global-config',
        is_scheduled_enabled: true,
        schedule_interval_hours: 4,
        retention_daily: 7,
        retention_weekly: 4,
        retention_monthly: 3,
      });
    }

    if (!config.is_scheduled_enabled) {
      return;
    }

    const intervalMs = (config.schedule_interval_hours || 4) * 60 * 60 * 1000;
    const now = Date.now();

    const lastBackup = await PlatformBackupModel.findOne({
      status: { $in: ['completed', 'verified'] },
    }).sort({ createdAt: -1 });

    const lastRunTime = lastBackup?.createdAt ? new Date(lastBackup.createdAt).getTime() : 0;
    const isDue = now - lastRunTime >= intervalMs;

    if (isDue) {
      console.log(`[BackupScheduler] Scheduled backup is due (interval: ${config.schedule_interval_hours}h). Starting...`);
      const backup = await backupService.createBackup({
        type: 'scheduled',
        createdBy: 'system',
        createdByEmail: 'system@quarryvault.internal',
        notes: `Automated scheduled backup (Interval: ${config.schedule_interval_hours}h)`,
      });

      console.log(`[BackupScheduler] Scheduled backup completed: ${backup.backup_id}. Applying retention...`);
      await applyRetentionPolicy({
        dailyRetention: config.retention_daily || 7,
        weeklyRetention: config.retention_weekly || 4,
        monthlyRetention: config.retention_monthly || 3,
      });

      config.last_scheduled_run = new Date();
      config.next_scheduled_run = new Date(Date.now() + intervalMs);
      await config.save();
    } else {
      config.next_scheduled_run = new Date(lastRunTime + intervalMs);
      await config.save();
    }
  } catch (err) {
    console.error('[BackupScheduler] Error running scheduled backup cycle:', err);
  }
}

/**
 * Starts the background backup scheduler.
 */
export function startBackupScheduler(checkIntervalMs: number = 600000): void {
  if (schedulerInterval) return;

  // Run initial check after a brief startup delay (10s)
  setTimeout(() => {
    runScheduledBackupCycle().catch(() => {});
  }, 10000);

  schedulerInterval = setInterval(() => {
    runScheduledBackupCycle().catch(() => {});
  }, checkIntervalMs);

  console.log(`[BackupScheduler] Started background backup scheduler (Check interval: ${checkIntervalMs / 1000}s)`);
}

/**
 * Stops the background backup scheduler.
 */
export function stopBackupScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[BackupScheduler] Stopped background backup scheduler.');
  }
}
