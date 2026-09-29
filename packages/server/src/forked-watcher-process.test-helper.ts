import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waitWithinTestBudget } from './wait-within-test-budget.test-helper.ts';

export type WatcherEntry = 'managed' | 'config' | 'multi-config';

export type ReadinessScenario = 'create' | 'edit';

export type MutationTiming =
  | 'as-start-resolves'
  | 'while-first-baseline-stat-held'
  | 'after-first-baseline-stat';

export interface ReadinessSpec {
  mode: 'readiness';
  entry: WatcherEntry;
  watch: string[];
  scenario: ReadinessScenario;
  timing: MutationTiming;
  target: string;
  held: string;
  content: string;
  barrier: string;
}

export interface ContractSpec {
  mode: 'contract';
  entry: WatcherEntry;
  watch: string[];
  coarseTimestampsAt?: string;
}

export type WatcherProcessSpec = ReadinessSpec | ContractSpec;

export type Recovery = 'readable' | 'removed' | 'replaced-by-file';

export type ContractCommand =
  | { op: 'write-in-two-steps'; path: string; partial: string; complete: string }
  | { op: 'unreadable-until-sampled'; dir: string; leaf: string }
  | { op: 'close-while-sampling'; path: string; content: string }
  | { op: 'hold-next-sample'; path: string; content: string; barrier: string }
  | { op: 'unreadable-across-polls'; dir: string; path: string }
  | {
      op: 'unreadable-again-after-recovery';
      dir: string;
      failingAt: string;
      sampledEveryPoll: string;
      recovery: Recovery;
      aside: string;
    }
  | { op: 'error-code-changes-while-failing'; dir: string; failingAt: string; aside: string }
  | { op: 'close-between-polls'; path: string }
  | { op: 'close-while-sample-held'; path: string; dir: string; barrier: string }
  | { op: 'rewrite-in-place'; path: string; content: string }
  | {
      op: 'two-step-write-across-interruption';
      path: string;
      dir: string;
      partial: string;
      complete: string;
      interruption: 'unreadable' | 'removed';
    };

export type WatcherEvent =
  | { kind: 'change'; path: string; content: string }
  | { kind: 'unlink'; path: string };

export interface LoggedError {
  level: string;
  code: string;
  path: string;
  message: string;
}

export type WatcherProcessReport =
  | WatcherEvent
  | {
      kind: 'started';
      barrierEngaged: boolean;
      firstBaselineStatHeldAtResolve: boolean;
      startupTimers: number;
    }
  | {
      kind: 'mutated';
      barrierEngaged: boolean;
      firstBaselineStatHeldAtResolve: boolean;
      firstBaselineStatHeldAtMutation: boolean;
      startupTimersWaitedOut: number;
    }
  | { kind: 'settled'; startupTimers: number }
  | { kind: 'partial-written'; atStartupTimerTick: boolean }
  | { kind: 'partial-sampled' }
  | { kind: 'completed' }
  | { kind: 'unreadable' }
  | { kind: 'readable-again' }
  | { kind: 'closing' }
  | { kind: 'closed' }
  | { kind: 'quiesced'; eventsAfterClose: WatcherEvent[] }
  | { kind: 'sample-held' }
  | { kind: 'overlap-checked'; samplesBegunWhileHeld: number; timersWaitedOut: number }
  | { kind: 'error-reports'; onceEstablished: LoggedError[]; afterAnotherPoll: LoggedError[] }
  | { kind: 'removed' }
  | {
      kind: 'error-reports-across-recovery';
      firstEpisode: LoggedError[];
      afterRecovery: LoggedError[];
    }
  | {
      kind: 'error-reports-across-code-change';
      beforeChange: LoggedError[];
      afterChange: LoggedError[];
      whileItPersists: LoggedError[];
    }
  | { kind: 'idle-after-close'; samplesAfterClose: number }
  | {
      kind: 'idle-after-held-close';
      resolvedWhileHeld: boolean;
      eventsAfterClose: WatcherEvent[];
      loggedAfterClose: LoggedError[];
    }
  | { kind: 'interrupted' }
  | { kind: 'restored' }
  | { kind: 'rewritten-in-place'; statUnchanged: boolean };

type ReportKind = WatcherProcessReport['kind'];

type FieldType = 'string' | 'boolean' | 'number' | 'events' | 'logged';

type FieldTypeOf<Value> = Value extends string
  ? 'string'
  : Value extends boolean
    ? 'boolean'
    : Value extends number
      ? 'number'
      : Value extends WatcherEvent[]
        ? 'events'
        : Value extends LoggedError[]
          ? 'logged'
          : never;

type FieldTypes<Shape> = {
  [Field in Exclude<keyof Shape, 'kind'>]-?: FieldTypeOf<Shape[Field]>;
};

const REPORT_FIELDS: {
  [Kind in ReportKind]: FieldTypes<Extract<WatcherProcessReport, { kind: Kind }>>;
} = {
  change: { path: 'string', content: 'string' },
  unlink: { path: 'string' },
  started: {
    barrierEngaged: 'boolean',
    firstBaselineStatHeldAtResolve: 'boolean',
    startupTimers: 'number',
  },
  mutated: {
    barrierEngaged: 'boolean',
    firstBaselineStatHeldAtResolve: 'boolean',
    firstBaselineStatHeldAtMutation: 'boolean',
    startupTimersWaitedOut: 'number',
  },
  settled: { startupTimers: 'number' },
  'partial-written': { atStartupTimerTick: 'boolean' },
  'partial-sampled': {},
  completed: {},
  unreadable: {},
  'readable-again': {},
  closing: {},
  closed: {},
  quiesced: { eventsAfterClose: 'events' },
  'sample-held': {},
  'overlap-checked': { samplesBegunWhileHeld: 'number', timersWaitedOut: 'number' },
  'error-reports': { onceEstablished: 'logged', afterAnotherPoll: 'logged' },
  removed: {},
  'error-reports-across-recovery': { firstEpisode: 'logged', afterRecovery: 'logged' },
  'error-reports-across-code-change': {
    beforeChange: 'logged',
    afterChange: 'logged',
    whileItPersists: 'logged',
  },
  'idle-after-close': { samplesAfterClose: 'number' },
  'idle-after-held-close': {
    resolvedWhileHeld: 'boolean',
    eventsAfterClose: 'events',
    loggedAfterClose: 'logged',
  },
  interrupted: {},
  restored: {},
  'rewritten-in-place': { statUnchanged: 'boolean' },
};

function isReportKind(kind: unknown): kind is ReportKind {
  return typeof kind === 'string' && Object.hasOwn(REPORT_FIELDS, kind);
}

const LOGGED_ERROR_FIELDS: FieldTypes<LoggedError> = {
  level: 'string',
  code: 'string',
  path: 'string',
  message: 'string',
};

function isLoggedError(value: unknown): value is LoggedError {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return Object.entries(LOGGED_ERROR_FIELDS).every(([field, type]) => typeof entry[field] === type);
}

function isWatcherProcessReport(value: unknown): value is WatcherProcessReport {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as Record<string, unknown>;
  if (!isReportKind(report.kind)) return false;
  const fields: Readonly<Record<string, FieldType>> = REPORT_FIELDS[report.kind];
  return Object.entries(fields).every(([field, type]) => {
    const fieldValue = report[field];
    if (type === 'events') return Array.isArray(fieldValue) && fieldValue.every(isWatcherEvent);
    if (type === 'logged') return Array.isArray(fieldValue) && fieldValue.every(isLoggedError);
    return typeof fieldValue === type;
  });
}

function isWatcherEvent(value: unknown): value is WatcherEvent {
  return isWatcherProcessReport(value) && (value.kind === 'change' || value.kind === 'unlink');
}

export function reportOf<Kind extends ReportKind>(
  reports: readonly WatcherProcessReport[],
  kind: Kind,
): Extract<WatcherProcessReport, { kind: Kind }> | undefined {
  return reports.find(
    (report): report is Extract<WatcherProcessReport, { kind: Kind }> => report.kind === kind,
  );
}

export function deliveriesFor(reports: readonly WatcherProcessReport[], path: string): string[] {
  return reports.flatMap((report) =>
    report.kind === 'change' && report.path === path ? [report.content] : [],
  );
}

export function delivered(
  reports: readonly WatcherProcessReport[],
  path: string,
  content: string,
): boolean {
  return deliveriesFor(reports, path).includes(content);
}

export function unlinked(reports: readonly WatcherProcessReport[], path: string): boolean {
  return reports.some((report) => report.kind === 'unlink' && report.path === path);
}

interface WatcherProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ForkedWatcherProcess {
  reports(): readonly WatcherProcessReport[];
  exitStatus(): WatcherProcessExit | undefined;
  until(
    what: string,
    condition: (reports: readonly WatcherProcessReport[]) => boolean,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface ForkedContractProcess extends ForkedWatcherProcess {
  send(command: ContractCommand): void;
}

const WATCHER_PROCESS = fileURLToPath(new URL('./watcher-process.test-helper.ts', import.meta.url));

const BOUNDED_BY_THE_TEST_BUDGET = { timeoutMs: Number.POSITIVE_INFINITY };

export function forkWatcherProcess(spec: ContractSpec): ForkedContractProcess;
export function forkWatcherProcess(spec: ReadinessSpec): ForkedWatcherProcess;
export function forkWatcherProcess(spec: WatcherProcessSpec): ForkedContractProcess {
  const child = fork(WATCHER_PROCESS, [JSON.stringify(spec)], {
    execArgv: ['--import', 'tsx', '--conditions=@inkeep/source'],
    silent: true,
    env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
  });
  const reports: WatcherProcessReport[] = [];
  let stderr = '';
  let protocolError: string | undefined;
  let exitStatus: WatcherProcessExit | undefined;
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdout?.resume();
  child.on('message', (message) => {
    if (isWatcherProcessReport(message)) reports.push(message);
    else protocolError ??= `sent an unrecognized message ${JSON.stringify(message)}`;
  });
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', (code, signal) => {
      exitStatus = { code, signal };
      resolveExit();
    });
    child.once('error', (error) => {
      protocolError ??= `failed: ${error.message}`;
      exitStatus ??= { code: null, signal: null };
      resolveExit();
    });
  });
  return {
    reports: () => reports,
    exitStatus: () => exitStatus,
    until: (what, condition) =>
      waitWithinTestBudget(
        what,
        () => {
          if (protocolError !== undefined) {
            throw new Error(`the watcher process ${protocolError}; stderr: ${stderr}`);
          }
          if (condition(reports)) return true;
          if (exitStatus !== undefined) {
            throw new Error(
              `the watcher process exited (code ${exitStatus.code}, signal ${exitStatus.signal}) before the wait was met; stderr: ${stderr}`,
            );
          }
          return false;
        },
        BOUNDED_BY_THE_TEST_BUDGET,
      ),
    send: (command) => {
      child.send(command);
    },
    close: async () => {
      if (child.connected) child.disconnect();
      await exited;
    },
  };
}
