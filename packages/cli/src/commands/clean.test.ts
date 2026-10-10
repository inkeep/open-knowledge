import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
function corrupt(): LockState {
  return { status: 'corrupt', lockPath: '/tmp/server.lock' };
}
function dead(pid: number): LockState {
  return {
    status: 'dead-pid',
    lockPath: '/tmp/server.lock',
    lock: {
      pid,
      port: 0,
      hostname: 'host',
      startedAt: '2026-04-16T00:00:00Z',
      worktreeRoot: '/x',
    },
  };
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
    const plan = buildCleanPlan(dead(999));
    expect(plan.prune).toEqual([
      { name: 'server', lockPath: '/tmp/server.lock', reason: 'dead-pid' },
    ]);
  });

  test('corrupt → pruned', () => {
    const plan = buildCleanPlan(corrupt());
    expect(plan.prune).toEqual([
      { name: 'server', lockPath: '/tmp/server.lock', reason: 'corrupt' },
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
    inspect: () => ({ status: 'corrupt', lockPath: '/tmp/foreign.lock', foreignHost: true }),
    unlink: (path) => unlinked.push(path),
    log: () => {},
    error: () => {},
  });
  expect(unlinked).toEqual([]);
  expect(outcome.failed[0]?.error).toContain('owning machine');
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
