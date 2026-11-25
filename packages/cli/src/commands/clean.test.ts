import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { buildCleanPlan, runClean } from './clean.ts';
import { startDefunctProcess } from './defunct-process.test-helper.ts';
import type { LockState } from './lock-state.ts';

function alive(pid: number, port: number): LockState {
  return {
    status: 'alive',
    lockPath: `/tmp/fake-${pid}.lock`,
    lock: {
      pid,
      port,
      hostname: 'host',
      startedAt: '2026-04-16T00:00:00Z',
      worktreeRoot: '/x',
    },
  };
}
function missing(): LockState {
  return { status: 'missing', lockPath: '/tmp/server.lock' };
}
function corrupt(): Extract<LockState, { status: 'corrupt' }> {
  return { status: 'corrupt', lockPath: '/tmp/server.lock', text: '{' };
}
function dead(pid: number): Extract<LockState, { status: 'dead-pid' }> {
  const lock = {
    pid,
    port: 0,
    hostname: 'host',
    startedAt: '2026-04-16T00:00:00Z',
    worktreeRoot: '/x',
  };
  return { status: 'dead-pid', lockPath: '/tmp/server.lock', lock, text: JSON.stringify(lock) };
}
function reused(pid: number): Extract<LockState, { status: 'reused-pid' }> {
  const lock = {
    pid,
    port: 3000,
    hostname: 'host',
    startedAt: '2026-04-16T00:00:00Z',
    worktreeRoot: '/x',
  };
  return { status: 'reused-pid', lockPath: '/tmp/server.lock', lock, text: JSON.stringify(lock) };
}
function foreign(): LockState {
  return {
    status: 'foreign-host',
    lockPath: '/tmp/server.lock',
    lock: {
      pid: 1,
      port: 3000,
      hostname: 'other-host',
      startedAt: '2026-04-16T00:00:00Z',
      worktreeRoot: '/x',
    },
  };
}

describe('buildCleanPlan', () => {
  test('alive → empty prune', () => {
    const plan = buildCleanPlan(alive(100, 3001));
    expect(plan.prune).toEqual([]);
  });

  test('dead-pid → pruned', () => {
    const checked = dead(999);
    expect(buildCleanPlan(checked).prune).toEqual([
      {
        name: 'server',
        lockPath: '/tmp/server.lock',
        reason: 'dead-pid',
        text: checked.text,
      },
    ]);
  });

  test('reused-pid → pruned', () => {
    const checked = reused(4242);
    expect(buildCleanPlan(checked).prune).toEqual([
      {
        name: 'server',
        lockPath: '/tmp/server.lock',
        reason: 'reused-pid',
        text: checked.text,
      },
    ]);
  });

  test('corrupt → pruned', () => {
    const plan = buildCleanPlan(corrupt());
    expect(plan.prune).toEqual([
      { name: 'server', lockPath: '/tmp/server.lock', reason: 'corrupt', text: '{' },
    ]);
  });

  test('missing locks are not pruned', () => {
    const plan = buildCleanPlan(missing());
    expect(plan.prune).toEqual([]);
  });

  test('foreign-host locks are not pruned (not ours to touch)', () => {
    const plan = buildCleanPlan(foreign());
    expect(plan.prune).toEqual([]);
  });
});

describe('runClean', () => {
  test.each([
    [missing(), 'nothing-to-clean'],
    [alive(100, 3001), 'live-retained'],
    [foreign(), 'ownership-unverified'],
    [
      { status: 'unverified-owner', lockPath: '/tmp/server.lock', pid: 100 } as LockState,
      'ownership-unverified',
    ],
    [
      { status: 'corrupt', lockPath: '/tmp/server.lock', foreignHost: true } as LockState,
      'ownership-unverified',
    ],
    [
      { status: 'read-error', lockPath: '/tmp/server.lock', error: 'EACCES' } as LockState,
      'read-failed',
    ],
  ] as const)('retains %s with typed %s decision', (state, code) => {
    const unlinked: string[] = [];
    const outcome = runClean({
      lockDir: '/tmp/x',
      inspect: () => state,
      unlink: (path) => unlinked.push(path),
      log: () => {},
      error: () => {},
    });
    expect(outcome.decision.code).toBe(code);
    expect(unlinked).toEqual([]);
  });

  test.each([dead(999), corrupt()])('removes stale %s with typed success', (state) => {
    const unlinked: string[] = [];
    const outcome = runClean({
      lockDir: '/tmp/x',
      inspect: () => state,
      unlink: (path) => unlinked.push(path),
      log: () => {},
      error: () => {},
    });
    expect(outcome.decision.code).toBe('stale-removed');
    expect(unlinked).toEqual([state.lockPath]);
  });
  test('reports foreign ownership as a refusal instead of claiming no stale locks', () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const unlinked: string[] = [];
    const outcome = runClean({
      lockDir: '/tmp/x',
      inspect: foreign,
      unlink: (path) => unlinked.push(path),
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    });
    expect(outcome.failed).toHaveLength(1);
    expect(unlinked).toEqual([]);
    expect(logs).toEqual([]);
    expect(errors.join(' ')).toContain('another machine');
  });

  test('reports unreadable locks without deleting them or claiming no stale locks', () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const unlinked: string[] = [];
    const outcome = runClean({
      lockDir: '/tmp/x',
      inspect: () => ({ status: 'read-error', lockPath: '/tmp/server.lock', error: 'EACCES' }),
      unlink: (path) => unlinked.push(path),
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    });
    expect(unlinked).toEqual([]);
    expect(logs).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
    expect(errors.join(' ')).toContain('Restore file and parent-directory access');
    expect(errors.join(' ')).toContain('EACCES');
  });

  test('no stale locks → log, no unlinks', () => {
    const logs: string[] = [];
    const unlinked: string[] = [];
    const outcome = runClean({
      lockDir: '/tmp/x',
      inspect: () => alive(100, 3001),
      unlink: (p) => unlinked.push(p),
      log: (msg) => logs.push(msg),
      error: () => {},
    });
    expect(unlinked).toEqual([]);
    expect(outcome.pruned).toEqual([]);
    expect(logs).toEqual(['No stale locks.']);
  });

  test('stale → unlink + summary with singular grammar', () => {
    const logs: string[] = [];
    const unlinked: string[] = [];
    const outcome = runClean({
      lockDir: '/tmp/x',
      inspect: () => dead(999),
      unlink: (p) => unlinked.push(p),
      log: (msg) => logs.push(msg),
      error: () => {},
    });
    expect(unlinked).toEqual(['/tmp/server.lock']);
    expect(outcome.pruned).toHaveLength(1);
    expect(outcome.failed).toEqual([]);
    expect(logs.at(0)).toContain('Pruned 1 stale lock:');
    expect(logs.at(0)).toContain('server (dead-pid)');
  });

  test('a lock whose pid now belongs to another process is pruned and labelled reused-pid', () => {
    const logs: string[] = [];
    const unlinked: string[] = [];
    const outcome = runClean({
      lockDir: '/tmp/x',
      inspect: () => reused(4242),
      unlink: (p) => unlinked.push(p),
      log: (msg) => logs.push(msg),
      error: () => {},
    });
    expect(unlinked).toEqual(['/tmp/server.lock']);
    expect(outcome.failed).toEqual([]);
    expect(logs).toEqual(['Pruned 1 stale lock: server (reused-pid)']);
  });

  test('unlink failure → reported as failed', () => {
    const errors: string[] = [];
    const outcome = runClean({
      lockDir: '/tmp/x',
      inspect: () => dead(999),
      unlink: () => {
        throw new Error('EACCES');
      },
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    expect(outcome.pruned).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.error).toBe('EACCES');
    expect(errors.at(0)).toContain('server (/tmp/server.lock)');
  });
});

test('never prunes a malformed foreign-owned lock', () => {
  const unlinked: string[] = [];
  const outcome = runClean({
    lockDir: '/tmp/x',
    inspect: () => ({
      status: 'corrupt',
      lockPath: '/tmp/foreign.lock',
      text: '{',
      foreignHost: true,
    }),
    unlink: (path) => unlinked.push(path),
    log: () => {},
    error: () => {},
  });
  expect(unlinked).toEqual([]);
  expect(outcome.failed[0]?.error).toContain('owning machine');
});

describe('runClean over a lock another server took after it was checked', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const checkedLock = {
    pid: 4242,
    hostname: hostname(),
    port: 7391,
    startedAt: '2026-04-16T00:00:00Z',
    worktreeRoot: '/project',
  };
  const checkedText = JSON.stringify(checkedLock);
  const successorUnderSamePid = JSON.stringify({
    ...checkedLock,
    port: 7392,
    startedAt: '2026-04-16T00:05:00Z',
  });

  function checkedState(
    status: 'dead-pid' | 'reused-pid' | 'corrupt',
    lockPath: string,
  ): Extract<LockState, { text: string }> {
    return status === 'corrupt'
      ? { status, lockPath, text: '{ "pid": 4242, "hostname"' }
      : { status, lockPath, lock: checkedLock, text: checkedText };
  }

  function lockFile(text: string): string {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-clean-replaced-')));
    const lockPath = join(root, 'server.lock');
    writeFileSync(lockPath, text);
    return lockPath;
  }

  const successors = [
    [
      'another pid',
      JSON.stringify({ ...checkedLock, pid: 4343, startedAt: '2026-04-16T00:05:00Z' }),
    ],
    ['the same pid', successorUnderSamePid],
    ['nothing yet', ''],
    ['part of its lock', successorUnderSamePid.slice(0, 20)],
  ] as const;
  const cases = (['dead-pid', 'reused-pid', 'corrupt'] as const).flatMap((status) =>
    successors.map(([successor, text]) => [status, successor, text] as const),
  );

  test.each(cases)(
    'leaves the new lock in place when the checked lock was %s and the successor wrote %s',
    (status, _successor, successorText) => {
      const lockPath = lockFile(successorText);

      const outcome = runClean({
        lockDir: root ?? '',
        inspect: () => checkedState(status, lockPath),
        log: () => {},
        error: () => {},
      });

      expect(outcome.decision.code).toBe('remove-failed');
      expect(readFileSync(lockPath, 'utf-8')).toBe(successorText);
      expect(outcome.pruned).toEqual([]);
      expect(outcome.failed.map((failure) => failure.error)).toEqual([
        'the lock changed after it was checked, so it was left in place',
      ]);
    },
  );

  test.each(['dead-pid', 'reused-pid', 'corrupt'] as const)(
    'removes a %s lock that still holds what was checked',
    (status) => {
      const lockPath = lockFile('');
      const checked = checkedState(status, lockPath);
      writeFileSync(lockPath, checked.text);

      const outcome = runClean({
        lockDir: root ?? '',
        inspect: () => checked,
        log: () => {},
        error: () => {},
      });

      expect(outcome.failed).toEqual([]);
      expect(outcome.decision.code).toBe('stale-removed');
      expect(outcome.pruned.map((target) => target.reason)).toEqual([status]);
      expect(existsSync(lockPath)).toBe(false);
    },
  );

  test('reports a lock that was removed after it was checked', () => {
    const lockPath = lockFile(checkedText);
    rmSync(lockPath);

    const outcome = runClean({
      lockDir: root ?? '',
      inspect: () => checkedState('dead-pid', lockPath),
      log: () => {},
      error: () => {},
    });

    expect(outcome.pruned).toEqual([]);
    expect(outcome.failed.map((failure) => failure.error)).toEqual([
      'the lock was removed after it was checked',
    ]);
  });
});

describe('runClean over a lock whose recorded process has exited but is unreaped', () => {
  const children: ChildProcess[] = [];
  let root: string | undefined;

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  test.skipIf(process.platform === 'win32')('prunes it, as a crash-stale lock', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-clean-defunct-')));
    const defunct = await startDefunctProcess(root, children);
    expect(defunct.state).toMatch(/^Z/);

    const lockDir = join(root, '.ok', 'local');
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, 'server.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: defunct.pid,
        hostname: hostname(),
        port: 7391,
        startedAt: new Date().toISOString(),
        worktreeRoot: root,
      }),
    );

    const outcome = runClean({ lockDir, log: () => {}, error: () => {} });

    expect(outcome.failed).toEqual([]);
    expect(outcome.pruned.map((target) => target.lockPath)).toEqual([lockPath]);
    expect(existsSync(lockPath)).toBe(false);
  });
});
