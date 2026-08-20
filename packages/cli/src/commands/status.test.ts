import { describe, expect, test } from 'vitest';
import type { LockState } from './lock-state.ts';
import { buildStatusReport, renderStatusText, runStatus } from './status.ts';

function alive(pid: number, port: number, host = 'host', capabilities?: string[]): LockState {
  return {
    status: 'alive',
    lockPath: `/tmp/fake-${pid}.lock`,
    lock: {
      pid,
      port,
      hostname: host,
      startedAt: '2026-04-16T00:00:00Z',
      worktreeRoot: '/x',
      ...(capabilities !== undefined ? { capabilities } : {}),
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
  test('alive server advertising ui → both rows alive', () => {
    const r = buildStatusReport(alive(100, 3001, 'host', ['http', 'ws', 'ui']));
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
    const r = buildStatusReport(missing());
    expect(r.server.alive).toBe(false);
    expect(r.server.state).toBe('missing');
    expect(r.server.pid).toBeUndefined();
  });

  test('dead-pid → alive: false, reports pid', () => {
    const r = buildStatusReport(dead(999));
    expect(r.server.alive).toBe(false);
    expect(r.server.state).toBe('dead-pid');
    expect(r.server.pid).toBe(999);
  });

  test('corrupt → alive: false, no pid surfaced', () => {
    const r = buildStatusReport(corrupt());
    expect(r.server.state).toBe('corrupt');
    expect(r.server.pid).toBeUndefined();
  });

  test('foreign-host → alive: unknown', () => {
    const r = buildStatusReport(foreign());
    expect(r.server.alive).toBe('unknown');
    expect(r.server.host).toBe('other-box');
  });

  test('single-listener default: server advertises `ui` → ui served by server', () => {
    // Single-listener writes only server.lock (capabilities incl. `ui`); a
    // "not running" ui row would be a false negative. Derive it from capability.
    const r = buildStatusReport(alive(100, 3001, 'host', ['http', 'ws', 'ui']));
    expect(r.ui.state).toBe('alive');
    expect(r.ui.alive).toBe(true);
    expect(r.ui.servedByServer).toBe(true);
    expect(r.ui.pid).toBe(100);
    expect(r.ui.port).toBe(3001);
  });

  test('server without the `ui` capability leaves the ui row not-running', () => {
    // `--only server`: no UI anywhere, so the ui row must stay honest.
    const r = buildStatusReport(alive(100, 3001, 'host', ['http', 'ws']));
    expect(r.ui.state).toBe('missing');
    expect(r.ui.servedByServer).toBeUndefined();
  });
});

describe('renderStatusText', () => {
  test('alive entries include pid + port + startedAt', () => {
    const out = renderStatusText(buildStatusReport(alive(100, 3001, 'host', ['http', 'ws', 'ui'])));
    expect(out).toContain('pid=100 port=3001');
    expect(out).toContain('started=2026-04-16T00:00:00Z');
  });

  test('ui served by server renders "served by server", not "not running"', () => {
    const out = renderStatusText(buildStatusReport(alive(100, 3001, 'host', ['http', 'ws', 'ui'])));
    expect(out).toContain('served by server  pid=100 port=3001');
    expect(out).not.toContain('ui      not running');
  });

  test('missing entries render "not running"', () => {
    const out = renderStatusText(buildStatusReport(missing()));
    expect(out).toContain('not running');
  });

  test('stale entries suggest ok clean', () => {
    const out = renderStatusText(buildStatusReport(dead(999)));
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
      inspect: () => alive(100, 3001, 'host', ['http', 'ws', 'ui']),
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
      inspect: () => alive(100, 3001, 'host', ['http', 'ws']),
      log: (msg) => logs.push(msg),
    });
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0] ?? '');
    expect(parsed.server.state).toBe('alive');
    expect(parsed.server.pid).toBe(100);
    // server.lock EXPLICITLY omits `ui` (--only server) → the ui row stays not-running.
    expect(parsed.ui.state).toBe('missing');
  });

  test('pre-v2 server.lock without `capabilities` → ui row optimistically served-by-server', () => {
    // A missing `capabilities` field is indeterminate; the shared
    // `lockAdvertisesUi` predicate treats it as ui-capable, so status agrees
    // with preview_url / the redirect rather than falsely reporting "not running".
    const report = buildStatusReport(alive(100, 3001));
    expect(report.ui.state).toBe('alive');
    expect(report.ui.servedByServer).toBe(true);
  });

  test('never sets non-zero exit code even with all dead/corrupt', () => {
    const before = process.exitCode;
    runStatus({
      lockDir: '/tmp/x',
      inspect: () => dead(999),
      log: () => {},
    });
    expect(process.exitCode).toBe(before);
  });
});
