import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { acquireLock, type LockMetadata, releaseLock } from './shadow-lock';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-lock-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('acquireLock', () => {
  test('creates lock file with correct metadata', () => {
    const shadowDir = resolve(tmpDir, 'shadow');
    mkdirSync(shadowDir, { recursive: true });

    const lockPath = acquireLock(shadowDir, '/some/worktree');

    expect(lockPath).toBe(resolve(shadowDir, 'lock'));
    expect(existsSync(lockPath)).toBe(true);

    const metadata: LockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(metadata.pid).toBe(process.pid);
    expect(metadata.hostname).toBe(hostname());
    expect(metadata.worktreeRoot).toBe('/some/worktree');
    expect(typeof metadata.startedAt).toBe('string');
    // Verify startedAt is a valid ISO date
    expect(Number.isNaN(Date.parse(metadata.startedAt))).toBe(false);
  });

  test('replaces stale lock from dead process', () => {
    const shadowDir = resolve(tmpDir, 'shadow');
    mkdirSync(shadowDir, { recursive: true });

    // Write a lock with a dead PID (99999999 is almost certainly not running)
    const staleLock: LockMetadata = {
      pid: 99999999,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      worktreeRoot: '/old/worktree',
    };
    writeFileSync(resolve(shadowDir, 'lock'), JSON.stringify(staleLock), 'utf-8');

    // Should succeed — stale lock is replaced
    const lockPath = acquireLock(shadowDir, '/new/worktree');

    const metadata: LockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(metadata.pid).toBe(process.pid);
    expect(metadata.worktreeRoot).toBe('/new/worktree');
  });

  test('rejects when lock owner is alive (different process)', () => {
    const shadowDir = resolve(tmpDir, 'shadow');
    mkdirSync(shadowDir, { recursive: true });

    // Use process.ppid (always > 1 in test environments) to simulate another
    // live writer. PID 1 was previously used here but the new isValidLockPid
    // guard rejects it as untrusted before isProcessAlive is consulted.
    const liveLock: LockMetadata = {
      pid: process.ppid > 1 ? process.ppid : process.pid + 1,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      worktreeRoot: '/other/worktree',
    };
    writeFileSync(resolve(shadowDir, 'lock'), JSON.stringify(liveLock), 'utf-8');

    expect(() => acquireLock(shadowDir, '/my/worktree')).toThrow(/locked by another writer/);
  });

  test('replaces corrupt lock file', () => {
    const shadowDir = resolve(tmpDir, 'shadow');
    mkdirSync(shadowDir, { recursive: true });

    writeFileSync(resolve(shadowDir, 'lock'), 'not valid json', 'utf-8');

    // Should succeed — corrupt lock treated as stale
    const lockPath = acquireLock(shadowDir, '/my/worktree');
    const metadata: LockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(metadata.pid).toBe(process.pid);
  });

  test('is idempotent for same process', () => {
    const shadowDir = resolve(tmpDir, 'shadow');
    mkdirSync(shadowDir, { recursive: true });

    acquireLock(shadowDir, '/first/worktree');
    // Same process re-acquires — should not throw
    acquireLock(shadowDir, '/second/worktree');

    const metadata: LockMetadata = JSON.parse(readFileSync(resolve(shadowDir, 'lock'), 'utf-8'));
    expect(metadata.pid).toBe(process.pid);
    expect(metadata.worktreeRoot).toBe('/second/worktree');
  });

  test('replaces lock from different hostname', () => {
    const shadowDir = resolve(tmpDir, 'shadow');
    mkdirSync(shadowDir, { recursive: true });

    // Lock from a different host — can't verify liveness, treat as stale.
    // Use a real foreign PID rather than 1 so the isValidLockPid guard
    // doesn't short-circuit before the foreign-host stale-replacement path.
    const remoteLock: LockMetadata = {
      pid: 12345,
      hostname: 'some-other-host-that-does-not-exist',
      startedAt: new Date().toISOString(),
      worktreeRoot: '/remote/worktree',
    };
    writeFileSync(resolve(shadowDir, 'lock'), JSON.stringify(remoteLock), 'utf-8');

    const lockPath = acquireLock(shadowDir, '/my/worktree');
    const metadata: LockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(metadata.pid).toBe(process.pid);
  });
});

describe('releaseLock', () => {
  test('removes lock file', () => {
    const shadowDir = resolve(tmpDir, 'shadow');
    mkdirSync(shadowDir, { recursive: true });

    acquireLock(shadowDir, '/some/worktree');
    expect(existsSync(resolve(shadowDir, 'lock'))).toBe(true);

    releaseLock(shadowDir);
    expect(existsSync(resolve(shadowDir, 'lock'))).toBe(false);
  });

  test('no-ops if lock does not exist', () => {
    const shadowDir = resolve(tmpDir, 'shadow');
    mkdirSync(shadowDir, { recursive: true });

    // Should not throw
    releaseLock(shadowDir);
  });
});
