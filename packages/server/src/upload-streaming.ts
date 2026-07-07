/**
 * Streaming upload primitives.
 *
 * Extracted from `api-extension.ts` for clarity + unit-testability.
 * in short: busboy's 'file' event emits a Node Readable that we pipe
 * through a HashingPassThrough Transform into createWriteStream(tempPath),
 * giving us O(1) memory, on-the-fly sha256, and a typed-error cleanup
 * path via stream.pipeline().
 *
 * Four primitives:
 *
 *  - HashingPassThrough: a 5-line Transform that side-effects sha256.update()
 *    while passing bytes through unchanged. digest() throws if called pre-
 *    'finish' to avoid half-computed-hash footguns. byteLength() is safe at
 *    any time; useful for dedup size-prefilter.
 *
 *  - tmpUploadDir / mintTempUploadPath: name a unique tempfile under
 *    <projectDir>/.ok/local/tmp/. Same-filesystem guarantee for the
 *    eventual link → atomic rename equivalence on POSIX (no EXDEV).
 *
 *  - linkTempToFinalWithCollisionRetry: atomic create-if-not-exists via
 *    linkSync (throws EEXIST on collision). Preserves api-extension's
 *    existing 99-attempt suffix-retry semantic. POSIX rename(2) overwrites
 *    by default — link(2) is the cross-platform way to preserve the
 *    "first writer wins at this filename" contract.
 *
 *  - cleanupOrphanUploadTempfiles: boot-time sweep for orphaned tempfiles
 *    older than the threshold. Mirrors the shape of
 *    recoverPendingManagedRename in server-factory.ts — runs once at startup,
 *    logs and continues on per-entry errors.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { getLocalDir } from './config/paths.ts';
import { tracedLinkSync, tracedMkdirSync, tracedUnlinkSync } from './fs-traced.ts';

import { getLogger } from './logger.ts';
import { UploadWriteError } from './upload-errors.ts';

const log = getLogger('upload-streaming');

/**
 * sha256 pass-through Transform: hashes every chunk as it flows, emits
 * bytes unchanged downstream. `digest()` finalizes the hash and is
 * one-shot — calling twice throws. `byteLength()` returns running total;
 * final value is stable after 'finish'.
 *
 * Usage:
 *
 *   const hasher = new HashingPassThrough();
 *   await pipeline(busboyFileStream, hasher, createWriteStream(tempPath));
 *   const sha = hasher.digest();        // sha256 hex
 *   const size = hasher.byteLength();   // bytes observed
 */
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

/**
 * <projectDir>/.ok/local/tmp — parks upload tempfiles beside the
 * server lock + shadow repo, same-filesystem as the final destination so
 * linkSync is always atomic (no EXDEV risk across mount boundaries).
 *
 * Lives at the project root rather than inside the content sub-folder so
 * one project presents a single `.ok/local/` regardless of `content.dir`.
 */
export function tmpUploadDir(projectDir: string): string {
  return resolve(getLocalDir(projectDir), 'tmp');
}

/**
 * Lazily-create the tmp dir on first call, return a unique path inside it.
 * UUID guarantees no intra-process collision; cross-process collision
 * risk is handled by linkTempToFinalWithCollisionRetry later.
 */
export function mintTempUploadPath(projectDir: string): string {
  const dir = tmpUploadDir(projectDir);
  tracedMkdirSync(dir, { recursive: true });
  return resolve(dir, `upload-${randomUUID()}`);
}

/**
 * Atomic rename-equivalent via hardlink + unlink. Preserves the same
 * collision-retry semantic as the buffer-era `writeUploadAtomic` — first
 * the sanitized name, then `${stem}-1${ext}`, … `${stem}-99${ext}`. On
 * success, returns the basename that won; on EEXIST on all 100 slots,
 * throws `UploadWriteError('collision-exhaustion')`. On any other link
 * error, classifies via UploadWriteError's union and best-effort unlinks
 * the tempfile before propagating.
 *
 * Why linkSync not renameSync: POSIX rename(2) overwrites by default,
 * breaking the "first writer wins at this filename" contract. link(2)
 * is atomic create-if-not-exists cross-platform (throws EEXIST on
 * collision, always).
 */
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
      // Link succeeded; tempfile is now consumed by the inode — unlink the
      // tmp name (the file survives via its second link at destPath).
      try {
        tracedUnlinkSync(tempPath);
      } catch {
        // Best-effort; if this throws the final file is already in place
        // and the tmp name will be reaped by the boot-time orphan sweep.
      }
      return name;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue;

      // Any non-EEXIST error terminates the retry — unlink the tempfile
      // and propagate a typed error. Best-effort unlink because the error
      // we're reporting (e.g. storage-full) takes priority.
      try {
        tracedUnlinkSync(tempPath);
      } catch {
        // silent — original err is the signal
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

  // Exhausted all 100 candidate names. Best-effort cleanup + signal.
  try {
    tracedUnlinkSync(tempPath);
  } catch {
    // tempfile will be reaped by boot-time orphan sweep
  }
  throw new UploadWriteError('urn:ok:error:collision-exhaustion');
}

/**
 * Boot-time sweep for orphaned upload tempfiles. Runs once at server
 * startup — mirrors the shape of recoverPendingManagedRename in
 * server-factory.ts. Non-throwing: individual unlink failures are logged and
 * counted, never propagate.
 *
 * Default age threshold: 24h. Matches the grace window OK uses elsewhere
 * for stale-resource reclamation (shadow-branch GC). Anything younger is
 * likely still being written to — leave it to the normal cleanup path.
 */
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
    // Only sweep our own upload-* tempfiles — don't touch unrelated
    // artifacts a future subsystem might park under .ok/local/tmp/.
    if (!name.startsWith('upload-')) continue;
    result.scanned++;

    const full = resolve(dir, name);
    try {
      const stat = statSync(full);
      if (stat.mtimeMs >= threshold) {
        // Still within grace — could be an in-flight upload from a concurrent
        // process. Skip.
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
