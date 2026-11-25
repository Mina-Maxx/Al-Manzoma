import { connectDatabase, disconnectDatabase } from '../database/connection.js';
import { UserModel } from '../database/models/index.js';

/**
 * Username and email uniqueness is otherwise enforced only by check-then-insert in the routes, so
 * concurrent requests can create duplicate accounts. This adds partial unique indexes (null/missing
 * values are ignored). It never touches data: with duplicates present it only reports them.
 *
 *   npm run indexes:users            # dry run: report duplicates, change nothing
 *   npm run indexes:users -- --apply # create the indexes when no duplicates exist
 */
const SPECS = [
  { field: 'normalized_username', name: 'uniq_normalized_username' },
  { field: 'email', name: 'uniq_email' },
] as const;

export interface UniqueIndexReport {
  field: string;
  duplicates: Array<{ value: string; user_ids: string[] }>;
  created: boolean;
}

export async function ensureUniqueUserIndexes(options?: { apply?: boolean }): Promise<UniqueIndexReport[]> {
  const apply = options?.apply ?? false;
  const reports: UniqueIndexReport[] = [];

  for (const { field, name } of SPECS) {
    const groups = await UserModel.aggregate([
      { $match: { [field]: { $type: 'string', $ne: '' } } },
      { $group: { _id: `$${field}`, ids: { $push: '$_id' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);
    const duplicates = groups.map((g: any) => ({ value: String(g._id), user_ids: g.ids as string[] }));
    let created = false;

    if (duplicates.length === 0 && apply) {
      await UserModel.collection.createIndex(
        { [field]: 1 },
        { unique: true, name, partialFilterExpression: { [field]: { $type: 'string' } } }
      );
      created = true;
    }
    reports.push({ field, duplicates, created });
  }
  return reports;
}

async function main() {
  const apply = process.argv.slice(2).includes('--apply');
  await connectDatabase();
  try {
    const reports = await ensureUniqueUserIndexes({ apply });
    for (const r of reports) {
      if (r.duplicates.length) {
        console.error(`[indexes] ${r.field}: ${r.duplicates.length} duplicated value(s); resolve them before applying:`);
        for (const d of r.duplicates) console.error(`  - ${d.value}: users ${d.user_ids.join(', ')}`);
      } else {
        console.log(`[indexes] ${r.field}: no duplicates${r.created ? ' - unique index created' : apply ? '' : ' (dry run, nothing changed)'}`);
      }
    }
    if (reports.some((r) => r.duplicates.length)) process.exitCode = 2;
  } finally {
    await disconnectDatabase();
  }
}

if (process.argv[1]?.endsWith('ensureUniqueUserIndexes.ts') || process.argv[1]?.endsWith('ensureUniqueUserIndexes.js')) {
  main().catch((err) => {
    console.error('[indexes] Fatal error:', err);
    process.exit(1);
  });
}
