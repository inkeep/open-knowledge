import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { inspectLock } from './lock-state.ts';

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshLockDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-lock-state-'));
  fixtures.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('inspectLock', () => {
  test.each([undefined, 0, '123'])('retains foreign ownership when PID %j is unusable', (pid) => {
    const dir = freshLockDir();
    writeFileSync(join(dir, 'server.lock'), JSON.stringify({ pid, machineId: 'foreign' }));
    expect(
      inspectLock(dir, 'server', {
        machineId: 'local',
        isAlive: () => {
          throw new Error('no probe');
        },
      }),
    ).toMatchObject({ status: 'corrupt', foreignHost: true });
  });

  test('a PID without ownership metadata cannot be classified as a local live server', () => {
    const dir = freshLockDir();
    writeFileSync(join(dir, 'server.lock'), JSON.stringify({ pid: 4242 }));
    expect(inspectLock(dir, 'server', { isAlive: () => true })).toEqual({
      status: 'unverified-owner',
      lockPath: join(dir, 'server.lock'),
      pid: 4242,
    });
  });

  test('a live PID with a matching hostname retains its local ownership', () => {
    const dir = freshLockDir();
    writeFileSync(join(dir, 'server.lock'), JSON.stringify({ pid: 4242, hostname: hostname() }));
    expect(inspectLock(dir, 'server', { isAlive: () => true })).toMatchObject({
      status: 'alive',
      lock: { pid: 4242, hostname: hostname() },
    });
  });

  test('recovers a dead PID-only lock without inventing foreign ownership', () => {
    const dir = freshLockDir();
    writeFileSync(join(dir, 'server.lock'), JSON.stringify({ pid: 4242 }));
    expect(inspectLock(dir, 'server', { isAlive: () => false }).status).toBe('dead-pid');
  });

  test('missing lock file', () => {
    const dir = freshLockDir();
    const result = inspectLock(dir, 'server');
    expect(result.status).toBe('missing');
    expect(result.lockPath.endsWith('/server.lock')).toBe(true);
  });

  test('corrupt JSON', () => {
    const dir = freshLockDir();
    writeFileSync(join(dir, 'server.lock'), 'not-json{{{', 'utf-8');
    const result = inspectLock(dir, 'server');
    expect(result.status).toBe('corrupt');
    expect(result.lockPath.endsWith('/server.lock')).toBe(true);
  });

  test('valid JSON but missing pid is treated as corrupt', () => {
    const dir = freshLockDir();
    writeFileSync(join(dir, 'server.lock'), JSON.stringify({ port: 3000 }), 'utf-8');
    const result = inspectLock(dir, 'server');
    expect(result.status).toBe('corrupt');
  });

  test('foreign host with locally-live PID classifies foreign-host', () => {
    const dir = freshLockDir();
    writeFileSync(
      join(dir, 'server.lock'),
      JSON.stringify({
        pid: 12345,
        hostname: 'other-box',
        port: 3000,
        startedAt: '2026-04-16T00:00:00Z',
        worktreeRoot: '/x',
      }),
      'utf-8',
    );
    const result = inspectLock(dir, 'server', { host: 'this-box', isAlive: () => true });
    expect(result.status).toBe('foreign-host');
    if (result.status === 'foreign-host') {
      expect(result.lock.hostname).toBe('other-box');
    }
  });

  test('foreign host remains foreign even when its PID is absent locally', () => {
    const dir = freshLockDir();
    writeFileSync(
      join(dir, 'server.lock'),
      JSON.stringify({
        pid: 999999,
        hostname: 'previous-hostname',
        port: 3000,
        startedAt: '2026-04-16T00:00:00Z',
        worktreeRoot: '/x',
      }),
      'utf-8',
    );
    const result = inspectLock(dir, 'server', {
      host: 'current-hostname',
      isAlive: () => false,
    });
    expect(result.status).toBe('foreign-host');
    if (result.status === 'foreign-host') {
      expect(result.lock.pid).toBe(999999);
      expect(result.lock.hostname).toBe('previous-hostname');
    }
  });

  test('matching machineId classifies alive even when hostname has drifted', () => {
    const dir = freshLockDir();
    writeFileSync(
      join(dir, 'server.lock'),
      JSON.stringify({
        pid: 4242,
        hostname: 'drifted-bonjour-name',
        machineId: 'machine-A',
        port: 3000,
        startedAt: '2026-04-16T00:00:00Z',
        worktreeRoot: '/x',
      }),
      'utf-8',
    );
    const result = inspectLock(dir, 'server', {
      machineId: 'machine-A',
      host: 'current-hostname',
      isAlive: () => true,
    });
    expect(result.status).toBe('alive');
  });

  test('foreign machineId with a live PID classifies foreign-host (machineId beats a matching hostname)', () => {
    const dir = freshLockDir();
    writeFileSync(
      join(dir, 'server.lock'),
      JSON.stringify({
        pid: 4243,
        hostname: 'current-hostname',
        machineId: 'machine-B',
        port: 3000,
        startedAt: '2026-04-16T00:00:00Z',
        worktreeRoot: '/x',
      }),
      'utf-8',
    );
    const result = inspectLock(dir, 'server', {
      machineId: 'machine-A',
      host: 'current-hostname',
      isAlive: () => true,
    });
    expect(result.status).toBe('foreign-host');
  });

  test('dead pid on same host', () => {
    const dir = freshLockDir();
    writeFileSync(
      join(dir, 'server.lock'),
      JSON.stringify({
        pid: 999999,
        hostname: hostname(),
        port: 3000,
        startedAt: '2026-04-16T00:00:00Z',
        worktreeRoot: '/x',
      }),
      'utf-8',
    );
    const result = inspectLock(dir, 'server', { isAlive: () => false });
    expect(result.status).toBe('dead-pid');
    if (result.status === 'dead-pid') {
      expect(result.lock.pid).toBe(999999);
    }
  });

  test('alive pid on same host', () => {
    const dir = freshLockDir();
    writeFileSync(
      join(dir, 'server.lock'),
      JSON.stringify({
        pid: 4242,
        hostname: hostname(),
        port: 52831,
        startedAt: '2026-04-16T00:00:00Z',
        worktreeRoot: '/x',
      }),
      'utf-8',
    );
    const result = inspectLock(dir, 'server', { isAlive: (pid) => pid === 4242 });
    expect(result.status).toBe('alive');
    if (result.status === 'alive') {
      expect(result.lock.pid).toBe(4242);
      expect(result.lock.port).toBe(52831);
    }
  });

  test('peeks do not mutate filesystem (dead pid lock remains for ok clean)', () => {
    const dir = freshLockDir();
    writeFileSync(
      join(dir, 'server.lock'),
      JSON.stringify({
        pid: 999999,
        hostname: hostname(),
        port: 0,
        startedAt: '2026-04-16T00:00:00Z',
        worktreeRoot: '/x',
      }),
      'utf-8',
    );
    const first = inspectLock(dir, 'server', { isAlive: () => false });
    expect(first.status).toBe('dead-pid');
    const second = inspectLock(dir, 'server', { isAlive: () => false });
    expect(second.status).toBe('dead-pid');
  });
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'distinguishes unreadable lock contents from malformed JSON',
  () => {
    const dir = freshLockDir();
    const path = join(dir, 'server.lock');
    writeFileSync(path, 'not json');
    chmodSync(path, 0o000);
    try {
      expect(inspectLock(dir, 'server')).toMatchObject({
        status: 'read-error',
        error: expect.stringContaining('EACCES'),
      });
    } finally {
      chmodSync(path, 0o600);
    }
  },
);
