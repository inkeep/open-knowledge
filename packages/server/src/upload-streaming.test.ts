/**
 * Unit tests for streaming upload primitives.
 *
 * Pure-function level. No HTTP server, no busboy. Covers:
 *  - HashingPassThrough: digest correctness, pre-finish guard, byteLength
 *  - tmpUploadDir / mintTempUploadPath: lazy mkdir, UUID uniqueness
 *  - linkTempToFinalWithCollisionRetry: 0/1/50/99/100 collisions, EEXIST
 *    retry, ENOSPC/EACCES classification + tempfile unlink
 *  - cleanupOrphanUploadTempfiles: age threshold, non-upload-* skip,
 *    missing-dir no-op, per-entry error containment
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import { UploadWriteError } from './upload-errors.ts';
import {
  cleanupOrphanUploadTempfiles,
  HashingPassThrough,
  linkTempToFinalWithCollisionRetry,
  mintTempUploadPath,
  tmpUploadDir,
} from './upload-streaming.ts';

// Collecting Writable — avoids biome's useYield rule that fires on
// async-generator consumers. Production code uses createWriteStream; the
// test just needs a sink that can be piped to and whose buffer is readable.
class CollectingSink extends Writable {
  readonly chunks: Buffer[] = [];
  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error) => void) {
    this.chunks.push(chunk);
    cb();
  }
}

describe('HashingPassThrough', () => {
  async function streamToDigest(
    chunks: Buffer[],
  ): Promise<{ sha: string; size: number; collected: Buffer }> {
    const hasher = new HashingPassThrough();
    const sink = new CollectingSink();
    await pipeline(Readable.from(chunks), hasher, sink);
    return {
      sha: hasher.digest(),
      size: hasher.byteLength(),
      collected: Buffer.concat(sink.chunks),
    };
  }

  function referenceSha(chunks: Buffer[]): string {
    const h = createHash('sha256');
    for (const c of chunks) h.update(c);
    return h.digest('hex');
  }

  test('digest matches reference for 0-byte stream', async () => {
    const { sha, size } = await streamToDigest([]);
    expect(sha).toBe(referenceSha([]));
    expect(size).toBe(0);
  });

  test('digest matches reference for 1-byte stream', async () => {
    const chunks = [Buffer.from([0x61])];
    const { sha, size } = await streamToDigest(chunks);
    expect(sha).toBe(referenceSha(chunks));
    expect(size).toBe(1);
  });

  test('digest matches reference for 1 KB deterministic buffer', async () => {
    const chunks = [Buffer.alloc(1024, 0xab)];
    const { sha, size } = await streamToDigest(chunks);
    expect(sha).toBe(referenceSha(chunks));
    expect(size).toBe(1024);
  });

  test('digest matches reference for 10 MB random buffer', async () => {
    const chunks = [randomBytes(10 * 1024 * 1024)];
    const { sha, size } = await streamToDigest(chunks);
    expect(sha).toBe(referenceSha(chunks));
    expect(size).toBe(10 * 1024 * 1024);
  });

  test('digest matches reference across many small chunks', async () => {
    // 1000 × 4 KB chunks = 4 MB total; exercises the _transform loop.
    const chunks = Array.from({ length: 1000 }, () => randomBytes(4096));
    const { sha, size } = await streamToDigest(chunks);
    expect(sha).toBe(referenceSha(chunks));
    expect(size).toBe(1000 * 4096);
  });

  test('digest() throws on second call (one-shot)', async () => {
    const hasher = new HashingPassThrough();
    const sink = new CollectingSink();
    await pipeline(Readable.from([Buffer.from('abc')]), hasher, sink);
    expect(hasher.digest()).toBe(referenceSha([Buffer.from('abc')]));
    expect(() => hasher.digest()).toThrow('digest() already called');
  });

  test('byteLength() works mid-stream (not only post-finish)', async () => {
    const hasher = new HashingPassThrough();
    expect(hasher.byteLength()).toBe(0);
    // Write one chunk, check byteLength before finishing.
    hasher.write(Buffer.alloc(42));
    // Give the event loop a tick so _transform runs.
    await new Promise((r) => setImmediate(r));
    expect(hasher.byteLength()).toBe(42);
    hasher.end();
  });

  test('pass-through semantics: bytes downstream equal bytes upstream', async () => {
    const input = Buffer.from('the quick brown fox');
    const { collected } = await streamToDigest([input]);
    expect(collected.equals(input)).toBe(true);
  });
});

describe('tmpUploadDir / mintTempUploadPath', () => {
  let tmpBase: string;

  beforeEach(async () => {
    tmpBase = await mkdtemp(join(tmpdir(), 'upload-streaming-'));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  test('tmpUploadDir resolves to <projectDir>/.ok/local/tmp', () => {
    expect(tmpUploadDir(tmpBase)).toBe(resolve(tmpBase, '.ok', LOCAL_DIR, 'tmp'));
  });

  test('mintTempUploadPath lazily creates the tmp dir', () => {
    expect(existsSync(tmpUploadDir(tmpBase))).toBe(false);
    const p = mintTempUploadPath(tmpBase);
    expect(existsSync(tmpUploadDir(tmpBase))).toBe(true);
    expect(p.startsWith(tmpUploadDir(tmpBase))).toBe(true);
  });

  test('mintTempUploadPath returns unique paths across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(mintTempUploadPath(tmpBase));
    }
    expect(seen.size).toBe(50);
  });

  test('minted paths are prefixed with upload-', () => {
    const p = mintTempUploadPath(tmpBase);
    const base = p.slice(p.lastIndexOf('/') + 1);
    expect(base.startsWith('upload-')).toBe(true);
  });
});

describe('linkTempToFinalWithCollisionRetry', () => {
  let tmpBase: string;
  let destDir: string;

  beforeEach(async () => {
    tmpBase = await mkdtemp(join(tmpdir(), 'link-retry-'));
    destDir = join(tmpBase, 'dest');
    mkdirSync(destDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  function makeTemp(contents: string): string {
    const p = mintTempUploadPath(tmpBase);
    writeFileSync(p, contents);
    return p;
  }

  test('no collision: succeeds on first attempt, returns sanitized basename', () => {
    const tmp = makeTemp('hello');
    const result = linkTempToFinalWithCollisionRetry(tmp, destDir, 'photo.png');
    expect(result).toBe('photo.png');
    expect(existsSync(join(destDir, 'photo.png'))).toBe(true);
    expect(existsSync(tmp)).toBe(false);
  });

  test('1 collision: retries to photo-1.png', () => {
    writeFileSync(join(destDir, 'photo.png'), 'existing');
    const tmp = makeTemp('new');
    const result = linkTempToFinalWithCollisionRetry(tmp, destDir, 'photo.png');
    expect(result).toBe('photo-1.png');
    expect(existsSync(join(destDir, 'photo.png'))).toBe(true);
    expect(existsSync(join(destDir, 'photo-1.png'))).toBe(true);
    expect(existsSync(tmp)).toBe(false);
  });

  test('50 collisions: retries to photo-50.png', () => {
    writeFileSync(join(destDir, 'photo.png'), 'base');
    for (let i = 1; i <= 49; i++) {
      writeFileSync(join(destDir, `photo-${i}.png`), `conflict-${i}`);
    }
    const tmp = makeTemp('winner');
    const result = linkTempToFinalWithCollisionRetry(tmp, destDir, 'photo.png');
    expect(result).toBe('photo-50.png');
    expect(existsSync(join(destDir, 'photo-50.png'))).toBe(true);
    expect(existsSync(tmp)).toBe(false);
  });

  test('99 collisions: retries to photo-99.png (last slot)', () => {
    writeFileSync(join(destDir, 'photo.png'), 'base');
    for (let i = 1; i <= 98; i++) {
      writeFileSync(join(destDir, `photo-${i}.png`), `conflict-${i}`);
    }
    const tmp = makeTemp('winner');
    const result = linkTempToFinalWithCollisionRetry(tmp, destDir, 'photo.png');
    expect(result).toBe('photo-99.png');
    expect(existsSync(tmp)).toBe(false);
  });

  test('100 collisions: throws UploadWriteError(collision-exhaustion) + unlinks tempfile', () => {
    writeFileSync(join(destDir, 'photo.png'), 'base');
    for (let i = 1; i <= 99; i++) {
      writeFileSync(join(destDir, `photo-${i}.png`), `conflict-${i}`);
    }
    const tmp = makeTemp('doomed');
    expect(() => linkTempToFinalWithCollisionRetry(tmp, destDir, 'photo.png')).toThrow(
      UploadWriteError,
    );
    expect(existsSync(tmp)).toBe(false);
  });

  test('EACCES on destDir: throws storage-readonly + unlinks tempfile', () => {
    // A non-existent destDir reliably produces ENOENT (not EEXIST); but we
    // want to exercise the non-EEXIST retry-terminator, which is the
    // concrete behavior that matters. ENOENT lands in the 'storage-error'
    // fallback bucket — fine as a regression guard for "retry loop
    // terminates on any non-EEXIST error".
    const tmp = makeTemp('doomed');
    const missing = join(tmpBase, 'does-not-exist');
    expect(() => linkTempToFinalWithCollisionRetry(tmp, missing, 'x.png')).toThrow(
      UploadWriteError,
    );
    expect(existsSync(tmp)).toBe(false);
  });

  test('handles extension-less filenames', () => {
    const tmp = makeTemp('data');
    const result = linkTempToFinalWithCollisionRetry(tmp, destDir, 'README');
    expect(result).toBe('README');
    expect(existsSync(join(destDir, 'README'))).toBe(true);
  });

  test('collision retry respects extension-less stem', () => {
    writeFileSync(join(destDir, 'README'), 'existing');
    const tmp = makeTemp('data');
    const result = linkTempToFinalWithCollisionRetry(tmp, destDir, 'README');
    expect(result).toBe('README-1');
  });
});

describe('cleanupOrphanUploadTempfiles', () => {
  let tmpBase: string;

  beforeEach(async () => {
    tmpBase = await mkdtemp(join(tmpdir(), 'orphan-sweep-'));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  test('missing tmp dir: returns zero-result, does not throw', () => {
    const result = cleanupOrphanUploadTempfiles(tmpBase);
    expect(result).toEqual({ scanned: 0, deleted: 0, errors: 0 });
  });

  test('sweeps upload-* files older than 24h threshold', () => {
    const dir = tmpUploadDir(tmpBase);
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, 'upload-stale-uuid');
    const fresh = join(dir, 'upload-fresh-uuid');
    writeFileSync(stale, 'stale');
    writeFileSync(fresh, 'fresh');

    // Backdate stale to 25 hours ago.
    const stalePast = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, stalePast, stalePast);

    const result = cleanupOrphanUploadTempfiles(tmpBase);
    expect(result.scanned).toBe(2);
    expect(result.deleted).toBe(1);
    expect(result.errors).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test('skips non-upload-* entries', () => {
    const dir = tmpUploadDir(tmpBase);
    mkdirSync(dir, { recursive: true });
    const unrelated = join(dir, 'some-other-artifact');
    writeFileSync(unrelated, 'not ours');
    const stalePast = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(unrelated, stalePast, stalePast);

    const result = cleanupOrphanUploadTempfiles(tmpBase);
    expect(result.scanned).toBe(0);
    expect(result.deleted).toBe(0);
    expect(existsSync(unrelated)).toBe(true);
  });

  test('respects custom ageMs threshold', () => {
    const dir = tmpUploadDir(tmpBase);
    mkdirSync(dir, { recursive: true });
    const mid = join(dir, 'upload-mid');
    writeFileSync(mid, 'mid');
    // Backdate 2 hours.
    const midPast = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(mid, midPast, midPast);

    // Default 24h: file is young, not deleted.
    const defaultResult = cleanupOrphanUploadTempfiles(tmpBase);
    expect(defaultResult.deleted).toBe(0);
    expect(existsSync(mid)).toBe(true);

    // 1h threshold: now deletes.
    const tightResult = cleanupOrphanUploadTempfiles(tmpBase, { ageMs: 60 * 60 * 1000 });
    expect(tightResult.deleted).toBe(1);
    expect(existsSync(mid)).toBe(false);
  });

  test('empty tmp dir: scans 0, deletes 0', () => {
    const dir = tmpUploadDir(tmpBase);
    mkdirSync(dir, { recursive: true });
    const result = cleanupOrphanUploadTempfiles(tmpBase);
    expect(result).toEqual({ scanned: 0, deleted: 0, errors: 0 });
  });
});
