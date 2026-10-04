import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';
import type { PtyOsObservation, PtyProcessLike } from '../../src/utility/pty-host.ts';
import {
  createHarnessReadinessAfterCompletion,
  createHarnessReadinessObserver,
  createPtyHostProbe,
  HARNESS_WINDOWS_LAUNCH_STALL_MS,
} from '../support/pty-readiness.test-helper.ts';
import { createHarnessScenarioRunner } from '../support/pty-startup-trace.test-helper.ts';
import type { WindowsOsStateOptions } from '../support/windows-os-state.test-helper.ts';

const PROLOGUE = '\u001b[1t\u001b[c\u001b[?1004h\u001b[?9001h';
const SHELL_TEXT = 'shell output with private content';
const PTY_ID = 'observed-shell';
const SHELL_PID = 424_242;
const CONSOLE_PID = 5_150;
const LATE_OUTPUT = 'late collection bytes';

function processRecord(pid: number) {
  return {
    status: 'captured',
    pid,
    parentPid: process.pid,
    createdAtMs: 1_700_000_000_000,
    secondCreatedAtMs: 1_700_000_000_000,
    first: { userMs: 5, kernelMs: 1, threadCount: 1 },
    second: { userMs: 5, kernelMs: 1, threadCount: 1 },
    threads: [{ id: 3, state: 'wait', waitReason: 'user-request' }],
    omittedThreads: 0,
  };
}

const QUERY_RESULT = {
  version: 1,
  shells: [processRecord(SHELL_PID)],
  console: {
    status: 'captured',
    candidateCount: 1,
    candidates: [processRecord(CONSOLE_PID)],
    unavailableCandidates: [],
    omittedCandidates: 0,
  },
};

const EXPECTED_SECTIONS = {
  shell: { status: 'captured', value: expect.objectContaining({ pid: SHELL_PID }) },
  console: {
    status: 'captured',
    value: expect.objectContaining({ candidates: [expect.objectContaining({ pid: CONSOLE_PID })] }),
  },
  worker: {
    status: 'captured',
    value: expect.objectContaining({ nodeThreadId: 41, userMs: 7, systemMs: 3 }),
  },
};

function answeringQuery() {
  const stdout = new PassThrough();
  const query = Object.assign(new EventEmitter(), {
    pid: 93_422,
    stdout,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const hooks = { started: () => {} };
  const spawnQuery: WindowsOsStateOptions['spawnQuery'] = () => {
    setImmediate(() => stdout.write('READY\n'));
    query.stdin.once('data', () => {
      hooks.started();
      stdout.write(`RESULT ${JSON.stringify(QUERY_RESULT)}\n`);
      queueMicrotask(() => query.emit('close', 0, null));
    });
    return query;
  };
  return { spawnQuery, hooks };
}

function createScenario(
  title: string,
  grantMs = 0,
  spawnQuery?: WindowsOsStateOptions['spawnQuery'],
) {
  const events: Record<string, unknown>[] = [];
  const sequence: Array<{ kind: string; value?: unknown }> = [];
  const worker = Object.assign(new EventEmitter(), {
    threadId: 41,
    cpuUsage: async () => ({ user: 7_000, system: 3_000 }),
  });
  const socket = () =>
    Object.assign(new EventEmitter(), {
      destroyed: false,
      connecting: false,
      bytesRead: 0,
      readableLength: 0,
      writableLength: 0,
    });
  const output = socket();
  const input = socket();
  let receive = (_data: string) => {};
  const agent = {
    _conoutSocketWorker: { _worker: worker, _isDisposed: false },
    _outSocket: output,
    _inSocket: input,
    _pendingPtyInfo: {},
    innerPid: 0,
    exitCode: undefined,
    _completePtyConnection() {
      this.innerPid = 424242;
      this._pendingPtyInfo = undefined;
    },
    _$onProcessExit() {},
  };
  const terminal: PtyProcessLike & { _agent: typeof agent } = {
    _agent: agent,
    get pid() {
      return agent.innerPid;
    },
    onData(callback) {
      receive = callback;
    },
    onExit() {},
    write: vi.fn(),
    resize() {},
    kill: vi.fn(() => sequence.push({ kind: 'release' })),
    pause() {},
    resume() {},
  };
  const host = createPtyHostProbe({
    platform: 'win32',
    env: {},
    shellExists: () => true,
    startupTrace: { native: true },
    spawnQuery:
      spawnQuery ??
      (() => {
        throw new Error('recording query is unavailable');
      }),
    spawn: () => terminal,
    logger: {
      info(entry) {
        events.push(entry);
        sequence.push({ kind: 'trace', value: entry });
      },
      warn(entry) {
        events.push(entry);
        sequence.push({ kind: 'trace', value: entry });
      },
    },
  });
  const lines: string[] = [];
  const runner = createHarnessScenarioRunner({
    titles: [title],
    grantMs: () => grantMs,
    isRefusal: () => false,
    print(line) {
      lines.push(line);
      sequence.push({ kind: 'verdict', value: line });
    },
  });
  runner.own({
    snapshot: () => host.snapshotStartup(),
    captureFailure: () => host.captureFailure(),
    cancelCapture: () => host.cancelCapture(),
    release: () => host.killActive(),
  });
  host.send({
    type: 'create',
    ptyId: PTY_ID,
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  });
  worker.emit('online');
  worker.emit('message', 1);
  agent._completePtyConnection();
  output.emit('connect');
  return {
    host,
    runner,
    events,
    lines,
    sequence,
    terminal,
    output(data: string) {
      output.bytesRead += Buffer.byteLength(data);
      receive(data);
    },
  };
}

const SILENCE_ROUTES = [
  { title: 'initial interactive readiness', output: PROLOGUE, wait: 'input' },
  { title: 'env-stripped interactive readiness', output: PROLOGUE, wait: 'input' },
  { title: 'structured launch marker', output: PROLOGUE, wait: 'condition' },
  {
    title: 'post-launch input readiness',
    output: `${PROLOGUE}${SHELL_TEXT}`,
    wait: 'input',
  },
  { title: 'post-output command marker', output: `${PROLOGUE}${SHELL_TEXT}`, wait: 'condition' },
  { title: 'silent respawn readiness', output: PROLOGUE, wait: 'respawn' },
] as const;

test.each(SILENCE_ROUTES)('$title has pre-cleanup OS state', async ({ title, output, wait }) => {
  const query = answeringQuery();
  const scenario = createScenario(title, 0, query.spawnQuery);
  query.hooks.started = () => scenario.sequence.push({ kind: 'query-start' });
  await scenario.runner.run(title, async (deadlineAt) => {
    scenario.output(output);
    const stream = scenario.host.streamOf(PTY_ID);
    const readiness =
      wait === 'respawn'
        ? createHarnessReadinessAfterCompletion(stream, {
            after: { observedAt: deadlineAt },
            initialDeadlineAt: deadlineAt,
            reportDeadlineAt: deadlineAt,
          })
        : createHarnessReadinessObserver(stream, deadlineAt, deadlineAt);
    if (wait === 'input') {
      await readiness.waitForEvaluatedInput(
        (data) => scenario.host.send({ type: 'input', ptyId: PTY_ID, data }),
        { input: 'readiness-probe\r', marker: 'readiness-answer' },
        title,
      );
    } else {
      await readiness.waitForCondition(() => stream.read().includes('missing-answer'), title);
    }
  });

  const snapshots = scenario.events.filter((entry) => entry.stage === 'snapshot');
  expect(snapshots.map((entry) => entry.reason)).toEqual(['failure', 'before-cleanup']);
  expect(snapshots[0]?.traceId).toBe(snapshots[1]?.traceId);
  expect(scenario.sequence.findIndex((entry) => entry.kind === 'release')).toBeGreaterThan(
    scenario.sequence.findIndex(
      (entry) =>
        entry.kind === 'trace' &&
        (entry.value as Record<string, unknown>).stage === 'snapshot' &&
        (entry.value as Record<string, unknown>).reason === 'failure',
    ),
  );
  expect(scenario.lines).toEqual([expect.stringMatching(`^FAIL ${title} ::`)]);
  expect(scenario.runner.verdictLine('')).toBe('HARNESS_RESULT ok=0 fail=1 refused=0');
  expect(JSON.stringify(scenario.events)).not.toContain(SHELL_TEXT);
  expect(JSON.stringify(scenario.events)).not.toContain('readiness-probe');
  const osSnapshot = scenario.events.find((entry) => entry.stage === 'os-snapshot');
  expect(osSnapshot).toEqual(
    expect.objectContaining({
      traceId: snapshots[0]?.traceId,
      attempt: snapshots[0]?.attempt,
      observation: expect.objectContaining(EXPECTED_SECTIONS),
    }),
  );
  const observation = osSnapshot?.observation as PtyOsObservation;
  for (const snapshot of snapshots) {
    expect(snapshot.native).toEqual(
      expect.objectContaining({
        shell: expect.objectContaining({ osState: observation.shell }),
        console: expect.objectContaining({ osState: observation.console }),
        worker: expect.objectContaining({ osState: observation.worker }),
      }),
    );
  }
  const release = scenario.sequence.findIndex((entry) => entry.kind === 'release');
  expect(scenario.sequence.findIndex((entry) => entry.kind === 'query-start')).toBeGreaterThan(-1);
  expect(scenario.sequence.findIndex((entry) => entry.kind === 'query-start')).toBeLessThan(
    release,
  );
});

test('the OS record keeps transport counters from failure detection apart from the failure snapshot', async () => {
  const query = answeringQuery();
  const scenario = createScenario('bytes during collection', 0, query.spawnQuery);
  query.hooks.started = () => scenario.output(LATE_OUTPUT);
  await scenario.runner.run('bytes during collection', async () => {
    scenario.output(PROLOGUE);
    throw new Error('shell did not answer');
  });
  const detected = Buffer.byteLength(PROLOGUE);
  const osSnapshot = scenario.events.find((entry) => entry.stage === 'os-snapshot');
  const failure = scenario.events.find(
    (entry) => entry.stage === 'snapshot' && entry.reason === 'failure',
  );
  expect(osSnapshot?.transport).toEqual(expect.objectContaining({ mainBytes: detected }));
  expect(failure?.native).toEqual(
    expect.objectContaining({
      transport: expect.objectContaining({
        mainBytes: detected + Buffer.byteLength(LATE_OUTPUT),
      }),
    }),
  );
});

test('a passing scenario leaves OS observation unused', async () => {
  const scenario = createScenario('shell answers');
  await scenario.runner.run('shell answers', async () => {
    scenario.output(`${PROLOGUE}${SHELL_TEXT}`);
  });
  const snapshots = scenario.events.filter((entry) => entry.stage === 'snapshot');
  expect(snapshots.map((entry) => entry.reason)).toEqual(['before-cleanup']);
  expect(snapshots[0]?.native).toEqual(
    expect.objectContaining({
      shell: expect.objectContaining({ osState: 'unobserved' }),
      console: expect.objectContaining({ osState: 'unobserved' }),
      worker: expect.objectContaining({ osState: 'unobserved' }),
    }),
  );
  expect(scenario.terminal.kill).toHaveBeenCalledOnce();
  expect(scenario.lines).toEqual(['PASS shell answers']);
  expect(scenario.runner.verdictLine('')).toBe('HARNESS_RESULT ok=1 fail=0 refused=0');
});

test('a sent readiness probe without a reply retains OS state before release', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const scenario = createScenario('sent probe reply stalls', HARNESS_WINDOWS_LAUNCH_STALL_MS);
    const running = scenario.runner.run('sent probe reply stalls', async (deadlineAt) => {
      scenario.output(`${PROLOGUE}${SHELL_TEXT}`);
      const readiness = createHarnessReadinessObserver(
        scenario.host.streamOf(PTY_ID),
        deadlineAt,
        deadlineAt,
      );
      await readiness.waitForEvaluatedInput(
        (data) => scenario.host.send({ type: 'input', ptyId: PTY_ID, data }),
        { input: 'readiness-probe\r', marker: 'readiness-answer' },
        'sent probe reply stalls',
      );
    });
    await vi.advanceTimersToNextTimerAsync();
    expect(scenario.terminal.write).toHaveBeenCalledWith('readiness-probe\r');
    await vi.runAllTimersAsync();
    await running;
    const failure = scenario.events.find(
      (entry) => entry.stage === 'snapshot' && entry.reason === 'failure',
    );
    expect(scenario.lines).toEqual([expect.stringMatching(/^FAIL sent probe reply stalls ::/u)]);
    expect(scenario.runner.verdictLine('')).toBe('HARNESS_RESULT ok=0 fail=1 refused=0');
    const native = failure?.native as { shell: { osState: unknown } };
    expect(native.shell.osState).toBeDefined();
    expect(native.shell.osState).not.toBe('unobserved');
    expect(scenario.sequence.findIndex((entry) => entry.kind === 'release')).toBeGreaterThan(
      scenario.sequence.findIndex((entry) => entry.kind === 'trace' && entry.value === failure),
    );
  } finally {
    vi.useRealTimers();
  }
});

test('a hard timeout synchronously retains an in-flight collection deadline and its detection-time transport before release', async () => {
  const query = Object.assign(new EventEmitter(), {
    pid: 93_421,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(() => true),
  });
  let starts = 0;
  const scenario = createScenario('hard-timeout collection', 10_000, () => {
    starts += 1;
    return query;
  });
  const running = scenario.runner.run('hard-timeout collection', async () => {
    scenario.output(PROLOGUE);
    throw new Error('shell did not answer');
  });
  await vi.waitFor(() => expect(starts).toBe(1));
  scenario.output(LATE_OUTPUT);
  const verdict = scenario.runner.hardTimeoutVerdict();
  const observation = scenario.events.find((entry) => entry.stage === 'os-snapshot');
  const hardSnapshot = scenario.events.find(
    (entry) => entry.stage === 'snapshot' && entry.reason === 'failure',
  );
  expect(verdict).toContain('hard timeout during hard-timeout collection');
  expect(observation?.observation).toEqual(expect.objectContaining({ reason: 'deadline' }));
  const detected = Buffer.byteLength(PROLOGUE);
  expect(observation?.transport).toEqual(expect.objectContaining({ mainBytes: detected }));
  expect(hardSnapshot?.native).toEqual(
    expect.objectContaining({
      shell: expect.objectContaining({ osState: expect.objectContaining({ reason: 'deadline' }) }),
      transport: expect.objectContaining({ mainBytes: detected + Buffer.byteLength(LATE_OUTPUT) }),
    }),
  );
  expect(query.kill).toHaveBeenCalledOnce();
  await running;
  expect(scenario.events.filter((entry) => entry.stage === 'os-snapshot')).toHaveLength(1);
  expect(scenario.sequence.findIndex((entry) => entry.kind === 'release')).toBeGreaterThan(
    scenario.sequence.findIndex((entry) => entry.value === hardSnapshot),
  );
});
