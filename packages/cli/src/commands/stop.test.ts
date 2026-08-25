import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockFilePath } from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { LockState } from './lock-state.ts';
import { buildStopPlan, formatNoTargetMessage, probeCollabClients, runStop } from './stop.ts';

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
  test('no running processes → log and exit 0 equivalent', async () => {
    const logs: string[] = [];
    const killed: Array<[number, string]> = [];
    const outcome = await runStop({
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

  test('both alive → SIGTERM both, log stopped summary', async () => {
    const logs: string[] = [];
    const killed: Array<[number, string]> = [];
    const outcome = await runStop({
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

  test('EPERM on kill → failure reported, outcome.failed populated', async () => {
    const errors: string[] = [];
    const outcome = await runStop({
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

  test('mix of success + failure — reports both', async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const outcome = await runStop({
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

  test('dead/corrupt locks are not killed (ok clean will prune them)', async () => {
    const killed: number[] = [];
    const outcome = await runStop({
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

// ---------------------------------------------------------------------------
// foreign-host (hostname drift) coverage
// ---------------------------------------------------------------------------

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
  test('foreign-host + locally-live → SIGTERM sent', async () => {
    const killed: Array<[number, string]> = [];
    const outcome = await runStop({
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

  test('foreign-host + dead PID → no targets, no SIGTERM', async () => {
    const killed: number[] = [];
    const outcome = await runStop({
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

describe('runStop in-use guard', () => {
  const twoAlive = () => ({
    lockDir: '/tmp/guard',
    inspect: (name: 'server' | 'ui') =>
      name === 'server' ? aliveLock(100, 3001) : aliveLock(200, 3000),
  });

  test('declines when the target reports live collaboration clients', async () => {
    const killed: Array<[number, string]> = [];
    const errors: string[] = [];
    const outcome = await runStop({
      ...twoAlive(),
      kill: (pid, sig) => killed.push([pid, sig]),
      log: () => {},
      error: (msg) => errors.push(msg),
      probeClients: async () => 2,
    });

    expect(killed).toEqual([]);
    expect(outcome.stopped).toEqual([]);
    expect(outcome.declined).toEqual({ clients: 2 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('2 collaboration clients');
    expect(errors[0]).toContain('--force');
  });

  test('--force terminates despite live clients', async () => {
    const killed: Array<[number, string]> = [];
    const outcome = await runStop({
      ...twoAlive(),
      force: true,
      kill: (pid, sig) => killed.push([pid, sig]),
      log: () => {},
      error: () => {},
      probeClients: async () => 5,
    });

    expect(killed).toEqual([
      [100, 'SIGTERM'],
      [200, 'SIGTERM'],
    ]);
    expect(outcome.declined).toBeUndefined();
    expect(outcome.stopped).toHaveLength(2);
  });

  test('an unreachable server (probe returns null) proceeds — it is already gone', async () => {
    const killed: Array<[number, string]> = [];
    const outcome = await runStop({
      ...twoAlive(),
      kill: (pid, sig) => killed.push([pid, sig]),
      log: () => {},
      error: () => {},
      probeClients: async () => null,
    });

    expect(killed).toHaveLength(2);
    expect(outcome.declined).toBeUndefined();
  });

  test('zero reported clients proceeds', async () => {
    const killed: Array<[number, string]> = [];
    const outcome = await runStop({
      ...twoAlive(),
      kill: (pid, sig) => killed.push([pid, sig]),
      log: () => {},
      error: () => {},
      probeClients: async () => 0,
    });

    expect(killed).toHaveLength(2);
    expect(outcome.stopped).toHaveLength(2);
  });
});

describe('runStop durable record', () => {
  function captureLogger(): {
    logger: Parameters<typeof runStop>[0]['logger'];
    records: Array<{ level: string; obj: Record<string, unknown>; msg: string }>;
  } {
    const records: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
    const logger = {
      info: (obj: Record<string, unknown>, msg: string) =>
        records.push({ level: 'info', obj, msg }),
      warn: (obj: Record<string, unknown>, msg: string) =>
        records.push({ level: 'warn', obj, msg }),
    } as unknown as Parameters<typeof runStop>[0]['logger'];
    return { logger, records };
  }

  test('records the resolved lock dir and every signalled pid', async () => {
    const { logger, records } = captureLogger();
    await runStop({
      lockDir: '/tmp/target/.ok/local',
      inspect: (name) => (name === 'server' ? aliveLock(100, 3001) : aliveLock(200, 3000)),
      kill: () => {},
      log: () => {},
      error: () => {},
      probeClients: async () => 0,
      logger,
    });

    const record = records.find((r) => r.msg === 'stop signalled processes');
    expect(record).toBeDefined();
    expect(record?.obj.lockDir).toBe('/tmp/target/.ok/local');
    expect(record?.obj.signalled).toEqual([
      { name: 'server', pid: 100, port: 3001 },
      { name: 'ui', pid: 200, port: 3000 },
    ]);
    expect(record?.obj.forced).toBe(false);
  });

  test('records a decline with the client count and the target', async () => {
    const { logger, records } = captureLogger();
    await runStop({
      lockDir: '/tmp/other/.ok/local',
      inspect: (name) => (name === 'server' ? aliveLock(7, 3001) : missing()),
      kill: () => {},
      log: () => {},
      error: () => {},
      probeClients: async () => 1,
      logger,
    });

    const record = records.find((r) => r.msg === 'stop declined: live collaboration clients');
    expect(record?.level).toBe('warn');
    expect(record?.obj).toMatchObject({ lockDir: '/tmp/other/.ok/local', clients: 1, pids: [7] });
  });
});

describe('formatNoTargetMessage', () => {
  test('nothing here AND nothing anywhere says both', () => {
    const msg = formatNoTargetMessage('/proj', 0);
    expect(msg).toContain('/proj');
    expect(msg).toContain('no other open-knowledge servers are running');
  });

  test('nothing here but servers elsewhere does not claim nothing is running', () => {
    const msg = formatNoTargetMessage('/proj', 2);
    expect(msg).toContain('Nothing was running for /proj');
    expect(msg).toContain('2 other open-knowledge servers are running');
    expect(msg).toContain('ok ps');
    expect(msg).not.toContain('no other');
  });

  test('singular agreement for one other server', () => {
    expect(formatNoTargetMessage('/proj', 1)).toContain('1 other open-knowledge server is running');
  });

  test('drops the `ok ps` pointer when the caller prints the listing itself', () => {
    const msg = formatNoTargetMessage('/proj', 2, { listingFollows: true });
    expect(msg).toContain('Nothing was running for /proj');
    expect(msg).toContain('2 other open-knowledge servers are running');
    expect(msg).not.toContain('ok ps');
  });
});

describe('probeCollabClients failure record', () => {
  const records: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const logger = {
    info: () => {},
    warn: (obj: Record<string, unknown>, msg: string) => records.push({ obj, msg }),
  } as unknown as Parameters<typeof runStop>[0]['logger'];

  let lockDir: string;

  /** A same-host, live-pid server lock so `inspectLock` classifies `alive`. */
  function seedAliveServerLock(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ok-stop-probe-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      lockFilePath(dir, 'server'),
      JSON.stringify({
        pid: process.pid,
        port: 24999,
        hostname: hostname(),
        startedAt: '2026-08-18T00:00:00Z',
        worktreeRoot: dir,
      }),
      'utf-8',
    );
    return dir;
  }

  afterEach(() => {
    records.length = 0;
    vi.unstubAllGlobals();
    if (lockDir !== undefined) rmSync(lockDir, { recursive: true, force: true });
  });

  test('records an unreachable server, and still reports "proceed"', async () => {
    lockDir = seedAliveServerLock();
    vi.stubGlobal('fetch', () => Promise.reject(new Error('connect ECONNREFUSED')));

    expect(await probeCollabClients(lockDir, logger)).toBeNull();

    const record = records.find((r) => r.msg === 'stop client-probe failed');
    expect(record?.obj).toMatchObject({ lockDir, outcome: 'unreachable' });
    // The raw error rides under `err` so pino's serializer keeps the stack.
    expect((record?.obj.err as Error).message).toContain('ECONNREFUSED');
  });

  test('records a malformed answer distinctly from an unreachable one', async () => {
    lockDir = seedAliveServerLock();
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ version: '1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    expect(await probeCollabClients(lockDir, logger)).toBeNull();

    const record = records.find((r) => r.msg === 'stop client-probe failed');
    expect(record?.obj).toMatchObject({ lockDir, outcome: 'no-client-count' });
  });

  test('records a server that answered non-2xx', async () => {
    lockDir = seedAliveServerLock();
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 503 })));

    expect(await probeCollabClients(lockDir, logger)).toBeNull();

    const record = records.find((r) => r.msg === 'stop client-probe failed');
    expect(record?.obj).toMatchObject({ lockDir, outcome: 'http-error', status: 503 });
  });

  test('a live client count is not a failure', async () => {
    lockDir = seedAliveServerLock();
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ collabClients: 3 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    expect(await probeCollabClients(lockDir, logger)).toBe(3);
    expect(records).toEqual([]);
  });
});
