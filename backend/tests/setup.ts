import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeAll, afterAll, beforeEach } from 'vitest';

let mongoServer: MongoMemoryReplSet | null = null;
if (process.env.NODE_ENV !== 'test') {
  throw new Error('Backend tests require NODE_ENV=test so external storage adapters cannot be selected.');
}
const testStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quarryvault-test-storage-'));
const testBackupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quarryvault-test-backups-'));
process.env.QUARRYVAULT_TEST_STORAGE_ROOT = testStorageRoot;
process.env.BACKUP_STORAGE_DIR = testBackupRoot;

beforeAll(async () => {
  if (process.env.TEST_MONGODB_URI) {
    throw new Error('External TEST_MONGODB_URI is disabled for safety; tests must use the isolated MongoMemoryServer.');
  }
  // Permission updates use MongoDB transactions to commit membership,
  // quarry overrides, and their audit event together.
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri('quarryvault_test'), { serverSelectionTimeoutMS: 5000 });
});

afterAll(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
  }
  if (mongoServer) await mongoServer.stop();
  fs.rmSync(testStorageRoot, { recursive: true, force: true });
  fs.rmSync(testBackupRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  if (mongoose.connection.readyState === 1) {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  }
});
