import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Worker } from 'node:worker_threads';
import { getWindowsEnvValue } from '../../src/shared/windows-env.ts';
import type {
  PtyOsMachineSample,
  PtyOsObservation,
  PtyOsProcessSample,
  PtyOsSection,
  PtyOsThreadSample,
  PtyOsUnavailableReason,
} from '../../src/utility/pty-host.ts';

export const WINDOWS_OS_MAX_BUDGET_MS = 5_000;
export const WINDOWS_OS_MAX_TARGETS = 8;
export const WINDOWS_OS_MAX_CANDIDATES = 4;
export const WINDOWS_OS_MAX_THREADS = 16;
export const WINDOWS_OS_MAX_RAW_BYTES = 64 * 1024;
export const WINDOWS_OS_MAX_RESULT_BYTES = 32 * 1024;
export const WINDOWS_OS_HELPER_EXIT = { ownerLoss: 86, deadline: 87 } as const;

export function windowsPowerShellPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return win32.join(
    getWindowsEnvValue(env, 'SystemRoot') ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

type TerminationReason = 'deadline' | 'output-limit' | 'owner-loss';
type StreamLike = {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'error', listener: () => void): unknown;
  destroy?(): unknown;
};
type InputLike = {
  write(chunk: string): unknown;
  end(): unknown;
  on?(event: 'error', listener: () => void): unknown;
  destroy?(): unknown;
};
export interface WindowsQueryHelper {
  pid?: number;
  stdout: StreamLike | null;
  stderr: StreamLike | null;
  stdin: InputLike | null;
  on(event: 'error', listener: () => void): unknown;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(): boolean;
  unref?(): void;
}

export interface WindowsOsStateOptions {
  pid: number;
  additionalPids?: number[];
  parentPid?: number;
  budgetMs?: number;
  deadlineAt?: number;
  platform?: NodeJS.Platform;
  worker?: Pick<Worker, 'threadId' | 'cpuUsage'>;
  spawnQuery?: (file: string, args: string[]) => WindowsQueryHelper;
}

export interface WindowsOsCollection {
  result: Promise<PtyOsObservation>;
  cancel(reason: 'deadline' | 'owner-loss'): PtyOsObservation | null;
}

const queryFile = fileURLToPath(new URL('./windows-os-query.test-helper.ps1', import.meta.url));
const threadStates = [
  'initialized',
  'ready',
  'running',
  'standby',
  'terminated',
  'wait',
  'transition',
  'unknown',
] as const;
const waitReasons = [
  'executive',
  'free-page',
  'page-in',
  'pool-allocation',
  'execution-delay',
  'suspended',
  'user-request',
  'event-pair-high',
  'event-pair-low',
  'lpc-receive',
  'lpc-reply',
  'virtual-memory',
  'page-out',
  'unknown',
  'not-applicable',
] as const;
const unavailableReasons = [
  'process-absent',
  'access-unavailable',
  'identity-changed',
  'console-identity-unavailable',
] as const;
const shellRetainingReasons = ['deadline', 'owner-loss', 'query-exited'] as const;
const candidateFailureReasons = [
  'process-absent',
  'access-unavailable',
  'identity-changed',
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function positivePid(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value);
}

function member<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.some((item) => item === value);
}

function unavailable<T>(reason: PtyOsUnavailableReason): PtyOsSection<T> {
  return { status: 'unavailable', reason };
}

function parseCpu(value: unknown): PtyOsProcessSample['first'] | null {
  const item = record(value);
  if (
    item === null ||
    !finite(item.userMs) ||
    !finite(item.kernelMs) ||
    !nonnegativeInteger(item.threadCount)
  )
    return null;
  return {
    userMs: item.userMs,
    kernelMs: item.kernelMs,
    threadCount: item.threadCount,
  };
}

function parseThread(value: unknown): PtyOsThreadSample | null {
  const item = record(value);
  if (
    item === null ||
    !positivePid(item.id) ||
    !member(item.state, threadStates) ||
    !member(item.waitReason, waitReasons) ||
    (item.state !== 'wait' && item.waitReason !== 'not-applicable') ||
    (item.state === 'wait' && item.waitReason === 'not-applicable')
  )
    return null;
  return { id: item.id, state: item.state, waitReason: item.waitReason };
}

function parseProcess(value: unknown): PtyOsSection<PtyOsProcessSample> | null {
  const item = record(value);
  if (item === null) return null;
  if (item.status === 'unavailable') {
    return member(item.reason, unavailableReasons) ? unavailable(item.reason) : null;
  }
  if (item.status !== 'captured') return null;
  const first = parseCpu(item.first);
  const second = parseCpu(item.second);
  if (
    !positivePid(item.pid) ||
    !(item.parentPid === null || nonnegativeInteger(item.parentPid)) ||
    !finite(item.createdAtMs) ||
    !finite(item.secondCreatedAtMs) ||
    first === null ||
    second === null ||
    !Array.isArray(item.threads) ||
    !nonnegativeInteger(item.omittedThreads)
  )
    return null;
  if (item.createdAtMs !== item.secondCreatedAtMs) return unavailable('identity-changed');
  const threads: PtyOsThreadSample[] = [];
  for (const raw of item.threads.slice(0, WINDOWS_OS_MAX_THREADS)) {
    const thread = parseThread(raw);
    if (thread === null) return null;
    threads.push(thread);
  }
  const omittedThreads =
    item.omittedThreads + Math.max(0, item.threads.length - WINDOWS_OS_MAX_THREADS);
  if (!nonnegativeInteger(omittedThreads)) return null;
  return {
    status: 'captured',
    value: {
      pid: item.pid,
      parentPid: item.parentPid,
      createdAtMs: item.createdAtMs,
      first,
      second,
      threads,
      omittedThreads,
    },
  };
}

function parseShells(
  value: unknown,
  requestedPids: number[],
): {
  shell: PtyOsSection<PtyOsProcessSample>;
  targets: PtyOsObservation['targets'];
} | null {
  const item = record(value);
  if (
    item === null ||
    item.version !== 1 ||
    !Array.isArray(item.shells) ||
    item.shells.length !== requestedPids.length
  )
    return null;
  const targets: PtyOsObservation['targets'] = [];
  for (let index = 0; index < requestedPids.length; index++) {
    const requestedPid = requestedPids[index];
    if (requestedPid === undefined) return null;
    const shell = parseProcess(item.shells[index]);
    if (shell === null || (shell.status === 'captured' && shell.value.pid !== requestedPid))
      return null;
    targets.push({ requestedPid, shell });
  }
  const shell = targets[0]?.shell ?? null;
  return shell === null ? null : { shell, targets };
}

function parseQuery(
  value: unknown,
  requestedPids: number[],
): {
  shell: PtyOsSection<PtyOsProcessSample>;
  targets: PtyOsObservation['targets'];
  console: PtyOsObservation['console'];
} | null {
  const shells = parseShells(value, requestedPids);
  const console = record(record(value)?.console);
  if (shells === null || console === null) return null;
  const { shell, targets } = shells;
  let candidates: PtyOsObservation['console'];
  if (console.status === 'unavailable') {
    if (!member(console.reason, unavailableReasons)) return null;
    candidates = unavailable(console.reason);
  } else {
    if (
      console.status !== 'captured' ||
      !nonnegativeInteger(console.candidateCount) ||
      !Array.isArray(console.candidates) ||
      !Array.isArray(console.unavailableCandidates) ||
      console.unavailableCandidates.length > WINDOWS_OS_MAX_CANDIDATES ||
      !nonnegativeInteger(console.omittedCandidates)
    )
      return null;
    const parsed: PtyOsProcessSample[] = [];
    for (const raw of console.candidates.slice(0, WINDOWS_OS_MAX_CANDIDATES)) {
      const process = parseProcess(raw);
      if (process === null || process.status !== 'captured') return null;
      parsed.push(process.value);
    }
    const unavailableCandidates: Array<{
      reason: (typeof candidateFailureReasons)[number];
      count: number;
    }> = [];
    let failedCount = 0;
    for (const raw of console.unavailableCandidates) {
      const failure = record(raw);
      if (
        failure === null ||
        !member(failure.reason, candidateFailureReasons) ||
        !nonnegativeInteger(failure.count) ||
        failure.count === 0
      )
        return null;
      failedCount += failure.count;
      unavailableCandidates.push({ reason: failure.reason, count: failure.count });
    }
    const countedCandidates = console.candidates.length + failedCount + console.omittedCandidates;
    if (
      !nonnegativeInteger(failedCount) ||
      !nonnegativeInteger(countedCandidates) ||
      countedCandidates !== console.candidateCount
    )
      return null;
    const omittedCandidates =
      console.omittedCandidates +
      Math.max(0, console.candidates.length - WINDOWS_OS_MAX_CANDIDATES);
    if (!nonnegativeInteger(omittedCandidates)) return null;
    candidates = {
      status: 'captured',
      value: {
        association: 'candidate-parent-relation',
        candidateCount: console.candidateCount,
        candidates: parsed,
        unavailableCandidates,
        omittedCandidates,
      },
    };
  }
  return { shell, targets, console: candidates };
}

function sampleMachine(): PtyOsMachineSample | null {
  try {
    const values = cpus();
    const totals = { userMs: 0, systemMs: 0, idleMs: 0, irqMs: 0, niceMs: 0 };
    for (const cpu of values) {
      totals.userMs += cpu.times.user;
      totals.systemMs += cpu.times.sys;
      totals.idleMs += cpu.times.idle;
      totals.irqMs += cpu.times.irq;
      totals.niceMs += cpu.times.nice;
    }
    return { atMs: performance.now(), logicalCpus: values.length, ...totals };
  } catch {
    return null;
  }
}

function boundedMachine(
  first: PtyOsMachineSample | null,
  second: PtyOsMachineSample | null,
): PtyOsObservation['machine'] {
  if (first === null || second === null) return unavailable('access-unavailable');
  const numbers = [
    first.atMs,
    first.logicalCpus,
    first.userMs,
    first.systemMs,
    first.idleMs,
    first.irqMs,
    first.niceMs,
    second.atMs,
    second.logicalCpus,
    second.userMs,
    second.systemMs,
    second.idleMs,
    second.irqMs,
    second.niceMs,
  ];
  return numbers.every(finite) && first.logicalCpus > 0 && second.logicalCpus > 0
    ? { status: 'captured', value: { first, second } }
    : unavailable('invalid-shape');
}

function defaultSpawnQuery(file: string, args: string[]): WindowsQueryHelper {
  return spawn(file, args, { stdio: 'pipe', windowsHide: true, shell: false });
}

export function startWindowsOsState(options: WindowsOsStateOptions): WindowsOsCollection {
  const startedAtMs = performance.now();
  const requestedPid = options.pid;
  const requestedPids = [options.pid, ...(options.additionalPids ?? [])];
  const firstMachine = sampleMachine();
  const parentPid = options.parentPid;
  const allowedBudget = Math.min(
    WINDOWS_OS_MAX_BUDGET_MS,
    options.budgetMs ?? WINDOWS_OS_MAX_BUDGET_MS,
    options.deadlineAt === undefined ? WINDOWS_OS_MAX_BUDGET_MS : options.deadlineAt - startedAtMs,
  );
  let child: WindowsQueryHelper | null = null;
  let closed = false;
  let exited = false;
  let exitCode: number | null = null;
  let terminationReason: TerminationReason | null = null;
  let delivery: PtyOsObservation['helper']['delivery'] = 'not-attempted';
  let exit: PtyOsObservation['helper']['exit'] = 'not-observed';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let rawBytes = 0;
  let stdout = '';
  let ready = false;
  let resultSeen = false;
  let protocolInvalid = false;
  let shellFrame: ReturnType<typeof parseShells> | null = null;
  let shellSeen = false;
  let query: ReturnType<typeof parseQuery> | null = null;
  let queryReason: PtyOsUnavailableReason | null = null;
  let finalObservation: PtyOsObservation | null = null;
  let workerValue: PtyOsObservation['worker'] = unavailable('worker-unavailable');
  const worker = options.worker;
  if (worker !== undefined && worker.threadId > 0) {
    const nodeThreadId = worker.threadId;
    const requestedAtMs = performance.now();
    void Promise.resolve()
      .then(() => worker.cpuUsage())
      .then((cpu) => {
        const repliedAtMs = performance.now();
        if (settled) return;
        if (!finite(cpu.user) || !finite(cpu.system) || !finite(repliedAtMs)) {
          workerValue = unavailable('invalid-shape');
          return;
        }
        workerValue = {
          status: 'captured',
          value: {
            nodeThreadId,
            requestedAtMs,
            repliedAtMs,
            userMs: cpu.user / 1_000,
            systemMs: cpu.system / 1_000,
          },
        };
      })
      .catch(() => {
        if (!settled) workerValue = unavailable('worker-unavailable');
      });
    workerValue = unavailable('worker-request-deadline');
  }
  let resolveResult: (result: PtyOsObservation) => void = () => undefined;
  const result = new Promise<PtyOsObservation>((resolve) => {
    resolveResult = resolve;
  });
  const requestTermination = (reason: TerminationReason): void => {
    if (terminationReason !== null) return;
    terminationReason = reason;
    if (child === null || !positivePid(child.pid)) {
      delivery = 'no-pid';
      return;
    }
    if (exited || closed) {
      delivery = 'already-exited';
      exit = 'observed-before-request';
      return;
    }
    try {
      delivery = child.kill() ? 'accepted' : 'rejected';
    } catch {
      delivery = 'threw';
    }
  };
  const settle = (reason: PtyOsUnavailableReason | null): PtyOsObservation | null => {
    if (settled) return finalObservation;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    if (reason !== null && child !== null && !closed) {
      try {
        child.stdin?.end();
      } catch {}
      try {
        child.stdout?.destroy?.();
      } catch {}
      try {
        child.stderr?.destroy?.();
      } catch {}
      try {
        child.unref?.();
      } catch {}
    }
    const sampled =
      reason === null
        ? query
        : !protocolInvalid && member(reason, shellRetainingReasons)
          ? shellFrame
          : null;
    const shell = sampled?.shell ?? unavailable<PtyOsProcessSample>(reason ?? 'invalid-shape');
    const targets: PtyOsObservation['targets'] =
      sampled?.targets ??
      requestedPids
        .slice(0, WINDOWS_OS_MAX_TARGETS)
        .filter(positivePid)
        .map((pid) => ({ requestedPid: pid, shell: unavailable(reason ?? 'invalid-shape') }));
    const console: PtyOsObservation['console'] =
      reason === null && query !== null ? query.console : unavailable(reason ?? 'invalid-shape');
    const machine = boundedMachine(firstMachine, sampleMachine());
    const completedAtMs = performance.now();
    const status: PtyOsObservation['status'] =
      shell.status === 'captured' &&
      machine.status === 'captured' &&
      console.status === 'captured' &&
      console.value.unavailableCandidates.length === 0 &&
      workerValue.status === 'captured'
        ? 'captured'
        : shell.status === 'captured'
          ? 'partial'
          : 'unavailable';
    const outcomeReason =
      reason ??
      (shell.status === 'unavailable'
        ? shell.reason
        : machine.status === 'unavailable'
          ? machine.reason
          : console.status === 'unavailable'
            ? console.reason
            : console.value.unavailableCandidates[0] !== undefined
              ? console.value.unavailableCandidates[0].reason
              : workerValue.status === 'unavailable'
                ? workerValue.reason
                : null);
    const observation: PtyOsObservation = {
      version: 1,
      status,
      reason: outcomeReason,
      requestedPid: positivePid(requestedPid) ? requestedPid : null,
      targets,
      startedAtMs: finite(startedAtMs) ? startedAtMs : null,
      completedAtMs: finite(completedAtMs) ? completedAtMs : null,
      shell,
      machine,
      console,
      worker: workerValue,
      helper: {
        requested: terminationReason !== null,
        reason: terminationReason,
        delivery,
        exit,
        exitCode,
      },
    };
    if (Buffer.byteLength(JSON.stringify(observation)) > WINDOWS_OS_MAX_RESULT_BYTES) {
      finalObservation = {
        ...observation,
        status: 'unavailable',
        reason: 'output-limit',
        targets: [],
        shell: unavailable('output-limit'),
        console: unavailable('output-limit'),
        worker: unavailable('output-limit'),
      };
      resolveResult(finalObservation);
      return finalObservation;
    }
    finalObservation = observation;
    resolveResult(observation);
    return observation;
  };
  if (
    requestedPids.length > WINDOWS_OS_MAX_TARGETS ||
    requestedPids.some((pid) => !positivePid(pid)) ||
    (parentPid !== undefined && !positivePid(parentPid))
  ) {
    settle('invalid-shape');
    return { result, cancel: () => finalObservation };
  }
  if ((options.platform ?? process.platform) !== 'win32') {
    settle('unsupported-platform');
    return { result, cancel: () => finalObservation };
  }
  if (!finite(allowedBudget) || allowedBudget < 1) {
    settle('no-budget');
    return { result, cancel: () => finalObservation };
  }
  const executable = windowsPowerShellPath();
  const deadlineEpochMs = Date.now() + allowedBudget;
  try {
    child = (options.spawnQuery ?? defaultSpawnQuery)(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      queryFile,
      '-PidValues',
      requestedPids.join(','),
      '-ParentPidValue',
      String(parentPid ?? 0),
      '-DeadlineEpochMs',
      String(Math.floor(deadlineEpochMs)),
      '-DurationCapMs',
      String(Math.floor(allowedBudget)),
    ]);
  } catch {
    settle('query-start-failed');
    return { result, cancel: () => finalObservation };
  }
  const active = child;
  active.on('error', () => {
    if (!settled) settle('query-start-failed');
  });
  const observeExit = (code: number | null): void => {
    exited = true;
    exitCode = nonnegativeInteger(code) ? code : null;
    exit =
      terminationReason === null
        ? code === WINDOWS_OS_HELPER_EXIT.ownerLoss
          ? 'cooperative-owner-loss'
          : code === WINDOWS_OS_HELPER_EXIT.deadline
            ? 'cooperative-deadline'
            : 'observed-before-request'
        : 'observed-after-request';
  };
  active.on('exit', observeExit);
  active.on('close', (code) => {
    closed = true;
    if (!exited) observeExit(code);
    if (!settled) {
      if (stdout.length > 0) queryReason = 'invalid-json';
      settle(
        code === 0
          ? protocolInvalid
            ? 'invalid-shape'
            : (queryReason ?? (query === null ? 'invalid-json' : null))
          : 'query-exited',
      );
    }
  });
  if (!positivePid(active.pid)) {
    settle('query-start-failed');
    return { result, cancel: () => finalObservation };
  }
  const remainingBudget = Math.max(0, allowedBudget - (performance.now() - startedAtMs));
  timer = setTimeout(() => {
    requestTermination('deadline');
    settle('deadline');
  }, remainingBudget);
  const ingest = (chunk: Buffer | string, isStdout: boolean): void => {
    if (settled) return;
    rawBytes += Buffer.byteLength(chunk);
    if (rawBytes > WINDOWS_OS_MAX_RAW_BYTES) {
      requestTermination('output-limit');
      settle('output-limit');
      return;
    }
    if (!isStdout) return;
    stdout += chunk.toString();
    for (;;) {
      const end = stdout.indexOf('\n');
      if (end < 0) break;
      const line = stdout.slice(0, end).replace(/\r$/u, '');
      stdout = stdout.slice(end + 1);
      if (!ready) {
        if (line !== 'READY') {
          protocolInvalid = true;
          queryReason = 'invalid-shape';
          continue;
        }
        ready = true;
        try {
          active.stdin?.write('S\n');
        } catch {
          settle('query-exited');
        }
        continue;
      }
      if (line.startsWith('SHELL ') && !shellSeen && !resultSeen) {
        shellSeen = true;
        try {
          shellFrame = parseShells(JSON.parse(line.slice(6)) as unknown, requestedPids);
        } catch {
          shellFrame = null;
        }
        if (shellFrame === null) {
          protocolInvalid = true;
          queryReason = 'invalid-shape';
        }
        continue;
      }
      if (!line.startsWith('RESULT ') || resultSeen) {
        protocolInvalid = true;
        queryReason = 'invalid-shape';
        continue;
      }
      resultSeen = true;
      try {
        query = parseQuery(JSON.parse(line.slice(7)) as unknown, requestedPids);
        queryReason = query === null || protocolInvalid ? 'invalid-shape' : null;
      } catch {
        queryReason = 'invalid-json';
      }
    }
  };
  active.stdout?.on('data', (chunk) => ingest(chunk, true));
  active.stderr?.on('data', (chunk) => ingest(chunk, false));
  active.stdout?.on('error', () => {
    if (!settled) settle('query-exited');
  });
  active.stderr?.on('error', () => {
    if (!settled) settle('query-exited');
  });
  active.stdin?.on?.('error', () => {
    if (!settled) settle('query-exited');
  });
  return {
    result,
    cancel(reason) {
      if (settled) return finalObservation;
      requestTermination(reason);
      return settle(reason);
    },
  };
}

export async function collectWindowsOsState(
  options: WindowsOsStateOptions,
): Promise<PtyOsObservation> {
  return startWindowsOsState(options).result;
}
