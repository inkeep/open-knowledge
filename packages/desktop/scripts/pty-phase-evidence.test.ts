import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createPtyPhaseTrace } from '../src/shared/pty-phase-trace.ts';
import { type PtyProcessLike, setupPtyHost } from '../src/utility/pty-host.ts';
import {
  preservePtyEvidence,
  readPtyPhaseRecords,
  summarizePtyPhases,
} from './pty-phase-evidence.mjs';

const fixtures: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('the retained artifact attributes a controlled host delay without inferring missing phases', () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-phase-artifact-'));
  fixtures.push(root);
  const logDir = join(root, 'logs');
  mkdirSync(logDir);
  const logPath = join(root, 'stdio.log');
  const SHELL_LOOKUP_DELAY_MS = 1000;
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
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
      appendFileSync(logPath, `${JSON.stringify(record)}\n`),
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
      clock += SHELL_LOOKUP_DELAY_MS;
      return true;
    },
    spawn: () => pty,
  });
  receive({
    data: {
      type: 'create',
      ptyId: 'retained-session',
      cwd: 'C:\\project',
      cols: 80,
      rows: 24,
      shell: 'C:\\Windows\\System32\\cmd.exe',
    },
  });
  const destination = preservePtyEvidence({
    diagnosticsDir: join(root, 'retained'),
    logPath,
    logDir,
    userDataDir: join(root, 'profile'),
    launchedAt: 0,
    appPid: process.pid,
    driver: { status: 1, stdout: '', stderr: 'echo failed' },
  });
  rmSync(logDir, { recursive: true });
  rmSync(logPath);
  const summary = JSON.parse(readFileSync(join(destination, 'phase-summary.json'), 'utf8'));
  expect(summary.longestCompleted).toMatchObject({
    producer: 'utility',
    phase: 'shell-resolution',
    ptyId: 'retained-session',
    outcome: 'end',
    durationMs: SHELL_LOOKUP_DELAY_MS,
  });
  expect(summary.incomplete).toEqual([]);
  expect(summary.missingProducers).toEqual(['renderer', 'main']);
  expect(
    readPtyPhaseRecords(readFileSync(join(destination, 'phase-trace.jsonl'), 'utf8')).some(
      (record: { phase: string }) => record.phase === 'shell-resolution',
    ),
  ).toBe(true);
  const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8'));
  expect(manifest.driver.status).toBe(1);
  expect(manifest.userDataSource).toBe('requested-unconfirmed');
  expect(manifest.files.some((file: { status: string }) => file.status === 'missing')).toBe(true);
});

test('the retained summary measures the wait from native spawn to first output and on to first forward', () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-phase-interval-'));
  fixtures.push(root);
  const logDir = join(root, 'logs');
  mkdirSync(logDir);
  const logPath = join(root, 'stdio.log');
  const SPAWN_TO_OUTPUT_DELAY_MS = 3000;
  const FORWARD_DELAY_MS = 40;
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  let receive = (_event: { data: unknown }) => {};
  let output = (_data: string) => {};
  const pty: PtyProcessLike = {
    pid: 12345,
    onData(listener) {
      output = listener;
    },
    onExit() {},
    write() {},
    resize() {},
    kill() {},
    pause() {},
    resume() {},
  };
  setupPtyHost({
    phaseTrace: createPtyPhaseTrace({ OK_PTY_PHASE_TRACE: '1' }, 'utility', (record) =>
      appendFileSync(logPath, `${JSON.stringify(record)}\n`),
    ),
    env: {},
    platform: 'win32',
    parentPort: {
      on(_event, callback) {
        receive = callback;
      },
      postMessage(message) {
        if (message.type === 'data') clock += FORWARD_DELAY_MS;
      },
    },
    shellExists: () => true,
    spawn: () => pty,
  });
  receive({
    data: {
      type: 'create',
      ptyId: 'late-output',
      cwd: 'C:\\project',
      cols: 80,
      rows: 24,
      shell: 'C:\\Windows\\System32\\cmd.exe',
    },
  });
  clock += SPAWN_TO_OUTPUT_DELAY_MS;
  output('Microsoft Windows\r\n');
  const destination = preservePtyEvidence({
    diagnosticsDir: join(root, 'retained'),
    logPath,
    logDir,
    userDataDir: join(root, 'profile'),
    launchedAt: 0,
    appPid: process.pid,
    driver: { status: 1, stdout: '', stderr: 'echo failed' },
  });
  const summary = JSON.parse(readFileSync(join(destination, 'phase-summary.json'), 'utf8'));
  expect(summary.intervals).toEqual([
    expect.objectContaining({
      producer: 'utility',
      ptyId: 'late-output',
      from: 'pty-spawn',
      to: 'pty-first-output',
      durationMs: SPAWN_TO_OUTPUT_DELAY_MS,
    }),
    expect.objectContaining({
      producer: 'utility',
      ptyId: 'late-output',
      from: 'pty-first-output',
      to: 'pty-first-forward',
      durationMs: FORWARD_DELAY_MS,
    }),
  ]);
});

test('pairs first output only with the successful spawn of the current session, and first forward with that output', () => {
  const PTY_ID = 'replaced-session';
  let sequence = 0;
  const mark = (
    phase: string,
    edge: string,
    atMs: number,
    context: Record<string, unknown> = {},
  ) => ({
    event: 'pty-phase',
    producer: 'utility',
    pid: 4,
    timeOriginMs: 11,
    sequence: ++sequence,
    phase,
    edge,
    atMs,
    ptyId: PTY_ID,
    ...context,
  });
  const replacedSpawnBegin = mark('pty-spawn', 'begin', 1, { attempt: 1, backend: 'bundled' });
  const replacedSpawnEnd = mark('pty-spawn', 'end', 2, { attempt: 1, backend: 'bundled' });
  const bundledBegin = mark('pty-spawn', 'begin', 10, { attempt: 1, backend: 'bundled' });
  const bundledError = mark('pty-spawn', 'error', 12, { attempt: 1, backend: 'bundled' });
  const inboxBegin = mark('pty-spawn', 'begin', 13, { attempt: 2, backend: 'inbox' });
  const inboxEnd = mark('pty-spawn', 'end', 20, { attempt: 2, backend: 'inbox' });
  const replacedOutput = mark('pty-first-output', 'point', 35, { currentSession: false });
  const currentOutput = mark('pty-first-output', 'point', 50, { currentSession: true });
  const firstForward = mark('pty-first-forward', 'point', 54);
  const summary = summarizePtyPhases([
    replacedSpawnBegin,
    replacedSpawnEnd,
    bundledBegin,
    bundledError,
    inboxBegin,
    inboxEnd,
    replacedOutput,
    currentOutput,
    firstForward,
  ]);
  expect(summary.intervals).toEqual([
    {
      producer: 'utility',
      pid: 4,
      ptyId: PTY_ID,
      from: 'pty-spawn',
      to: 'pty-first-output',
      durationMs: currentOutput.atMs - inboxEnd.atMs,
      fromSequence: inboxEnd.sequence,
      toSequence: currentOutput.sequence,
    },
    {
      producer: 'utility',
      pid: 4,
      ptyId: PTY_ID,
      from: 'pty-first-output',
      to: 'pty-first-forward',
      durationMs: firstForward.atMs - currentOutput.atMs,
      fromSequence: currentOutput.sequence,
      toSequence: firstForward.sequence,
    },
  ]);
});

test('the longest completed span names an app phase rather than the renderer evaluation that waits for the echo', () => {
  const PTY_ID = 'echo-timeout';
  const CREATE_MS = 120;
  const START_MS = 30;
  const ECHO_TIMEOUT_MS = 15_000;
  const CLEANUP_MS = 10;
  const SHELL_RESOLUTION_BEGIN_MS = 40;
  const SHELL_RESOLUTION_MS = 600;
  let rendererSequence = 0;
  const renderer = (phase: string, edge: string, atMs: number, ptyId: string | null = null) => ({
    event: 'pty-phase',
    producer: 'renderer',
    timeOriginMs: 7,
    sequence: ++rendererSequence,
    phase,
    edge,
    ptyId,
    atMs,
  });
  let utilitySequence = 0;
  const utility = (phase: string, edge: string, atMs: number) => ({
    event: 'pty-phase',
    producer: 'utility',
    pid: 4,
    timeOriginMs: 11,
    sequence: ++utilitySequence,
    phase,
    edge,
    ptyId: PTY_ID,
    atMs,
  });
  const startBeginMs = CREATE_MS;
  const cleanupEndMs = ECHO_TIMEOUT_MS + CLEANUP_MS;
  const summary = summarizePtyPhases([
    renderer('evaluation', 'begin', 0),
    renderer('create', 'begin', 0),
    renderer('create', 'end', CREATE_MS),
    renderer('start', 'begin', startBeginMs, PTY_ID),
    renderer('start', 'end', startBeginMs + START_MS, PTY_ID),
    renderer('echo-timer', 'point', ECHO_TIMEOUT_MS, PTY_ID),
    renderer('cleanup', 'begin', ECHO_TIMEOUT_MS, PTY_ID),
    renderer('cleanup', 'end', cleanupEndMs, PTY_ID),
    renderer('evaluation', 'error', cleanupEndMs),
    utility('shell-resolution', 'begin', SHELL_RESOLUTION_BEGIN_MS),
    utility('shell-resolution', 'end', SHELL_RESOLUTION_BEGIN_MS + SHELL_RESOLUTION_MS),
  ]);
  expect(summary.completed).toContainEqual(
    expect.objectContaining({
      producer: 'renderer',
      phase: 'evaluation',
      outcome: 'error',
      durationMs: cleanupEndMs,
    }),
  );
  expect(summary.longestCompleted).toMatchObject({
    producer: 'utility',
    phase: 'shell-resolution',
    ptyId: PTY_ID,
    outcome: 'end',
    durationMs: SHELL_RESOLUTION_MS,
  });
});

const LIVENESS = 'bug-report-main-thread-liveness.json';
const DIRTY_SHUTDOWN = 'bug-report-dirty-shutdown.json';
const STALL = 'bug-report-main-thread-stall.json';
const MAIN_EXIT = 'bug-report-main-exit.json';
const DESKTOP_LOG = 'desktop.2026-10-06.log';

function collectForcedStopEvidence({
  omit,
  unreadable,
}: {
  omit?: string;
  unreadable?: string;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ok-phase-collection-'));
  fixtures.push(root);
  const logDir = join(root, 'logs');
  const userDataDir = join(root, 'profile');
  const logPath = join(root, 'stdio.log');
  mkdirSync(logDir);
  mkdirSync(userDataDir);
  if (omit !== 'app-stdio.log') writeFileSync(logPath, 'app output\n');
  if (omit !== 'desktop-logs') writeFileSync(join(logDir, DESKTOP_LOG), '{"event":"boot"}\n');
  for (const name of [LIVENESS, DIRTY_SHUTDOWN]) {
    if (name !== omit) writeFileSync(join(userDataDir, name), '{}\n');
  }
  if (unreadable) mkdirSync(join(userDataDir, unreadable));
  const destination = preservePtyEvidence({
    diagnosticsDir: join(root, 'retained'),
    logPath,
    logDir,
    userDataDir,
    launchedAt: 0,
    appPid: process.pid,
    driver: { status: 0, stdout: '', stderr: '' },
  });
  const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8'));
  const sources: Record<string, string> = {
    'app-stdio.log': logPath,
    'desktop-logs': logDir,
    [DESKTOP_LOG]: join(logDir, DESKTOP_LOG),
  };
  const statusOf = (name: string) =>
    manifest.files.find(
      (file: { source: string }) => file.source === (sources[name] ?? join(userDataDir, name)),
    )?.status;
  return { collection: manifest.collection, statusOf };
}

test('a forced stop with no incident counts the evidence as fully collected', () => {
  const { collection, statusOf } = collectForcedStopEvidence();
  expect(statusOf('app-stdio.log')).toBe('copied');
  expect(statusOf(DESKTOP_LOG)).toBe('copied');
  expect(statusOf(LIVENESS)).toBe('copied');
  expect(statusOf(DIRTY_SHUTDOWN)).toBe('copied');
  expect(statusOf(STALL)).toBe('missing');
  expect(statusOf(MAIN_EXIT)).toBe('missing');
  expect(collection).toBe('copied');
});

test.each(['app-stdio.log', 'desktop-logs', LIVENESS, DIRTY_SHUTDOWN])(
  'a run without %s counts the evidence as partial',
  (name) => {
    const { collection, statusOf } = collectForcedStopEvidence({ omit: name });
    expect(statusOf(name)).toBe('missing');
    expect(collection).toBe('partial');
  },
);

test('an incident file that cannot be read counts the evidence as partial', () => {
  const { collection, statusOf } = collectForcedStopEvidence({ unreadable: STALL });
  expect(statusOf(STALL)).toBe('unavailable');
  expect(collection).toBe('partial');
});

test('keeps interrupted phases and separates process clock origins', () => {
  const records = readPtyPhaseRecords(
    [
      'not a record',
      JSON.stringify({
        event: 'pty-phase',
        producer: 'utility',
        pid: 4,
        timeOriginMs: 11,
        sequence: 1,
        phase: 'native-import',
        edge: 'begin',
        atMs: 2,
      }),
      JSON.stringify({
        event: 'pty-phase',
        producer: 'utility',
        pid: 5,
        timeOriginMs: 22,
        sequence: 1,
        phase: 'native-import',
        edge: 'end',
        atMs: 900,
      }),
    ].join('\n'),
  );
  const summary = summarizePtyPhases(records);
  expect(summary.completed).toEqual([]);
  expect(summary.longestCompleted).toBeNull();
  expect(summary.incomplete).toHaveLength(2);
});
