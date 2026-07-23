import { describe, expect, test } from 'vitest';
import { buildCleanPlan, runClean } from './clean.ts';
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
function missing(name: string): LockState {
  return { status: 'missing', lockPath: `/tmp/${name}.lock` };
}
function corrupt(name: string): LockState {
  return { status: 'corrupt', lockPath: `/tmp/${name}.lock` };
}
function dead(name: string, pid: number): LockState {
  return {
    status: 'dead-pid',
    lockPath: `/tmp/${name}.lock`,
    lock: {
      pid,
      port: 0,
      hostname: 'host',
      startedAt: '2026-04-16T00:00:00Z',
      worktreeRoot: '/x',
    },
  };
}
function foreign(name: string): LockState {
  return {
    status: 'foreign-host',
    lockPath: `/tmp/${name}.lock`,
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
  test('no stale → empty prune', () => {
    const plan = buildCleanPlan(alive(100, 3001), alive(200, 3000));
    expect(plan.prune).toEqual([]);
  });

  test('dead + corrupt → both pruned', () => {
    const plan = buildCleanPlan(dead('server', 999), corrupt('ui'));
    expect(plan.prune).toEqual([
      { name: 'server', lockPath: '/tmp/server.lock', reason: 'dead-pid' },
      { name: 'ui', lockPath: '/tmp/ui.lock', reason: 'corrupt' },
    ]);
  });

  test('missing locks are not pruned', () => {
    const plan = buildCleanPlan(missing('server'), missing('ui'));
    expect(plan.prune).toEqual([]);
  });

  test('foreign-host locks are not pruned (not ours to touch)', () => {
    const plan = buildCleanPlan(foreign('server'), foreign('ui'));
    expect(plan.prune).toEqual([]);
  });

  test('mix: live server + stale ui → only ui pruned', () => {
    const plan = buildCleanPlan(alive(100, 3001), dead('ui', 999));
    expect(plan.prune.map((t) => t.name)).toEqual(['ui']);
  });
});

describe('runClean', () => {
  test('no stale locks → log, no unlinks', () => {
    const logs: string[] = [];
    const unlinked: string[] = [];
    const outcome = runClean({
      lockDir: '/tmp/x',
      inspect: (name) => (name === 'server' ? alive(100, 3001) : missing('ui')),
      unlink: (p) => unlinked.push(p),
      log: (msg) => logs.push(msg),
      error: () => {},
    });
    expect(unlinked).toEqual([]);
    expect(outcome.pruned).toEqual([]);
    expect(logs).toEqual(['No stale locks.']);
  });

  test('all stale → unlink both + summary', () => {
    const logs: string[] = [];
    const unlinked: string[] = [];
    const outcome = runClean({
      lockDir: '/tmp/x',
      inspect: (name) => (name === 'server' ? dead('server', 999) : corrupt('ui')),
      unlink: (p) => unlinked.push(p),
      log: (msg) => logs.push(msg),
      error: () => {},
    });
    expect(unlinked).toEqual(['/tmp/server.lock', '/tmp/ui.lock']);
    expect(outcome.pruned).toHaveLength(2);
    expect(outcome.failed).toEqual([]);
    expect(logs.at(0)).toContain('Pruned 2 stale locks');
    expect(logs.at(0)).toContain('server (dead-pid)');
    expect(logs.at(0)).toContain('ui (corrupt)');
  });

  test('singular grammar when only one stale', () => {
    const logs: string[] = [];
    runClean({
      lockDir: '/tmp/x',
      inspect: (name) => (name === 'server' ? dead('server', 999) : alive(200, 3000)),
      unlink: () => {},
      log: (msg) => logs.push(msg),
      error: () => {},
    });
    expect(logs.at(0)).toContain('Pruned 1 stale lock:');
  });

  test('live + stale — only prunes stale, leaves live alone', () => {
    const unlinked: string[] = [];
    const outcome = runClean({
      lockDir: '/tmp/x',
      inspect: (name) => (name === 'server' ? alive(100, 3001) : dead('ui', 999)),
      unlink: (p) => unlinked.push(p),
      log: () => {},
      error: () => {},
    });
    expect(unlinked).toEqual(['/tmp/ui.lock']);
    expect(outcome.pruned.map((t) => t.name)).toEqual(['ui']);
  });

  test('unlink failure → reported as failed', () => {
    const errors: string[] = [];
    const outcome = runClean({
      lockDir: '/tmp/x',
      inspect: (name) => (name === 'server' ? dead('server', 999) : missing('ui')),
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
