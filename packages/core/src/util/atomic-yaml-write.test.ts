import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile, atomicWriteFileSync } from './atomic-yaml-write.ts';

let testDir: string;
let target: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ok-atomic-write-'));
  target = join(testDir, 'state.yml');
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

// Helper: list any tmp siblings of `target` in testDir (the orphan
// cleanup contract — tmp files MUST NOT outlive the atomic-write call).
function orphanTmps(): string[] {
  return readdirSync(testDir).filter((f) => f.startsWith('state.yml.tmp.'));
}

describe('atomicWriteFileSync — sequential', () => {
  test('writes content atomically; target exists with correct bytes', () => {
    atomicWriteFileSync(target, 'hello\n');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('hello\n');
  });

  test('overwrites existing file via rename(2)', () => {
    atomicWriteFileSync(target, 'first\n');
    atomicWriteFileSync(target, 'second\n');
    expect(readFileSync(target, 'utf-8')).toBe('second\n');
  });

  test('leaves no orphan .tmp siblings on happy path', () => {
    atomicWriteFileSync(target, 'x');
    expect(orphanTmps()).toEqual([]);
  });
});

describe('atomicWriteFileSync — failure cleanup', () => {
  test('cleans tmp when rename fails because target is a non-empty dir', () => {
    // Set up: target path is a directory with content. writeFileSync to
    // the tmp sibling succeeds (parent dir is writable), then renameSync
    // fails (can't replace a non-empty directory with a regular file).
    // This exercises the try/catch cleanup path that the unit-only
    // chmod-parent test (which fires at writeFileSync, before any tmp is
    // created) can't reach.
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'occupant'), 'x');

    expect(() => atomicWriteFileSync(target, 'new content')).toThrow();
    expect(orphanTmps()).toEqual([]);
  });

  test('cleans tmp when writeFileSync fails because parent dir is missing', () => {
    // Tmp path lives in a non-existent dir → writeFileSync errors with
    // ENOENT before any tmp is created. Catch best-effort unlinks the
    // never-existed tmp (also ENOENT, swallowed) and re-throws.
    const missing = join(testDir, 'no', 'such', 'dir', 'state.yml');
    expect(() => atomicWriteFileSync(missing, 'x')).toThrow();
    // testDir stays clean (no tmps leak into a sibling location).
    expect(orphanTmps()).toEqual([]);
  });
});

describe('atomicWriteFile (async) — sequential', () => {
  test('writes content atomically; target exists with correct bytes', async () => {
    await atomicWriteFile(target, 'hello\n');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('hello\n');
  });

  test('leaves no orphan .tmp siblings on happy path', async () => {
    await atomicWriteFile(target, 'x');
    expect(orphanTmps()).toEqual([]);
  });
});

describe('atomicWriteFile (async) — failure cleanup', () => {
  test('cleans tmp when rename fails because target is a non-empty dir', async () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'occupant'), 'x');

    await expect(atomicWriteFile(target, 'new content')).rejects.toThrow();
    expect(orphanTmps()).toEqual([]);
  });

  test('cleans tmp when writeFile fails because parent dir is missing', async () => {
    // Mirror of the sync writeFile-fail test. Sibling coverage so a
    // future refactor that narrowed the async catch (e.g., checking
    // err.code before cleanup) can't regress one variant without the
    // other.
    const missing = join(testDir, 'no', 'such', 'dir', 'state.yml');
    await expect(atomicWriteFile(missing, 'x')).rejects.toThrow();
    expect(orphanTmps()).toEqual([]);
  });
});

// Crash-orphan sweep contract: each atomic-write call best-effort
// cleans `${basename}.tmp.*` siblings whose mtime is older than the
// internal STALE_TMP_AGE_MS (30 s). Concurrent writers' fresh tmps
// stay safe; tmps belonging to unrelated targets stay safe.
describe('atomicWriteFileSync — crash-orphan sweep', () => {
  test('unlinks stale .tmp siblings of the target', () => {
    const ancientTmp = join(testDir, 'state.yml.tmp.ancient-uuid');
    writeFileSync(ancientTmp, 'crashed mid-write');
    const ancient = new Date('2000-01-01T00:00:00Z');
    utimesSync(ancientTmp, ancient, ancient);

    atomicWriteFileSync(target, 'new');
    expect(existsSync(ancientTmp)).toBe(false);
    expect(readFileSync(target, 'utf-8')).toBe('new');
  });

  test('preserves recent .tmp siblings of the target (concurrent writers)', () => {
    const freshTmp = join(testDir, 'state.yml.tmp.in-flight-uuid');
    writeFileSync(freshTmp, 'concurrent writer');
    // mtime = now (set by writeFileSync); well within STALE_TMP_AGE_MS.

    atomicWriteFileSync(target, 'new');
    expect(existsSync(freshTmp)).toBe(true);
    expect(readFileSync(freshTmp, 'utf-8')).toBe('concurrent writer');
  });

  test('does not sweep stale .tmp siblings of unrelated targets', () => {
    const unrelatedTmp = join(testDir, 'other.yml.tmp.ancient-uuid');
    writeFileSync(unrelatedTmp, 'unrelated');
    const ancient = new Date('2000-01-01T00:00:00Z');
    utimesSync(unrelatedTmp, ancient, ancient);

    atomicWriteFileSync(target, 'new');
    expect(existsSync(unrelatedTmp)).toBe(true);
  });
});

describe('atomicWriteFile (async) — crash-orphan sweep', () => {
  test('unlinks stale .tmp siblings of the target', async () => {
    const ancientTmp = join(testDir, 'state.yml.tmp.ancient-uuid');
    writeFileSync(ancientTmp, 'crashed mid-write');
    const ancient = new Date('2000-01-01T00:00:00Z');
    utimesSync(ancientTmp, ancient, ancient);

    await atomicWriteFile(target, 'new');
    expect(existsSync(ancientTmp)).toBe(false);
    expect(readFileSync(target, 'utf-8')).toBe('new');
  });

  test('preserves recent .tmp siblings of the target (concurrent writers)', async () => {
    const freshTmp = join(testDir, 'state.yml.tmp.in-flight-uuid');
    writeFileSync(freshTmp, 'concurrent writer');

    await atomicWriteFile(target, 'new');
    expect(existsSync(freshTmp)).toBe(true);
  });

  test('does not sweep stale .tmp siblings of unrelated targets', async () => {
    const unrelatedTmp = join(testDir, 'other.yml.tmp.ancient-uuid');
    writeFileSync(unrelatedTmp, 'unrelated');
    const ancient = new Date('2000-01-01T00:00:00Z');
    utimesSync(unrelatedTmp, ancient, ancient);

    await atomicWriteFile(target, 'new');
    expect(existsSync(unrelatedTmp)).toBe(true);
  });
});
