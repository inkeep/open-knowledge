import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import {
  acquireProcessLock,
  type LockName,
  lockFilePath,
  ProcessLockCollisionError,
  type ProcessLockMetadata,
  readProcessLock,
  readProcessLockDetailed,
  releaseProcessLock,
  updateProcessLockPort,
} from './process-lock';
import { PROTOCOL_VERSION, RUNTIME_VERSION } from './version-constants';

const LOCK_NAME: LockName = 'ui';

/**
 * Pick a PID that is alive on this host AND passes `isValidLockPid` (≥ 2,
 * not our own pid). Uses `process.ppid` when it's > 1; otherwise falls
 * back to scanning a small range above process.pid for a live one.
 *
 * Tests previously used `pid: 1` (init/launchd) as a "known alive" stand-
 * in for a foreign holder. The security validator now rejects pid ≤ 1, so
 * tests that rely on a real collision/live-lock state need a real PID.
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
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-process-lock-test-'));
  lockDir = resolve(tmpDir, '.ok', LOCAL_DIR);
  lockPath = lockFilePath(lockDir, LOCK_NAME);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('acquireProcessLock', () => {
  test('creates lock file at <lockDir>/<lockName>.lock with correct metadata', () => {
    const handle = acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 3000, worktreeRoot: '/my/wt' },
    });

    expect(handle.lockPath).toBe(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    expect(lockPath.endsWith('ui.lock')).toBe(true);

    const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(process.pid);
    expect(md.hostname).toBe(hostname());
    expect(md.port).toBe(3000);
    expect(md.worktreeRoot).toBe('/my/wt');
    expect(Number.isNaN(Date.parse(md.startedAt))).toBe(false);
  });

  test('creates lockDir when missing', () => {
    expect(existsSync(lockDir)).toBe(false);
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 0, worktreeRoot: '/wt' },
    });
    expect(existsSync(lockDir)).toBe(true);
  });

  test('accepts port=0 sentinel (process starting)', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 0, worktreeRoot: '/wt' },
    });
    const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.port).toBe(0);
  });

  test('writes distinct files for different lockNames in the same lockDir', () => {
    acquireProcessLock({
      lockName: 'server',
      lockDir,
      metadata: { port: 1111, worktreeRoot: '/wt' },
    });
    acquireProcessLock({ lockName: 'ui', lockDir, metadata: { port: 2222, worktreeRoot: '/wt' } });

    expect(existsSync(lockFilePath(lockDir, 'server'))).toBe(true);
    expect(existsSync(lockFilePath(lockDir, 'ui'))).toBe(true);

    const serverMd = JSON.parse(readFileSync(lockFilePath(lockDir, 'server'), 'utf-8'));
    const uiMd = JSON.parse(readFileSync(lockFilePath(lockDir, 'ui'), 'utf-8'));
    expect(serverMd.port).toBe(1111);
    expect(uiMd.port).toBe(2222);
  });

  test('replaces stale lock from dead process', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 1, worktreeRoot: '/old' },
    });
    const stale: ProcessLockMetadata = {
      pid: 99999999,
      hostname: hostname(),
      port: 1234,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/old',
    };
    writeFileSync(lockPath, JSON.stringify(stale), 'utf-8');

    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 3000, worktreeRoot: '/new' },
    });

    const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(process.pid);
    expect(md.port).toBe(3000);
    expect(md.worktreeRoot).toBe('/new');
  });

  test('throws ProcessLockCollisionError when lock owner is alive', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 0, worktreeRoot: '/seed' },
    });
    // Use process.ppid — a real PID that passes isValidLockPid (rejects 0/1)
    // and is alive for the duration of the test. PID 1 (launchd/init) is
    // explicitly refused by the security validator, so a "known alive" lock
    // holder must be ≥ 2.
    const livePid = aliveForeignPid();
    const live: ProcessLockMetadata = {
      pid: livePid,
      hostname: hostname(),
      port: 9000,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/other',
    };
    writeFileSync(lockPath, JSON.stringify(live), 'utf-8');

    const tryAgain = () =>
      acquireProcessLock({
        lockName: LOCK_NAME,
        lockDir,
        metadata: { port: 3000, worktreeRoot: '/me' },
      });
    expect(tryAgain).toThrow(ProcessLockCollisionError);
    try {
      tryAgain();
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessLockCollisionError);
      if (err instanceof ProcessLockCollisionError) {
        expect(err.existing.pid).toBe(livePid);
        expect(err.existing.port).toBe(9000);
        expect(err.lockName).toBe(LOCK_NAME);
        expect(err.lockPath).toBe(lockPath);
        expect(err.message).toContain('already running on port 9000');
        expect(err.message).toContain(LOCK_NAME);
      }
    }
  });

  test('replaces corrupt lock file', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 0, worktreeRoot: '/wt' },
    });
    writeFileSync(lockPath, 'not valid json', 'utf-8');

    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 3000, worktreeRoot: '/me' },
    });
    const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(process.pid);
    expect(md.port).toBe(3000);
  });

  test('is idempotent for same process (refreshes port/startedAt)', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 1111, worktreeRoot: '/wt1' },
    });
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 2222, worktreeRoot: '/wt2' },
    });

    const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(process.pid);
    expect(md.port).toBe(2222);
    expect(md.worktreeRoot).toBe('/wt2');
  });

  test('replaces lock from different hostname', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 0, worktreeRoot: '/tmp' },
    });
    const remote: ProcessLockMetadata = {
      pid: 1,
      hostname: 'some-other-host',
      port: 3000,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/remote',
    };
    writeFileSync(lockPath, JSON.stringify(remote), 'utf-8');

    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 3001, worktreeRoot: '/me' },
    });
    const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(process.pid);
    expect(md.port).toBe(3001);
  });

  test('handle.release removes the lock we just acquired', () => {
    const handle = acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 3000, worktreeRoot: '/me' },
    });
    expect(existsSync(lockPath)).toBe(true);
    handle.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('round-trips kind/parentPid/capabilities when provided', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: {
        port: 4242,
        worktreeRoot: '/wt',
        kind: 'mcp-spawned',
        parentPid: 99999,
        capabilities: ['http', 'ws'],
      },
    });
    const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.kind).toBe('mcp-spawned');
    expect(md.parentPid).toBe(99999);
    expect(md.capabilities).toEqual(['http', 'ws']);
  });

  test('omits kind/parentPid/capabilities when not provided (legacy lock shape)', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 1, worktreeRoot: '/wt' },
    });
    const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.kind).toBeUndefined();
    expect(md.parentPid).toBeUndefined();
    expect(md.capabilities).toBeUndefined();
  });

  test('updatePort preserves new optional fields', () => {
    const handle = acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: {
        port: 0,
        worktreeRoot: '/wt',
        kind: 'interactive',
        parentPid: 12345,
        capabilities: ['http', 'ws'],
      },
    });
    handle.updatePort(8080);
    const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.port).toBe(8080);
    expect(md.kind).toBe('interactive');
    expect(md.parentPid).toBe(12345);
    expect(md.capabilities).toEqual(['http', 'ws']);
  });

  test('handle.updatePort updates only port, preserving other fields', () => {
    const handle = acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 0, worktreeRoot: '/me' },
    });
    const before: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    handle.updatePort(3000);
    const after: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(after.port).toBe(3000);
    expect(after.pid).toBe(before.pid);
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.worktreeRoot).toBe(before.worktreeRoot);
  });
});

describe('updateProcessLockPort', () => {
  test('no-op when lock file is missing', () => {
    updateProcessLockPort({ lockName: LOCK_NAME, lockDir, port: 3000 });
    expect(existsSync(lockPath)).toBe(false);
  });

  test('refuses to overwrite a lock owned by a different pid', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 0, worktreeRoot: '/me' },
    });
    const foreign: ProcessLockMetadata = {
      pid: 1,
      hostname: hostname(),
      port: 1234,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/other',
    };
    writeFileSync(lockPath, JSON.stringify(foreign), 'utf-8');

    updateProcessLockPort({ lockName: LOCK_NAME, lockDir, port: 9999 });

    const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(1);
    expect(md.port).toBe(1234);
  });

  test('ignores corrupt lock file', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 0, worktreeRoot: '/wt' },
    });
    writeFileSync(lockPath, 'garbage', 'utf-8');
    updateProcessLockPort({ lockName: LOCK_NAME, lockDir, port: 3000 });
    expect(readFileSync(lockPath, 'utf-8')).toBe('garbage');
  });
});

describe('readProcessLock', () => {
  test('returns metadata when live lock exists on this host', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 3000, worktreeRoot: '/me' },
    });
    const md = readProcessLock({ lockName: LOCK_NAME, lockDir });
    expect(md).not.toBeNull();
    expect(md?.pid).toBe(process.pid);
    expect(md?.port).toBe(3000);
  });

  test('returns null + unlinks stale lock (dead pid)', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 0, worktreeRoot: '/wt' },
    });
    const stale: ProcessLockMetadata = {
      pid: 99999999,
      hostname: hostname(),
      port: 3000,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/old',
    };
    writeFileSync(lockPath, JSON.stringify(stale), 'utf-8');

    expect(readProcessLock({ lockName: LOCK_NAME, lockDir })).toBeNull();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('returns null for cross-host lock (does not unlink)', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 0, worktreeRoot: '/wt' },
    });
    const remote: ProcessLockMetadata = {
      pid: 1,
      hostname: 'other-host',
      port: 3000,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/remote',
    };
    writeFileSync(lockPath, JSON.stringify(remote), 'utf-8');

    expect(readProcessLock({ lockName: LOCK_NAME, lockDir })).toBeNull();
    expect(existsSync(lockPath)).toBe(true);
  });

  test('returns null when lock is missing', () => {
    expect(readProcessLock({ lockName: LOCK_NAME, lockDir })).toBeNull();
  });

  test('returns null for corrupt lock', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 0, worktreeRoot: '/wt' },
    });
    writeFileSync(lockPath, 'garbage', 'utf-8');
    expect(readProcessLock({ lockName: LOCK_NAME, lockDir })).toBeNull();
  });

  test('reads only the named lock (does not cross-contaminate)', () => {
    acquireProcessLock({
      lockName: 'server',
      lockDir,
      metadata: { port: 1111, worktreeRoot: '/wt' },
    });
    expect(readProcessLock({ lockName: 'server', lockDir })?.port).toBe(1111);
    expect(readProcessLock({ lockName: 'ui', lockDir })).toBeNull();
  });
});

describe('releaseProcessLock', () => {
  test('removes lock owned by this process', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 3000, worktreeRoot: '/me' },
    });
    expect(existsSync(lockPath)).toBe(true);
    releaseProcessLock({ lockName: LOCK_NAME, lockDir });
    expect(existsSync(lockPath)).toBe(false);
  });

  test('is safe to call multiple times', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 3000, worktreeRoot: '/me' },
    });
    releaseProcessLock({ lockName: LOCK_NAME, lockDir });
    releaseProcessLock({ lockName: LOCK_NAME, lockDir });
    expect(existsSync(lockPath)).toBe(false);
  });

  test('no-op if lock does not exist', () => {
    releaseProcessLock({ lockName: LOCK_NAME, lockDir });
  });

  test('refuses to remove a lock owned by a different pid', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 0, worktreeRoot: '/me' },
    });
    const foreign: ProcessLockMetadata = {
      pid: 1,
      hostname: hostname(),
      port: 9000,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/other',
    };
    writeFileSync(lockPath, JSON.stringify(foreign), 'utf-8');

    releaseProcessLock({ lockName: LOCK_NAME, lockDir });

    expect(existsSync(lockPath)).toBe(true);
    const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(1);
  });

  // Refcounting protects the Vite dev plugin's per-`configureServer`
  // createServer lifecycle: pass-1's destroy runs releaseProcessLock at the
  // moment pass-2's createServer has already idempotently re-acquired the
  // lock. Without refcounting, pass-1's release unlinks the lock file out
  // from under pass-2 — silently breaking (cross-process collision).
  // The pre-fix variant would FAIL the "still exists after single release"
  // expectation below; the post-fix variant keeps the file until the LAST
  // release.
  test('double acquire then single release keeps lock file in place', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 1111, worktreeRoot: '/wt1' },
    });
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 2222, worktreeRoot: '/wt2' },
    });
    expect(existsSync(lockPath)).toBe(true);

    releaseProcessLock({ lockName: LOCK_NAME, lockDir });

    // Other active acquire still holds the lock — file must remain so
    // a foreign-process acquire (`ok start` against the same contentDir)
    // still throws ProcessLockCollisionError.
    expect(existsSync(lockPath)).toBe(true);
    const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.pid).toBe(process.pid);
    expect(md.port).toBe(2222);
  });

  test('double acquire then double release removes lock file', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 1111, worktreeRoot: '/wt1' },
    });
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 2222, worktreeRoot: '/wt2' },
    });
    releaseProcessLock({ lockName: LOCK_NAME, lockDir });
    expect(existsSync(lockPath)).toBe(true);
    releaseProcessLock({ lockName: LOCK_NAME, lockDir });
    expect(existsSync(lockPath)).toBe(false);
  });

  test('release without prior acquire is a no-op (untracked release path)', () => {
    // Process-exit handlers may fire after the close-handler path already
    // drained the refcount — those untracked releases must remain
    // ownership-guarded but otherwise no-op.
    expect(existsSync(lockPath)).toBe(false);
    releaseProcessLock({ lockName: LOCK_NAME, lockDir });
    expect(existsSync(lockPath)).toBe(false);
  });

  test('refcount drains correctly across an acquire-release-acquire-release cycle', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 1111, worktreeRoot: '/wt1' },
    });
    releaseProcessLock({ lockName: LOCK_NAME, lockDir });
    expect(existsSync(lockPath)).toBe(false);

    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 2222, worktreeRoot: '/wt2' },
    });
    expect(existsSync(lockPath)).toBe(true);
    releaseProcessLock({ lockName: LOCK_NAME, lockDir });
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('version metadata (protocolVersion + runtimeVersion)', () => {
  test('acquireProcessLock auto-populates protocolVersion + runtimeVersion from constants', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 3000, worktreeRoot: '/me' },
    });
    const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(md.runtimeVersion).toBe(RUNTIME_VERSION);
    expect(typeof md.runtimeVersion).toBe('string');
    expect(md.runtimeVersion?.length).toBeGreaterThan(0);
  });

  test('acquireProcessLock honors explicit overrides on the metadata input', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: {
        port: 3000,
        worktreeRoot: '/me',
        protocolVersion: 99,
        runtimeVersion: 'test-1.2.3',
      },
    });
    const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.protocolVersion).toBe(99);
    expect(md.runtimeVersion).toBe('test-1.2.3');
  });

  test('updateProcessLockPort preserves the version fields', () => {
    const handle = acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: {
        port: 0,
        worktreeRoot: '/me',
        protocolVersion: 7,
        runtimeVersion: 'preserve-test',
      },
    });
    handle.updatePort(4000);
    const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(md.port).toBe(4000);
    expect(md.protocolVersion).toBe(7);
    expect(md.runtimeVersion).toBe('preserve-test');
  });
});

describe('readProcessLockDetailed', () => {
  test('returns absent when no lock file exists', () => {
    const result = readProcessLockDetailed({ lockName: LOCK_NAME, lockDir });
    expect(result.status).toBe('absent');
  });

  test('returns live with the parsed lock when fields are complete', () => {
    acquireProcessLock({
      lockName: LOCK_NAME,
      lockDir,
      metadata: { port: 5000, worktreeRoot: '/me' },
    });
    const result = readProcessLockDetailed({ lockName: LOCK_NAME, lockDir });
    expect(result.status).toBe('live');
    if (result.status !== 'live') throw new Error('expected live');
    expect(result.lock.port).toBe(5000);
    expect(result.lock.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.lock.runtimeVersion).toBe(RUNTIME_VERSION);
  });

  test('returns incompatible.missing-fields for a live lock missing protocolVersion', () => {
    // Hand-craft a lock as if a pre-version-constants binary wrote it.
    // Use a real alive foreign pid so liveness passes — pid 1 is now
    // refused by the isValidLockPid validator.
    const versionless = {
      pid: aliveForeignPid(),
      hostname: hostname(),
      port: 6000,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/legacy',
      // No protocolVersion, no runtimeVersion — simulates a v0.x lock.
    };
    require('node:fs').mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify(versionless), 'utf-8');

    const result = readProcessLockDetailed({ lockName: LOCK_NAME, lockDir });
    expect(result.status).toBe('incompatible');
    if (result.status !== 'incompatible') throw new Error('expected incompatible');
    expect(result.reason).toBe('missing-fields');
  });

  test('returns incompatible.missing-fields for a live lock missing runtimeVersion only', () => {
    const partial = {
      pid: aliveForeignPid(),
      hostname: hostname(),
      port: 6500,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/legacy',
      protocolVersion: 1,
      // No runtimeVersion.
    };
    require('node:fs').mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify(partial), 'utf-8');

    const result = readProcessLockDetailed({ lockName: LOCK_NAME, lockDir });
    expect(result.status).toBe('incompatible');
  });

  test('returns incompatible.corrupt for unparseable JSON', () => {
    require('node:fs').mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, '{not json', 'utf-8');
    const result = readProcessLockDetailed({ lockName: LOCK_NAME, lockDir });
    expect(result.status).toBe('incompatible');
    if (result.status !== 'incompatible') throw new Error('expected incompatible');
    expect(result.reason).toBe('corrupt');
  });

  test('returns incompatible.corrupt for shape violation (missing pid)', () => {
    require('node:fs').mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ port: 1234 }), 'utf-8');
    const result = readProcessLockDetailed({ lockName: LOCK_NAME, lockDir });
    expect(result.status).toBe('incompatible');
    if (result.status !== 'incompatible') throw new Error('expected incompatible');
    expect(result.reason).toBe('corrupt');
  });

  test('returns stale + cleans up on dead pid', () => {
    const stale: ProcessLockMetadata = {
      pid: 99999999,
      hostname: hostname(),
      port: 7000,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/old',
      protocolVersion: 1,
      runtimeVersion: '0.1.0',
    };
    require('node:fs').mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify(stale), 'utf-8');

    const result = readProcessLockDetailed({ lockName: LOCK_NAME, lockDir });
    expect(result.status).toBe('stale');
    expect(existsSync(lockPath)).toBe(false);
  });

  test('returns stale (without cleanup) on cross-host lock', () => {
    const remote: ProcessLockMetadata = {
      // Real alive pid (validator rejects pid 1) so the host check is the
      // only reason this classifies as stale.
      pid: aliveForeignPid(),
      hostname: 'some-other-host',
      port: 7100,
      startedAt: new Date().toISOString(),
      worktreeRoot: '/remote',
      protocolVersion: 1,
      runtimeVersion: '0.1.0',
    };
    require('node:fs').mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify(remote), 'utf-8');

    const result = readProcessLockDetailed({ lockName: LOCK_NAME, lockDir });
    expect(result.status).toBe('stale');
    // We do NOT unlink cross-host locks (they're owned by another machine).
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe('lock-pid security validation', () => {
  // Hostile-lock cases: a `<lockDir>/server.lock` whose `pid` field cannot
  // refer to a real OpenKnowledge holder must NEVER feed signal-sending
  // code paths. acquireProcessLock + readProcessLock + readProcessLockDetailed
  // all classify these as corrupt/incompatible so the desktop's auto-kill
  // path cannot trust the pid value.
  const HOSTILE_PIDS: ReadonlyArray<{ pid: unknown; label: string }> = [
    { pid: 0, label: 'PID 0 (process group)' },
    { pid: 1, label: 'PID 1 (init/launchd)' },
    { pid: -42, label: 'negative PID (process group syntax)' },
    { pid: 1.5, label: 'non-integer PID' },
    { pid: Number.NaN, label: 'NaN PID' },
    { pid: Number.POSITIVE_INFINITY, label: 'Infinity PID' },
    { pid: 0x80000000, label: 'PID above 2^31-1 (corrupt or tampered)' },
    { pid: '12345', label: 'string PID (not a number)' },
    { pid: null, label: 'null PID' },
  ];

  for (const { pid, label } of HOSTILE_PIDS) {
    test(`acquireProcessLock replaces hostile lock with ${label}`, () => {
      acquireProcessLock({
        lockName: LOCK_NAME,
        lockDir,
        metadata: { port: 0, worktreeRoot: '/seed' },
      });
      const hostile = {
        pid,
        hostname: hostname(),
        port: 9000,
        startedAt: new Date().toISOString(),
        worktreeRoot: '/attacker',
      };
      writeFileSync(lockPath, JSON.stringify(hostile), 'utf-8');

      // Must not throw a collision — hostile pid is treated as corrupt
      // and the lock gets atomically replaced with our own.
      acquireProcessLock({
        lockName: LOCK_NAME,
        lockDir,
        metadata: { port: 4242, worktreeRoot: '/me' },
      });
      const md: ProcessLockMetadata = JSON.parse(readFileSync(lockPath, 'utf-8'));
      expect(md.pid).toBe(process.pid);
      expect(md.port).toBe(4242);
    });

    test(`readProcessLock returns null for hostile lock with ${label}`, () => {
      const hostile = {
        pid,
        hostname: hostname(),
        port: 9000,
        startedAt: new Date().toISOString(),
        worktreeRoot: '/attacker',
      };
      require('node:fs').mkdirSync(lockDir, { recursive: true });
      writeFileSync(lockPath, JSON.stringify(hostile), 'utf-8');

      expect(readProcessLock({ lockName: LOCK_NAME, lockDir })).toBeNull();
    });

    test(`readProcessLockDetailed returns incompatible.corrupt for hostile lock with ${label}`, () => {
      const hostile = {
        pid,
        hostname: hostname(),
        port: 9000,
        startedAt: new Date().toISOString(),
        worktreeRoot: '/attacker',
        protocolVersion: 1,
        runtimeVersion: '1.0.0',
      };
      require('node:fs').mkdirSync(lockDir, { recursive: true });
      writeFileSync(lockPath, JSON.stringify(hostile), 'utf-8');

      const result = readProcessLockDetailed({ lockName: LOCK_NAME, lockDir });
      expect(result.status).toBe('incompatible');
      if (result.status !== 'incompatible') throw new Error('expected incompatible');
      expect(result.reason).toBe('corrupt');
    });
  }

  test('isValidLockPid rejects hostile sentinels', async () => {
    const { isValidLockPid } = await import('./process-alive.ts');
    expect(isValidLockPid(0)).toBe(false);
    expect(isValidLockPid(1)).toBe(false);
    expect(isValidLockPid(-1)).toBe(false);
    expect(isValidLockPid(1.5)).toBe(false);
    expect(isValidLockPid(Number.NaN)).toBe(false);
    expect(isValidLockPid(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidLockPid(0x80000000)).toBe(false);
    expect(isValidLockPid('123')).toBe(false);
    expect(isValidLockPid(null)).toBe(false);
    // Own pid is structurally valid — the lock-acquire idempotent rewrite
    // path stores process.pid in our own lock. The "do not signal self"
    // guard is the responsibility of the desktop kill site, not the parser.
    expect(isValidLockPid(process.pid)).toBe(true);
    expect(isValidLockPid(process.ppid > 1 ? process.ppid : 12345)).toBe(true);
  });
});
