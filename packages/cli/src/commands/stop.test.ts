import { describe, expect, test } from 'bun:test';
import type { LockState } from './lock-state.ts';
import { buildStopPlan, runStop } from './stop.ts';

function aliveLock(pid: number, port: number): LockState {
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
  return { status: 'missing', lockPath: '/tmp/missing.lock' };
}
function dead(pid: number): LockState {
  return {
    status: 'dead-pid',
    lockPath: `/tmp/fake-${pid}.lock`,
    lock: {
      pid,
      port: 0,
      hostname: 'host',
      startedAt: '2026-04-16T00:00:00Z',
      worktreeRoot: '/x',
    },
  };
}
function foreign(pid: number, port: number): LockState {
  return {
    status: 'foreign-host',
    lockPath: `/tmp/fake-${pid}.lock`,
    lock: {
      pid,
      port,
      hostname: 'other-host',
      startedAt: '2026-04-16T00:00:00Z',
      worktreeRoot: '/x',
    },
  };
}

describe('buildStopPlan', () => {
  test('both alive → both targeted', () => {
    const plan = buildStopPlan(aliveLock(100, 3001), aliveLock(200, 3000));
    expect(plan.targets).toEqual([
      { name: 'server', pid: 100, port: 3001 },
      { name: 'ui', pid: 200, port: 3000 },
    ]);
  });

  test('neither alive → no targets', () => {
    const plan = buildStopPlan(missing(), dead(999));
    expect(plan.targets).toEqual([]);
  });

  test('only server alive → only server targeted', () => {
    const plan = buildStopPlan(aliveLock(100, 3001), dead(999));
    expect(plan.targets).toEqual([{ name: 'server', pid: 100, port: 3001 }]);
  });

  test('only ui alive → only ui targeted', () => {
    const plan = buildStopPlan(missing(), aliveLock(200, 3000));
    expect(plan.targets).toEqual([{ name: 'ui', pid: 200, port: 3000 }]);
  });
});

describe('runStop', () => {
  test('no running processes → log and exit 0 equivalent', () => {
    const logs: string[] = [];
    const killed: Array<[number, string]> = [];
    const outcome = runStop({
      lockDir: '/tmp/x',
      inspect: () => missing(),
      kill: (pid, sig) => killed.push([pid, sig]),
      log: (msg) => logs.push(msg),
      error: () => {},
    });
    expect(outcome.hadTargets).toBe(false);
    expect(outcome.stopped).toEqual([]);
    expect(outcome.failed).toEqual([]);
    expect(killed).toEqual([]);
    expect(logs).toEqual(['No running open-knowledge processes.']);
  });

  test('both alive → SIGTERM both, log stopped summary', () => {
    const logs: string[] = [];
    const killed: Array<[number, string]> = [];
    const outcome = runStop({
      lockDir: '/tmp/x',
      inspect: (name) => (name === 'server' ? aliveLock(100, 3001) : aliveLock(200, 3000)),
      kill: (pid, sig) => killed.push([pid, sig]),
      log: (msg) => logs.push(msg),
      error: () => {},
    });
    expect(killed).toEqual([
      [100, 'SIGTERM'],
      [200, 'SIGTERM'],
    ]);
    expect(outcome.stopped.map((t) => t.name)).toEqual(['server', 'ui']);
    expect(outcome.failed).toEqual([]);
    expect(logs.at(0)).toContain('server (pid=100, port=3001)');
    expect(logs.at(0)).toContain('ui (pid=200, port=3000)');
  });

  test('EPERM on kill → failure reported, outcome.failed populated', () => {
    const errors: string[] = [];
    const outcome = runStop({
      lockDir: '/tmp/x',
      inspect: (name) => (name === 'server' ? aliveLock(100, 3001) : missing()),
      kill: () => {
        throw new Error('EPERM');
      },
      log: () => {},
      error: (msg) => errors.push(msg),
    });
    expect(outcome.stopped).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.target.pid).toBe(100);
    expect(outcome.failed[0]?.error).toBe('EPERM');
    expect(errors.at(0)).toContain('server (pid=100)');
  });

  test('mix of success + failure — reports both', () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const outcome = runStop({
      lockDir: '/tmp/x',
      inspect: (name) => (name === 'server' ? aliveLock(100, 3001) : aliveLock(200, 3000)),
      kill: (pid) => {
        if (pid === 200) throw new Error('EPERM');
      },
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    expect(outcome.stopped.map((t) => t.pid)).toEqual([100]);
    expect(outcome.failed.map((f) => f.target.pid)).toEqual([200]);
    expect(logs.some((l) => l.includes('server (pid=100'))).toBe(true);
    expect(errors.some((e) => e.includes('ui (pid=200)'))).toBe(true);
  });

  test('dead/corrupt locks are not killed (ok clean will prune them)', () => {
    const killed: number[] = [];
    const outcome = runStop({
      lockDir: '/tmp/x',
      inspect: (name) => (name === 'server' ? dead(999) : aliveLock(200, 3000)),
      kill: (pid) => killed.push(pid),
      log: () => {},
      error: () => {},
    });
    expect(killed).toEqual([200]);
    expect(outcome.stopped.map((t) => t.pid)).toEqual([200]);
  });
});


describe('buildStopPlan with foreign-host states', () => {
  test('foreign-host + locally-live PID → targeted (hostname drift)', () => {
    const plan = buildStopPlan(foreign(100, 3001), foreign(200, 3000), {
      isAlive: () => true,
    });
    expect(plan.targets).toEqual([
      { name: 'server', pid: 100, port: 3001 },
      { name: 'ui', pid: 200, port: 3000 },
    ]);
  });

  test('foreign-host + dead PID → skipped (truly cross-host or stale)', () => {
    const plan = buildStopPlan(foreign(100, 3001), foreign(200, 3000), {
      isAlive: () => false,
    });
    expect(plan.targets).toEqual([]);
  });

  test('mix: alive + foreign-host-live → both targeted', () => {
    const plan = buildStopPlan(aliveLock(100, 3001), foreign(200, 3000), {
      isAlive: () => true,
    });
    expect(plan.targets).toEqual([
      { name: 'server', pid: 100, port: 3001 },
      { name: 'ui', pid: 200, port: 3000 },
    ]);
  });

  test('mix: alive + foreign-host-dead → only alive targeted', () => {
    const plan = buildStopPlan(aliveLock(100, 3001), foreign(200, 3000), {
      isAlive: () => false,
    });
    expect(plan.targets).toEqual([{ name: 'server', pid: 100, port: 3001 }]);
  });

  test('isAlive is consulted per-pid, not once', () => {
    const checked: number[] = [];
    buildStopPlan(foreign(100, 3001), foreign(200, 3000), {
      isAlive: (pid) => {
        checked.push(pid);
        return pid === 200;
      },
    });
    expect(checked).toEqual([100, 200]);
  });
});

describe('runStop with foreign-host states', () => {
  test('foreign-host + locally-live → SIGTERM sent', () => {
    const killed: Array<[number, string]> = [];
    const outcome = runStop({
      lockDir: '/tmp/x',
      inspect: (name) => (name === 'server' ? foreign(100, 3001) : foreign(200, 3000)),
      kill: (pid, sig) => killed.push([pid, sig]),
      isAlive: () => true,
      log: () => {},
      error: () => {},
    });
    expect(killed).toEqual([
      [100, 'SIGTERM'],
      [200, 'SIGTERM'],
    ]);
    expect(outcome.stopped.map((t) => t.pid)).toEqual([100, 200]);
  });

  test('foreign-host + dead PID → no targets, no SIGTERM', () => {
    const killed: number[] = [];
    const outcome = runStop({
      lockDir: '/tmp/x',
      inspect: (name) => (name === 'server' ? foreign(100, 3001) : foreign(200, 3000)),
      kill: (pid) => killed.push(pid),
      isAlive: () => false,
      log: () => {},
      error: () => {},
    });
    expect(killed).toEqual([]);
    expect(outcome.hadTargets).toBe(false);
  });
});
