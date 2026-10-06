import { afterEach, expect, test, vi } from 'vitest';
import { summarizePtyPhases } from '../../scripts/pty-phase-evidence.mjs';
import { createPtyPhaseTrace, type PtyPhaseRecord } from '../../src/shared/pty-phase-trace.ts';
import {
  type PtyHostOutgoingMessage,
  type PtyProcessLike,
  type SpawnPty,
  setupPtyHost,
} from '../../src/utility/pty-host.ts';

afterEach(() => vi.restoreAllMocks());

const SESSION = 'phase-session';

function stubPty(pid: number) {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: { exitCode: number | undefined; signal?: number }) => void> =
    [];
  const pty: PtyProcessLike = {
    pid,
    onData(listener) {
      dataListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    write() {},
    resize() {},
    kill() {},
    pause() {},
    resume() {},
  };
  return {
    pty,
    dataListeners,
    output(data: string) {
      for (const listener of dataListeners) listener(data);
    },
    exit(exitCode: number) {
      for (const listener of exitListeners) listener({ exitCode });
    },
  };
}

function createSession(options: { traced: boolean; platform: 'win32' | 'linux'; spawn: SpawnPty }) {
  const windows = options.platform === 'win32';
  const records: PtyPhaseRecord[] = [];
  const posted: PtyHostOutgoingMessage[] = [];
  const timeline: string[] = [];
  let receive = (_event: { data: unknown }) => {};
  setupPtyHost({
    ...(options.traced
      ? {
          phaseTrace: createPtyPhaseTrace({ OK_PTY_PHASE_TRACE: '1' }, 'utility', (record) => {
            records.push(record);
            timeline.push(`${record.phase}:${record.edge}`);
          }),
        }
      : {}),
    env: windows ? { SystemRoot: 'C:\\Windows' } : { SHELL: '/bin/bash', PATH: '/usr/bin' },
    platform: options.platform,
    parentPort: {
      on(_event, callback) {
        receive = callback;
      },
      postMessage(message) {
        posted.push(message);
        timeline.push(`post:${message.type}`);
      },
    },
    shellExists: () => true,
    spawn: options.spawn,
  });
  receive({
    data: {
      type: 'create',
      ptyId: SESSION,
      cwd: windows ? 'C:\\project' : '/project',
      cols: 80,
      rows: 24,
      shell: windows ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/bash',
    },
  });
  return { records, posted, timeline };
}

test('attributes a controlled slow shell lookup to the shell-resolution phase', () => {
  const SHELL_LOOKUP_DELAY_MS = 1000;
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const phases: PtyPhaseRecord[] = [];
  const posted: PtyHostOutgoingMessage[] = [];
  let receive = (_event: { data: unknown }) => {};
  const pty: PtyProcessLike = {
    pid: 12345,
    onData() {},
    onExit() {},
    write() {},
    resize() {},
    kill() {},
    pause() {},
    resume() {},
  };
  setupPtyHost({
    phaseTrace: createPtyPhaseTrace({ OK_PTY_PHASE_TRACE: '1' }, 'utility', (record) =>
      phases.push(record),
    ),
    env: { SystemRoot: 'C:\\Windows' },
    platform: 'win32',
    parentPort: {
      on(_event, callback) {
        receive = callback;
      },
      postMessage(message) {
        posted.push(message);
      },
    },
    shellExists: () => {
      clock += SHELL_LOOKUP_DELAY_MS;
      return true;
    },
    spawn: () => pty,
  });
  receive({
    data: {
      type: 'create',
      ptyId: 'phase-session',
      cwd: 'C:\\project',
      cols: 80,
      rows: 24,
      shell: 'C:\\Windows\\System32\\cmd.exe',
    },
  });
  expect(posted).toContainEqual({
    type: 'shell-notice',
    ptyId: 'phase-session',
    notice: 'shell-resolved',
    shellFamily: 'cmd',
  });
  const durations = phases
    .filter((record) => record.edge === 'end')
    .flatMap((end) => {
      const begin = phases.find(
        (record) =>
          record.phase === end.phase && record.edge === 'begin' && record.ptyId === end.ptyId,
      );
      return begin
        ? [{ phase: end.phase, ptyId: end.ptyId, elapsed: Number(end.atMs) - Number(begin.atMs) }]
        : [];
    });
  expect(durations.sort((left, right) => right.elapsed - left.elapsed)[0]).toEqual({
    phase: 'shell-resolution',
    ptyId: 'phase-session',
    elapsed: SHELL_LOOKUP_DELAY_MS,
  });
});

test('reports an exceptional shell lookup without changing the thrown value', () => {
  const records: PtyPhaseRecord[] = [];
  let receive = (_event: { data: unknown }) => {};
  let original: unknown;
  let caught: unknown;
  setupPtyHost({
    phaseTrace: createPtyPhaseTrace({ OK_PTY_PHASE_TRACE: '1' }, 'utility', (record) =>
      records.push(record),
    ),
    env: {},
    platform: 'win32',
    parentPort: {
      on(_event, callback) {
        receive = callback;
      },
      postMessage() {},
    },
    shellExists: () => {
      try {
        return JSON.parse('{');
      } catch (error) {
        original = error;
        throw error;
      }
    },
    spawn: () => {
      throw new Error('lookup failed before native spawn');
    },
  });
  try {
    receive({
      data: {
        type: 'create',
        ptyId: 'exception-session',
        cwd: 'C:\\project',
        cols: 80,
        rows: 24,
        shell: 'C:\\Windows\\System32\\cmd.exe',
      },
    });
  } catch (error) {
    caught = error;
  }
  expect(original).toBeInstanceOf(SyntaxError);
  expect(caught).toBe(original);
  expect(records.at(-1)).toMatchObject({
    event: 'pty-phase',
    phase: 'shell-resolution',
    edge: 'error',
    ptyId: 'exception-session',
  });
});

test('brackets the native spawn of a created terminal as a completed pty-spawn span', () => {
  const SPAWN_DELAY_MS = 750;
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const session = stubPty(4321);
  const { records } = createSession({
    traced: true,
    platform: 'win32',
    spawn: () => {
      clock += SPAWN_DELAY_MS;
      return session.pty;
    },
  });
  expect(
    summarizePtyPhases(records).completed.filter(
      (span: { phase: string }) => span.phase === 'pty-spawn',
    ),
  ).toEqual([
    expect.objectContaining({ ptyId: SESSION, outcome: 'end', durationMs: SPAWN_DELAY_MS }),
  ]);
});

test('brackets each conpty attempt when the bundled spawn falls back to the inbox console', () => {
  const session = stubPty(4321);
  const { records, posted } = createSession({
    traced: true,
    platform: 'win32',
    spawn: (_file, _args, options) => {
      if (options.useConptyDll) {
        throw new Error('Cannot find conpty.dll at C:\\fixture\\conpty.dll, error code: 2');
      }
      return session.pty;
    },
  });
  expect(
    records
      .filter((record) => record.phase === 'pty-spawn')
      .map(({ edge, ptyId, backend, attempt }) => ({ edge, ptyId, backend, attempt })),
  ).toEqual([
    { edge: 'begin', ptyId: SESSION, backend: 'bundled', attempt: 1 },
    { edge: 'error', ptyId: SESSION, backend: 'bundled', attempt: 1 },
    { edge: 'begin', ptyId: SESSION, backend: 'inbox', attempt: 2 },
    { edge: 'end', ptyId: SESSION, backend: 'inbox', attempt: 2 },
  ]);
  expect(posted.filter((message) => message.type === 'spawn-error')).toEqual([]);
});

test('marks the first output the host sees and its first forward to main exactly once', () => {
  const session = stubPty(4321);
  const { records, posted, timeline } = createSession({
    traced: true,
    platform: 'win32',
    spawn: () => session.pty,
  });
  const created = timeline.length;
  session.output('first chunk');
  session.output('second chunk');
  expect(posted.filter((message) => message.type === 'data')).toEqual([
    { type: 'data', ptyId: SESSION, data: 'first chunk' },
    { type: 'data', ptyId: SESSION, data: 'second chunk' },
  ]);
  expect(timeline.slice(created)).toEqual([
    'pty-first-output:point',
    'post:data',
    'pty-first-forward:point',
    'post:data',
  ]);
  expect(records.filter((record) => record.phase === 'pty-first-output')).toEqual([
    expect.objectContaining({ ptyId: SESSION, currentSession: true }),
  ]);
});

test('marks a terminal that exits before producing any output', () => {
  const session = stubPty(4321);
  const { records, posted } = createSession({
    traced: true,
    platform: 'win32',
    spawn: () => session.pty,
  });
  session.exit(-1);
  expect(records.filter((record) => record.phase === 'pty-exit')).toEqual([
    expect.objectContaining({ ptyId: SESSION, edge: 'point', exitCode: -1 }),
  ]);
  expect(records.filter((record) => record.phase.startsWith('pty-first'))).toEqual([]);
  expect(posted.at(-1)).toEqual({ type: 'exit', ptyId: SESSION, exitCode: -1, signal: null });
});

test('reports a failed posix spawn while posting the same spawn-error as an untraced host', () => {
  const fail: SpawnPty = () => {
    throw new Error('posix spawn failed');
  };
  const traced = createSession({ traced: true, platform: 'linux', spawn: fail });
  const plain = createSession({ traced: false, platform: 'linux', spawn: fail });
  expect(
    traced.records
      .filter((record) => record.phase === 'pty-spawn')
      .map(({ edge, ptyId, backend }) => ({ edge, ptyId, backend })),
  ).toEqual([
    { edge: 'begin', ptyId: SESSION, backend: 'posix' },
    { edge: 'error', ptyId: SESSION, backend: 'posix' },
  ]);
  expect(traced.posted).toContainEqual({
    type: 'spawn-error',
    ptyId: SESSION,
    message: 'posix spawn failed',
  });
  expect(traced.posted).toEqual(plain.posted);
});

test('an unset trace reads no clock and leaves posted messages and data listeners unchanged', () => {
  const run = (traced: boolean) => {
    const session = stubPty(4321);
    const host = createSession({ traced, platform: 'win32', spawn: () => session.pty });
    session.output('first chunk');
    session.output('second chunk');
    session.exit(0);
    return { ...host, dataListeners: session.dataListeners.length };
  };
  const now = vi.spyOn(performance, 'now');
  const plain = run(false);
  expect(now).not.toHaveBeenCalled();
  now.mockRestore();
  const traced = run(true);
  expect(traced.records.some((record) => record.phase === 'pty-first-forward')).toBe(true);
  expect(plain.posted).toEqual(traced.posted);
  expect([plain.dataListeners, traced.dataListeners]).toEqual([1, 1]);
});
