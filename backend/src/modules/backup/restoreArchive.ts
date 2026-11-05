import fs from 'node:fs';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar-stream';
import { pipeline } from 'node:stream/promises';

/**
 * Extracts a gzip-compressed tar archive into a new, private staging directory.
 * Only regular files and directories are accepted; links and special files are
 * deliberately rejected to prevent path traversal and link-based writes.
 */
export async function extractTarGzSafely(archivePath: string, destinationDir: string): Promise<void> {
  await fs.promises.mkdir(destinationDir, { recursive: true, mode: 0o700 });

  const parser = extract();
  const gunzip = createGunzip();
  const input = fs.createReadStream(archivePath);
  const seenFiles = new Set<string>();
  let entries = 0;

  const completion = new Promise<void>((resolve, reject) => {
    parser.once('finish', resolve);
    parser.once('error', reject);
    gunzip.once('error', (error) => parser.destroy(error));
    input.once('error', (error) => parser.destroy(error));
  });

  parser.on('entry', (header, entryStream, next) => {
    void (async () => {
      try {
        entries += 1;
        if (entries > 100_000) throw new Error('Backup archive exceeds the 100,000-entry safety limit.');

        const name = header.name;
        if (!name || name.includes('\0') || name.includes('\\') || path.posix.isAbsolute(name) || path.win32.isAbsolute(name)) {
          throw new Error(`Unsafe path in backup archive: ${JSON.stringify(name)}`);
        }

        const normalized = name.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
        if (!normalized || normalized === '.') {
          entryStream.resume();
          entryStream.once('end', () => next());
          return;
        }

        const segments = normalized.split('/');
        if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /^[a-zA-Z]:/.test(segment))) {
          throw new Error(`Unsafe path in backup archive: ${JSON.stringify(name)}`);
        }

        const target = path.resolve(destinationDir, ...segments);
        const relative = path.relative(path.resolve(destinationDir), target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`Backup archive path escapes staging directory: ${JSON.stringify(name)}`);
        }

        if (header.type === 'directory') {
          await fs.promises.mkdir(target, { recursive: true, mode: 0o700 });
          entryStream.resume();
          entryStream.once('end', () => next());
          return;
        }

        if (header.type !== 'file' && header.type !== 'contiguous-file') {
          throw new Error(`Unsupported archive entry type "${header.type}" for ${JSON.stringify(name)}.`);
        }
        if (!Number.isSafeInteger(header.size) || header.size < 0) {
          throw new Error(`Invalid file size for archive entry ${JSON.stringify(name)}.`);
        }
        if (seenFiles.has(relative)) throw new Error(`Duplicate file in backup archive: ${JSON.stringify(name)}`);
        seenFiles.add(relative);

        await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await pipeline(entryStream as any, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
        const actualSize = (await fs.promises.stat(target)).size;
        if (actualSize !== header.size) throw new Error(`Truncated archive entry ${JSON.stringify(name)}.`);
        next();
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        next(cause);
        parser.destroy(cause);
      }
    })();
  });

  input.pipe(gunzip).pipe(parser as any);
  await completion;
}
