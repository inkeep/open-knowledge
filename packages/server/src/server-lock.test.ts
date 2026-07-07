import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import {
  acquireServerLock,
  readServerLock,
  releaseServerLock,
  ServerLockCollisionError,
  type ServerLockMetadata,
  updateServerLockPort,
} from './server-lock';

/**
 * Pick a PID that is alive on this host AND passes `isValidLockPid` (≥ 2).
 * The security validator now refuses pid 1 (init/launchd) so tests that
 * need a "known alive foreign holder" require a real PID.
 */
function aliveForeignPid(): number {
  if (process.ppid > 1 && process.ppid !== process.pid) return process.ppid;
  for (let candidate = process.pid + 1; candidate < process.pid + 5000; candidate++) {
    try {
      process.kill(candidate, 0);
      return candidate;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM') return candidate;
    }
  }
  throw new Error('aliveForeignPid: could not find a live foreign pid for the test');
}

let tmpDir: string;
let lockDir: string;
let lockPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-server-lock-test-'));
  lockDir = resolve(tmpDir, '.ok', LOCAL_DIR);
  lockPath = resolve(lockDir, 'server.lock');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('acquireServerLock', () => {
  test('creates lock file with correct metadata (and creates lockDir)', () => {
    const returned = acquireServerLock(lockDir, { port: 5173, worktreeRoot: '/my/wt' });

    expect(returned).toBe(lockPath);
    expect(existsSync(lockPath)).toBe(true);

    const md: ServerLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(process.pid);
    expect(md.hostname).toBe(hostname());
    expect(md.port).toBe(5173);
    expect(md.worktreeRoot).toBe('/my/wt');
    expect(Number.isNaN(Date.parse(md.startedAt))).toBe(false);
  });

  test('accepts port=0 sentinel (server starting)', () => {
    acquireServerLock(lockDir, { port: 0, worktreeRoot: '/wt' });
    const md: ServerLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.port).toBe(0);
  });

  test('replaces stale lock from dead process', () => {
    acquireServerLock(lockDir, { port: 1, worktreeRoot: '/old' });
    const stale: ServerLockMetadata = {
      pid: 99999999,
      hostname: hostname(),
      port: 1234,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/old',
    };
    writeFileSync(lockPath, JSON.stringify(stale), 'utf-8');

    acquireServerLock(lockDir, { port: 5173, worktreeRoot: '/new' });

    const md: ServerLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(process.pid);
    expect(md.port).toBe(5173);
    expect(md.worktreeRoot).toBe('/new');
  });

  test('throws ServerLockCollisionError when lock owner is alive', () => {
    // Seed lockDir via our own acquire then overwrite with a foreign-pid lock.
    // Use a real alive PID — the security validator refuses pid 1.
    acquireServerLock(lockDir, { port: 0, worktreeRoot: '/seed' });
    const livePid = aliveForeignPid();
    const live: ServerLockMetadata = {
      pid: livePid,
      hostname: hostname(),
      port: 9000,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/other',
    };
    writeFileSync(lockPath, JSON.stringify(live), 'utf-8');

    const tryAgain = () => acquireServerLock(lockDir, { port: 5173, worktreeRoot: '/me' });
    expect(tryAgain).toThrow(ServerLockCollisionError);
    try {
      tryAgain();
    } catch (err) {
      expect(err).toBeInstanceOf(ServerLockCollisionError);
      if (err instanceof ServerLockCollisionError) {
        expect(err.existing.pid).toBe(livePid);
        expect(err.existing.port).toBe(9000);
        expect(err.message).toContain('already running on port 9000');
      }
    }
  });

  test('replaces corrupt lock file', () => {
    acquireServerLock(lockDir, { port: 0, worktreeRoot: '/wt' });
    writeFileSync(lockPath, 'not valid json', 'utf-8');

    acquireServerLock(lockDir, { port: 5173, worktreeRoot: '/me' });
    const md: ServerLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(process.pid);
    expect(md.port).toBe(5173);
  });

  test('is idempotent for same process (refreshes port/startedAt)', () => {
    acquireServerLock(lockDir, { port: 1111, worktreeRoot: '/wt1' });
    acquireServerLock(lockDir, { port: 2222, worktreeRoot: '/wt2' });

    const md: ServerLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(process.pid);
    expect(md.port).toBe(2222);
    expect(md.worktreeRoot).toBe('/wt2');
  });

  test('replaces lock from different hostname', () => {
    acquireServerLock(lockDir, { port: 0, worktreeRoot: '/tmp' });
    const remote: ServerLockMetadata = {
      pid: 1,
      hostname: 'some-other-host',
      port: 5173,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/remote',
    };
    writeFileSync(lockPath, JSON.stringify(remote), 'utf-8');

    acquireServerLock(lockDir, { port: 5174, worktreeRoot: '/me' });
    const md: ServerLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(process.pid);
    expect(md.port).toBe(5174);
  });
});

describe('updateServerLockPort', () => {
  test('rewrites only the port, preserving other fields', () => {
    acquireServerLock(lockDir, { port: 0, worktreeRoot: '/wt' });
    const before: ServerLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));

    updateServerLockPort(lockDir, 5173);

    const after: ServerLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(after.port).toBe(5173);
    expect(after.pid).toBe(before.pid);
    expect(after.hostname).toBe(before.hostname);
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.worktreeRoot).toBe(before.worktreeRoot);
  });

  test('no-op when lock file is missing', () => {
    // Should not throw
    updateServerLockPort(lockDir, 5173);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('refuses to overwrite a lock owned by a different pid', () => {
    const foreign: ServerLockMetadata = {
      pid: 1,
      hostname: hostname(),
      port: 1234,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/other',
    };
    // Create dir + write foreign lock
    acquireServerLock(lockDir, { port: 0, worktreeRoot: '/me' });
    writeFileSync(lockPath, JSON.stringify(foreign), 'utf-8');

    updateServerLockPort(lockDir, 9999);

    const md: ServerLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(1);
    expect(md.port).toBe(1234);
  });

  test('ignores corrupt lock file', () => {
    acquireServerLock(lockDir, { port: 0, worktreeRoot: '/wt' });
    writeFileSync(lockPath, 'garbage', 'utf-8');
    // Should not throw
    updateServerLockPort(lockDir, 5173);
    expect(readFileSync(lockPath, 'utf-8')).toBe('garbage');
  });
});

describe('readServerLock', () => {
  test('returns metadata when live lock exists on this host', () => {
    acquireServerLock(lockDir, { port: 5173, worktreeRoot: '/me' });
    const md = readServerLock(lockDir);
    expect(md).not.toBeNull();
    expect(md?.pid).toBe(process.pid);
    expect(md?.port).toBe(5173);
  });

  test('returns null + unlinks stale lock (dead pid)', () => {
    acquireServerLock(lockDir, { port: 0, worktreeRoot: '/wt' });
    const stale: ServerLockMetadata = {
      pid: 99999999,
      hostname: hostname(),
      port: 5173,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/old',
    };
    writeFileSync(lockPath, JSON.stringify(stale), 'utf-8');

    expect(readServerLock(lockDir)).toBeNull();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('returns null for cross-host lock (does not unlink)', () => {
    acquireServerLock(lockDir, { port: 0, worktreeRoot: '/wt' });
    const remote: ServerLockMetadata = {
      pid: 1,
      hostname: 'other-host',
      port: 5173,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/remote',
    };
    writeFileSync(lockPath, JSON.stringify(remote), 'utf-8');

    expect(readServerLock(lockDir)).toBeNull();
    expect(existsSync(lockPath)).toBe(true); // Preserved — another host might own it
  });

  test('returns null when lock is missing', () => {
    expect(readServerLock(lockDir)).toBeNull();
  });

  test('returns null for corrupt lock', () => {
    acquireServerLock(lockDir, { port: 0, worktreeRoot: '/wt' });
    writeFileSync(lockPath, 'garbage', 'utf-8');
    expect(readServerLock(lockDir)).toBeNull();
  });
});

describe('releaseServerLock', () => {
  test('removes lock owned by this process', () => {
    acquireServerLock(lockDir, { port: 5173, worktreeRoot: '/me' });
    expect(existsSync(lockPath)).toBe(true);
    releaseServerLock(lockDir);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('is safe to call multiple times', () => {
    acquireServerLock(lockDir, { port: 5173, worktreeRoot: '/me' });
    releaseServerLock(lockDir);
    releaseServerLock(lockDir); // no throw
    expect(existsSync(lockPath)).toBe(false);
  });

  test('no-op if lock does not exist', () => {
    releaseServerLock(lockDir);
  });

  test('refuses to remove a lock owned by a different pid', () => {
    // Seed the dir then overwrite with a foreign-pid lock
    acquireServerLock(lockDir, { port: 0, worktreeRoot: '/me' });
    const foreign: ServerLockMetadata = {
      pid: 1,
      hostname: hostname(),
      port: 9000,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/other',
    };
    writeFileSync(lockPath, JSON.stringify(foreign), 'utf-8');

    releaseServerLock(lockDir);

    expect(existsSync(lockPath)).toBe(true);
    const md: ServerLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(1);
  });
});
