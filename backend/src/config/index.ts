import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load .env prioritizing backend-specific .env then fallback candidates
const envCandidates = [
  path.resolve(process.cwd(), 'backend', '.env'),
  path.resolve(__dirname, '..', '..', '.env'),
  path.resolve(__dirname, '..', '.env'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
];

for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}
dotenv.config();

export interface AppConfig {
  env: string;
  port: number;
  enableDocs: boolean;
  mongoUri: string;
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  jwtAlgorithms: string[];
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  supabaseJwtAudience: string;
  dashboardBaseUrl: string;
  webOrigin: string;
  syncCursorSecret: string;
  maxFileSizeBytes: number;
  defaultCompanyQuotaBytes: number;
  defaultCompanyMaxUsers: number;
  idempotencyLeaseSeconds: number;
  inviteRateLimitPerMinute: number;
  
  // Storage settings (Cloudflare R2 / S3 compatible)
  storageBackend: 'r2' | 's3' | 'local';
  r2AccountId?: string;
  r2BucketName: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  r2Endpoint?: string;
  r2Region: string;
  storageLocalRoot: string;
  backupStorageDir: string;
  backupEncryptionKey: string;
}

export const config: AppConfig = {
  env: process.env.NODE_ENV || process.env.APP_ENV || 'development',
  port: parseInt(process.env.PORT || '8000', 10),
  enableDocs: process.env.ENABLE_DOCS === 'true' || (process.env.NODE_ENV || process.env.APP_ENV || 'development') !== 'production',
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/quarryvault',
  jwtSecret: process.env.JWT_SECRET || process.env.DEV_JWT_SECRET || 'dev-insecure-secret-change-me-32chars-minimum-length!',
  jwtIssuer: process.env.JWT_ISSUER || process.env.DEV_JWT_ISSUER || 'quarryvault-dev',
  jwtAudience: process.env.JWT_AUDIENCE || process.env.DEV_JWT_AUDIENCE || 'quarryvault-dev',
  jwtAlgorithms: (process.env.SUPABASE_JWT_ALGORITHMS || 'HS256,RS256,ES256').split(',').map(s => s.trim()),
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabaseJwtAudience: process.env.SUPABASE_JWT_AUDIENCE || 'authenticated',
  dashboardBaseUrl: process.env.DASHBOARD_BASE_URL || 'http://localhost:8000',
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:3001',
  syncCursorSecret: process.env.SYNC_CURSOR_SECRET || 'dev-sync-cursor-secret-at-least-32-chars-long!',
  maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_BYTES || '10485760', 10), // 10 MB
  defaultCompanyQuotaBytes: parseInt(process.env.DEFAULT_COMPANY_QUOTA_BYTES || '5368709120', 10), // 5 GiB
  defaultCompanyMaxUsers: parseInt(process.env.DEFAULT_COMPANY_MAX_USERS || '10', 10),
  idempotencyLeaseSeconds: parseInt(process.env.IDEMPOTENCY_LEASE_SECONDS || '300', 10),
  inviteRateLimitPerMinute: parseInt(process.env.INVITE_RATE_LIMIT_PER_MINUTE || '10', 10),

  // Storage
  storageBackend: (process.env.STORAGE_BACKEND as any) || 'local',
  r2AccountId: process.env.R2_ACCOUNT_ID,
  r2BucketName: process.env.R2_BUCKET_NAME || 'quarryvault-docs',
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID,
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  r2Endpoint: process.env.R2_ENDPOINT,
  r2Region: process.env.R2_REGION || 'auto',
  storageLocalRoot: process.env.STORAGE_LOCAL_ROOT || path.resolve(process.cwd(), '.storage'),
  backupStorageDir: process.env.BACKUP_STORAGE_DIR || path.resolve(process.cwd(), 'backups'),
  backupEncryptionKey: process.env.BACKUP_ENCRYPTION_KEY || '',
};

/**
 * Validates that production environments do not run with insecure development defaults.
 */
export function validateProductionConfig(cfg: AppConfig = config): void {
  if (cfg.env === 'production') {
    const origin = (cfg.webOrigin && cfg.webOrigin !== 'http://localhost:3001') ? cfg.webOrigin : process.env.WEB_ORIGIN;
    if (!origin || origin === 'http://localhost:3001') {
      throw new Error("Fatal: WEB_ORIGIN must be explicitly set to the admin application's browser origin in production.");
    }

    const isDefaultJwtSecret = !cfg.jwtSecret || cfg.jwtSecret.includes('dev-insecure-secret');
    if (isDefaultJwtSecret || cfg.jwtSecret.length < 32) {
      throw new Error(
        'Fatal: In production, JWT_SECRET must be explicitly set to a secure string of at least 32 characters.'
      );
    }

    const isDefaultSyncSecret = !cfg.syncCursorSecret || cfg.syncCursorSecret.includes('dev-sync-cursor');
    if (isDefaultSyncSecret || cfg.syncCursorSecret.length < 32) {
      throw new Error(
        'Fatal: In production, SYNC_CURSOR_SECRET must be explicitly set to a secure string of at least 32 characters.'
      );
    }

    const isDefaultBackupKey = !cfg.backupEncryptionKey || cfg.backupEncryptionKey.includes('dev-backup-key');
    if (isDefaultBackupKey || cfg.backupEncryptionKey.length < 32) {
      throw new Error(
        'Fatal: In production, BACKUP_ENCRYPTION_KEY must be explicitly set to a dedicated secure string of at least 32 characters.'
      );
    }

    if (cfg.storageBackend === 'local') {
      throw new Error(
        'Fatal: STORAGE_BACKEND=local is prohibited in production. Cloudflare R2 (STORAGE_BACKEND=r2) must be configured.'
      );
    }

    if ((cfg.storageBackend === 'r2' || cfg.storageBackend === 's3') && (!cfg.r2AccessKeyId || !cfg.r2SecretAccessKey)) {
      throw new Error(
        'Fatal: Cloudflare R2 credentials (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) must be provided in production.'
      );
    }
  }
}
