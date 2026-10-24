import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { okUserHomeDisplayPath } from '@inkeep/open-knowledge-core';
import {
  type Config,
  getMachineId,
  isProcessAlive,
  lockFilePath,
  machineIdFilePath,
} from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { LockState } from './lock-state.ts';
import {
  buildStopPlan,
  findLockDirByNumber,
  formatNoTargetMessage,
  probeCollabClients,
  runStop,
  stopCommand,
} from './stop.ts';

test('legacy numeric lookup retains first port match before PID fallback', async () => {
  const dirs = ['/tmp/a', '/tmp/b', '/tmp/c'];
  const inspect = (dir: string) =>
    dir === dirs[0]
      ? aliveLock(4242, 3333)
      : dir === dirs[1]
        ? aliveLock(10, 4242)
        : aliveLock(11, 4242);
  expect(
    await findLockDirByNumber(
      4242,
      () => true,
      async () => dirs,
      inspect,
    ),
  ).toBe('/tmp/b');
});

function aliveLock(pid: number, port: number): LockState {
  return {
    status: 'alive',
    lockPath: `/tmp/fake-${pid}.lock`,
    lock: {
      pid,
      port,
      hostname: hostname(),
      machineId: getMachineId(),
      startedAt: '2026-04-16T00:00:00Z',
      worktreeRoot: '/x',
    },
  };
}
const startedBeforeFixtureLocks = () => ({
  startedAtMs: Date.parse('2026-01-01T00:00:00Z'),
  clock: 'creation' as const,
});
const verifiedWriter = { isAlive: () => true, readProcessStart: startedBeforeFixtureLocks };
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
    text: '',
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
  test('alive is targeted even when the pid probe reports dead', () => {
    const plan = buildStopPlan(aliveLock(100, 3001), { isAlive: () => false });
    expect(plan.targets).toEqual([{ name: 'server', pid: 100, port: 3001 }]);
  });

  test('missing → no targets', () => {
    expect(buildStopPlan(missing()).targets).toEqual([]);
  });

  test('dead-pid → no targets', () => {
    expect(buildStopPlan(dead(999)).targets).toEqual([]);
  });
});

describe('runStop', () => {
  test('never signals an unverified owner even with force', async () => {
    const kill = vi.fn();
    const outcome = await runStop({
      lockDir: '/tmp/x',
      force: true,
      inspect: () => ({ status: 'unverified-owner', lockPath: '/tmp/server.lock', pid: 100 }),
      kill,
      log: () => {},
      error: () => {},
    });
    expect(outcome.decision.code).toBe('ownership-unverified');
    expect(kill).not.toHaveBeenCalled();
  });
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
    expect(outcome.decision.code).toBe('already-stopped');
    expect(killed).toEqual([]);
    expect(logs).toEqual(['No running open-knowledge processes.']);
  });

  test('alive → SIGTERM sent, log stopped summary', async () => {
    const logs: string[] = [];
    const killed: Array<[number, string]> = [];
    const outcome = await runStop({
      lockDir: '/tmp/x',
      inspect: () => aliveLock(100, 3001),
      ...verifiedWriter,
      kill: (pid, sig) => killed.push([pid, sig]),
      log: (msg) => logs.push(msg),
      error: () => {},
    });
    expect(killed).toEqual([[100, 'SIGTERM']]);
    expect(outcome.stopped.map((t) => t.name)).toEqual(['server']);
    expect(outcome.failed).toEqual([]);
    expect(outcome.decision.code).toBe('signalled');
    expect(logs.at(0)).toContain('server (pid=100, port=3001)');
  });

  test('EPERM on kill → failure reported, outcome.failed populated', async () => {
    const errors: string[] = [];
    const outcome = await runStop({
      lockDir: '/tmp/x',
      inspect: () => aliveLock(100, 3001),
      ...verifiedWriter,
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
    expect(outcome.decision.code).toBe('signal-failed');
    expect(errors.at(0)).toContain('server (pid=100)');
  });

  test('dead/corrupt locks are not killed (ok clean will prune them)', async () => {
    const killed: number[] = [];
    const outcome = await runStop({
      lockDir: '/tmp/x',
      inspect: () => dead(999),
      kill: (pid) => killed.push(pid),
      log: () => {},
      error: () => {},
    });
    expect(killed).toEqual([]);
    expect(outcome.hadTargets).toBe(false);
  });
});

describe('buildStopPlan with foreign-host states', () => {
  test('foreign-host + locally-live PID → targeted (hostname drift)', () => {
    const plan = buildStopPlan(foreign(100, 3001), { isAlive: (pid) => pid === 100 });
    expect(plan.targets).toEqual([{ name: 'server', pid: 100, port: 3001 }]);
  });

  test('foreign-host + dead PID → skipped (truly cross-host or stale)', () => {
    const plan = buildStopPlan(foreign(100, 3001), { isAlive: () => false });
    expect(plan.targets).toEqual([]);
  });
});

describe('runStop with foreign-host states', () => {
  test('foreign-host + locally-live → refused without a signal', async () => {
    const killed: Array<[number, string]> = [];
    const outcome = await runStop({
      lockDir: '/tmp/x',
      inspect: () => foreign(100, 3001),
      kill: (pid, sig) => killed.push([pid, sig]),
      ...verifiedWriter,
      log: () => {},
      error: () => {},
    });
    expect(killed).toEqual([]);
    expect(outcome.stopped).toEqual([]);
    expect(outcome.failed.map((failure) => failure.unverified?.cause)).toEqual(['foreign-host']);
  });

  test('foreign-host + dead PID → no targets, no SIGTERM', async () => {
    const killed: number[] = [];
    const outcome = await runStop({
      lockDir: '/tmp/x',
      inspect: () => foreign(100, 3001),
      kill: (pid) => killed.push(pid),
      isAlive: () => false,
      log: () => {},
      error: () => {},
    });
    expect(killed).toEqual([]);
    expect(outcome.hadTargets).toBe(false);
  });
});

describe('runStop channel guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const lockOf = (channel: string | undefined, state = aliveLock(100, 3001)): LockState =>
    (state.status === 'alive' || state.status === 'foreign-host') && channel !== undefined
      ? { ...state, lock: { ...state.lock, channel } }
      : state;
  const run = (
    channel: string | undefined,
    overrides: Partial<Parameters<typeof runStop>[0]> = {},
  ) => {
    const killed: Array<[number, string]> = [];
    const errors: string[] = [];
    const outcome = runStop({
      lockDir: '/tmp/channel',
      inspect: () => lockOf(channel),
      ...verifiedWriter,
      selfChannel: 'beta',
      kill: (pid, sig) => killed.push([pid, sig]),
      log: () => {},
      error: (msg) => errors.push(msg),
      probeClients: async () => 0,
      ...overrides,
    });
    return { outcome, killed, errors };
  };

  test("refuses to stop another channel's server", async () => {
    const { outcome, killed, errors } = run('stable');
    const result = await outcome;
    expect(result.declined).toEqual({ otherChannel: 'stable' });
    expect(result.decision).toMatchObject({ code: 'channel-mismatch' });
    expect(result.decision.detail).toContain('OpenKnowledge (Stable)');
    expect(result.decision.detail).toContain('--force');
    expect(killed).toEqual([]);
    expect(errors[0]).toContain('OpenKnowledge (Stable)');
    expect(errors[0]).toContain('--force');
  });

  test('channel refusal precedes the connected-client probe', async () => {
    const probeClients = vi.fn(async () => 2);
    const { outcome, killed } = run('stable', { probeClients });
    expect((await outcome).decision.code).toBe('channel-mismatch');
    expect(probeClients).not.toHaveBeenCalled();
    expect(killed).toEqual([]);
  });

  test("--force stops another channel's server", async () => {
    const { outcome, killed } = run('stable', { force: true });
    expect((await outcome).stopped).toHaveLength(1);
    expect(killed).toEqual([[100, 'SIGTERM']]);
  });

  test('stops a server of the same channel', async () => {
    const { outcome, killed } = run('beta');
    expect((await outcome).declined).toBeUndefined();
    expect(killed).toEqual([[100, 'SIGTERM']]);
  });

  test('stops a server whose lock records no channel', async () => {
    const { outcome, killed } = run(undefined);
    expect((await outcome).declined).toBeUndefined();
    expect(killed).toEqual([[100, 'SIGTERM']]);
  });

  test("OK_CHANNEL=beta refuses Stable's server", async () => {
    vi.stubEnv('OK_CHANNEL', 'beta');
    const { outcome, killed } = run('stable', { selfChannel: undefined });
    expect((await outcome).declined).toEqual({ otherChannel: 'stable' });
    expect(killed).toEqual([]);
  });

  test("OK_CHANNEL=stable stops Stable's server", async () => {
    vi.stubEnv('OK_CHANNEL', 'stable');
    const { outcome, killed } = run('stable', { selfChannel: undefined });
    expect((await outcome).declined).toBeUndefined();
    expect(killed).toEqual([[100, 'SIGTERM']]);
  });

  test('an unsupported OK_CHANNEL skips the check, warns, and stops as before', async () => {
    vi.stubEnv('OK_CHANNEL', 'bogus');
    const warnings: string[] = [];
    const logger = {
      info: () => {},
      warn: (_obj: unknown, msg: string) => warnings.push(msg),
    } as unknown as Parameters<typeof runStop>[0]['logger'];
    const { outcome, killed } = run('stable', { selfChannel: undefined, logger });
    expect((await outcome).declined).toBeUndefined();
    expect(killed).toEqual([[100, 'SIGTERM']]);
    expect(warnings.some((msg) => msg.includes('Unsupported OK_CHANNEL'))).toBe(true);
  });

  test("installed Stable refuses a dev build's server without --force", async () => {
    vi.stubEnv('OK_CHANNEL', '');
    const { outcome, killed, errors } = run('dev', { selfChannel: undefined });
    expect((await outcome).declined).toEqual({ otherChannel: 'dev' });
    expect(killed).toEqual([]);
    expect(errors[0]).toContain('OpenKnowledge Dev');
    expect(errors[0]).toContain(
      '`node <checkout>/packages/cli/dist/cli.mjs stop` with OK_CHANNEL=dev set',
    );
    expect(errors[0]).toContain('--force');
  });

  test("a dev-channel CLI stops the dev build's server", async () => {
    vi.stubEnv('OK_CHANNEL', 'dev');
    const { outcome, killed } = run('dev', { selfChannel: undefined });
    expect((await outcome).declined).toBeUndefined();
    expect(killed).toEqual([[100, 'SIGTERM']]);
  });

  test("a dev-channel CLI refuses installed Stable's server", async () => {
    vi.stubEnv('OK_CHANNEL', 'dev');
    const { outcome, killed } = run('stable', { selfChannel: undefined });
    expect((await outcome).declined).toEqual({ otherChannel: 'stable' });
    expect(killed).toEqual([]);
  });

  test('refuses a foreign-host lock of another channel whose pid is alive here', async () => {
    const { outcome, killed } = run('stable', {
      inspect: () => lockOf('stable', foreign(100, 3001)),
      isAlive: () => true,
    });
    expect((await outcome).declined).toEqual({ otherChannel: 'stable' });
    expect(killed).toEqual([]);
  });
});

describe('runStop in-use guard', () => {
  const oneAlive = () => ({
    lockDir: '/tmp/guard',
    inspect: () => aliveLock(100, 3001),
    ...verifiedWriter,
  });

  test('declines when the target reports live collaboration clients', async () => {
    const killed: Array<[number, string]> = [];
    const errors: string[] = [];
    const outcome = await runStop({
      ...oneAlive(),
      kill: (pid, sig) => killed.push([pid, sig]),
      log: () => {},
      error: (msg) => errors.push(msg),
      probeClients: async () => 2,
    });

    expect(killed).toEqual([]);
    expect(outcome.stopped).toEqual([]);
    expect(outcome.declined).toEqual({ clients: 2 });
    expect(outcome.decision.code).toBe('clients-connected');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('2 collaboration clients');
    expect(errors[0]).toContain('--force');
  });

  test('--force terminates despite live clients', async () => {
    const killed: Array<[number, string]> = [];
    const outcome = await runStop({
      ...oneAlive(),
      force: true,
      kill: (pid, sig) => killed.push([pid, sig]),
      log: () => {},
      error: () => {},
      probeClients: async () => 5,
    });

    expect(killed).toEqual([[100, 'SIGTERM']]);
    expect(outcome.declined).toBeUndefined();
    expect(outcome.stopped).toHaveLength(1);
  });

  test('an unreachable server (probe returns null) proceeds — it is already gone', async () => {
    const killed: Array<[number, string]> = [];
    const outcome = await runStop({
      ...oneAlive(),
      kill: (pid, sig) => killed.push([pid, sig]),
      log: () => {},
      error: () => {},
      probeClients: async () => null,
    });

    expect(killed).toHaveLength(1);
    expect(outcome.declined).toBeUndefined();
  });

  test('zero reported clients proceeds', async () => {
    const killed: Array<[number, string]> = [];
    const outcome = await runStop({
      ...oneAlive(),
      kill: (pid, sig) => killed.push([pid, sig]),
      log: () => {},
      error: () => {},
      probeClients: async () => 0,
    });

    expect(killed).toHaveLength(1);
    expect(outcome.stopped).toHaveLength(1);
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
      inspect: () => aliveLock(100, 3001),
      ...verifiedWriter,
      kill: () => {},
      log: () => {},
      error: () => {},
      probeClients: async () => 0,
      logger,
    });

    const record = records.find((r) => r.msg === 'stop signalled processes');
    expect(record).toBeDefined();
    expect(record?.obj.lockDir).toBe('/tmp/target/.ok/local');
    expect(record?.obj.signalled).toEqual([{ name: 'server', pid: 100, port: 3001 }]);
    expect(record?.obj.forced).toBe(false);
  });

  test('records a decline with the client count and the target', async () => {
    const { logger, records } = captureLogger();
    await runStop({
      lockDir: '/tmp/other/.ok/local',
      inspect: () => aliveLock(7, 3001),
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

describe('runStop identity check at the signal', () => {
  const lockDir = '/tmp/gate/.ok/local';
  const lockPath = `${lockDir}/server.lock`;
  const lockWrittenAt = '2026-04-16T00:00:00Z';
  const startedLongAfterTheLock = () => ({
    startedAtMs: Date.parse('2026-04-17T12:00:00Z'),
    clock: 'creation' as const,
  });

  function lockState(status: 'alive' | 'foreign-host', owner: Record<string, string>): LockState {
    return {
      status,
      lockPath,
      lock: { pid: 100, port: 3001, startedAt: lockWrittenAt, worktreeRoot: '/x', ...owner },
    };
  }
  const thisMachine = () => lockState('alive', { hostname: hostname(), machineId: getMachineId() });
  const anotherMachine = () =>
    lockState('foreign-host', {
      hostname: 'another-machine.example',
      machineId: '6f1c2d4e-0000-4000-8000-000000000000',
    });

  function run(state: LockState, overrides: Partial<Parameters<typeof runStop>[0]>) {
    const killed: Array<[number, string]> = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const logger = {
      info: () => {},
      warn: (obj: Record<string, unknown>, msg: string) => warnings.push({ obj, msg }),
    } as unknown as Parameters<typeof runStop>[0]['logger'];
    const outcome = runStop({
      lockDir,
      inspect: () => state,
      kill: (pid, sig) => killed.push([pid, sig]),
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
      probeClients: async () => null,
      logger,
      ...overrides,
    });
    return { outcome, killed, logs, errors, warnings };
  }

  test('a pid now held by a process started after the lock is reported stale and not signalled', async () => {
    const { outcome, killed, logs, errors } = run(thisMachine(), {
      isAlive: () => true,
      readProcessStart: startedLongAfterTheLock,
    });

    expect(await outcome).toMatchObject({ stopped: [], failed: [], hadTargets: true });
    expect(killed).toEqual([]);
    expect(logs).toEqual([]);
    expect(errors).toEqual([
      `Process 100 is no longer the server that wrote ${lockPath}; it was not signalled. Run \`ok clean\` to remove the stale lock.`,
    ]);
  });

  test('a lock naming a host with control characters reaches the refusal escaped', async () => {
    const { outcome, killed, errors } = run(
      lockState('foreign-host', { hostname: 'evil\nRun: ok clean --all\u001b]52;c;Zm9v\u0007' }),
      { isAlive: () => true, readProcessStart: startedLongAfterTheLock },
    );

    expect((await outcome).failed).toHaveLength(1);
    expect(killed).toEqual([]);
    const text = errors.join('');
    expect(text).toContain(
      'If evil\\u000aRun: ok clean --all\\u001b]52;c;Zm9v\\u0007 is another machine',
    );
    expect(text).not.toContain('\n');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
  });

  test('a Beta CLI names its own clean command for a reused pid', async () => {
    vi.stubEnv('OK_CHANNEL', 'beta');
    const { outcome, errors } = run(thisMachine(), {
      isAlive: () => true,
      readProcessStart: startedLongAfterTheLock,
    });
    try {
      await outcome;
      expect(errors.at(-1)).toContain('Run `ok-beta clean` to remove the stale lock.');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('a server that exited before the signal is reported, not signalled and not a failure', async () => {
    const { outcome, killed, logs, errors } = run(thisMachine(), {
      isAlive: () => false,
      readProcessStart: startedLongAfterTheLock,
    });

    expect(await outcome).toMatchObject({ stopped: [], failed: [], hadTargets: true });
    expect(killed).toEqual([]);
    expect(logs).toEqual(['server (pid=100) had already exited']);
    expect(errors).toEqual([]);
  });

  test('a holder whose start cannot be read fails without a signal, names the cause and says --force does not help', async () => {
    const { outcome, killed, errors, warnings } = run(thisMachine(), {
      isAlive: () => true,
      readProcessStart: () => null,
      force: true,
      platform: 'darwin',
    });
    const refusal =
      `Could not read when process 100 started, so it cannot be confirmed as the server that wrote ${lockPath}; ` +
      'it was not signalled, and --force does not override this check. ' +
      'macOS reads the process start with ps, and that read failed, as it does inside some sandboxes; retry from a shell where ps can run. ' +
      'Before ending process 100 yourself, confirm that it is an OpenKnowledge server. ' +
      `Once you have confirmed no OpenKnowledge server is running for this project, remove ${lockPath}.`;

    expect(await outcome).toMatchObject({
      stopped: [],
      failed: [
        {
          target: { name: 'server', pid: 100, port: 3001 },
          error: refusal,
          unverified: expect.objectContaining({
            cause: 'process-start-unreadable',
            pid: 100,
            lockPath,
            platform: 'darwin',
            nativeFailures: [],
          }),
        },
      ],
      hadTargets: true,
    });
    expect(killed).toEqual([]);
    expect(errors).toEqual([`Failed to stop: server (pid=100): ${refusal}`]);
    expect(warnings).toContainEqual({
      obj: {
        lockDir,
        lockPath,
        lockPid: 100,
        platform: 'darwin',
        cause: 'process-start-unreadable',
      },
      msg: 'stop declined: lock holder identity unverified',
    });
  });

  test('on Linux an unreadable start points at the /proc files it reads', async () => {
    const { outcome } = run(thisMachine(), {
      isAlive: () => true,
      readProcessStart: () => null,
      platform: 'linux',
    });

    expect((await outcome).failed.map((failure) => failure.error)).toEqual([
      `Could not read when process 100 started, so it cannot be confirmed as the server that wrote ${lockPath}; ` +
        'it was not signalled, and --force does not override this check. ' +
        'Linux reads the process start from /proc/100/stat and /proc/stat; restore read access to /proc and retry. ' +
        'Before ending process 100 yourself, confirm that it is an OpenKnowledge server. ' +
        `Once you have confirmed no OpenKnowledge server is running for this project, remove ${lockPath}.`,
    ]);
  });

  test.each([
    [
      'unavailable',
      'the Windows native addon (native-config.win32-x64-msvc.node) did not load or does not export readProcessStart: the addon was not found',
      'Reinstall OpenKnowledge to restore the Windows component that verifies process identity. ',
    ],
    [
      'query-failed',
      'readProcessStart failed: OpenProcess: os error 5',
      'The Windows component loaded but the operating system refused the query, so reinstalling will not help; retry from an account that can inspect that process. ',
    ],
  ] as const)(
    'on Windows a %s native read reaches the refusal and the record',
    async (kind, reason, recovery) => {
      const { outcome, warnings } = run(thisMachine(), {
        isAlive: () => true,
        readProcessStart: (_pid, options) => {
          options?.onNativeFailure?.({ kind, reason });
          return null;
        },
        platform: 'win32',
      });

      expect((await outcome).failed.map((failure) => failure.error)).toEqual([
        `Could not read when process 100 started, so it cannot be confirmed as the server that wrote ${lockPath}; ` +
          'it was not signalled, and --force does not override this check. ' +
          recovery +
          `The failure detail is recorded in the CLI log under ${okUserHomeDisplayPath('logs')}. ` +
          'Before ending process 100 yourself, confirm that it is an OpenKnowledge server. ' +
          `Once you have confirmed no OpenKnowledge server is running for this project, remove ${lockPath}.`,
      ]);
      expect(warnings).toContainEqual({
        obj: {
          lockDir,
          lockPath,
          lockPid: 100,
          platform: 'win32',
          cause: 'process-start-unreadable',
          nativeFailures: [{ kind, reason }],
        },
        msg: 'stop declined: lock holder identity unverified',
      });
    },
  );

  test('on Windows without a logger, as the desktop runs it, a native read failure points at no log', async () => {
    const { outcome } = run(thisMachine(), {
      isAlive: () => true,
      readProcessStart: (_pid, options) => {
        options?.onNativeFailure?.({
          kind: 'query-failed',
          reason: 'readProcessStart failed: OpenProcess: os error 5',
        });
        return null;
      },
      platform: 'win32',
      logger: undefined,
    });

    expect((await outcome).failed.map((failure) => failure.error)).toEqual([
      `Could not read when process 100 started, so it cannot be confirmed as the server that wrote ${lockPath}; ` +
        'it was not signalled, and --force does not override this check. ' +
        'The Windows component loaded but the operating system refused the query, so reinstalling will not help; retry from an account that can inspect that process. ' +
        'Before ending process 100 yourself, confirm that it is an OpenKnowledge server. ' +
        `Once you have confirmed no OpenKnowledge server is running for this project, remove ${lockPath}.`,
    ]);
  });

  test('a holder whose start cannot be compared with the recorded start fails without a signal', async () => {
    const state = lockState('alive', { hostname: hostname(), machineId: getMachineId() });
    if (state.status !== 'alive') throw new Error('expected an alive lock state');
    state.lock.processStart = { bootId: 'boot-a', startTicks: 5_000 };
    const { outcome, killed, warnings } = run(state, {
      isAlive: () => true,
      readProcessStart: startedLongAfterTheLock,
    });

    expect((await outcome).failed.map((failure) => failure.error)).toEqual([
      `The start of process 100 cannot be compared with the start recorded in ${lockPath}, so it cannot be confirmed as the server that wrote the lock; ` +
        'it was not signalled, and --force does not override this check. ' +
        'Before ending process 100 yourself, confirm that it is an OpenKnowledge server. ' +
        `Once you have confirmed no OpenKnowledge server is running for this project, remove ${lockPath}.`,
    ]);
    expect(killed).toEqual([]);
    expect(warnings.map((w) => w.obj.cause)).toEqual(['process-start-incomparable']);
  });

  test('a lock from this machine recording only its host name fails without a signal', async () => {
    const { outcome, killed, warnings } = run(lockState('alive', { hostname: hostname() }), {
      isAlive: () => true,
      readProcessStart: () => ({
        startedAtMs: Date.parse(lockWrittenAt) - 60_000,
        clock: 'creation' as const,
      }),
    });

    expect((await outcome).failed.map((failure) => failure.error)).toEqual([
      `The server lock at ${lockPath} records neither a machine ID nor a process start, as locks written by version 0.25.0 and earlier do, so process 100 cannot be confirmed as the server that wrote it; ` +
        'it was not signalled, and --force does not override this check. ' +
        'Before ending process 100 yourself, confirm that it is an OpenKnowledge server. ' +
        `Once you have confirmed no OpenKnowledge server is running for this project, remove ${lockPath}. ` +
        'A server you start again with this release records its machine ID, so `ok stop` can confirm it.',
    ]);
    expect(killed).toEqual([]);
    expect(warnings.map((w) => w.obj.cause)).toEqual(['writer-identity-unrecorded']);
  });

  test('a lock whose startedAt is ahead of the clock fails without a signal, naming that', async () => {
    const { outcome, killed, warnings } = run(
      lockState('alive', {
        hostname: hostname(),
        machineId: getMachineId(),
        startedAt: '2099-01-01T00:00:00Z',
      }),
      {
        isAlive: () => true,
        readProcessStart: () => ({ startedAtMs: Date.now() - 60_000, clock: 'creation' as const }),
      },
    );

    expect((await outcome).failed.map((failure) => failure.error)).toEqual([
      `The server lock at ${lockPath} records a start later than the current time on this machine, so process 100 cannot be confirmed as the server that wrote it; ` +
        'it was not signalled, and --force does not override this check. ' +
        'Before ending process 100 yourself, confirm that it is an OpenKnowledge server. ' +
        `Once you have confirmed no OpenKnowledge server is running for this project, remove ${lockPath}.`,
    ]);
    expect(killed).toEqual([]);
    expect(warnings.map((w) => w.obj.cause)).toEqual(['recorded-start-in-future']);
  });

  test('a holder whose start contradicts the recorded start fails without a signal', async () => {
    const state = lockState('alive', {
      hostname: hostname(),
      machineId: getMachineId(),
    });
    if (state.status !== 'alive') throw new Error('expected an alive lock state');
    state.lock.processStart = { startedAtMs: Date.parse('2026-04-17T12:00:00Z') + 60_000 };
    const { outcome, killed, warnings } = run(state, {
      isAlive: () => true,
      readProcessStart: startedLongAfterTheLock,
    });
    const refusal =
      `Process 100 started before the start recorded in ${lockPath}, so it cannot be confirmed as the server that wrote the lock; ` +
      'it was not signalled, and --force does not override this check. ' +
      'Before ending process 100 yourself, confirm that it is an OpenKnowledge server. ' +
      `Once you have confirmed no OpenKnowledge server is running for this project, remove ${lockPath}.`;

    expect(await outcome).toMatchObject({
      stopped: [],
      failed: [
        {
          target: { name: 'server', pid: 100, port: 3001 },
          error: refusal,
          unverified: expect.objectContaining({ cause: 'process-start-mismatch', pid: 100 }),
        },
      ],
      hadTargets: true,
    });
    expect(killed).toEqual([]);
    expect(warnings.map((w) => w.obj.cause)).toEqual(['process-start-mismatch']);
  });

  test("a local process named by another machine's lock fails without a signal and points at the owning machine", async () => {
    const { outcome, killed, errors, warnings } = run(anotherMachine(), {
      isAlive: () => true,
      readProcessStart: startedLongAfterTheLock,
      platform: 'darwin',
    });
    const refusal =
      `The server lock at ${lockPath} records a machine ID different from the one in ${machineIdFilePath()}, so process 100, which is running on this machine, cannot be confirmed as the server that wrote it; ` +
      'it was not signalled, and --force does not override this check. ' +
      'If the server was started on this machine from another account, run `ok stop` as that account. ' +
      'If it was started from this account with a different home folder, run `ok stop` with `HOME` set to that folder. ' +
      'Otherwise stop it from the machine that owns the lock. ' +
      'This lock records no process start; a server started by this release records one, which lets `ok stop` confirm it from any home folder.';

    expect(await outcome).toMatchObject({
      stopped: [],
      failed: [
        {
          target: { name: 'server', pid: 100, port: 3001 },
          error: refusal,
          unverified: expect.objectContaining({ cause: 'foreign-host', pid: 100 }),
        },
      ],
      hadTargets: true,
    });
    expect(killed).toEqual([]);
    expect(errors).toEqual([`Failed to stop: server (pid=100): ${refusal}`]);
    expect(warnings.map((w) => w.obj.cause)).toEqual(['foreign-host']);
  });

  test("another machine's lock keeps the owning-machine guidance when the local start cannot be read", async () => {
    const { outcome, warnings } = run(anotherMachine(), {
      isAlive: () => true,
      readProcessStart: () => null,
      platform: 'darwin',
    });

    expect((await outcome).failed.map((failure) => failure.error)).toEqual([
      `The server lock at ${lockPath} records a machine ID different from the one in ${machineIdFilePath()}, so process 100, which is running on this machine, cannot be confirmed as the server that wrote it; ` +
        'it was not signalled, and --force does not override this check. ' +
        'If the server was started on this machine from another account, run `ok stop` as that account. ' +
        'If it was started from this account with a different home folder, run `ok stop` with `HOME` set to that folder. ' +
        'Otherwise stop it from the machine that owns the lock. ' +
        'This lock records no process start; a server started by this release records one, which lets `ok stop` confirm it from any home folder.',
    ]);
    expect(warnings.map((w) => w.obj.cause)).toEqual(['foreign-host']);
  });

  test.each([
    ['darwin', 'HOME'],
    ['win32', 'USERPROFILE'],
  ] as const)(
    "another machine's lock that records a start is refused on %s naming %s and without the restart advice",
    async (platform, homeVariable) => {
      const state = anotherMachine();
      if (state.status !== 'foreign-host') throw new Error('expected a foreign-host lock state');
      state.lock.processStart = { startedAtMs: Date.parse('2026-04-17T12:00:00Z') + 60_000 };
      const { outcome, killed, warnings } = run(state, {
        isAlive: () => true,
        readProcessStart: startedLongAfterTheLock,
        platform,
      });

      expect((await outcome).failed.map((failure) => failure.error)).toEqual([
        `The server lock at ${lockPath} records a machine ID different from the one in ${machineIdFilePath()}, so process 100, which is running on this machine, cannot be confirmed as the server that wrote it; ` +
          'it was not signalled, and --force does not override this check. ' +
          'If the server was started on this machine from another account, run `ok stop` as that account. ' +
          `If it was started from this account with a different home folder, run \`ok stop\` with \`${homeVariable}\` set to that folder. ` +
          'Otherwise stop it from the machine that owns the lock.',
      ]);
      expect(killed).toEqual([]);
      expect(warnings.map((w) => w.obj.cause)).toEqual(['foreign-host']);
    },
  );

  test('a lock naming only another host is refused with both host names and the advice for a renamed host', async () => {
    const state = lockState('foreign-host', { hostname: 'another-machine.example' });
    if (state.status !== 'foreign-host') throw new Error('expected a foreign-host lock state');
    state.lock.processStart = { startedAtMs: Date.parse('2026-04-17T12:00:00Z') + 60_000 };
    const { outcome, killed, warnings } = run(state, {
      isAlive: () => true,
      readProcessStart: startedLongAfterTheLock,
    });

    expect((await outcome).failed.map((failure) => failure.error)).toEqual([
      `The server lock at ${lockPath} records only the host another-machine.example, not this machine's ${hostname()}, and the start of process 100, which is running on this machine, does not confirm it as the server that wrote the lock; ` +
        'it was not signalled, and --force does not override this check. ' +
        'If another-machine.example is another machine, stop the server there. ' +
        `If it is an earlier name of this machine, confirm that process 100 is an OpenKnowledge server before ending it yourself, and once no OpenKnowledge server is running for this project, remove ${lockPath}.`,
    ]);
    expect(killed).toEqual([]);
    expect(warnings.map((w) => w.obj.cause)).toEqual(['foreign-host']);
  });

  test("an earlier-started local process named by another machine's lock is not signalled", async () => {
    const { outcome, killed } = run(anotherMachine(), {
      isAlive: () => true,
      readProcessStart: startedBeforeFixtureLocks,
    });

    expect((await outcome).stopped).toEqual([]);
    expect(killed).toEqual([]);
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

  test.each([
    ['stable', 'ok'],
    ['beta', 'ok-beta'],
  ])('%s: the pointer names %s ps', (channel, command) => {
    vi.stubEnv('OK_CHANNEL', channel);
    try {
      expect(formatNoTargetMessage('/proj', 2)).toBe(
        `Nothing was running for /proj. 2 other open-knowledge servers are running — run \`${command} ps\` to list them.`,
      );
    } finally {
      vi.unstubAllEnvs();
    }
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

  function seedAliveServerLock(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ok-stop-probe-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      lockFilePath(dir, 'server'),
      JSON.stringify({
        pid: process.pid,
        port: 24999,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
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
    expect((record?.obj.err as Error | undefined)?.message).toContain('ECONNREFUSED');
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

describe('runStop on a live lock that records no owning machine', () => {
  let lockDir: string | undefined;

  afterEach(() => {
    if (lockDir !== undefined) rmSync(lockDir, { recursive: true, force: true });
    lockDir = undefined;
  });

  test('refuses it without a signal, even with --force, and says not to remove the lock', async () => {
    lockDir = mkdtempSync(join(tmpdir(), 'ok-stop-ownerless-'));
    const lockPath = lockFilePath(lockDir, 'server');
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        port: 24998,
        startedAt: new Date().toISOString(),
        worktreeRoot: lockDir,
      }),
      'utf-8',
    );
    const killed: Array<[number, string]> = [];
    const errors: string[] = [];
    const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const logger = {
      info: () => {},
      warn: (obj: Record<string, unknown>, msg: string) => warnings.push({ obj, msg }),
    } as unknown as Parameters<typeof runStop>[0]['logger'];

    const outcome = await runStop({
      lockDir,
      force: true,
      kill: (pid, sig) => killed.push([pid, sig]),
      log: () => {},
      error: (msg) => errors.push(msg),
      probeClients: async () => null,
      logger,
    });

    const refusal =
      `The server lock at ${lockPath} does not record its owning machine, and its recorded process ${process.pid} is still running on this machine, so it cannot be confirmed as the server that wrote the lock; ` +
      'it was not signalled, and --force does not override this check. ' +
      `Check whether process ${process.pid} is an OpenKnowledge server, and if it is, stop it yourself. ` +
      'Do not remove the lock file while that process is running.';

    expect(outcome).toMatchObject({
      stopped: [],
      failed: [
        {
          target: { name: 'server', pid: process.pid },
          error: refusal,
          unverified: { cause: 'unverified-owner', pid: process.pid, lockPath },
        },
      ],
      hadTargets: true,
    });
    expect(killed).toEqual([]);
    expect(errors).toEqual([`Failed to stop: server (pid=${process.pid}): ${refusal}`]);
    expect(warnings).toContainEqual({
      obj: {
        lockDir,
        lockPath,
        lockPid: process.pid,
        platform: process.platform,
        cause: 'unverified-owner',
      },
      msg: 'stop declined: lock holder identity unverified',
    });
  });
});

describe('ok stop on a project whose live lock records no owning machine', () => {
  let project: string | undefined;
  let holder: ChildProcess | undefined;
  const savedExitCode = process.exitCode;

  afterEach(async () => {
    process.exitCode = savedExitCode;
    vi.restoreAllMocks();
    if (holder !== undefined && holder.exitCode === null && holder.signalCode === null) {
      const exited = once(holder, 'exit');
      holder.kill('SIGKILL');
      await exited;
    }
    holder = undefined;
    if (project !== undefined) rmSync(project, { recursive: true, force: true });
    project = undefined;
  });

  test.each([
    ['directory', []],
    ['directory', ['--force']],
    ['no-argument', []],
    ['no-argument', ['--force']],
  ] as const)('exits 1 and leaves the process running (%s form, flags %j)', async (form, flags) => {
    project = mkdtempSync(join(tmpdir(), 'ok-stop-command-ownerless-'));
    holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    await once(holder, 'spawn');
    const pid = holder.pid;
    if (pid === undefined) throw new Error('holder did not start');
    const lockDir = join(project, '.ok', 'local');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockFilePath(lockDir, 'server'), JSON.stringify({ pid }), 'utf-8');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = undefined;

    if (form === 'directory') {
      await stopCommand(() => {
        throw new Error('the directory form reads no config');
      }).parseAsync([project, ...flags], { from: 'user' });
    } else {
      vi.spyOn(process, 'cwd').mockReturnValue(project);
      await stopCommand(() => ({}) as Config).parseAsync([...flags], { from: 'user' });
    }

    expect(process.exitCode).toBe(1);
    expect(isProcessAlive(pid)).toBe(true);
    expect(errors).toEqual([
      expect.stringContaining(
        `process ${pid} is still running on this machine, so it cannot be confirmed as the server that wrote the lock; it was not signalled`,
      ),
    ]);
  });
});
