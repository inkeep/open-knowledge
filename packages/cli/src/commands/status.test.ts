import { describe, expect, test } from 'vitest';
import type { LockState } from './lock-state.ts';
import { buildStatusReport, renderStatusText, runStatus } from './status.ts';

function alive(pid: number, port: number, host = 'host'): LockState {
  return {
    status: 'alive',
    lockPath: `/tmp/fake-${pid}.lock`,
    lock: {
      pid,
      port,
      hostname: host,
      startedAt: '2026-04-16T00:00:00Z',
      worktreeRoot: '/x',
    },
  };
}
function missing(): LockState {
  return { status: 'missing', lockPath: '/tmp/m.lock' };
}
function dead(pid: number): LockState {
  return {
    status: 'dead-pid',
    lockPath: '/tmp/d.lock',
    lock: {
      pid,
      port: 0,
      hostname: 'host',
      startedAt: '2026-04-16T00:00:00Z',
      worktreeRoot: '/x',
    },
  };
}
function corrupt(): LockState {
  return { status: 'corrupt', lockPath: '/tmp/c.lock' };
}
function foreign(): LockState {
  return {
    status: 'foreign-host',
    lockPath: '/tmp/f.lock',
    lock: {
      pid: 1,
      port: 3000,
      hostname: 'other-box',
      startedAt: '2026-04-16T00:00:00Z',
      worktreeRoot: '/x',
    },
  };
}

describe('buildStatusReport', () => {
  test('alive on both', () => {
    const r = buildStatusReport(alive(100, 3001), alive(200, 3000));
    expect(r.server).toEqual({
      name: 'server',
      state: 'alive',
      pid: 100,
      port: 3001,
      startedAt: '2026-04-16T00:00:00Z',
      host: 'host',
      alive: true,
    });
    expect(r.ui.alive).toBe(true);
  });

  test('missing → alive: false', () => {
    const r = buildStatusReport(missing(), missing());
    expect(r.server.alive).toBe(false);
    expect(r.server.state).toBe('missing');
    expect(r.server.pid).toBeUndefined();
  });

  test('dead-pid → alive: false, reports pid', () => {
    const r = buildStatusReport(dead(999), missing());
    expect(r.server.alive).toBe(false);
    expect(r.server.state).toBe('dead-pid');
    expect(r.server.pid).toBe(999);
  });

  test('corrupt → alive: false, no pid surfaced', () => {
    const r = buildStatusReport(corrupt(), missing());
    expect(r.server.state).toBe('corrupt');
    expect(r.server.pid).toBeUndefined();
  });

  test('foreign-host → alive: unknown', () => {
    const r = buildStatusReport(foreign(), missing());
    expect(r.server.alive).toBe('unknown');
    expect(r.server.host).toBe('other-box');
  });
});

describe('renderStatusText', () => {
  test('alive entries include pid + port + startedAt', () => {
    const out = renderStatusText(buildStatusReport(alive(100, 3001), alive(200, 3000)));
    expect(out).toContain('pid=100 port=3001');
    expect(out).toContain('pid=200 port=3000');
    expect(out).toContain('started=2026-04-16T00:00:00Z');
  });

  test('missing entries render "not running"', () => {
    const out = renderStatusText(buildStatusReport(missing(), missing()));
    expect(out).toContain('not running');
  });

  test('stale entries suggest ok clean', () => {
    const out = renderStatusText(buildStatusReport(dead(999), missing()));
    expect(out).toContain('stale');
    expect(out).toContain('pid=999');
    expect(out).toContain('ok clean');
  });
});

describe('runStatus', () => {
  test('text output by default', () => {
    const logs: string[] = [];
    runStatus({
      lockDir: '/tmp/x',
      inspect: (name) => (name === 'server' ? alive(100, 3001) : alive(200, 3000)),
      log: (msg) => logs.push(msg),
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('pid=100');
  });

  test('--json emits parseable JSON report', () => {
    const logs: string[] = [];
    runStatus({
      lockDir: '/tmp/x',
      json: true,
      inspect: (name) => (name === 'server' ? alive(100, 3001) : missing()),
      log: (msg) => logs.push(msg),
    });
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0] ?? '');
    expect(parsed.server.state).toBe('alive');
    expect(parsed.server.pid).toBe(100);
    expect(parsed.ui.state).toBe('missing');
  });

  test('never sets non-zero exit code even with all dead/corrupt', () => {
    const before = process.exitCode;
    runStatus({
      lockDir: '/tmp/x',
      inspect: (name) => (name === 'server' ? dead(999) : corrupt()),
      log: () => {},
    });
    expect(process.exitCode).toBe(before);
  });
});
