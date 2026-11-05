import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config/index.js';
import {
  PlatformBackupModel,
  PlatformRestoreModel,
  PlatformBackupConfigModel,
  CompanyModel,
  UserModel,
  MembershipModel,
  PlatformAdminModel,
  QuarryModel,
  QuarryPermissionModel,
  FolderModel,
  DocumentModel,
  DocumentVersionModel,
  IdempotencyKeyModel,
  AuditEventModel,
  CompanySyncStateModel,
  ChangeLogModel,
  AppReleaseModel,
  PasswordResetTokenModel,
} from '../../database/models/index.js';
import {
  PlatformBackupDocument,
  PlatformRestoreDocument,
  BackupManifest,
  BackupType,
  AuditResult,
} from '../../types/index.js';
import { storage } from '../storage/index.js';
import { auditService } from '../audit/service.js';
import { computeFileSha256, encryptFile, decryptFile } from './crypto.js';
import { extractTarGzSafely } from './restoreArchive.js';
import {
  detectDumpExecutor,
  executeBackup as executeMongoDumpBackup,
  checkBackupRpo,
  evaluateRto,
} from '../../scripts/disasterRecovery.js';
import { DomainError, NotFoundError, ConflictError } from '../../middleware/errors.js';

const execAsync = promisify(exec);

async function computeReadableSha256(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export const ALL_COLLECTION_MODELS: Record<string, mongoose.Model<any>> = {
  companies: CompanyModel,
  users: UserModel,
  memberships: MembershipModel,
  platformadmins: PlatformAdminModel,
  quarries: QuarryModel,
  quarrypermissions: QuarryPermissionModel,
  folders: FolderModel,
  documents: DocumentModel,
  documentversions: DocumentVersionModel,
  idempotencykeys: IdempotencyKeyModel,
  auditevents: AuditEventModel,
  companysyncstates: CompanySyncStateModel,
  changelogs: ChangeLogModel,
  appreleases: AppReleaseModel,
  passwordresettokens: PasswordResetTokenModel,
};

export interface CreateBackupOptions {
  type?: BackupType;
  createdBy: string;
  createdByEmail: string;
  notes?: string;
  isLocked?: boolean;
}

export interface RestoreOptions {
  confirm: boolean;
  confirmationPhrase: string;
  createSafetyBackup?: boolean;
  actorUserId: string;
  actorEmail: string;
}

export class BackupService {
  private getBackupDir(): string {
    const dir = path.resolve(config.backupStorageDir || 'backups');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Creates a full platform backup containing:
   * 1. Database snapshot (Binary mongodump when available + collection JSON export)
   * 2. Document storage objects (Active, historical versions, releases, trash)
   * 3. Application recovery manifest and checksums
   * 4. Compressed archive (.tar.gz), with optional encryption at rest
   * 5. Immediate post-creation verification
   */
  async createBackup(options: CreateBackupOptions): Promise<PlatformBackupDocument> {
    const startTime = Date.now();
    const backupDir = this.getBackupDir();
    const backupId = `backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${uuidv4().substring(0, 6)}`;
    const stagingDir = path.join(backupDir, '.staging', backupId);

    // Initial backup record
    const backupRecord = await PlatformBackupModel.create({
      backup_id: backupId,
      backup_type: options.type || 'full',
      status: 'running',
      db_status: 'running',
      storage_status: 'pending',
      created_by: options.createdBy,
      created_by_email: options.createdByEmail,
      is_locked: Boolean(options.isLocked || options.type === 'safety'),
      notes: options.notes || null,
      manifest: {} as any,
    });

    try {
      fs.mkdirSync(stagingDir, { recursive: true });
      const dbStagingDir = path.join(stagingDir, 'db');
      const storageStagingDir = path.join(stagingDir, 'storage');
      fs.mkdirSync(dbStagingDir, { recursive: true });
      fs.mkdirSync(storageStagingDir, { recursive: true });

      // ---------------------------------------------------------
      // Phase 1: Database Snapshot
      // ---------------------------------------------------------
      const collectionsMap: Record<string, number> = {};
      const collectionsExportDir = path.join(dbStagingDir, 'collections');
      fs.mkdirSync(collectionsExportDir, { recursive: true });

      for (const [colName, model] of Object.entries(ALL_COLLECTION_MODELS)) {
        const docs = await model.find().lean();
        collectionsMap[colName] = docs.length;
        fs.writeFileSync(
          path.join(collectionsExportDir, `${colName}.json`),
          JSON.stringify(docs, null, 2),
          'utf8'
        );
      }

      // Check if native binary mongodump executor is available
      let hasBinaryDump = false;
      const dumpExecutor = process.env.NODE_ENV === 'test' ? null : await detectDumpExecutor();
      const activeDbName = mongoose.connection.name || 'quarryvault';
      if (dumpExecutor) {
        try {
          const binaryDumpFile = path.join(dbStagingDir, 'mongo-dump.archive.gz');
          await executeMongoDumpBackup({
            destinationFile: binaryDumpFile,
            dbName: activeDbName,
            timeoutMs: 120000,
          });
          hasBinaryDump = fs.existsSync(binaryDumpFile) && fs.statSync(binaryDumpFile).size > 0;
        } catch (dumpErr) {
          console.warn('[BackupService] Binary mongodump failed, continuing with collections export:', dumpErr);
        }
      }

      backupRecord.db_status = 'completed';
      backupRecord.storage_status = 'running';
      await backupRecord.save();

      // ---------------------------------------------------------
      // Phase 2: Document Storage Snapshot
      // ---------------------------------------------------------
      const storageObjects: Array<{ key: string; size_bytes: number; sha256: string }> = [];
      let totalStorageBytes = 0;

      // Collect all storage references
      const [documents, versions, releases, idempotencyKeys] = await Promise.all([
        DocumentModel.find({ storage_ref: { $exists: true, $ne: null } }).lean(),
        DocumentVersionModel.find({ storage_ref: { $exists: true, $ne: null } }).lean(),
        AppReleaseModel.find({ storage_ref: { $exists: true, $ne: null } }).lean(),
        IdempotencyKeyModel.find({ storage_ref: { $exists: true, $ne: null } }).lean(),
      ]);

      const allRefs = new Set<string>();
      for (const doc of documents) {
        if (doc.storage_ref) allRefs.add(doc.storage_ref);
      }
      for (const v of versions) {
        if (v.storage_ref) allRefs.add(v.storage_ref);
      }
      for (const rel of releases) {
        if (rel.storage_ref) allRefs.add(rel.storage_ref);
      }
      for (const key of idempotencyKeys) {
        if (key.storage_ref) allRefs.add(key.storage_ref);
      }

      // Stream objects from storage into backup staging
      for (const ref of allRefs) {
        try {
          const exists = await storage.exists(ref);
          if (!exists) continue;

          const item = await storage.get(ref);
          const safeRelPath = ref.replace(/^\/+/, '');
          const targetPath = path.join(storageStagingDir, safeRelPath);
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });

          const outStream = fs.createWriteStream(targetPath);
          await new Promise<void>((resolve, reject) => {
            (item.stream as any).pipe(outStream);
            outStream.on('finish', () => resolve());
            outStream.on('error', (err: any) => reject(err));
          });

          const stat = await fs.promises.stat(targetPath);
          const sha256 = await computeFileSha256(targetPath);
          totalStorageBytes += stat.size;
          storageObjects.push({
            key: ref,
            size_bytes: stat.size,
            sha256,
          });
        } catch (storageErr) {
          console.warn(`[BackupService] Warning: Could not archive storage object ${ref}:`, storageErr);
        }
      }

      backupRecord.storage_status = 'completed';
      await backupRecord.save();

      // ---------------------------------------------------------
      // Phase 3: Manifest Generation
      // ---------------------------------------------------------
      const manifest: BackupManifest = {
        manifest_version: '1.0',
        backup_id: backupId,
        backup_type: options.type || 'full',
        app_version: '1.0.13',
        created_at: new Date().toISOString(),
        storage_backend: config.storageBackend,
        database: {
          engine: 'mongodb',
          db_name: activeDbName,
          has_binary_dump: hasBinaryDump,
          collections_count: Object.keys(collectionsMap).length,
          collections: collectionsMap,
        },
        storage: {
          backend_type: config.storageBackend,
          objects_count: storageObjects.length,
          total_bytes: totalStorageBytes,
          objects: storageObjects,
        },
        system: {
          node_version: process.version,
          environment: config.env,
          rpo_target_hours: 4,
          rto_target_hours: 2,
        },
      };

      fs.writeFileSync(
        path.join(stagingDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf8'
      );

      // ---------------------------------------------------------
      // Phase 4: Packaging and Checksum
      // ---------------------------------------------------------
      const tarFilename = `quarryvault-backup-${backupId}.tar.gz`;
      let finalArchiveFile = path.join(backupDir, tarFilename);

      // Create compressed archive using native tar
      const tarCmd = `tar -czf "${finalArchiveFile}" -C "${stagingDir}" .`;
      await execAsync(tarCmd, { timeout: 180000 });

      // Clean up staging directory immediately
      fs.rmSync(stagingDir, { recursive: true, force: true });

      // Check encryption at rest
      const globalConfig = await PlatformBackupConfigModel.findById('platform-backup-global-config');
      if (globalConfig?.encryption_enabled || Boolean(config.backupEncryptionKey)) {
        const encFile = `${finalArchiveFile}.enc`;
        await encryptFile(finalArchiveFile, encFile);
        fs.unlinkSync(finalArchiveFile);
        finalArchiveFile = encFile;
      }

      const finalStat = await fs.promises.stat(finalArchiveFile);
      const archiveSha256 = await computeFileSha256(finalArchiveFile);
      const durationMs = Date.now() - startTime;

      backupRecord.status = 'completed';
      backupRecord.archive_path = finalArchiveFile;
      backupRecord.archive_filename = path.basename(finalArchiveFile);
      backupRecord.size_bytes = finalStat.size;
      backupRecord.checksum_sha256 = archiveSha256;
      backupRecord.duration_ms = durationMs;
      backupRecord.manifest = manifest;
      await backupRecord.save();

      // ---------------------------------------------------------
      // Phase 5: Automatic Post-Creation Verification
      // ---------------------------------------------------------
      await this.verifyBackupArchive(backupRecord._id);

      await auditService.record({
        action: 'backup.create',
        result: AuditResult.success,
        targetType: 'platform_backup',
        targetId: backupRecord._id,
        meta: {
          backup_id: backupId,
          type: backupRecord.backup_type,
          size_bytes: finalStat.size,
          duration_ms: durationMs,
          collections_count: manifest.database.collections_count,
          storage_objects_count: manifest.storage.objects_count,
        },
      });

      return backupRecord;
    } catch (err: any) {
      console.error('[BackupService] Full platform backup failed:', err);
      // Clean staging
      if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }

      backupRecord.status = 'failed';
      backupRecord.error_message = err.message || 'Unknown backup error';
      backupRecord.duration_ms = Date.now() - startTime;
      await backupRecord.save();

      await auditService.record({
        action: 'backup.create',
        result: AuditResult.failure,
        targetType: 'platform_backup',
        targetId: backupRecord._id,
        meta: {
          backup_id: backupId,
          error: err.message,
        },
      });

      throw err;
    }
  }

  /**
   * Verifies archive integrity, checksum, and manifest validity.
   */
  async verifyBackupArchive(backupRecordId: string): Promise<{ verified: boolean; message: string }> {
    const backup = await PlatformBackupModel.findById(backupRecordId);
    if (!backup) {
      throw new NotFoundError('Backup record not found');
    }

    if (!fs.existsSync(backup.archive_path)) {
      backup.status = 'failed';
      backup.error_message = `Archive file missing on disk: ${backup.archive_path}`;
      await backup.save();
      return { verified: false, message: backup.error_message };
    }

    // 1. Checksum verification
    const actualSha256 = await computeFileSha256(backup.archive_path);
    if (actualSha256 !== backup.checksum_sha256) {
      backup.status = 'failed';
      backup.error_message = `Checksum mismatch. Expected: ${backup.checksum_sha256}, Actual: ${actualSha256}`;
      await backup.save();
      return { verified: false, message: backup.error_message };
    }

    // 2. Stream-parse the complete archive in an isolated temporary directory.
    const backupDir = this.getBackupDir();
    const verificationDir = path.join(backupDir, '.verify', `verify-${uuidv4()}`);
    let archiveToTest = backup.archive_path;
    let tempDecryptedFile: string | null = null;

    try {
      await fs.promises.mkdir(verificationDir, { recursive: true });
      if (archiveToTest.endsWith('.enc')) {
        tempDecryptedFile = path.join(verificationDir, 'decrypted.tar.gz');
        await decryptFile(archiveToTest, tempDecryptedFile);
        archiveToTest = tempDecryptedFile;
      }

      const extractedDir = path.join(verificationDir, 'archive');
      await extractTarGzSafely(archiveToTest, extractedDir);
      const manifestFile = path.join(extractedDir, 'manifest.json');
      if (!fs.existsSync(manifestFile)) throw new Error('manifest.json is missing from the backup archive.');
      const parsedManifest = JSON.parse(await fs.promises.readFile(manifestFile, 'utf8'));
      if (!parsedManifest || parsedManifest.manifest_version !== '1.0' || !parsedManifest.database || !parsedManifest.storage) {
        throw new Error('Backup manifest is invalid or incomplete.');
      }
    } catch (tarErr: any) {
      backup.status = 'failed';
      backup.error_message = `Archive verification failed: ${tarErr.message}`;
      await backup.save();
      return { verified: false, message: backup.error_message };
    } finally {
      await fs.promises.rm(verificationDir, { recursive: true, force: true }).catch(() => undefined);
    }

    backup.status = 'verified';
    backup.verification_result = {
      verified: true,
      verified_at: new Date(),
      message: 'Archive checksum and tar structure verified successfully.',
    };
    await backup.save();

    await auditService.record({
      action: 'backup.verify',
      result: AuditResult.success,
      targetType: 'platform_backup',
      targetId: backup._id,
      meta: {
        backup_id: backup.backup_id,
        checksum: actualSha256,
      },
    });

    return { verified: true, message: 'Archive and manifest verified successfully.' };
  }

  /**
   * Restores QuarryVault to the state represented by a verified backup.
   * Staged workflow with safety backup and reference integrity checks.
   */
  async restoreBackup(backupRecordId: string, options: RestoreOptions): Promise<PlatformRestoreDocument> {
    const startTime = Date.now();
    if (!options.confirm || options.confirmationPhrase !== 'RESTORE-QUARRYVAULT') {
      throw new DomainError(
        "Destructive restore requires explicit confirmation. Please provide confirm: true and confirmationPhrase: 'RESTORE-QUARRYVAULT'.",
        400
      );
    }

    const backup = await PlatformBackupModel.findById(backupRecordId);
    if (!backup) throw new NotFoundError('Backup record not found');
    if (!backup.archive_path || !fs.existsSync(backup.archive_path)) {
      throw new NotFoundError(`Backup archive file not found on disk: ${backup.archive_path}`);
    }

    const verifyResult = await this.verifyBackupArchive(backup._id);
    if (!verifyResult.verified) throw new DomainError(`Cannot restore from corrupted backup: ${verifyResult.message}`, 400);

    const restoreRecord = await PlatformRestoreModel.create({
      backup_id: backup.backup_id,
      status: 'running',
      started_at: new Date(),
      restored_by: options.actorUserId,
      restored_by_email: options.actorEmail,
      db_restore_status: 'running',
      storage_restore_status: 'pending',
    });
    const restoreRecordId = restoreRecord._id;
    const restoreId = String(restoreRecordId);
    let safetyBackupId: string | undefined;
    const backupDir = this.getBackupDir();
    const restoreStagingDir = path.join(backupDir, '.restore-staging', `restore-${restoreId}`);
    const stagedStorageKeys: string[] = [];
    let committed = false;
    let completedRecord: PlatformRestoreDocument | null = null;

    const updateRestoreRecord = async (updates: Record<string, any>) =>
      PlatformRestoreModel.findByIdAndUpdate(restoreRecordId, { $set: updates }, { new: true });

    try {
      if (options.createSafetyBackup !== false) {
        const safetyBackup = await this.createBackup({
          type: 'safety',
          createdBy: options.actorUserId,
          createdByEmail: options.actorEmail,
          notes: `Automatic safety snapshot created before restoring backup ${backup.backup_id}`,
        });
        safetyBackupId = safetyBackup.backup_id;
        await updateRestoreRecord({ safety_backup_id: safetyBackupId });
      }

      const payloadDir = path.join(restoreStagingDir, 'payload');
      await fs.promises.mkdir(payloadDir, { recursive: true, mode: 0o700 });
      let archiveFile = backup.archive_path;
      if (archiveFile.endsWith('.enc')) {
        archiveFile = path.join(restoreStagingDir, 'decrypted.tar.gz');
        await decryptFile(backup.archive_path, archiveFile);
      }
      await extractTarGzSafely(archiveFile, payloadDir);

      const manifestPath = path.join(payloadDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) throw new Error('Restore failed: manifest.json is missing.');
      const manifest: BackupManifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      if (manifest.manifest_version !== '1.0' || !manifest.database?.collections || !Array.isArray(manifest.storage?.objects)) {
        throw new Error('Restore failed: backup manifest is invalid or incomplete.');
      }
      const expectedCollectionNames = Object.keys(ALL_COLLECTION_MODELS).sort();
      const manifestCollectionNames = Object.keys(manifest.database.collections).sort();
      if (manifest.backup_id !== backup.backup_id ||
          manifest.database.collections_count !== expectedCollectionNames.length ||
          manifestCollectionNames.length !== expectedCollectionNames.length ||
          manifestCollectionNames.some((name, index) => name !== expectedCollectionNames[index])) {
        throw new Error('Restore failed: backup identity or database collection inventory does not match the manifest.');
      }

      const collectionsDir = path.join(payloadDir, 'db', 'collections');
      const restoredCollections: Record<string, any[]> = {};
      for (const [collectionName] of Object.entries(ALL_COLLECTION_MODELS)) {
        const collectionFile = path.join(collectionsDir, `${collectionName}.json`);
        if (!fs.existsSync(collectionFile)) throw new Error(`Restore failed: required collection ${collectionName} is missing.`);
        const docs = JSON.parse(await fs.promises.readFile(collectionFile, 'utf8'));
        if (!Array.isArray(docs)) throw new Error(`Restore failed: collection ${collectionName} is not a JSON array.`);
        const expectedCount = manifest.database.collections[collectionName];
        if (typeof expectedCount !== 'number' || docs.length !== expectedCount) {
          throw new Error(`Restore failed: collection count mismatch for ${collectionName}.`);
        }
        restoredCollections[collectionName] = docs;
      }

      // Upload to immutable, restore-scoped keys first. No live records point to these
      // keys until the MongoDB transaction commits; original objects are never overwritten.
      const storageDir = path.join(payloadDir, 'storage');
      const restoredStorageRefs = new Map<string, string>();
      let stagedStorageBytes = 0;
      for (const object of manifest.storage.objects) {
        if (!object || typeof object.key !== 'string' || object.key.includes('\\') || object.key.includes('\0') ||
            object.key.startsWith('/') || object.key.split('/').some((part: string) => !part || part === '.' || part === '..') ||
            !Number.isSafeInteger(object.size_bytes) || object.size_bytes < 0 ||
            typeof object.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(object.sha256)) {
          throw new Error('Restore failed: unsafe or invalid storage object entry in manifest.');
        }
        if (restoredStorageRefs.has(object.key)) throw new Error(`Restore failed: duplicate storage key ${object.key}.`);

        const localPath = path.resolve(storageDir, ...object.key.split('/'));
        const relativePath = path.relative(path.resolve(storageDir), localPath);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) throw new Error('Restore failed: storage path escapes staging directory.');
        const stat = await fs.promises.stat(localPath).catch(() => null);
        if (!stat?.isFile() || stat.size !== object.size_bytes) throw new Error(`Restore failed: storage object missing or size mismatch: ${object.key}.`);
        const actualSha256 = await computeFileSha256(localPath);
        if (actualSha256.toLowerCase() !== object.sha256.toLowerCase()) throw new Error(`Restore failed: storage checksum mismatch: ${object.key}.`);

        const companyKey = object.key.match(/^company\/([^/]+)\/(.+)$/);
        const stagedKey = companyKey
          ? `company/${companyKey[1]}/restore-generations/${restoreId}/${companyKey[2]}`
          : `restore-generations/${restoreId}/${object.key}`;
        stagedStorageKeys.push(stagedKey);
        await storage.put(fs.createReadStream(localPath), stagedKey, { sizeBytes: object.size_bytes });
        if (!(await storage.exists(stagedKey))) throw new Error(`Restore failed: staged storage object is not readable: ${object.key}.`);
        const stagedObject = await storage.get(stagedKey);
        if (stagedObject.contentLength !== undefined && stagedObject.contentLength !== object.size_bytes) {
          throw new Error(`Restore failed: staged storage size mismatch: ${object.key}.`);
        }
        const stagedSha256 = await computeReadableSha256(stagedObject.stream);
        if (stagedSha256.toLowerCase() !== object.sha256.toLowerCase()) {
          throw new Error(`Restore failed: staged storage checksum mismatch: ${object.key}.`);
        }
        restoredStorageRefs.set(object.key, stagedKey);
        stagedStorageBytes += object.size_bytes;
      }
      if (manifest.storage.objects.length !== manifest.storage.objects_count || stagedStorageBytes !== manifest.storage.total_bytes) {
        throw new Error('Restore failed: storage object count or total size does not match the manifest.');
      }

      let verifiedReferences = 0;
      const storageRefCollections = new Set(['documents', 'documentversions', 'appreleases', 'idempotencykeys']);
      for (const collectionName of storageRefCollections) {
        const docs = restoredCollections[collectionName] || [];
        for (const doc of docs) {
          if (!doc.storage_ref) continue;
          const stagedKey = restoredStorageRefs.get(doc.storage_ref);
          if (!stagedKey) throw new Error(`Restore failed: referenced storage object is absent from archive: ${doc.storage_ref}.`);
          doc.storage_ref = stagedKey;
          verifiedReferences += 1;
        }
      }

      // The live database state, restore status, and success audit event switch in one
      // replica-set transaction. If any write fails, MongoDB aborts all collection changes.
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          for (const [collectionName, model] of Object.entries(ALL_COLLECTION_MODELS)) {
            await model.deleteMany({}, { session });
            const docs = restoredCollections[collectionName];
            for (let offset = 0; offset < docs.length; offset += 500) {
              await model.insertMany(docs.slice(offset, offset + 500), { session, ordered: true });
            }
          }

          await AuditEventModel.create([{
            actor_user_id: options.actorUserId,
            action: 'restore.execute',
            result: AuditResult.success,
            target_type: 'platform_restore',
            target_id: restoreRecordId,
            meta: {
              backup_id: backup.backup_id,
              safety_backup_id: safetyBackupId || null,
              verified_references: verifiedReferences,
              restored_storage_objects: restoredStorageRefs.size,
            },
          }], { session });

          completedRecord = await PlatformRestoreModel.findByIdAndUpdate(
            restoreRecordId,
            { $set: {
              status: 'completed',
              db_restore_status: 'completed',
              storage_restore_status: 'completed',
              completed_at: new Date(),
              duration_ms: Date.now() - startTime,
              verified_references_count: verifiedReferences,
              missing_storage_objects_count: 0,
              reference_check_passed: true,
              safety_backup_id: safetyBackupId || null,
              details: {
                restored_collections: manifest.database.collections,
                restored_storage_objects: restoredStorageRefs.size,
                storage_generation: `restore-generations/${restoreId}`,
              },
            } },
            { new: true, session }
          ) as PlatformRestoreDocument | null;
          if (!completedRecord) throw new Error('Restore record disappeared before transaction commit.');
        }, {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
          maxCommitTimeMS: 60_000,
        });
        committed = true;
      } finally {
        await session.endSession();
      }

      if (!completedRecord) throw new Error('Restore transaction completed without a final restore record.');
      return completedRecord;
    } catch (err: any) {
      console.error('[BackupService] Staged restore failed:', err);
      if (!committed) {
        for (const key of stagedStorageKeys.reverse()) {
          try { await storage.delete(key); } catch (cleanupErr) {
            console.error(`[BackupService] Could not remove unreferenced staged object ${key}:`, cleanupErr);
          }
        }
        await updateRestoreRecord({
          status: 'failed',
          error_message: err.message || 'Unknown restore error',
          duration_ms: Date.now() - startTime,
          reference_check_passed: false,
        }).catch((recordErr) => console.error('[BackupService] Could not mark restore failed:', recordErr));
        await auditService.record({
          action: 'restore.execute',
          result: AuditResult.failure,
          targetType: 'platform_restore',
          targetId: restoreRecordId,
          meta: { backup_id: backup.backup_id, error: err.message },
        }).catch((auditErr) => console.error('[BackupService] Could not write restore failure audit:', auditErr));
      }
      throw err;
    } finally {
      await fs.promises.rm(restoreStagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Deletes a backup archive while enforcing safety rules.
   */
  async deleteBackup(backupRecordId: string, options: { actorUserId: string; actorEmail: string }): Promise<void> {
    const backup = await PlatformBackupModel.findById(backupRecordId);
    if (!backup) {
      throw new NotFoundError('Backup record not found');
    }

    // Safety guard 0: Never delete safety or locked backups
    if (backup.is_locked || backup.backup_type === 'safety') {
      throw new DomainError('Safety guard: Cannot delete a locked or safety backup archive.', 400);
    }

    // Safety rule 1: Never delete the only verified backup
    if (backup.status === 'verified') {
      const remainingVerified = await PlatformBackupModel.countDocuments({
        _id: { $ne: backup._id },
        status: 'verified',
      });
      if (remainingVerified === 0) {
        throw new DomainError('Safety guard: Cannot delete the only remaining verified backup in the system.', 400);
      }
    }

    // Safety rule 2: Never delete a backup actively used by a running restore
    const activeRestore = await PlatformRestoreModel.findOne({
      backup_id: backup.backup_id,
      status: { $in: ['pending', 'running'] },
    });
    if (activeRestore) {
      throw new ConflictError('Cannot delete backup: An active restore operation is currently using this backup.');
    }

    // Physical file deletion
    if (backup.archive_path && fs.existsSync(backup.archive_path)) {
      try {
        fs.unlinkSync(backup.archive_path);
      } catch (err) {
        console.warn(`[BackupService] Warning: Could not delete archive file ${backup.archive_path}:`, err);
      }
    }

    await PlatformBackupModel.findByIdAndDelete(backup._id);

    await auditService.record({
      action: 'backup.delete',
      result: AuditResult.success,
      targetType: 'platform_backup',
      targetId: backup._id,
      meta: {
        backup_id: backup.backup_id,
        archive_filename: backup.archive_filename,
        actor_user_id: options.actorUserId,
      },
    });
  }

  /**
   * Returns a comprehensive disaster recovery overview with RPO and RTO compliance.
   */
  async getOverview(): Promise<any> {
    const totalBackups = await PlatformBackupModel.countDocuments();
    const verifiedBackups = await PlatformBackupModel.countDocuments({ status: 'verified' });
    const latestVerified = await PlatformBackupModel.findOne({ status: 'verified' }).sort({ createdAt: -1 });

    const rpoStatusObj = checkBackupRpo(this.getBackupDir(), 4);
    const rtoStatusObj = evaluateRto(latestVerified?.duration_ms || 1200, 2);

    let scheduleConfig = await PlatformBackupConfigModel.findById('platform-backup-global-config');
    if (!scheduleConfig) {
      scheduleConfig = await PlatformBackupConfigModel.create({
        _id: 'platform-backup-global-config',
      });
    }

    const rpoState: 'compliant' | 'warning' | 'critical' = rpoStatusObj.compliant
      ? 'compliant'
      : (rpoStatusObj.actualAgeHours && rpoStatusObj.actualAgeHours <= 8 ? 'warning' : 'critical');

    return {
      totalBackups,
      verifiedBackups,
      lastBackupAt: latestVerified?.createdAt?.toISOString?.() || (rpoStatusObj.lastBackupTime ? new Date(rpoStatusObj.lastBackupTime).toISOString() : null),
      lastSuccessfulBackup: latestVerified ? formatBackupRecord(latestVerified) : null,
      activeRestores: await PlatformRestoreModel.countDocuments({ status: { $in: ['pending', 'running'] } }),
      rpoStatus: rpoState,
      rpoHoursSinceLastBackup: rpoStatusObj.actualAgeHours ?? 0,
      targetRpoHours: 4,
      targetRtoHours: 2,
      estimatedRtoMinutes: rtoStatusObj.estimatedRestoreMinutes || 15,
      config: {
        scheduledIntervalHours: scheduleConfig.schedule_interval_hours || 4,
        retentionDaily: scheduleConfig.retention_daily || 7,
        retentionWeekly: scheduleConfig.retention_weekly || 4,
        retentionMonthly: scheduleConfig.retention_monthly || 3,
        isEncryptionEnabled: Boolean(scheduleConfig.encryption_enabled),
        autoVerifyOnBackup: true,
      },
      recentRestores: (await PlatformRestoreModel.find().sort({ started_at: -1 }).limit(10).lean()).map(formatRestoreRecord),
      rpoDetails: rpoStatusObj,
      rtoDetails: rtoStatusObj,
      scheduleConfig,
    };
  }
}

export function formatBackupRecord(b: any) {
  const doc = b && typeof b.toObject === 'function' ? b.toObject() : (b || {});
  return {
    ...doc,
    backupId: doc.backup_id,
    type: doc.backup_type,
    status: doc.status,
    dbStatus: doc.db_status,
    storageStatus: doc.storage_status,
    filename: doc.archive_filename,
    archiveSizeBytes: doc.size_bytes,
    sha256Checksum: doc.checksum_sha256,
    isEncrypted: Boolean(doc.archive_path?.endsWith('.enc')),
    retentionTier: doc.is_locked ? 'locked' : (doc.backup_type === 'safety' ? 'locked' : 'daily'),
    isSafetyBackup: doc.backup_type === 'safety',
    isRestoreLocked: Boolean(doc.is_locked),
    durationMs: doc.duration_ms,
    createdAt: doc.createdAt || doc.created_at,
  };
}

export function formatRestoreRecord(r: any) {
  const doc = r && typeof r.toObject === 'function' ? r.toObject() : (r || {});
  return {
    ...doc,
    restoreId: doc._id?.toString?.() || doc.restore_id,
    backupId: doc.backup_id,
    status: doc.status,
    dbStatus: doc.db_restore_status,
    storageStatus: doc.storage_restore_status,
    referenceVerificationStatus: doc.missing_storage_objects_count === 0 ? 'passed' : 'failed',
    safetyBackupId: doc.safety_backup_id,
    startedAt: doc.started_at,
    completedAt: doc.completed_at,
    durationMs: doc.duration_ms,
  };
}

export const backupService = new BackupService();
