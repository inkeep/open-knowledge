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
