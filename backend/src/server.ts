import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './database/connection.js';
import { config, validateProductionConfig } from './config/index.js';
import { startBackupScheduler, stopBackupScheduler } from './modules/backup/scheduler.js';
import { purgeExpiredDocuments } from './modules/documents/service.js';
import { reconcilePendingUploadSideEffects } from './services/uploadReconciliation.js';

let purgeTimer: NodeJS.Timeout | null = null;
let uploadReconciliationTimer: NodeJS.Timeout | null = null;

function startPurgeScheduler() {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const runPurge = async () => {
    try {
      const report = await purgeExpiredDocuments({ retentionDays: 30 });
      if (report.purgedCount > 0) {
        console.log(
          `[DocumentPurge] Purged ${report.purgedCount} expired documents, freed ${(report.freedBytes / (1024 * 1024)).toFixed(2)} MB.`
        );
      }
    } catch (err) {
      console.warn('[DocumentPurge] Purge cycle warning:', err);
    }
  };

  setTimeout(runPurge, 60000);
  purgeTimer = setInterval(runPurge, ONE_DAY_MS);
}

function stopPurgeScheduler() {
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }
}

function startUploadReconciliationScheduler() {
  const run = async () => {
    try {
      const result = await reconcilePendingUploadSideEffects(25);
      if (result.completed > 0) console.log(`[UploadReconciliation] Reconciled ${result.completed} pending upload(s).`);
    } catch (err) {
      console.warn('[UploadReconciliation] Worker cycle warning:', err);
    }
  };
  void run();
  uploadReconciliationTimer = setInterval(() => void run(), 30_000);
}

function stopUploadReconciliationScheduler() {
  if (uploadReconciliationTimer) {
    clearInterval(uploadReconciliationTimer);
    uploadReconciliationTimer = null;
  }
}

async function bootstrap() {
  try {
    // 0. Validate production environment configuration
    validateProductionConfig();

    // 1. Connect to MongoDB
    await connectDatabase(config.mongoUri);

    // Permission migration is intentionally manual: generate and review a dry-run conflict report first.

    // 2. Initialize Express application
    const app = createApp();

    // 3. Start automated platform backup, document purge, and upload reconciliation schedulers
    startBackupScheduler();
    startPurgeScheduler();
    startUploadReconciliationScheduler();

    // 5. Start HTTP server
    const server = app.listen(config.port, () => {
      console.log(`[QuarryVault Backend] Server listening on port ${config.port} (${config.env})`);
      console.log(`[QuarryVault Backend] Storage backend: ${config.storageBackend}`);
      console.log(`[QuarryVault Backend] Health endpoint: http://localhost:${config.port}/health`);
      console.log(`[QuarryVault Backend] Admin Portal: ${config.webOrigin || 'http://localhost:3001'}`);
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
      stopBackupScheduler();
      stopPurgeScheduler();
      stopUploadReconciliationScheduler();
      server.close(async () => {
        await disconnectDatabase();
        console.log('[Server] Shutdown complete.');
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    console.error('[Server] Fatal startup error:', err);
    process.exit(1);
  }
}

bootstrap();
