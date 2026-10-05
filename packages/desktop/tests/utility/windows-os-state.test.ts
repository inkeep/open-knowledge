import { EventEmitter } from 'node:events';
import { cpus } from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, cpus: vi.fn(actual.cpus) };
});

import type { PtyOsObservation } from '../../src/utility/pty-host.ts';
import {
  collectWindowsOsState,
  startWindowsOsState,
  WINDOWS_OS_MAX_RAW_BYTES,
  type WindowsOsCollection,
  type WindowsOsStateOptions,
  type WindowsQueryHelper,
  windowsPowerShellPath,
} from '../support/windows-os-state.test-helper.ts';
import { assertBoundedWindowsOsState } from '../support/windows-os-state-contract.test-helper.ts';

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
  privateContent: 'secret title',
};
const emptyConsole = {
  status: 'captured',
  candidateCount: 0,
  candidates: [],
  unavailableCandidates: [],
  omittedCandidates: 0,
};

function recordingQuery(
  raw: string | null,
  options?: {
    pid?: number | undefined;
    ready?: boolean;
    code?: number;
    killResult?: boolean;
    killThrows?: boolean;
  },
) {
  const sends: string[] = [];
  const unrefs: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: options !== undefined && Object.hasOwn(options, 'pid') ? options.pid : 99_999,
    stdout,
    stderr,
    stdin,
    kill() {
      sends.push('helper-kill-request');
      if (options?.killThrows) throw new Error('private helper command');
      return options?.killResult ?? true;
    },
    unref() {
      unrefs.push('helper-unref');
    },
  });
  const spawnQuery = (_file: string, _args: string[]): WindowsQueryHelper => {
    if (options?.ready !== false) {
      queueMicrotask(() => stdout.write('READY\n'));
      stdin.once('data', () => {
        if (raw !== null) {
          stdout.write(`RESULT ${raw}\n`);
          queueMicrotask(() => child.emit('close', options?.code ?? 0, null));
        }
      });
    }
    return child;
  };
  return { spawnQuery, sends, unrefs, child, stdout, stderr, stdin };
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(cpus).mockReset();
});

test('a projected raw result retains typed shell and machine samples without arbitrary content', async () => {
  const raw = JSON.stringify({
    version: 1,
    shells: [processSample],
    console: emptyConsole,
    privateContent: 'secret environment',
  });
  const query = recordingQuery(raw);
  const result = await collectWindowsOsState({
    pid: 4_242,
    parentPid: 12,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  assertBoundedWindowsOsState(result, 4_242);
  expect(() => assertBoundedWindowsOsState({ ...result, version: 2 }, 4_242)).toThrow();
  expect(() =>
    assertBoundedWindowsOsState({ ...result, console: { status: 'unavailable' } }, 4_242),
  ).toThrow();
  expect(() =>
    assertBoundedWindowsOsState(
      { ...result, console: { status: 'unavailable', reason: 'captured' } },
      4_242,
    ),
  ).toThrow();
  if (result.shell.status === 'captured') {
    const invalidShell = {
      ...result.shell,
      value: { ...result.shell.value, first: { ...result.shell.value.first, userMs: -1 } },
    };
    expect(() =>
      assertBoundedWindowsOsState(
        { ...result, shell: invalidShell, targets: [{ requestedPid: 4_242, shell: invalidShell }] },
        4_242,
      ),
    ).toThrow();
  }
  expect(() =>
    assertBoundedWindowsOsState({ ...result, privateContent: 'secret' }, 4_242),
  ).toThrow();
  expect(result.shell).toEqual(
    expect.objectContaining({
      status: 'captured',
      value: expect.objectContaining({
        pid: 4_242,
        createdAtMs: processSample.createdAtMs,
        threads: [{ id: 8, state: 'wait', waitReason: 'user-request' }],
      }),
    }),
  );
  expect(result.machine).toEqual(expect.objectContaining({ status: 'captured' }));
  expect(result.console).toEqual(expect.objectContaining({ status: 'captured' }));
  expect(result.helper).toEqual(
    expect.objectContaining({
      requested: false,
      delivery: 'not-attempted',
      exit: 'observed-before-request',
    }),
  );
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(query.sends).toEqual([]);
});

const capturedWorker = {
  status: 'captured',
  value: { nodeThreadId: 91, requestedAtMs: 0, repliedAtMs: 0, userMs: 1, systemMs: 2 },
} as const;

test.each([
  {
    caseName: 'a helper reason without a request',
    reshape: (result: PtyOsObservation) => ({
      ...result,
      helper: { ...result.helper, reason: 'deadline' },
    }),
  },
  {
    caseName: 'a helper request without a reason',
    reshape: (result: PtyOsObservation) => ({
      ...result,
      helper: { ...result.helper, requested: true },
    }),
  },
  {
    caseName: 'a partial record with nothing missing',
    reshape: (result: PtyOsObservation) => ({ ...result, worker: capturedWorker }),
  },
])('the bounded contract rejects $caseName', async ({ reshape }) => {
  const query = recordingQuery(
    JSON.stringify({ version: 1, shells: [processSample], console: emptyConsole }),
  );
  const result = await collectWindowsOsState({
    pid: 4_242,
    parentPid: 12,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  expect(result).toMatchObject({
    status: 'partial',
    shell: { status: 'captured' },
    machine: { status: 'captured' },
    console: { status: 'captured', value: { unavailableCandidates: [] } },
    worker: { status: 'unavailable' },
    helper: { requested: false, reason: null },
  });
  assertBoundedWindowsOsState(result, 4_242);
  expect(() => assertBoundedWindowsOsState(reshape(result), 4_242)).toThrow();
});

test.each([
  { caseName: 'malformed JSON', raw: '{private', reason: 'invalid-json' },
  { caseName: 'empty JSON', raw: '', reason: 'invalid-json' },
  { caseName: 'truncated JSON', raw: '{"version":', reason: 'invalid-json' },
  { caseName: 'array root', raw: '[]', reason: 'invalid-shape' },
  {
    caseName: 'nonnumeric CPU time',
    raw: JSON.stringify({
      version: 1,
      shells: [{ ...processSample, first: { userMs: '11', kernelMs: 2, threadCount: 1 } }],
      console: emptyConsole,
    }),
    reason: 'invalid-shape',
  },
  {
    caseName: 'changed creation identity',
    raw: JSON.stringify({
      version: 1,
      shells: [{ ...processSample, secondCreatedAtMs: processSample.createdAtMs + 1 }],
      console: emptyConsole,
    }),
    reason: 'identity-changed',
  },
  {
    caseName: 'unknown thread wait reason',
    raw: JSON.stringify({
      version: 1,
      shells: [
        {
          ...processSample,
          threads: [{ id: 8, state: 'wait', waitReason: 'private reason' }],
        },
      ],
      console: emptyConsole,
    }),
    reason: 'invalid-shape',
  },
  {
    caseName: 'overflowed omitted thread count',
    raw: JSON.stringify({
      version: 1,
      shells: [
        {
          ...processSample,
          threads: Array.from({ length: 17 }, (_, index) => ({
            id: index + 1,
            state: 'running',
            waitReason: 'not-applicable',
          })),
          omittedThreads: Number.MAX_SAFE_INTEGER,
        },
      ],
      console: emptyConsole,
    }),
    reason: 'invalid-shape',
  },
  {
    caseName: 'shell sample for another PID',
    raw: JSON.stringify({
      version: 1,
      shells: [{ ...processSample, pid: 4_243 }],
      console: emptyConsole,
    }),
    reason: 'invalid-shape',
  },
  {
    caseName: 'console candidate count without candidates',
    raw: JSON.stringify({
      version: 1,
      shells: [processSample],
      console: { ...emptyConsole, candidateCount: 1 },
    }),
    reason: 'invalid-shape',
  },
  {
    caseName: 'unknown record version',
    raw: JSON.stringify({ version: 2, shells: [processSample], console: emptyConsole }),
    reason: 'invalid-shape',
  },
  {
    caseName: 'more shells than requested PIDs',
    raw: JSON.stringify({
      version: 1,
      shells: [processSample, processSample],
      console: emptyConsole,
    }),
    reason: 'invalid-shape',
  },
  {
    caseName: 'waiting thread without a wait reason',
    raw: JSON.stringify({
      version: 1,
      shells: [
        { ...processSample, threads: [{ id: 8, state: 'wait', waitReason: 'not-applicable' }] },
      ],
      console: emptyConsole,
    }),
    reason: 'invalid-shape',
  },
  {
    caseName: 'running thread with a wait reason',
    raw: JSON.stringify({
      version: 1,
      shells: [
        { ...processSample, threads: [{ id: 8, state: 'running', waitReason: 'user-request' }] },
      ],
      console: emptyConsole,
    }),
    reason: 'invalid-shape',
  },
  {
    caseName: 'duplicate result frame',
    raw: `${JSON.stringify({ version: 1, shells: [processSample], console: emptyConsole })}\nRESULT {}`,
    reason: 'invalid-shape',
  },
])('$caseName produces $reason without leaking content', async ({ raw, reason }) => {
  const query = recordingQuery(raw);
  const result = await collectWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  expect(result.shell).toEqual(expect.objectContaining({ status: 'unavailable', reason }));
  expect(JSON.stringify(result)).not.toContain('private');
});

test('a missing process remains distinct from denied access and a valid non-wait thread has no wait reason', async () => {
  const results = await Promise.all(
    ['process-absent', 'access-unavailable'].map(async (reason) => {
      const query = recordingQuery(
        JSON.stringify({
          version: 1,
          shells: [{ status: 'unavailable', reason }],
          console: { status: 'unavailable', reason: 'console-identity-unavailable' },
        }),
      );
      return collectWindowsOsState({ pid: 4_242, platform: 'win32', spawnQuery: query.spawnQuery });
    }),
  );
  expect(results.map((item) => item.shell)).toEqual([
    { status: 'unavailable', reason: 'process-absent' },
    { status: 'unavailable', reason: 'access-unavailable' },
  ]);
  const query = recordingQuery(
    JSON.stringify({
      version: 1,
      shells: [
        {
          ...processSample,
          threads: [{ id: 9, state: 'running', waitReason: 'not-applicable' }],
        },
      ],
      console: emptyConsole,
    }),
  );
  const result = await collectWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  expect(result.shell.status === 'captured' && result.shell.value.threads[0]?.waitReason).toBe(
    'not-applicable',
  );
});

test('a UTF-8 byte overflow records a helper request without asserting that the helper exited', async () => {
  const query = recordingQuery(null, { ready: false });
  const running = startWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  query.stderr.write('é'.repeat(WINDOWS_OS_MAX_RAW_BYTES / 2 + 1));
  const result = await running.result;
  expect(result.reason).toBe('output-limit');
  expect(result.helper).toEqual(
    expect.objectContaining({
      requested: true,
      reason: 'output-limit',
      delivery: 'accepted',
      exit: 'not-observed',
    }),
  );
  expect(query.sends).toEqual(['helper-kill-request']);
  expect(JSON.stringify(result)).not.toContain('é');
});

test('a bounded multi-target request uses one helper and retains each requested process identity', async () => {
  const query = recordingQuery(
    JSON.stringify({
      version: 1,
      shells: [processSample, { ...processSample, pid: 4_243 }],
      console: emptyConsole,
    }),
  );
  let launches = 0;
  const result = await collectWindowsOsState({
    pid: 4_242,
    additionalPids: [4_243],
    platform: 'win32',
    spawnQuery: (file, args) => {
      launches += 1;
      return query.spawnQuery(file, args);
    },
  });
  expect(result.targets.map((target) => target.requestedPid)).toEqual([4_242, 4_243]);
  expect(result.targets.every((target) => target.shell.status === 'captured')).toBe(true);
  expect(launches).toBe(1);
});

test('thread and console candidate limits keep omitted counts without retaining extra rows', async () => {
  const oversizedProcess = {
    ...processSample,
    first: { ...processSample.first, threadCount: 20 },
    second: { ...processSample.second, threadCount: 20 },
    threads: Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      state: 'running',
      waitReason: 'not-applicable',
    })),
  };
  const query = recordingQuery(
    JSON.stringify({
      version: 1,
      shells: [oversizedProcess],
      console: {
        status: 'captured',
        candidateCount: 6,
        candidates: Array.from({ length: 6 }, (_, index) => ({
          ...processSample,
          pid: 5_000 + index,
        })),
        unavailableCandidates: [],
        omittedCandidates: 0,
      },
    }),
  );
  const result = await collectWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  expect(result.shell.status === 'captured' && result.shell.value.threads).toHaveLength(16);
  expect(result.shell.status === 'captured' && result.shell.value.omittedThreads).toBe(4);
  expect(result.console.status === 'captured' && result.console.value.candidates).toHaveLength(4);
  expect(result.console.status === 'captured' && result.console.value.omittedCandidates).toBe(2);
});

test('a candidate that exits after enumeration remains distinct from an empty candidate query', async () => {
  const query = recordingQuery(
    JSON.stringify({
      version: 1,
      shells: [processSample],
      console: {
        status: 'captured',
        candidateCount: 2,
        candidates: [{ ...processSample, pid: 5_000 }],
        unavailableCandidates: [{ reason: 'process-absent', count: 1 }],
        omittedCandidates: 0,
      },
    }),
  );
  const result = await collectWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  expect(result.status).toBe('partial');
  expect(result.console).toEqual(
    expect.objectContaining({
      status: 'captured',
      value: expect.objectContaining({
        candidateCount: 2,
        candidates: [expect.objectContaining({ pid: 5_000 })],
        unavailableCandidates: [{ reason: 'process-absent', count: 1 }],
        omittedCandidates: 0,
      }),
    }),
  );
  expect(JSON.stringify(result)).not.toContain('private');
});

test('the bounded contract accepts a partial record whose only gap is a failed console candidate', async () => {
  const query = recordingQuery(
    JSON.stringify({
      version: 1,
      shells: [processSample],
      console: {
        status: 'captured',
        candidateCount: 2,
        candidates: [{ ...processSample, pid: 5_000 }],
        unavailableCandidates: [{ reason: 'process-absent', count: 1 }],
        omittedCandidates: 0,
      },
    }),
  );
  const result = await collectWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  expect(result.status).toBe('partial');
  expect(() => assertBoundedWindowsOsState(result, 4_242)).not.toThrow();
  expect(() =>
    assertBoundedWindowsOsState({ ...result, worker: capturedWorker }, 4_242),
  ).not.toThrow();
});

test('a captured shell retains a partial result when console enumeration is unavailable', async () => {
  const query = recordingQuery(
    JSON.stringify({
      version: 1,
      shells: [processSample],
      console: { status: 'unavailable', reason: 'access-unavailable' },
    }),
  );
  const result = await collectWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  expect(result.status).toBe('partial');
  expect(result.shell.status).toBe('captured');
  expect(result.console).toEqual({ status: 'unavailable', reason: 'access-unavailable' });
});

test('an unavailable machine section alone names its reason on a partial record', async () => {
  vi.mocked(cpus).mockReturnValue([]);
  const query = recordingQuery(null, { ready: false });
  const running = startWindowsOsState({
    pid: 4_242,
    parentPid: 12,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
    worker: { threadId: 91, cpuUsage: async () => ({ user: 1_000, system: 2_000 }) },
  });
  await new Promise<void>(setImmediate);
  query.stdout.write(
    `READY\nRESULT ${JSON.stringify({ version: 1, shells: [processSample], console: emptyConsole })}\n`,
  );
  await new Promise<void>(setImmediate);
  query.child.emit('close', 0, null);
  const result = await running.result;
  expect(result.shell.status).toBe('captured');
  expect(result.console.status).toBe('captured');
  expect(result.worker.status).toBe('captured');
  expect(result.machine).toEqual({ status: 'unavailable', reason: 'invalid-shape' });
  expect(result.status).toBe('partial');
  expect(result.reason).toBe('invalid-shape');
  assertBoundedWindowsOsState(result, 4_242);
});

test('a captured query with a pending worker sample remains a bounded observation', async () => {
  const query = recordingQuery(
    JSON.stringify({ version: 1, shells: [processSample], console: emptyConsole }),
  );
  const result = await collectWindowsOsState({
    pid: 4_242,
    parentPid: 12,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
    worker: {
      threadId: 91,
      cpuUsage: () => new Promise<{ user: number; system: number }>(() => undefined),
    },
  });
  expect(result.shell.status).toBe('captured');
  expect(result.machine.status).toBe('captured');
  expect(result.console.status).toBe('captured');
  expect(result.worker).toEqual({ status: 'unavailable', reason: 'worker-request-deadline' });
  expect(result.status).toBe('partial');
  expect(query.sends).toEqual([]);
  assertBoundedWindowsOsState(result, 4_242);
});

test('the query helper starts with an execution policy scoped to its own process', async () => {
  const query = recordingQuery(null, { ready: false });
  const launches: string[][] = [];
  const running = startWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: (file, args) => {
      launches.push(args);
      return query.spawnQuery(file, args);
    },
  });
  running.cancel('owner-loss');
  await running.result;
  expect(launches).toHaveLength(1);
  const args = launches[0] ?? [];
  const policy = args.indexOf('-ExecutionPolicy');
  expect(policy).toBeGreaterThanOrEqual(0);
  expect(args[policy + 1]).toBe('Bypass');
  expect(policy).toBeLessThan(args.indexOf('-File'));
});

const shellFrame = JSON.stringify({ version: 1, shells: [{ ...processSample, parentPid: null }] });

test('a deadline after the process frame keeps the sampled shell on a partial record', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const query = recordingQuery(null, { ready: false });
  const running = startWindowsOsState({
    pid: 4_242,
    parentPid: 12,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  query.stdout.write(`READY\nSHELL ${shellFrame}\n`);
  await new Promise<void>(setImmediate);
  await vi.runAllTimersAsync();
  const result = await running.result;
  expect(result.reason).toBe('deadline');
  expect(result.status).toBe('partial');
  expect(result.shell).toEqual({
    status: 'captured',
    value: expect.objectContaining({ pid: 4_242, parentPid: null, threads: processSample.threads }),
  });
  expect(result.targets).toEqual([{ requestedPid: 4_242, shell: result.shell }]);
  expect(result.console).toEqual({ status: 'unavailable', reason: 'deadline' });
  expect(query.sends).toEqual(['helper-kill-request']);
  expect(JSON.stringify(result)).not.toContain('secret');
  assertBoundedWindowsOsState(result, 4_242);
});

test('a helper deadline exit after the process frame keeps the sampled shell', async () => {
  const query = recordingQuery(null, { ready: false });
  const running = startWindowsOsState({
    pid: 4_242,
    parentPid: 12,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  query.stdout.write(`READY\nSHELL ${shellFrame}\n`);
  await new Promise<void>(setImmediate);
  query.child.emit('exit', 87, null);
  query.child.emit('close', 87, null);
  const result = await running.result;
  expect(result.reason).toBe('query-exited');
  expect(result.status).toBe('partial');
  expect(result.shell.status).toBe('captured');
  expect(result.console).toEqual({ status: 'unavailable', reason: 'query-exited' });
  expect(result.helper).toEqual(expect.objectContaining({ exit: 'cooperative-deadline' }));
});

test('a result frame after the process frame supplies the parent PID and console', async () => {
  const query = recordingQuery(null, { ready: false });
  const running = startWindowsOsState({
    pid: 4_242,
    parentPid: 12,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  query.stdout.write(
    `READY\nSHELL ${shellFrame}\nRESULT ${JSON.stringify({ version: 1, shells: [processSample], console: emptyConsole })}\n`,
  );
  await new Promise<void>(setImmediate);
  query.child.emit('close', 0, null);
  const result = await running.result;
  expect(result.reason).toBe('worker-unavailable');
  expect(result.shell).toEqual(
    expect.objectContaining({
      status: 'captured',
      value: expect.objectContaining({ parentPid: 12 }),
    }),
  );
  expect(result.console.status).toBe('captured');
});

test('a process frame for another PID is not kept at the deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const query = recordingQuery(null, { ready: false });
  const running = startWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  query.stdout.write(
    `READY\nSHELL ${JSON.stringify({ version: 1, shells: [{ ...processSample, pid: 4_243 }] })}\n`,
  );
  await new Promise<void>(setImmediate);
  await vi.runAllTimersAsync();
  const result = await running.result;
  expect(result.shell).toEqual({ status: 'unavailable', reason: 'deadline' });
  expect(result.status).toBe('unavailable');
});

const shellRetentionCases: Array<{
  caseName: string;
  frames: string;
  finish: (running: WindowsOsCollection, query: ReturnType<typeof recordingQuery>) => unknown;
  reason: string;
  status: string;
  shell: unknown;
}> = [
  {
    caseName: 'owner-loss after a valid process frame',
    frames: `SHELL ${shellFrame}\n`,
    finish: (running) => running.cancel('owner-loss'),
    reason: 'owner-loss',
    status: 'partial',
    shell: {
      status: 'captured',
      value: expect.objectContaining({
        pid: 4_242,
        parentPid: null,
        threads: processSample.threads,
      }),
    },
  },
  {
    caseName: 'a stray line after a valid process frame',
    frames: `SHELL ${shellFrame}\nunexpected\n`,
    finish: (running) => running.cancel('deadline'),
    reason: 'deadline',
    status: 'unavailable',
    shell: { status: 'unavailable', reason: 'deadline' },
  },
  {
    caseName: 'a duplicate valid process frame',
    frames: `SHELL ${shellFrame}\nSHELL ${shellFrame}\n`,
    finish: (running) => running.cancel('deadline'),
    reason: 'deadline',
    status: 'unavailable',
    shell: { status: 'unavailable', reason: 'deadline' },
  },
  {
    caseName: 'output overflow after a process frame',
    frames: `SHELL ${shellFrame}\n`,
    finish: (_running, query) => query.stderr.write('x'.repeat(WINDOWS_OS_MAX_RAW_BYTES + 1)),
    reason: 'output-limit',
    status: 'unavailable',
    shell: { status: 'unavailable', reason: 'output-limit' },
  },
  {
    caseName: 'a process frame after the result frame',
    frames: `RESULT ${JSON.stringify({ version: 1, shells: [processSample], console: emptyConsole })}\nSHELL ${shellFrame}\n`,
    finish: (_running, query) => query.child.emit('close', 0, null),
    reason: 'invalid-shape',
    status: 'unavailable',
    shell: { status: 'unavailable', reason: 'invalid-shape' },
  },
];

test.each(shellRetentionCases)(
  '$caseName settles with $reason and shell $shell.status',
  async ({ frames, finish, reason, status, shell }) => {
    const query = recordingQuery(null, { ready: false });
    const running = startWindowsOsState({
      pid: 4_242,
      parentPid: 12,
      platform: 'win32',
      spawnQuery: query.spawnQuery,
    });
    query.stdout.write(`READY\n${frames}`);
    await new Promise<void>(setImmediate);
    finish(running, query);
    const result = await running.result;
    expect(result.requestedPid).toBe(4_242);
    expect(result.targets).toEqual([{ requestedPid: 4_242, shell }]);
    expect(result.reason).toBe(reason);
    expect(result.status).toBe(status);
    expect(result.shell).toEqual(shell);
    expect(result.console).toEqual({ status: 'unavailable', reason });
  },
);

test('more than eight requested targets never reaches the query boundary', async () => {
  const query = recordingQuery(null, { ready: false });
  let starts = 0;
  const result = await collectWindowsOsState({
    pid: 4_242,
    additionalPids: Array.from({ length: 8 }, (_, index) => 5_000 + index),
    platform: 'win32',
    spawnQuery: (file, args) => {
      starts += 1;
      return query.spawnQuery(file, args);
    },
  });
  expect(result.reason).toBe('invalid-shape');
  expect(result.targets.length).toBeLessThanOrEqual(8);
  expect(starts).toBe(0);
});

test('an owned helper with no PID receives no termination call at a deadline', async () => {
  const query = recordingQuery(null, { pid: undefined, ready: false });
  const result = await collectWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  expect(result.reason).toBe('query-start-failed');
  expect(query.child.pid).toBeUndefined();
  expect(result.helper.delivery).toBe('not-attempted');
  expect(query.sends).toEqual([]);
  expect(() => query.child.emit('error', new Error('private spawn command'))).not.toThrow();
});

test('a zero helper PID is rejected without a termination call', async () => {
  const query = recordingQuery(null, { pid: 0, ready: false });
  const result = await collectWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  expect(query.child.pid).toBe(0);
  expect(result.reason).toBe('query-start-failed');
  expect(result.helper.delivery).toBe('not-attempted');
  expect(query.sends).toEqual([]);
});

test('a helper that exits before a result frame reports query-exited', async () => {
  const query = recordingQuery(null, { ready: false });
  const running = startWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  query.child.emit('close', 88, null);
  const result = await running.result;
  expect(result.reason).toBe('query-exited');
  expect(result.helper.exit).toBe('observed-before-request');
});

test.each([
  { code: 86, exit: 'cooperative-owner-loss' },
  { code: 87, exit: 'cooperative-deadline' },
] as const)(
  'an unrequested helper exit code $code is recorded as $exit',
  async ({ code, exit }) => {
    const query = recordingQuery(null, { ready: false });
    const running = startWindowsOsState({
      pid: 4_242,
      platform: 'win32',
      spawnQuery: query.spawnQuery,
    });
    query.child.emit('exit', code, null);
    query.child.emit('close', code, null);
    const result = await running.result;
    expect(result.reason).toBe('query-exited');
    expect(result.helper).toEqual(
      expect.objectContaining({ requested: false, exit, exitCode: code }),
    );
    expect(query.sends).toEqual([]);
  },
);

test('observed helper exit prevents a later deadline from sending a termination request', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const query = recordingQuery(null, { ready: false });
  const running = startWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  query.child.emit('exit', 0, null);
  await vi.runAllTimersAsync();
  const result = await running.result;
  expect(result.helper).toEqual(
    expect.objectContaining({
      requested: true,
      delivery: 'already-exited',
      exit: 'observed-before-request',
    }),
  );
  expect(query.sends).toEqual([]);
});

test('owner disposal requests only its recording helper and seals late output', async () => {
  const query = recordingQuery(null, { ready: false });
  const running = startWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  const cancelled = running.cancel('owner-loss');
  const result = await running.result;
  expect(cancelled).toBe(result);
  expect(result.helper).toEqual(
    expect.objectContaining({
      requested: true,
      reason: 'owner-loss',
      delivery: 'accepted',
      exit: 'not-observed',
    }),
  );
  expect(query.sends).toEqual(['helper-kill-request']);
  query.child.emit('exit', 86, null);
  expect(result.helper.exit).toBe('not-observed');
});

test('worker response and rejection have distinct typed outcomes before collection settles', async () => {
  const acceptedQuery = recordingQuery(null, { ready: false });
  const accepted = startWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: acceptedQuery.spawnQuery,
    worker: { threadId: 91, cpuUsage: async () => ({ user: 1_000, system: 2_000 }) },
  });
  await new Promise<void>(setImmediate);
  const acceptedResult = accepted.cancel('owner-loss');
  expect(acceptedResult?.worker).toEqual(
    expect.objectContaining({
      status: 'captured',
      value: expect.objectContaining({ nodeThreadId: 91, userMs: 1, systemMs: 2 }),
    }),
  );

  const rejectedQuery = recordingQuery(null, { ready: false });
  const rejected = startWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: rejectedQuery.spawnQuery,
    worker: {
      threadId: 92,
      cpuUsage: async () => {
        throw new Error('private worker response');
      },
    },
  });
  await new Promise<void>(setImmediate);
  const rejectedResult = rejected.cancel('owner-loss');
  expect(rejectedResult?.worker).toEqual({ status: 'unavailable', reason: 'worker-unavailable' });
});

test.each([
  { killResult: false, killThrows: false, delivery: 'rejected' },
  { killResult: true, killThrows: true, delivery: 'threw' },
])(
  'a termination delivery of $delivery still releases owned pipes after the deadline',
  async ({ killResult, killThrows, delivery }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const query = recordingQuery(null, { ready: false, killResult, killThrows });
    const running = startWindowsOsState({
      pid: 4_242,
      platform: 'win32',
      spawnQuery: query.spawnQuery,
    });
    await vi.runAllTimersAsync();
    const result = await running.result;
    expect(result.helper.delivery).toBe(delivery);
    expect(query.sends).toEqual(['helper-kill-request']);
    expect(query.stdin.writableEnded).toBe(true);
    expect(query.stdout.destroyed).toBe(true);
    expect(query.stderr.destroyed).toBe(true);
    expect(query.unrefs).toEqual(['helper-unref']);
  },
);

test('a never-settling helper is cancelled through its recording handle at the collection deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const query = recordingQuery(null, { ready: false });
  const running = startWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    spawnQuery: query.spawnQuery,
  });
  await vi.runAllTimersAsync();
  const result = await running.result;
  expect(result.reason).toBe('deadline');
  expect(result.helper).toEqual(
    expect.objectContaining({
      requested: true,
      reason: 'deadline',
      delivery: 'accepted',
      exit: 'not-observed',
    }),
  );
  expect(query.sends).toEqual(['helper-kill-request']);
  query.child.emit('close', 1, null);
  expect(result.helper.exit).toBe('not-observed');
});

test('an unsupported platform or spent budget does not start the helper', async () => {
  const query = recordingQuery(null, { ready: false });
  let starts = 0;
  const spawnQuery: WindowsOsStateOptions['spawnQuery'] = (file, args) => {
    starts += 1;
    return query.spawnQuery(file, args);
  };
  const unsupported = await collectWindowsOsState({
    pid: 4_242,
    platform: 'darwin',
    spawnQuery,
  });
  const spent = await collectWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    budgetMs: 0,
    spawnQuery,
  });
  const lessThanOneMs = await collectWindowsOsState({
    pid: 4_242,
    platform: 'win32',
    budgetMs: 0.5,
    spawnQuery,
  });
  expect(unsupported.reason).toBe('unsupported-platform');
  expect(spent.reason).toBe('no-budget');
  expect(lessThanOneMs.reason).toBe('no-budget');
  expect(starts).toBe(0);
  expect(query.sends).toEqual([]);
});

test('the Windows PowerShell path reads SystemRoot case-insensitively with Windows separators', () => {
  expect(windowsPowerShellPath({ systemroot: 'D:\\Win' })).toBe(
    'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  expect(windowsPowerShellPath({})).toBe(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
});
