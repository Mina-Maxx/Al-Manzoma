import crypto from 'crypto';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { config } from '../../config/index.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits for GCM

/**
 * Derives a consistent 32-byte (256-bit) encryption key from the provided secret
 * or from configured application secrets.
 */
export function deriveKey(secret?: string): Buffer {
  const effectiveSecret =
    secret ||
    config.backupEncryptionKey ||
    config.jwtSecret ||
    'quarryvault-default-backup-encryption-key-salt';
  return crypto.createHash('sha256').update(effectiveSecret).digest();
}

/**
 * Computes SHA-256 checksum of a file on disk via streaming.
 */
export async function computeFileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Encrypts a file using AES-256-GCM into a self-contained encrypted container.
 * Format: [12-byte IV][16-byte Auth Tag][Ciphertext]
 */
export async function encryptFile(
  srcPath: string,
  destPath: string,
  key: Buffer = deriveKey()
): Promise<void> {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const inputStream = fs.createReadStream(srcPath);
  const chunks: Buffer[] = [];

  for await (const chunk of inputStream) {
    chunks.push(cipher.update(chunk as Buffer));
  }
  chunks.push(cipher.final());
  const tag = cipher.getAuthTag();

  // Write IV + Tag + Ciphertext
  const outStream = fs.createWriteStream(destPath);
  outStream.write(iv);
  outStream.write(tag);
  for (const chunk of chunks) {
    outStream.write(chunk);
  }
  await new Promise<void>((resolve, reject) => {
    outStream.end(() => resolve());
    outStream.on('error', reject);
  });
}

/**
 * Decrypts a self-contained AES-256-GCM container file.
 */
export async function decryptFile(
  srcPath: string,
  destPath: string,
  key: Buffer = deriveKey()
): Promise<void> {
  const stat = await fs.promises.stat(srcPath);
  if (stat.size < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Encrypted file is corrupt or invalid (size too small)');
  }

  const fd = await fs.promises.open(srcPath, 'r');
  const iv = Buffer.alloc(IV_LENGTH);
  const tag = Buffer.alloc(TAG_LENGTH);

  await fd.read(iv, 0, IV_LENGTH, 0);
  await fd.read(tag, 0, TAG_LENGTH, IV_LENGTH);
  await fd.close();

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const inputStream = fs.createReadStream(srcPath, {
    start: IV_LENGTH + TAG_LENGTH,
  });
  const outputStream = fs.createWriteStream(destPath);

  await pipeline(inputStream, decipher, outputStream);
}
