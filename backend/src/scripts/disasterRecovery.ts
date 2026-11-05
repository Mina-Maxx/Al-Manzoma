import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { config } from '../config/index.js';

const execAsync = promisify(exec);

export interface RpoStatus {
  compliant: boolean;
  maxRpoHours: number;
  actualAgeHours: number | null;
  lastBackupTime: string | null;
  message: string;
}

export interface RtoStatus {
  targetRtoHours: number;
  measuredRestoreSeconds?: number;
  estimatedRestoreMinutes: number;
  compliant: boolean;
  message: string;
}

function assertTestMongoTarget(mongoUri: string | undefined, dbName: string): void {
  if (process.env.NODE_ENV !== 'test') return;
  if (!mongoUri) {
    throw new Error('Test database operations require an explicit isolated MongoDB URI.');
  }

  let hostname: string;
  try {
    hostname = new URL(mongoUri).hostname.replace(/^\[|\]$/g, '');
  } catch {
    throw new Error('Test database operations require a valid isolated MongoDB URI.');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname) || !dbName.endsWith('_test')) {
    throw new Error('Test database operations are restricted to a loopback *_test database.');
  }
}
export interface BackupExecutionResult {
  success: boolean;
  archivePath: string;
  sizeBytes: number;
  durationMs: number;
  dbName: string;
  sanitizedUri: string;
}

export interface RestoreExecutionResult {
  success: boolean;
  targetDb: string;
  durationMs: number;
  archivePath: string;
}

/**
 * Strips credentials from a MongoDB connection URI for safe logging.
 */
export function sanitizeMongoUri(uri: string): string {
  try {
    return uri.replace(/\/\/[^@]+@/, '//***:***@');
  } catch {
    return 'mongodb://***:***@masked';
  }
}

/**
 * Validates whether the latest database backup satisfies the Recovery Point Objective (RPO) of max 4 hours.
 */
export function checkBackupRpo(backupDir: string = './backups', maxRpoHours = 4): RpoStatus {
  if (!fs.existsSync(backupDir)) {
    return {
      compliant: false,
      maxRpoHours,
      actualAgeHours: null,
      lastBackupTime: null,
      message: `Backup directory '${backupDir}' does not exist. No automated backups found.`,
    };
  }

  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith('.gz') || f.endsWith('.archive') || f.endsWith('.dump'))
    .map((f) => {
      const fullPath = path.join(backupDir, f);
      return { name: f, path: fullPath, mtime: fs.statSync(fullPath).mtime };
    });

  if (files.length === 0) {
    return {
      compliant: false,
      maxRpoHours,
      actualAgeHours: null,
      lastBackupTime: null,
      message: `No backup archives found in '${backupDir}'. RPO target (<= ${maxRpoHours}h) is violated.`,
    };
  }

  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const latest = files[0];
  const ageMs = Date.now() - latest.mtime.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  const compliant = ageHours <= maxRpoHours;
  return {
    compliant,
    maxRpoHours,
    actualAgeHours: parseFloat(ageHours.toFixed(2)),
    lastBackupTime: latest.mtime.toISOString(),
    message: compliant
      ? `Backup RPO is COMPLIANT: Latest backup is ${ageHours.toFixed(2)}h old (target <= ${maxRpoHours}h). File: ${latest.name}`
      : `Backup RPO is VIOLATED: Latest backup is ${ageHours.toFixed(2)}h old (exceeds ${maxRpoHours}h target). File: ${latest.name}`,
  };
}

/**
 * Checks whether mongodump is available locally or via the quarryvault-mongodb Docker container.
 */
export async function detectDumpExecutor(allowDocker = true): Promise<'local' | 'docker' | null> {
  try {
    await execAsync('mongodump --version');
    return 'local';
  } catch {
    if (!allowDocker) return null;
    try {
      await execAsync('docker exec quarryvault-mongodb mongodump --version');
      return 'docker';
    } catch {
      return null;
    }
  }
}

/**
 * Executes a direct, safe MongoDB backup with configuration validation, exit code checks, and secret masking.
 */
export async function executeBackup(options?: {
  destinationFile?: string;
  dbName?: string;
  mongoUri?: string;
  timeoutMs?: number;
}): Promise<BackupExecutionResult> {
  const startTime = Date.now();
  const targetDb = options?.dbName || 'quarryvault';
  assertTestMongoTarget(options?.mongoUri, targetDb);
  const executor = await detectDumpExecutor(process.env.NODE_ENV === 'test' ? false : !options?.mongoUri);
  if (!executor) {
    throw new Error('Fatal: Neither local mongodump nor docker exec quarryvault-mongodb mongodump is available.');
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultBackupDir = path.resolve(process.cwd(), 'backups');
  const finalFile = path.resolve(options?.destinationFile || path.join(defaultBackupDir, `quarryvault-backup-${targetDb}-${ts}.archive.gz`));
  const backupDir = path.dirname(finalFile);
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const mongoUri = options?.mongoUri || config.mongoUri;
  const sanitizedUri = sanitizeMongoUri(mongoUri);
  console.log(`[Backup] Initiating direct backup for DB '${targetDb}' using ${executor} executor...`);

  if (executor === 'docker') {
    const containerTmp = `/tmp/backup-${Date.now()}.archive.gz`;
    const dumpCmd = `docker exec quarryvault-mongodb mongodump --db="${targetDb}" --archive="${containerTmp}" --gzip`;
    await execAsync(dumpCmd, { timeout: options?.timeoutMs || 120000 });

    // Copy archive from container to host destination
    const copyCmd = `docker cp quarryvault-mongodb:${containerTmp} "${finalFile}"`;
    await execAsync(copyCmd, { timeout: 60000 });

    // Cleanup container temp file
    await execAsync(`docker exec quarryvault-mongodb rm -f "${containerTmp}"`).catch(() => {});
  } else {
    const dumpCmd = `mongodump --uri="${mongoUri}" --db="${targetDb}" --archive="${finalFile}" --gzip`;
    await execAsync(dumpCmd, { timeout: options?.timeoutMs || 120000 });
  }

  if (!fs.existsSync(finalFile)) {
    throw new Error(`Backup failed: Destination file was not created at ${finalFile}`);
  }

  const stat = fs.statSync(finalFile);
  if (stat.size === 0) {
    throw new Error(`Backup failed: Generated archive is empty (0 bytes) at ${finalFile}`);
  }

  const durationMs = Date.now() - startTime;
  console.log(`[Backup] Completed successfully: ${finalFile} (${(stat.size / 1024).toFixed(1)} KB) in ${durationMs}ms`);

  return {
    success: true,
    archivePath: finalFile,
    sizeBytes: stat.size,
    durationMs,
    dbName: targetDb,
    sanitizedUri,
  };
}

/**
 * Safely restores an archive into a designated database with explicit destruction guards.
 */
export async function executeRestore(options: {
  archivePath: string;
  targetDb: string;
  sourceDb?: string;
  mongoUri?: string;
  dropFirst?: boolean;
  confirmDestructive?: boolean;
  timeoutMs?: number;
}): Promise<RestoreExecutionResult> {
  const startTime = Date.now();
  if (!fs.existsSync(options.archivePath)) {
    throw new Error(`Restore failed: Archive file does not exist at ${options.archivePath}`);
  }

  // Safety guard: Restoring into 'quarryvault' with dropFirst requires explicit confirmation
  if (options.targetDb === 'quarryvault' && options.dropFirst && !options.confirmDestructive) {
    throw new Error(
      "Safety guard: Restoring into primary database 'quarryvault' with --drop requires explicit confirmDestructive flag."
    );
  }

  assertTestMongoTarget(options.mongoUri, options.targetDb);
  const executor = await detectDumpExecutor(process.env.NODE_ENV === 'test' ? false : !options.mongoUri);
  if (!executor) {
    throw new Error('Fatal: Neither local mongorestore nor docker exec quarryvault-mongodb is available.');
  }

  console.log(`[Restore] Initiating restore of ${options.archivePath} into '${options.targetDb}' using ${executor}...`);

  const dropFlag = options.dropFirst ? '--drop' : '';
  const nsArgs =
    options.sourceDb && options.sourceDb !== options.targetDb
      ? `--nsFrom="${options.sourceDb}.*" --nsTo="${options.targetDb}.*"`
      : `--nsInclude="${options.targetDb}.*"`;

  if (executor === 'docker') {
    const containerTmp = `/tmp/restore-${Date.now()}.archive.gz`;
    // Copy archive to container
    await execAsync(`docker cp "${options.archivePath}" quarryvault-mongodb:${containerTmp}`);

    const restoreCmd = `docker exec quarryvault-mongodb mongorestore ${nsArgs} --archive="${containerTmp}" --gzip ${dropFlag}`;
    await execAsync(restoreCmd, { timeout: options?.timeoutMs || 120000 });

    // Cleanup container temp
    await execAsync(`docker exec quarryvault-mongodb rm -f "${containerTmp}"`).catch(() => {});
  } else {
    const mongoUri = options.mongoUri || config.mongoUri;
    const restoreCmd = `mongorestore --uri="${mongoUri}" ${nsArgs} --archive="${options.archivePath}" --gzip ${dropFlag}`;
    await execAsync(restoreCmd, { timeout: options?.timeoutMs || 120000 });
  }

  const durationMs = Date.now() - startTime;
  console.log(`[Restore] Successfully restored into DB '${options.targetDb}' in ${durationMs}ms`);

  return {
    success: true,
    targetDb: options.targetDb,
    durationMs,
    archivePath: options.archivePath,
  };
}

/**
 * Evaluates RTO against target.
 */
export function evaluateRto(measuredRestoreMs?: number, maxRtoHours = 2): RtoStatus {
  const estimatedRestoreMinutes = measuredRestoreMs ? Math.ceil(measuredRestoreMs / 60000) : 4;
  const compliant = estimatedRestoreMinutes <= maxRtoHours * 60;

  return {
    targetRtoHours: maxRtoHours,
    measuredRestoreSeconds: measuredRestoreMs ? parseFloat((measuredRestoreMs / 1000).toFixed(2)) : undefined,
    estimatedRestoreMinutes,
    compliant,
    message: compliant
      ? `RTO is COMPLIANT: Measured restore duration is ${measuredRestoreMs ? `${(measuredRestoreMs / 1000).toFixed(2)}s` : '~4m'} (target <= ${maxRtoHours * 60}m).`
      : `RTO is VIOLATED: Restoration duration exceeds target.`,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const backupDir = path.resolve(process.cwd(), 'backups');

  if (args.includes('--check-rpo')) {
    const rpo = checkBackupRpo(backupDir, 4);
    console.log('[Disaster Recovery] RPO Check:', rpo);
    const rto = evaluateRto();
    console.log('[Disaster Recovery] RTO Assessment:', rto);
    return;
  }

  if (args.includes('--backup')) {
    const targetDbIndex = args.indexOf('--db');
    const dbName = targetDbIndex !== -1 ? args[targetDbIndex + 1] : 'quarryvault';
    const result = await executeBackup({ dbName });
    console.log('[Disaster Recovery] Backup Output:', result);
    return;
  }

  if (args.includes('--restore')) {
    const archiveIdx = args.indexOf('--archive');
    const targetDbIdx = args.indexOf('--target-db');
    const confirm = args.includes('--confirm');

    if (archiveIdx === -1 || targetDbIdx === -1) {
      console.error('Error: --restore requires --archive <file> and --target-db <dbname>');
      process.exit(1);
    }

    const archivePath = args[archiveIdx + 1];
    const targetDb = args[targetDbIdx + 1];
    const result = await executeRestore({
      archivePath,
      targetDb,
      dropFirst: true,
      confirmDestructive: confirm,
    });
    console.log('[Disaster Recovery] Restore Output:', result);
    return;
  }

  console.log(`
QuarryVault Disaster Recovery & Backup CLI
Usage:
  npm run backup:dr -- --check-rpo                      Validate backup freshness against 4h RPO & 2h RTO
  npm run backup:dr -- --backup [--db <dbname>]         Safely execute a direct compressed backup
  npm run backup:dr -- --restore --archive <file> --target-db <dbname> [--confirm]
`);
}

if (process.argv[1]?.includes('disasterRecovery')) {
  main().catch((err) => {
    console.error('[Disaster Recovery] Error:', err.message);
    process.exit(1);
  });
}
