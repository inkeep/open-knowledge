import { chmodSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { machineIdFilePath, type ProcessStart } from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createTempDirFactory } from '../../../../test-support/temp-dir.test-helper.ts';
import { describeLockOwnershipRefusal, inspectLock } from './lock-state.ts';

const startedBeforeFixtureLocks = (): ProcessStart => ({
  startedAtMs: Date.parse('2026-04-15T00:00:00Z'),
  clock: 'creation',
});

const tempDir = createTempDirFactory(afterEach);

function freshLockDir(): string {
  return tempDir('ok-lock-state-');
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
    expect(inspectLock(dir, 'server', { isAlive: () => false })).toMatchObject({
      status: 'dead-pid',
      text: JSON.stringify({ pid: 4242 }),
    });
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
    expect(inspectLock(dir, 'server')).toEqual({
      status: 'corrupt',
      lockPath: join(dir, 'server.lock'),
      text: 'not-json{{{',
    });
  });

  test('valid JSON but missing pid is treated as corrupt', () => {
    const dir = freshLockDir();
    writeFileSync(join(dir, 'server.lock'), JSON.stringify({ port: 3000 }), 'utf-8');
    expect(inspectLock(dir, 'server')).toEqual({
      status: 'corrupt',
      lockPath: join(dir, 'server.lock'),
      text: JSON.stringify({ port: 3000 }),
    });
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
      readProcessStart: startedBeforeFixtureLocks,
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
    const result = inspectLock(dir, 'server', {
      isAlive: (pid) => pid === 4242,
      readProcessStart: startedBeforeFixtureLocks,
    });
    expect(result.status).toBe('alive');
    if (result.status === 'alive') {
      expect(result.lock.pid).toBe(4242);
      expect(result.lock.port).toBe(52831);
    }
  });

  function writeSameHostLock(dir: string, overrides: Record<string, unknown> = {}) {
    const lock = {
      pid: 4242,
      hostname: hostname(),
      port: 52831,
      startedAt: '2026-04-16T00:00:00Z',
      worktreeRoot: '/x',
      ...overrides,
    };
    writeFileSync(join(dir, 'server.lock'), JSON.stringify(lock), 'utf-8');
    return lock;
  }

  test('a live pid whose holder started well after the lock was written is a reused pid', () => {
    const dir = freshLockDir();
    const lock = writeSameHostLock(dir);
    expect(
      inspectLock(dir, 'server', {
        isAlive: () => true,
        readProcessStart: () => ({
          startedAtMs: Date.parse('2026-04-17T12:00:00Z'),
          clock: 'creation',
        }),
      }),
    ).toEqual({
      status: 'reused-pid',
      lockPath: join(dir, 'server.lock'),
      lock,
      text: JSON.stringify(lock),
    });
  });

  test.each([
    ['started before the lock was written', startedBeforeFixtureLocks],
    ['cannot be identified', () => null],
  ] as const)('a live pid whose holder %s stays alive', (_case, readProcessStart) => {
    const dir = freshLockDir();
    const lock = writeSameHostLock(dir);
    expect(inspectLock(dir, 'server', { isAlive: () => true, readProcessStart })).toEqual({
      status: 'alive',
      lockPath: join(dir, 'server.lock'),
      lock,
    });
  });

  test('a recorded process start naming another process decides over the lock start time', () => {
    const dir = freshLockDir();
    const lock = writeSameHostLock(dir, {
      processStart: { startedAtMs: Date.parse('2026-04-15T00:00:00Z') },
    });
    expect(
      inspectLock(dir, 'server', {
        isAlive: () => true,
        readProcessStart: () => ({
          startedAtMs: Date.parse('2026-04-16T00:00:01Z'),
          clock: 'creation',
        }),
      }),
    ).toEqual({
      status: 'reused-pid',
      lockPath: join(dir, 'server.lock'),
      lock,
      text: JSON.stringify(lock),
    });
  });

  test('a holder that exits while its start is read is a dead pid', () => {
    const dir = freshLockDir();
    writeFileSync(
      join(dir, 'server.lock'),
      JSON.stringify({ pid: 4242, hostname: hostname(), startedAt: '2026-04-16T00:00:00Z' }),
    );
    const liveness = [true, false];
    expect(
      inspectLock(dir, 'server', {
        isAlive: () => liveness.shift() ?? false,
        readProcessStart: () => null,
      }).status,
    ).toBe('dead-pid');
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

describe('describeLockOwnershipRefusal', () => {
  const lockPath = '/tmp/x/server.lock';
  const lock = {
    pid: 4242,
    port: 3000,
    startedAt: '2026-04-16T00:00:00Z',
    worktreeRoot: '/tmp/x',
  };
  const keepTheLockUntilConfirmed =
    'Confirm that no OpenKnowledge server is using this directory on the owning machine or any other machine sharing it. ' +
    `Only then remove the stale lock file at ${lockPath} and retry cleanup.`;

  test('a lock with another machine ID names the account and home folder remedies before removing the lock', () => {
    expect(
      describeLockOwnershipRefusal(
        {
          status: 'foreign-host',
          lockPath,
          lock: {
            ...lock,
            hostname: hostname(),
            machineId: '6f1c2d4e-0000-4000-8000-000000000000',
          },
        },
        'darwin',
      ),
    ).toBe(
      `Cannot verify shutdown: the server lock at ${lockPath} records a machine ID different from the one in ${machineIdFilePath()}. ` +
        'If the server was started on this machine from another account, run `ok stop` as that account while it is running, or `ok clean` once it has exited. ' +
        'If it was started from this account with a different home folder, run the same command with `HOME` set to that folder. ' +
        'Otherwise run the same command on the machine that owns the lock. ' +
        'This lock records no process start; a server started by this release records one, which lets `ok stop` confirm it from any home folder. ' +
        keepTheLockUntilConfirmed,
    );
  });

  test('a lock naming a host with control characters reaches the refusal escaped', () => {
    const text = describeLockOwnershipRefusal(
      {
        status: 'foreign-host',
        lockPath,
        lock: { ...lock, hostname: 'evil\nRun: ok clean --all\u001b]52;c;Zm9v\u0007' },
      },
      'darwin',
    );

    expect(text).toContain(
      'records only the host evil\\u000aRun: ok clean --all\\u001b]52;c;Zm9v\\u0007,',
    );
    expect(text).toContain(
      'If evil\\u000aRun: ok clean --all\\u001b]52;c;Zm9v\\u0007 is another machine',
    );
    expect(text).not.toContain('\n');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
  });

  test('a Beta CLI names its own stop command in the account and home folder remedies', () => {
    vi.stubEnv('OK_CHANNEL', 'beta');
    try {
      const text = describeLockOwnershipRefusal(
        {
          status: 'foreign-host',
          lockPath,
          lock: {
            ...lock,
            hostname: hostname(),
            machineId: '6f1c2d4e-0000-4000-8000-000000000000',
          },
        },
        'darwin',
      );
      expect(text).toContain(
        'run `ok-beta stop` as that account while it is running, or `ok-beta clean` once it has exited',
      );
      expect(text).toContain('which lets `ok-beta stop` confirm it');
      expect(text).not.toMatch(/`ok (stop|clean)/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('a lock with only another host name allows for a renamed machine', () => {
    expect(
      describeLockOwnershipRefusal({
        status: 'foreign-host',
        lockPath,
        lock: { ...lock, hostname: 'other-host' },
      }),
    ).toBe(
      `Cannot verify shutdown: the server lock at ${lockPath} records only the host other-host, not this machine's ${hostname()}. ` +
        'If other-host is another machine, stop OpenKnowledge there; if it is an earlier name of this machine, stop OpenKnowledge here if it is still running. ' +
        keepTheLockUntilConfirmed,
    );
  });

  test('a malformed lock naming another owner does not claim the owner is another machine', () => {
    expect(
      describeLockOwnershipRefusal({ status: 'corrupt', lockPath, text: '{', foreignHost: true }),
    ).toBe(
      `Cannot verify shutdown: the server lock at ${lockPath} records a machine ID or host name that is not this machine's, so its server may run on another machine, or on this one from another account, with a different home folder, or under an earlier host name. ` +
        'Stop OpenKnowledge wherever it was started. ' +
        keepTheLockUntilConfirmed,
    );
  });
});
