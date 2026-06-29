import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { getLocalDir } from './config/paths.ts';
import { tracedLinkSync, tracedMkdirSync, tracedUnlinkSync } from './fs-traced.ts';

import { getLogger } from './logger.ts';
import { UploadWriteError } from './upload-errors.ts';

const log = getLogger('upload-streaming');

export class HashingPassThrough extends Transform {
  private readonly hash = createHash('sha256');
  private bytes = 0;
  private digested = false;

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    cb(null, chunk);
  }

  digest(): string {
    if (this.digested) {
      throw new Error('HashingPassThrough.digest() already called');
    }
    this.digested = true;
    return this.hash.digest('hex');
  }

  byteLength(): number {
    return this.bytes;
  }
}

export function tmpUploadDir(projectDir: string): string {
  return resolve(getLocalDir(projectDir), 'tmp');
}

export function mintTempUploadPath(projectDir: string): string {
  const dir = tmpUploadDir(projectDir);
  tracedMkdirSync(dir, { recursive: true });
  return resolve(dir, `upload-${randomUUID()}`);
}

export function linkTempToFinalWithCollisionRetry(
  tempPath: string,
  destDir: string,
  sanitized: string,
): string {
  const ext = extname(sanitized);
  const stem = sanitized.slice(0, sanitized.length - ext.length);
  const candidates = [sanitized, ...Array.from({ length: 99 }, (_, i) => `${stem}-${i + 1}${ext}`)];

  for (const name of candidates) {
    const destPath = resolve(destDir, name);
    try {
      tracedLinkSync(tempPath, destPath);
      try {
        tracedUnlinkSync(tempPath);
      } catch {
      }
      return name;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue;

      try {
        tracedUnlinkSync(tempPath);
      } catch {
      }

      if (code === 'ENOSPC' || code === 'EDQUOT') {
        throw new UploadWriteError('urn:ok:error:storage-full', err);
      }
      if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
        throw new UploadWriteError('urn:ok:error:storage-readonly', err);
      }
      throw new UploadWriteError('urn:ok:error:storage-error', err);
    }
  }

  try {
    tracedUnlinkSync(tempPath);
  } catch {
  }
  throw new UploadWriteError('urn:ok:error:collision-exhaustion');
}

export function cleanupOrphanUploadTempfiles(
  projectDir: string,
  { ageMs = 24 * 60 * 60 * 1000 }: { ageMs?: number } = {},
): { scanned: number; deleted: number; errors: number } {
  const dir = tmpUploadDir(projectDir);
  const result = { scanned: 0, deleted: 0, errors: 0 };

  if (!existsSync(dir)) {
    return result;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    log.warn({ err, dir }, '[upload-tempfile-sweep] readdir failed');
    result.errors++;
    return result;
  }

  const now = Date.now();
  const threshold = now - ageMs;

  for (const name of entries) {
    if (!name.startsWith('upload-')) continue;
    result.scanned++;

    const full = resolve(dir, name);
    try {
      const stat = statSync(full);
      if (stat.mtimeMs >= threshold) {
        continue;
      }
      tracedUnlinkSync(full);
      result.deleted++;
    } catch (err) {
      log.warn({ err, path: full }, '[upload-tempfile-sweep] entry failed');
      result.errors++;
    }
  }

  if (result.deleted > 0 || result.errors > 0) {
    log.info(
      { dir, scanned: result.scanned, deleted: result.deleted, errors: result.errors },
      `[upload-tempfile-sweep] swept ${result.deleted}/${result.scanned} (errors: ${result.errors})`,
    );
  }

  return result;
}
