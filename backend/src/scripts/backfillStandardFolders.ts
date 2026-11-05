import { connectDatabase, disconnectDatabase } from '../database/connection.js';
import { QuarryModel, FolderModel } from '../database/models/index.js';
import { STANDARD_FOLDERS, QuarryStatus } from '../types/index.js';

export async function backfillStandardFolders(options?: { dryRun?: boolean }) {
  const dryRun = options?.dryRun ?? false;
  console.log(`[Backfill] Starting standard folders backfill (dryRun=${dryRun})...`);

  const quarries = await QuarryModel.find({ status: QuarryStatus.active }).lean();
  let totalQuarriesChecked = 0;
  let totalFoldersCreated = 0;

  for (const q of quarries) {
    totalQuarriesChecked++;
    const existingFolders = await FolderModel.find({
      quarry_id: q._id,
      deleted_at: null,
    }).lean();

    const existingNames = new Set(existingFolders.map((f) => f.name.toLowerCase()));
    const missingStandardFolders = STANDARD_FOLDERS.filter(
      (sf) => !existingNames.has(sf.name.toLowerCase())
    );

    if (missingStandardFolders.length > 0) {
      console.log(`[Backfill] Quarry '${q.name}' (${q._id}) is missing ${missingStandardFolders.length} standard folders:`, missingStandardFolders.map((f) => f.name).join(', '));
      if (!dryRun) {
        await FolderModel.insertMany(
          missingStandardFolders.map((sf) => ({
            company_id: q.company_id,
            quarry_id: q._id,
            parent_id: null,
            name: sf.name,
            is_standard: true,
            standard_order: sf.order,
            standard_key: sf.key,
            version: 1,
          }))
        );
      }
      totalFoldersCreated += missingStandardFolders.length;
    }
  }

  console.log(`[Backfill] Summary: Checked ${totalQuarriesChecked} quarries. Created ${totalFoldersCreated} standard folders (dryRun=${dryRun}).`);
  return { totalQuarriesChecked, totalFoldersCreated };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  await connectDatabase();
  try {
    await backfillStandardFolders({ dryRun });
  } finally {
    await disconnectDatabase();
  }
}

if (process.argv[1]?.endsWith('backfillStandardFolders.ts') || process.argv[1]?.endsWith('backfillStandardFolders.js')) {
  main().catch((err) => {
    console.error('[Backfill] Fatal error:', err);
    process.exit(1);
  });
}
