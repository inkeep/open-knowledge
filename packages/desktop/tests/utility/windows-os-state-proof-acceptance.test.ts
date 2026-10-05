import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import type { PtyOsObservation } from '../../src/utility/pty-host.ts';
import {
  WINDOWS_OS_MAX_BUDGET_MS,
  WINDOWS_OS_MAX_RAW_BYTES,
  WINDOWS_OS_MAX_RESULT_BYTES,
  type WindowsOsStateOptions,
} from '../support/windows-os-state.test-helper.ts';
import { runWindowsOsStateProof } from '../support/windows-os-state-proof.test-helper.ts';

type QueryMode =
  | 'before-ready'
  | 'after-shell'
  | 'captured'
  | 'exit-after-shell'
  | 'exit-before-ready'
  | 'protocol-break'
  | 'ready-without-result'
  | 'no-pid'
  | 'raw-overflow'
  | 'stream-error';

type MachineSample = 'sampled' | 'empty';
type WorkerReply = 'finite' | 'pending' | 'non-finite';

interface ScenarioOptions {
  directCli?: boolean;
  platform?: NodeJS.Platform;
  exitCode?: number;
  killFails?: boolean;
  machine?: MachineSample;
  workerReply?: WorkerReply;
  replaceRecord?: (observed: PtyOsObservation) => unknown;
}

interface Scenario {
  queryMode: QueryMode;
  directCli: boolean;
  exitCode: number | null;
  killFails: boolean;
  machine: MachineSample;
  workerReply: WorkerReply;
  replaceRecord: ((observed: PtyOsObservation) => unknown) | null;
  suppliedRecord: unknown;
  spawnCount: number;
  querySpawned: Promise<void>;
  resolveQuerySpawned: () => void;
  logs: string[];
}

let scenario: Scenario | null = null;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalLog = console.log.bind(console);

const processSample = {
  status: 'captured',
  pid: 4_242,
  parentPid: 12,
  createdAtMs: 1_700_000_000_000,
  secondCreatedAtMs: 1_700_000_000_000,
  first: { userMs: 11, kernelMs: 2, threadCount: 1 },
  second: { userMs: 13, kernelMs: 3, threadCount: 1 },
  threads: [{ id: 8, state: 'wait', waitReason: 'user-request' }],
  omittedThreads: 0,
};

const emptyConsole = {
  status: 'captured',
  candidateCount: 0,
  candidates: [],
  unavailableCandidates: [],
  omittedCandidates: 0,
};

function close(child: EventEmitter, code: number): void {
  child.emit('exit', code, null);
  child.emit('close', code, null);
}

function recordingProcess(pid: number | undefined, killFails = false) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connected: true,
    send(value: string) {
      if (value === 'release') {
        child.connected = false;
        queueMicrotask(() => close(child, 0));
      }
    },
    kill() {
      if (killFails) {
        child.emit('error', new Error('helper kill failed'));
        return false;
      }
      queueMicrotask(() => close(child, 1));
      return true;
    },
    unref() {},
  });
  return child;
}

function writeQuery(child: ReturnType<typeof recordingProcess>, active: Scenario): void {
  const mode = active.queryMode;
  if (mode === 'before-ready' || mode === 'no-pid') return;
  if (mode === 'exit-before-ready') {
    if (active.exitCode === null) throw new Error('helper exit code is missing');
    close(child, active.exitCode);
    return;
  }
  if (mode === 'raw-overflow') {
    child.stderr.write('x'.repeat(WINDOWS_OS_MAX_RAW_BYTES + 1));
    return;
  }
  if (mode === 'protocol-break') {
    child.stdout.write('BANNER\n');
    setImmediate(() => close(child, 0));
    return;
  }
  child.stdout.write('READY\n');
  if (mode === 'ready-without-result') {
    setImmediate(() => close(child, 0));
    return;
  }
  if (mode === 'stream-error') {
    setImmediate(() => child.stdout.emit('error', new Error('helper stream failed')));
    return;
  }
  if (mode === 'after-shell' || mode === 'exit-after-shell') {
    child.stdout.write(
      `SHELL ${JSON.stringify({ version: 1, shells: [{ ...processSample, parentPid: null }] })}\n`,
    );
    if (mode === 'exit-after-shell') {
      const exitCode = active.exitCode;
      if (exitCode === null) throw new Error('helper exit code is missing');
      setImmediate(() => close(child, exitCode));
    }
    return;
  }
  child.stdout.write(
    `RESULT ${JSON.stringify({ version: 1, shells: [processSample], console: emptyConsole })}\n`,
  );
  setImmediate(() => close(child, 0));
}

function fakeSpawn() {
  const active = scenario;
  if (active === null) throw new Error('proof scenario is missing');
  const index = active.spawnCount++;
  if (active.directCli) {
    if (index !== 0) throw new Error('the CLI launched an unexpected process');
    const query = recordingProcess(93_421);
    active.resolveQuerySpawned();
    queueMicrotask(() => writeQuery(query, active));
    return query;
  }
  if (index === 0) {
    const subject = recordingProcess(4_242);
    queueMicrotask(() => subject.emit('message', 'ready'));
    return subject;
  }
  if (index === 1) {
    const query = recordingProcess(
      active.queryMode === 'no-pid' ? undefined : 93_421,
      active.killFails,
    );
    active.resolveQuerySpawned();
    queueMicrotask(() => writeQuery(query, active));
    return query;
  }
  throw new Error('the proof launched an unexpected process');
}

function workerCpuUsage(): Promise<{ user: number; system: number }> {
  const reply = scenario?.workerReply ?? 'finite';
  if (reply === 'pending') return new Promise(() => undefined);
  return Promise.resolve({ user: reply === 'non-finite' ? Number.NaN : 1_000, system: 2_000 });
}

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: fakeSpawn,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, cpus: () => (scenario?.machine === 'empty' ? [] : actual.cpus()) };
});

vi.mock('node:worker_threads', async (importOriginal) => {
  const { EventEmitter: BaseEventEmitter } = await import('node:events');
  return {
    ...(await importOriginal<typeof import('node:worker_threads')>()),
    Worker: class extends BaseEventEmitter {
      threadId = 91;

      constructor() {
        super();
        queueMicrotask(() => this.emit('message', 'ready'));
      }

      cpuUsage() {
        return workerCpuUsage();
      }

      postMessage(value: string) {
        if (value === 'release') queueMicrotask(() => this.emit('exit', 0));
      }
    },
  };
});

vi.mock('../support/windows-os-state.test-helper.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../support/windows-os-state.test-helper.ts')>();
  return {
    ...actual,
    async collectWindowsOsState(options: WindowsOsStateOptions): Promise<PtyOsObservation> {
      const observed = await actual.collectWindowsOsState(options);
      const active = scenario;
      if (active === null || active.replaceRecord === null) return observed;
      active.suppliedRecord = active.replaceRecord(observed);
      return active.suppliedRecord as PtyOsObservation;
    },
  };
});

function createScenario(queryMode: QueryMode, options: ScenarioOptions = {}) {
  let resolveQuerySpawned: () => void = () => undefined;
  const querySpawned = new Promise<void>((resolve) => {
    resolveQuerySpawned = resolve;
  });
  scenario = {
    queryMode,
    directCli: options.directCli ?? false,
    exitCode: options.exitCode ?? null,
    killFails: options.killFails ?? false,
    machine: options.machine ?? 'sampled',
    workerReply: options.workerReply ?? 'finite',
    replaceRecord: options.replaceRecord ?? null,
    suppliedRecord: undefined,
    spawnCount: 0,
    querySpawned,
    resolveQuerySpawned,
    logs: [],
  };
  vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    scenario?.logs.push(values.map(String).join(' '));
    originalLog(...values);
  });
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: options.platform ?? 'win32',
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  return scenario;
}

function proofOutcome() {
  return runWindowsOsStateProof().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function requireAccepted(outcome: Awaited<ReturnType<typeof proofOutcome>>): Promise<void> {
  if (!outcome.ok) throw outcome.error;
  expect(outcome.ok).toBe(true);
}

function expectRejected(outcome: Awaited<ReturnType<typeof proofOutcome>>): void {
  expect(outcome.ok).toBe(false);
}

async function proofAfterDeadline(active: Scenario) {
  const proof = proofOutcome();
  const reached = await Promise.race([
    active.querySpawned.then(() => true),
    proof.then(() => false),
  ]);
  if (reached) await vi.advanceTimersByTimeAsync(WINDOWS_OS_MAX_BUDGET_MS);
  return proof;
}

function proofLines(active: Scenario, prefix: string): string[] {
  return active.logs.filter((line) => line.startsWith(prefix));
}

function expectProofSnapshot(active: Scenario, expected: Record<string, unknown>): void {
  const prefix = 'WINDOWS_OS_PROOF ';
  const lines = active.logs.filter((line) => line.startsWith(prefix));
  expect(lines).toHaveLength(1);
  const record = JSON.parse(lines[0]?.slice(prefix.length) ?? 'null') as Record<string, unknown>;
  expect(record).toMatchObject({ version: 1, requestedPid: 4_242, ...expected });
}

async function runDirectCli(queryMode: QueryMode) {
  const active = createScenario(queryMode, { directCli: true });
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const output: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  try {
    process.argv = [process.execPath, 'windows-os-state-cli.test-helper.ts', '--pid', '4242'];
    vi.resetModules();
    const loaded = import('../support/windows-os-state-cli.test-helper.ts').then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const reached = await Promise.race([
      active.querySpawned.then(() => true),
      loaded.then(() => false),
    ]);
    if (reached) await vi.advanceTimersByTimeAsync(WINDOWS_OS_MAX_BUDGET_MS);
    const outcome = await loaded;
    if (!outcome.ok) throw outcome.error;
    const serialized = output.join('');
    return {
      code: process.exitCode,
      bytes: Buffer.byteLength(serialized),
      record: JSON.parse(serialized) as Record<string, unknown>,
    };
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    write.mockRestore();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (platformDescriptor !== undefined)
    Object.defineProperty(process, 'platform', platformDescriptor);
  scenario = null;
});

test('required proof accepts a bounded observation when the query never becomes ready', async () => {
  const active = createScenario('before-ready');
  const proof = proofOutcome();
  const reached = await Promise.race([
    active.querySpawned.then(() => true),
    proof.then(() => false),
  ]);
  if (reached) await vi.advanceTimersByTimeAsync(WINDOWS_OS_MAX_BUDGET_MS);
  await requireAccepted(await proof);
  expectProofSnapshot(active, {
    status: 'unavailable',
    shell: { status: 'unavailable', reason: 'deadline' },
  });
});

test('required proof accepts a partial observation when the query stalls after the shell frame', async () => {
  const active = createScenario('after-shell');
  const proof = proofOutcome();
  const reached = await Promise.race([
    active.querySpawned.then(() => true),
    proof.then(() => false),
  ]);
  if (reached) await vi.advanceTimersByTimeAsync(WINDOWS_OS_MAX_BUDGET_MS);
  await requireAccepted(await proof);
  expectProofSnapshot(active, {
    status: 'partial',
    shell: { status: 'captured' },
    console: { status: 'unavailable', reason: 'deadline' },
  });
});

test('required proof logs a bounded OS snapshot for its owned subject', async () => {
  const active = createScenario('captured');
  const proof = proofOutcome();
  await requireAccepted(await proof);
  expectProofSnapshot(active, {
    status: 'captured',
    shell: { status: 'captured' },
    console: { status: 'captured' },
  });
});

test('standalone CLI emits a bounded partial record when query stalls after shell', async () => {
  const result = await runDirectCli('after-shell');
  expect(result.code).toBe(0);
  expect(result.bytes).toBeLessThanOrEqual(WINDOWS_OS_MAX_RESULT_BYTES + 1);
  expect(result.record).toMatchObject({
    version: 1,
    status: 'partial',
    console: { status: 'unavailable', reason: 'deadline' },
  });
});

test('standalone CLI emits an unavailable record when query stalls before ready', async () => {
  const result = await runDirectCli('before-ready');
  expect(result.code).toBe(1);
  expect(result.bytes).toBeLessThanOrEqual(WINDOWS_OS_MAX_RESULT_BYTES + 1);
  expect(result.record).toMatchObject({
    version: 1,
    status: 'unavailable',
    shell: { status: 'unavailable', reason: 'deadline' },
  });
});

const rejectedCollections: Array<{
  caseName: string;
  queryMode: QueryMode;
  options: ScenarioOptions;
  expected: Record<string, unknown>;
}> = [
  {
    caseName: 'the helper fails before it is ready',
    queryMode: 'exit-before-ready',
    options: { exitCode: 1 },
    expected: { reason: 'query-exited', helper: { exit: 'observed-before-request' } },
  },
  {
    caseName: 'the helper reports owner loss early',
    queryMode: 'exit-before-ready',
    options: { exitCode: 86 },
    expected: { reason: 'query-exited', helper: { exit: 'cooperative-owner-loss' } },
  },
  {
    caseName: 'the helper fails after its shell frame',
    queryMode: 'exit-after-shell',
    options: { exitCode: 88 },
    expected: {
      status: 'partial',
      reason: 'query-exited',
      shell: { status: 'captured' },
      console: { status: 'unavailable', reason: 'query-exited' },
      helper: { requested: false, exit: 'observed-before-request', exitCode: 88 },
    },
  },
  {
    caseName: 'the helper reports owner loss after its shell frame',
    queryMode: 'exit-after-shell',
    options: { exitCode: 86 },
    expected: {
      status: 'partial',
      reason: 'query-exited',
      shell: { status: 'captured' },
      console: { status: 'unavailable', reason: 'query-exited' },
      helper: { requested: false, exit: 'cooperative-owner-loss', exitCode: 86 },
    },
  },
  {
    caseName: 'an unexpected line precedes ready',
    queryMode: 'protocol-break',
    options: {},
    expected: { reason: 'invalid-shape', helper: { reason: null } },
  },
  {
    caseName: 'the helper exits without a result',
    queryMode: 'ready-without-result',
    options: {},
    expected: { reason: 'invalid-json', helper: { reason: null } },
  },
  {
    caseName: 'the helper starts without a process id',
    queryMode: 'no-pid',
    options: {},
    expected: { reason: 'query-start-failed', helper: { requested: false, reason: null } },
  },
  {
    caseName: 'the helper exceeds the raw output limit',
    queryMode: 'raw-overflow',
    options: {},
    expected: { reason: 'output-limit', helper: { requested: true, reason: 'output-limit' } },
  },
  {
    caseName: 'ending an over-limit helper errors',
    queryMode: 'raw-overflow',
    options: { killFails: true },
    expected: {
      reason: 'query-start-failed',
      helper: { requested: true, reason: 'output-limit' },
    },
  },
  {
    caseName: 'the platform is not Windows',
    queryMode: 'before-ready',
    options: { platform: 'linux' },
    expected: { reason: 'unsupported-platform', helper: { requested: false, reason: null } },
  },
];

test.each(rejectedCollections)(
  'required proof rejects and prints the record when $caseName',
  async ({ queryMode, options, expected }) => {
    const active = createScenario(queryMode, options);
    const outcome = await proofOutcome();
    expectProofSnapshot(active, { status: 'unavailable', ...expected });
    expectRejected(outcome);
  },
);

test.each([
  {
    caseName: 'the helper reports its deadline early',
    queryMode: 'exit-before-ready' as const,
    options: { exitCode: 87 },
    expected: { reason: 'query-exited', helper: { exit: 'cooperative-deadline' } },
  },
  {
    caseName: 'the helper reports its deadline after its shell frame',
    queryMode: 'exit-after-shell' as const,
    options: { exitCode: 87 },
    expected: {
      status: 'partial',
      reason: 'query-exited',
      shell: { status: 'captured' },
      console: { status: 'unavailable', reason: 'query-exited' },
      helper: { requested: false, exit: 'cooperative-deadline', exitCode: 87 },
    },
  },
  {
    caseName: 'a helper stream fails before exit',
    queryMode: 'stream-error' as const,
    options: {},
    expected: { reason: 'query-exited', helper: { exit: 'not-observed', reason: null } },
  },
])(
  'required proof accepts a bounded observation when $caseName',
  async ({ queryMode, options, expected }) => {
    const active = createScenario(queryMode, options);
    await requireAccepted(await proofOutcome());
    expectProofSnapshot(active, { status: 'unavailable', ...expected });
  },
);

const acceptedPartialCollections: Array<{
  caseName: string;
  options: ScenarioOptions;
  expected: Record<string, unknown>;
}> = [
  {
    caseName: 'the Worker reply is still pending',
    options: { workerReply: 'pending' },
    expected: {
      reason: 'worker-request-deadline',
      machine: { status: 'captured' },
      worker: { status: 'unavailable', reason: 'worker-request-deadline' },
    },
  },
  {
    caseName: 'the Worker reply is not finite',
    options: { workerReply: 'non-finite' },
    expected: {
      reason: 'invalid-shape',
      machine: { status: 'captured' },
      worker: { status: 'unavailable', reason: 'invalid-shape' },
    },
  },
  {
    caseName: 'the machine sample lists no CPUs',
    options: { machine: 'empty' },
    expected: {
      reason: 'invalid-shape',
      machine: { status: 'unavailable', reason: 'invalid-shape' },
      worker: { status: 'captured' },
    },
  },
];

test.each(acceptedPartialCollections)(
  'required proof accepts a partial observation when $caseName',
  async ({ options, expected }) => {
    const active = createScenario('captured', options);
    const outcome = await proofOutcome();
    expectProofSnapshot(active, {
      status: 'partial',
      shell: { status: 'captured' },
      console: { status: 'captured' },
      ...expected,
    });
    await requireAccepted(outcome);
  },
);

test('required proof accepts a bounded observation when ending the helper at the deadline reports an error', async () => {
  const active = createScenario('before-ready', { killFails: true });
  await requireAccepted(await proofAfterDeadline(active));
  expectProofSnapshot(active, {
    status: 'unavailable',
    reason: 'query-start-failed',
    helper: { requested: true, reason: 'deadline' },
  });
});

test('required proof prints a malformed record before rejecting it', async () => {
  const active = createScenario('captured', {
    replaceRecord: (observed) => ({ ...observed, version: 2 }),
  });
  const outcome = await proofOutcome();
  expectRejected(outcome);
  expect(active.suppliedRecord).toMatchObject({ version: 2, requestedPid: 4_242 });
  const lines = proofLines(active, 'WINDOWS_OS_PROOF ');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]?.slice('WINDOWS_OS_PROOF '.length) ?? 'null')).toEqual(
    active.suppliedRecord,
  );
});

test('required proof reports only the size of an oversized record and rejects it', async () => {
  const active = createScenario('captured', {
    replaceRecord: (observed) => ({
      ...observed,
      padding: 'x'.repeat(WINDOWS_OS_MAX_RESULT_BYTES),
    }),
  });
  const outcome = await proofOutcome();
  expectRejected(outcome);
  const bytes = Buffer.byteLength(JSON.stringify(active.suppliedRecord));
  expect(bytes).toBeGreaterThan(WINDOWS_OS_MAX_RESULT_BYTES);
  expect(proofLines(active, 'WINDOWS_OS_PROOF ')).toEqual([]);
  expect(proofLines(active, 'WINDOWS_OS_PROOF_OVERSIZE')).toEqual([
    `WINDOWS_OS_PROOF_OVERSIZE bytes=${bytes}`,
  ]);
});
