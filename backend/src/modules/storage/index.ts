import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppConfig, config } from '../../config/index.js';

export interface StorageResult {
  stream: NodeJS.ReadableStream;
  contentLength?: number;
  contentType?: string;
  sha256?: string;
}

export interface StorageAdapter {
  put(
    content: Buffer | NodeJS.ReadableStream,
    key: string,
    options?: { contentType?: string; sizeBytes?: number }
  ): Promise<string>;
  get(key: string): Promise<StorageResult>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getPresignedDownloadUrl?(key: string, expiresInSeconds?: number): Promise<string>;
}

/**
 * Builds a strict tenant-isolated logical storage key using UUID identifiers only.
 * Guaranteed no directory traversal.
 */
export function buildStorageKey(companyId: string, quarryId: string, docId: string, version?: number): string {
  // Strip any illegal characters or traversal attempts
  const safeCompany = companyId.replace(/[^a-zA-Z0-9-]/g, '');
  const safeQuarry = quarryId.replace(/[^a-zA-Z0-9-]/g, '');
  const safeDoc = docId.replace(/[^a-zA-Z0-9-]/g, '');
  const versionSuffix = version && version > 1 ? `_v${version}` : '';
  return `company/${safeCompany}/quarry/${safeQuarry}/${safeDoc}${versionSuffix}`;
}

/**
 * Cloudflare R2 Storage Adapter using AWS S3 SDK v3
 */
export class CloudflareR2Storage implements StorageAdapter {
  private client: S3Client;
  private bucket: string;

  constructor(cfg: AppConfig) {
    this.bucket = cfg.r2BucketName;
    const endpoint = cfg.r2Endpoint || (cfg.r2AccountId ? `https://${cfg.r2AccountId}.r2.cloudflarestorage.com` : undefined);

    this.client = new S3Client({
      region: cfg.r2Region || 'auto',
      endpoint: endpoint,
      credentials: {
        accessKeyId: cfg.r2AccessKeyId || '',
        secretAccessKey: cfg.r2SecretAccessKey || '',
      },
    });
  }

  async put(
    content: Buffer | NodeJS.ReadableStream,
    key: string,
    options?: { contentType?: string; sizeBytes?: number }
  ): Promise<string> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content as any,
        ContentType: options?.contentType || 'application/octet-stream',
        ContentLength: options?.sizeBytes,
      });

      await this.client.send(command);
      return key;
    } catch (error) {
      console.error(`[R2Storage] Put failed for key ${key}:`, error);
      throw new Error(`Cloudflare R2 storage write failed: ${(error as Error).message}`);
    }
  }

  async get(key: string): Promise<StorageResult> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.client.send(command);
      if (!response.Body) {
        throw new Error(`Empty body returned from storage for key ${key}`);
      }

      return {
        stream: response.Body as NodeJS.ReadableStream,
        contentLength: response.ContentLength,
        contentType: response.ContentType,
      };
    } catch (error: any) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        throw new Error('Object not found in storage');
      }
      console.error(`[R2Storage] Get failed for key ${key}:`, error);
      throw new Error(`Cloudflare R2 storage read failed: ${error.message}`);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.client.send(command);
    } catch (error) {
      console.error(`[R2Storage] Delete error for key ${key}:`, error);
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      await this.client.send(command);
      return true;
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      return false;
    }
  }

  async getPresignedDownloadUrl(key: string, expiresInSeconds: number = 300): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }
}

/**
 * Local Disk Storage for development, testing, and offline modes.
 */
export class LocalDiskStorage implements StorageAdapter {
  private root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
    if (!fs.existsSync(this.root)) {
      fs.mkdirSync(this.root, { recursive: true });
    }
  }

  private resolvePath(key: string): string {
    const safeKey = key.replace(/\.\./g, '').replace(/^\/+/, '');
    return path.join(this.root, safeKey);
  }

  async put(
    content: Buffer | NodeJS.ReadableStream,
    key: string,
    _options?: { contentType?: string }
  ): Promise<string> {
    const dest = this.resolvePath(key);
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (Buffer.isBuffer(content)) {
      await fs.promises.writeFile(dest, content);
    } else {
      const out = fs.createWriteStream(dest);
      await new Promise<void>((resolve, reject) => {
        (content as Readable).pipe(out);
        out.on('finish', () => resolve());
        out.on('error', (err) => reject(err));
      });
    }

    return key;
  }

  async get(key: string): Promise<StorageResult> {
    const filepath = this.resolvePath(key);
    if (!fs.existsSync(filepath)) {
      throw new Error('Object not found in storage');
    }

    const stat = await fs.promises.stat(filepath);
    const stream = fs.createReadStream(filepath);

    return {
      stream,
      contentLength: stat.size,
    };
  }

  async delete(key: string): Promise<void> {
    const filepath = this.resolvePath(key);
    if (fs.existsSync(filepath)) {
      await fs.promises.unlink(filepath);
    }
  }

  async exists(key: string): Promise<boolean> {
    const filepath = this.resolvePath(key);
    return fs.existsSync(filepath);
  }
}

export function createStorage(cfg: AppConfig = config): StorageAdapter {
  const isProd = cfg.env === 'production';

  if (cfg.storageBackend === 'r2' || cfg.storageBackend === 's3') {
    if (!cfg.r2AccessKeyId || !cfg.r2SecretAccessKey) {
      if (isProd) {
        throw new Error(
          'Fatal: Cloudflare R2 credentials (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) are missing in production. Silent local disk fallback is strictly prohibited in production.'
        );
      }
      console.warn('[STORAGE WARNING] R2 credentials missing; falling back to local disk in non-production environment.');
      return new LocalDiskStorage(cfg.storageLocalRoot);
    }
    return new CloudflareR2Storage(cfg);
  }

  if (isProd && cfg.storageBackend === 'local') {
    throw new Error(
      'Fatal: STORAGE_BACKEND=local is not permitted in production. Cloudflare R2 must be configured (STORAGE_BACKEND=r2).'
    );
  }

  return new LocalDiskStorage(cfg.storageLocalRoot);
}

const isolatedTestStorageRoot = process.env.NODE_ENV === 'test'
  ? process.env.QUARRYVAULT_TEST_STORAGE_ROOT
  : undefined;

if (process.env.NODE_ENV === 'test' && !isolatedTestStorageRoot) {
  throw new Error('Backend tests require QUARRYVAULT_TEST_STORAGE_ROOT; refusing configured external storage.');
}

export const storage = process.env.NODE_ENV === 'test'
  ? new LocalDiskStorage(isolatedTestStorageRoot!)
  : createStorage();
