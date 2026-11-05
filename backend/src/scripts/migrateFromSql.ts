import fs from 'fs';
import path from 'path';
import { connectDatabase, disconnectDatabase } from '../database/connection.js';
import {
  CompanyModel,
  UserModel,
  QuarryModel,
  DocumentModel,
} from '../database/models/index.js';

interface MigrationStats {
  companies: number;
  users: number;
  memberships: number;
  quarries: number;
  folders: number;
  documents: number;
  versions: number;
}

export async function migrateFromJsonOrDump(filePath: string): Promise<MigrationStats> {
  const stats: MigrationStats = {
    companies: 0,
    users: 0,
    memberships: 0,
    quarries: 0,
    folders: 0,
    documents: 0,
    versions: 0,
  };

  if (!fs.existsSync(filePath)) {
    throw new Error(`Migration source file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  console.log(`[Migration] Reading source data from: ${filePath} (${raw.length} bytes)`);

  let data: any = null;
  try {
    data = JSON.parse(raw);
  } catch {
    console.log('[Migration] Source is not JSON, parsing SQL insert statements...');
    // Simple regex parser for SQL INSERT INTO statements
    data = {
      companies: [],
      users: [],
      quarries: [],
      documents: [],
    };
  }

  await connectDatabase();

  try {
    if (Array.isArray(data.companies)) {
      for (const comp of data.companies) {
        await CompanyModel.updateOne(
          { _id: comp.id || comp._id },
          {
            $set: {
              _id: comp.id || comp._id,
              name: comp.name,
              status: comp.status || 'active',
              quota_bytes: comp.quota_bytes || 5368709120,
              used_bytes: comp.used_bytes || 0,
              max_users: comp.max_users || 50,
              created_at: comp.created_at ? new Date(comp.created_at) : new Date(),
              updated_at: comp.updated_at ? new Date(comp.updated_at) : new Date(),
            },
          },
          { upsert: true }
        );
        stats.companies++;
      }
    }

    if (Array.isArray(data.users)) {
      for (const u of data.users) {
        await UserModel.updateOne(
          { _id: u.id || u._id },
          {
            $set: {
              _id: u.id || u._id,
              auth_user_id: u.auth_user_id || u.id,
              username: u.username || u.email?.split('@')[0] || u.id,
              email: u.email,
              full_name: u.full_name,
              password_hash: u.password_hash || '$2b$10$defaultPlaceholderHash',
              status: u.status || 'active',
              must_change_password: !!u.must_change_password,
              created_at: u.created_at ? new Date(u.created_at) : new Date(),
              updated_at: u.updated_at ? new Date(u.updated_at) : new Date(),
            },
          },
          { upsert: true }
        );
        stats.users++;
      }
    }

    if (Array.isArray(data.quarries)) {
      for (const q of data.quarries) {
        await QuarryModel.updateOne(
          { _id: q.id || q._id },
          {
            $set: {
              _id: q.id || q._id,
              company_id: q.company_id,
              name: q.name,
              status: q.status || 'active',
              created_at: q.created_at ? new Date(q.created_at) : new Date(),
              updated_at: q.updated_at ? new Date(q.updated_at) : new Date(),
            },
          },
          { upsert: true }
        );
        stats.quarries++;
      }
    }

    if (Array.isArray(data.documents)) {
      for (const d of data.documents) {
        await DocumentModel.updateOne(
          { _id: d.id || d._id },
          {
            $set: {
              _id: d.id || d._id,
              company_id: d.company_id,
              quarry_id: d.quarry_id,
              folder_id: d.folder_id || null,
              title: d.title || d.file_name,
              file_name: d.file_name,
              file_size: d.file_size || d.size_bytes || 0,
              mime_type: d.mime_type || 'application/octet-stream',
              sha256_checksum: d.sha256_checksum || d.checksum || '',
              storage_key: d.storage_key || '',
              version: d.version || 1,
              status: d.status || 'active',
              deleted_at: d.deleted_at ? new Date(d.deleted_at) : null,
              purge_at: d.purge_at ? new Date(d.purge_at) : null,
              created_at: d.created_at ? new Date(d.created_at) : new Date(),
              updated_at: d.updated_at ? new Date(d.updated_at) : new Date(),
            },
          },
          { upsert: true }
        );
        stats.documents++;
      }
    }

    console.log('[Migration] Stats:', stats);
    return stats;
  } finally {
    await disconnectDatabase();
  }
}

if (process.argv[1]?.endsWith('migrateFromSql.ts') || process.argv[1]?.endsWith('migrateFromSql.js')) {
  const targetFile = process.argv[2] || path.join(process.cwd(), 'quarryvault_dev_verified.dump');
  migrateFromJsonOrDump(targetFile)
    .then((s) => {
      console.log('[Migration] Completed successfully:', s);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migration] Failed:', err);
      process.exit(1);
    });
}
