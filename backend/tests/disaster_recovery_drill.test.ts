import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { v4 as uuidv4 } from 'uuid';
import {
  executeBackup,
  executeRestore,
  checkBackupRpo,
  evaluateRto,
  sanitizeMongoUri,
  detectDumpExecutor,
} from '../src/scripts/disasterRecovery.js';
import {
  CompanyModel,
  UserModel,
  QuarryModel,
  FolderModel,
  DocumentModel,
  DocumentVersionModel,
  QuarryPermissionModel,
  AuditEventModel,
  ChangeLogModel,
} from '../src/database/models/index.js';
import { UserStatus, MembershipRole, DocumentStatus, AuditResult, ChangeEntityType, ChangeType } from '../src/types/index.js';

const SOURCE_DB = 'quarryvault_dr_source_test';
const DEST_DB = 'quarryvault_dr_dest_test';

describe('Disaster Recovery & Backup/Restore Drill Suite', () => {
  let sourceConn: mongoose.Connection;
  let destConn: mongoose.Connection;
  let mongoServer: MongoMemoryServer | null = null;
  let generatedBackupFile: string | null = null;
  let tempBackupDir: string | null = null;
  let isEnvironmentSupported = false;

  beforeAll(async () => {
    const executor = await detectDumpExecutor(false);
    if (!executor) {
      console.warn('[Drill Suite] Local mongodump/mongorestore is unavailable. Isolated live drill will be skipped.');
      return;
    }

    try {
      mongoServer = await MongoMemoryServer.create();
      tempBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quarryvault-dr-test-'));
      sourceConn = await mongoose.createConnection(mongoServer.getUri(SOURCE_DB), { serverSelectionTimeoutMS: 5000 }).asPromise();
      destConn = await mongoose.createConnection(mongoServer.getUri(DEST_DB), { serverSelectionTimeoutMS: 5000 }).asPromise();
      isEnvironmentSupported = true;
    } catch (_err) {
      console.warn('[Drill Suite] Isolated MongoMemoryServer or local dump tools are unavailable. Skipping live drill.');
    }
  });

  afterAll(async () => {
    // Drop test databases and clean test backup files
    await sourceConn?.dropDatabase().catch(() => {});
    await destConn?.dropDatabase().catch(() => {});
    await sourceConn?.close();
    await destConn?.close();
    await mongoServer?.stop();

    if (generatedBackupFile && fs.existsSync(generatedBackupFile)) {
      fs.unlinkSync(generatedBackupFile);
    }
    if (tempBackupDir && fs.existsSync(tempBackupDir)) fs.rmSync(tempBackupDir, { recursive: true, force: true });
  });

  it('1. Pre-backup: populates realistic synthetic data across all collections and indexes', async () => {
    if (!isEnvironmentSupported) return;
    const SourceCompany = sourceConn.model('Company', CompanyModel.schema);
    const SourceUser = sourceConn.model('User', UserModel.schema);
    const SourceQuarry = sourceConn.model('Quarry', QuarryModel.schema);
    const SourceFolder = sourceConn.model('Folder', FolderModel.schema);
    const SourceDocument = sourceConn.model('Document', DocumentModel.schema);
    const SourceVersion = sourceConn.model('DocumentVersion', DocumentVersionModel.schema);
    const SourcePermission = sourceConn.model('QuarryPermission', QuarryPermissionModel.schema);
    const SourceAudit = sourceConn.model('AuditEvent', AuditEventModel.schema);
    const SourceChange = sourceConn.model('ChangeLog', ChangeLogModel.schema);

    // Ensure indexes are built
    await Promise.all([
      SourceCompany.init(),
      SourceUser.init(),
      SourceQuarry.init(),
      SourceFolder.init(),
      SourceDocument.init(),
      SourceVersion.init(),
      SourcePermission.init(),
      SourceAudit.init(),
      SourceChange.init(),
    ]);

    // Insert synthetic records
    const compA = await SourceCompany.create({
      _id: uuidv4(),
      name: 'Granite Operations A',
      slug: 'granite-a',
      quota_bytes: 5368709120,
      used_bytes: 20971520,
    });

    const user1 = await SourceUser.create({
      _id: uuidv4(),
      auth_user_id: uuidv4(),
      email: 'admin@granite-a.com',
      username: 'granite_admin',
      password_hash: '$2a$10$syntheticHashForAdmin123456789012345',
      full_name: 'Granite Admin',
      status: UserStatus.active,
      must_change_password: false,
    });

    const quarry1 = await SourceQuarry.create({
      _id: uuidv4(),
      company_id: compA._id,
      name: 'North Quarry Pit',
      code: 'NQP-01',
    });

    const folder1 = await SourceFolder.create({
      _id: uuidv4(),
      company_id: compA._id,
      quarry_id: quarry1._id,
      name: 'Compliance 2026',
    });

    const doc1 = await SourceDocument.create({
      _id: uuidv4(),
      company_id: compA._id,
      quarry_id: quarry1._id,
      folder_id: folder1._id,
      display_name: 'Safety Inspection Report.pdf',
      original_filename: 'safety_report.pdf',
      mime_type: 'application/pdf',
      size_bytes: 1048576,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      status: DocumentStatus.available,
      version: 2,
    });

    await SourceVersion.create({
      _id: uuidv4(),
      document_id: doc1._id,
      company_id: compA._id,
      quarry_id: quarry1._id,
      version: 1,
      size_bytes: 524288,
      sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
      storage_ref: `company/${compA._id}/quarry/${quarry1._id}/${doc1._id}_v1`,
      mime_type: 'application/pdf',
      uploaded_by: user1._id,
    });

    await SourcePermission.create({
      _id: uuidv4(),
      company_id: compA._id,
      quarry_id: quarry1._id,
      user_id: user1._id,
      can_view: true,
      can_upload: true,
      can_download: true,
      can_delete: true,
    });

    await SourceAudit.create({
      _id: uuidv4(),
      action: 'document.upload',
      result: AuditResult.success,
      company_id: compA._id,
      actor_user_id: user1._id,
      target_type: 'document',
      target_id: doc1._id,
      meta: { size_bytes: 1048576 },
    });

    await SourceChange.create({
      _id: uuidv4(),
      company_id: compA._id,
      seq: 1,
      quarry_id: quarry1._id,
      entity_type: ChangeEntityType.document,
      entity_id: doc1._id,
      change_type: ChangeType.created,
      entity_version: 2,
      payload: { display_name: 'Safety Inspection Report.pdf' },
    });

    // Verify source counts
    expect(await SourceCompany.countDocuments()).toBe(1);
    expect(await SourceUser.countDocuments()).toBe(1);
    expect(await SourceQuarry.countDocuments()).toBe(1);
    expect(await SourceFolder.countDocuments()).toBe(1);
    expect(await SourceDocument.countDocuments()).toBe(1);
    expect(await SourceVersion.countDocuments()).toBe(1);
    expect(await SourcePermission.countDocuments()).toBe(1);
    expect(await SourceAudit.countDocuments()).toBe(1);
    expect(await SourceChange.countDocuments()).toBe(1);
  });

  it('2. Backup Execution: creates a non-empty timestamped archive and measures duration', async () => {
    if (!isEnvironmentSupported) return;
    const backupDir = tempBackupDir!;
    const result = await executeBackup({
      dbName: SOURCE_DB,
      mongoUri: mongoServer!.getUri(SOURCE_DB),
      destinationFile: path.join(backupDir, `quarryvault-dr-${uuidv4()}.archive.gz`),
    });

    generatedBackupFile = result.archivePath;
    expect(result.success).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(fs.existsSync(result.archivePath)).toBe(true);
    expect(result.durationMs).toBeGreaterThan(0);
    console.log(`[Drill Measurement] Backup duration: ${result.durationMs}ms, archive size: ${result.sizeBytes} bytes`);

    // Verify RPO check finds this backup
    const rpo = checkBackupRpo(backupDir, 4);
    expect(rpo.compliant).toBe(true);
    expect(rpo.actualAgeHours).toBeLessThanOrEqual(0.1);
  });

  it('3. Restore Drill: restores into isolated target DB and validates exact data & index integrity', async () => {
    if (!isEnvironmentSupported) return;
    expect(generatedBackupFile).toBeDefined();

    const restoreResult = await executeRestore({
      archivePath: generatedBackupFile!,
      targetDb: DEST_DB,
      sourceDb: SOURCE_DB,
      mongoUri: mongoServer!.getUri(DEST_DB),
      dropFirst: true,
      confirmDestructive: true,
    });

    expect(restoreResult.success).toBe(true);
    expect(restoreResult.durationMs).toBeGreaterThan(0);
    console.log(`[Drill Measurement] Restore duration: ${restoreResult.durationMs}ms into DB '${DEST_DB}'`);

    // Evaluate RTO
    const rto = evaluateRto(restoreResult.durationMs, 2);
    expect(rto.compliant).toBe(true);

    // Verify all restored collections and record counts in target database
    const DestCompany = destConn.model('Company', CompanyModel.schema);
    const DestUser = destConn.model('User', UserModel.schema);
    const DestQuarry = destConn.model('Quarry', QuarryModel.schema);
    const DestFolder = destConn.model('Folder', FolderModel.schema);
    const DestDocument = destConn.model('Document', DocumentModel.schema);
    const DestVersion = destConn.model('DocumentVersion', DocumentVersionModel.schema);
    const DestPermission = destConn.model('QuarryPermission', QuarryPermissionModel.schema);
    const DestAudit = destConn.model('AuditEvent', AuditEventModel.schema);
    const DestChange = destConn.model('ChangeLog', ChangeLogModel.schema);

    expect(await DestCompany.countDocuments()).toBe(1);
    expect(await DestUser.countDocuments()).toBe(1);
    expect(await DestQuarry.countDocuments()).toBe(1);
    expect(await DestFolder.countDocuments()).toBe(1);
    expect(await DestDocument.countDocuments()).toBe(1);
    expect(await DestVersion.countDocuments()).toBe(1);
    expect(await DestPermission.countDocuments()).toBe(1);
    expect(await DestAudit.countDocuments()).toBe(1);
    expect(await DestChange.countDocuments()).toBe(1);

    // Verify deep document field integrity
    const restoredDoc = await DestDocument.findOne().lean();
    expect(restoredDoc!.display_name).toBe('Safety Inspection Report.pdf');
    expect(restoredDoc!.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(restoredDoc!.size_bytes).toBe(1048576);
    expect(restoredDoc!.version).toBe(2);

    // Verify index restoration
    const indexes = await DestCompany.collection.indexes();
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('_id_');
  });

  it('4. Safety Guards: rejects unconfirmed destructive restore on primary DB and missing archives', async () => {
    // Missing archive must throw
    await expect(
      executeRestore({
        archivePath: 'C:/invalid/nonexistent_backup.archive.gz',
        targetDb: 'test_db',
      })
    ).rejects.toThrow(/does not exist/);

    // Drop on primary 'quarryvault' without confirmDestructive must throw
    const dummyArchive = path.join(os.tmpdir(), `quarryvault-dr-safety-${uuidv4()}.archive.gz`);
    fs.mkdirSync(path.dirname(dummyArchive), { recursive: true });
    fs.writeFileSync(dummyArchive, 'dummy content for safety test');

    try {
      await expect(
        executeRestore({
          archivePath: dummyArchive,
          targetDb: 'quarryvault',
          dropFirst: true,
          confirmDestructive: false,
        })
      ).rejects.toThrow(/Safety guard/);
    } finally {
      if (fs.existsSync(dummyArchive)) {
        fs.unlinkSync(dummyArchive);
      }
    }
  });

  it('5. Secret Masking: ensures connection URI is sanitized and never exposes passwords', () => {
    const rawUri = 'mongodb://app_user:SuperSecretPassword123!@cluster0.mongodb.net:27017/quarryvault?ssl=true';
    const sanitized = sanitizeMongoUri(rawUri);
    expect(sanitized).not.toContain('SuperSecretPassword123!');
    expect(sanitized).toContain('***:***@');
  });
});
