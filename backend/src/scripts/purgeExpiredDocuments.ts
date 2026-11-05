import { connectDatabase, disconnectDatabase } from '../database/connection.js';
import { purgeExpiredDocuments } from '../modules/documents/service.js';

async function main() {
  const args = process.argv.slice(2);
  let retentionDays = 30;
  let batchSize = 50;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--retention-days' && args[i + 1]) {
      retentionDays = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--batch-size' && args[i + 1]) {
      batchSize = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  console.log(`[Purge] Starting purge of documents deleted more than ${retentionDays} days ago (dryRun=${dryRun}, batchSize=${batchSize})...`);
  await connectDatabase();

  try {
    const report = await purgeExpiredDocuments({
      retentionDays,
      batchSize,
      dryRun,
    });

    console.log('[Purge] Report:', {
      retentionDays,
      dryRun,
      purgedCount: report.purgedCount,
      freedBytes: report.freedBytes,
      freedMegabytes: (report.freedBytes / (1024 * 1024)).toFixed(2),
      failedCount: report.failedCount,
    });
  } catch (error) {
    console.error('[Purge] Fatal purge error:', error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
