import {
  type PtyHostIncomingMessage,
  type PtyHostOutgoingMessage,
  type SetupPtyHostDeps,
  type SpawnPty,
  setupPtyHost,
} from '../../src/utility/pty-host.ts';

export interface PtyStream {
  read(): string;
  failure(): string | null;
}

export interface PtyHostProbe {
  send(message: PtyHostIncomingMessage): void;
  streamOf(ptyId: string): PtyStream;
  dataOf(ptyId: string): string;
  exitOf(ptyId: string): { exitCode: number | undefined; signal: number | null } | null;
  errorOf(ptyId: string): string | null;
  killActive(): void;
}

export interface PtyHostProbeOptions {
  spawn: SpawnPty;
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  shellExists?: (path: string) => boolean;
  logger?: SetupPtyHostDeps['logger'];
}

export function createPtyHostProbe(options: PtyHostProbeOptions): PtyHostProbe {
  let handler: ((event: { data: unknown }) => void) | null = null;
  const data = new Map<string, string>();
  const exits = new Map<string, { exitCode: number | undefined; signal: number | null }>();
  const errors = new Map<string, string>();
  const handle = setupPtyHost({
    parentPort: {
      on(_event, h) {
        handler = h;
      },
      postMessage(msg: PtyHostOutgoingMessage) {
        if (msg.type === 'data') data.set(msg.ptyId, (data.get(msg.ptyId) ?? '') + msg.data);
        else if (msg.type === 'exit')
          exits.set(msg.ptyId, { exitCode: msg.exitCode, signal: msg.signal });
        else if (msg.type === 'spawn-error')
          errors.set(
            msg.ptyId,
            msg.shellNeverAttached === true
              ? `shell never attached (exit code ${msg.exitCode ?? 'none'})`
              : (msg.message ?? msg.launchFailure),
          );
      },
    },
    spawn: options.spawn,
    env: options.env,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    shellExists: options.shellExists,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const dataOf = (ptyId: string): string => data.get(ptyId) ?? '';
  const exitOf = (ptyId: string): { exitCode: number | undefined; signal: number | null } | null =>
    exits.get(ptyId) ?? null;
  const errorOf = (ptyId: string): string | null => errors.get(ptyId) ?? null;
  return {
    send: (msg) => handler?.({ data: msg }),
    dataOf,
    exitOf,
    errorOf,
    killActive: () => handle.killActive(),
    streamOf: (ptyId) => ({
      read: () => dataOf(ptyId),
      failure: () => {
        const error = errorOf(ptyId);
        if (error !== null) return `spawn-error: ${error}`;
        const exit = exitOf(ptyId);
        if (exit === null) return null;
        return `exited (code ${exit.exitCode ?? 'none'}, signal ${exit.signal ?? 'none'})`;
      },
    }),
  };
}

export interface WaitOptions {
  stallMs?: number;
  intervalMs?: number;
  backstopAt?: number;
}

export interface ShellReadyOptions extends WaitOptions {
  quietSamples?: number;
}

const DEFAULT_INTERVAL_MS = 15;
const DEFAULT_STALL_MS = 8_000;
const DEFAULT_READY_INTERVAL_MS = 50;
const DEFAULT_QUIET_SAMPLES = 20;
const DEFAULT_READY_STALL_MS = 12_000;
const RECEIVED_EXCERPT_CHARS = 400;
const DEFAULT_INPUT_READY_STALL_MS = 16_000;
const BUNDLED_CONPTY_ATTACH_SEQUENCES = [
  '\u001b[1t',
  '\u001b[c',
  '\u001b[?1004h',
  '\u001b[?9001h',
] as const;
const INBOX_CONPTY_ATTACH_SEQUENCES = [
  '\u001b[?9001h',
  '\u001b[?1004h',
  '\u001b[?25l',
  '\u001b[?25h',
  '\u001b[2J',
  '\u001b[m',
  '\u001b[H',
] as const;
const CONPTY_ATTACH_SEQUENCES = [
  ...BUNDLED_CONPTY_ATTACH_SEQUENCES,
  ...INBOX_CONPTY_ATTACH_SEQUENCES,
] as const;
const INBOX_CONPTY_ATTACH_SEQUENCE_SET: ReadonlySet<string> = new Set(
  INBOX_CONPTY_ATTACH_SEQUENCES,
);
const ONLY_THE_BUNDLED_CONPTY_WRITES: ReadonlySet<string> = new Set(
  BUNDLED_CONPTY_ATTACH_SEQUENCES.filter(
    (sequence) => !INBOX_CONPTY_ATTACH_SEQUENCE_SET.has(sequence),
  ),
);
const CONPTY_TITLE_INTRODUCER = '\u001b]0;';
const CONPTY_TITLE_TERMINATORS = ['\u0007', '\u001b\\'] as const;

const HARNESS_BUDGET_MS_BY_TIER = { win32: 85_000, default: 30_000 } as const;
const HARNESS_VERDICT_GRACE_MS_BY_TIER = { win32: 5_000, default: 15_000 } as const;
const HARNESS_TEARDOWN_GRACE_MS = 15_000;
export const HARNESS_VERDICT_POLL_INTERVAL_MS = 25;
export const HARNESS_CHILD_KILL_WAIT_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function requireDuration(value: number, what: string, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${what} for ${label} must be a positive finite duration in milliseconds, got ${String(value)}`,
    );
  }
  return value;
}

function describeReceived(text: string): string {
  if (text.length === 0) return 'nothing';
  const tail = text.length > RECEIVED_EXCERPT_CHARS ? text.slice(-RECEIVED_EXCERPT_CHARS) : text;
  return `${text.length > RECEIVED_EXCERPT_CHARS ? '...' : ''}${JSON.stringify(tail)}`;
}

function describeLeading(text: string): string {
  if (text.length === 0) return 'nothing';
  if (text.length <= RECEIVED_EXCERPT_CHARS) return JSON.stringify(text);
  return `${JSON.stringify(text.slice(0, RECEIVED_EXCERPT_CHARS))}...`;
}

export async function waitForCondition(
  stream: PtyStream,
  predicate: () => boolean,
  label: string,
  options: WaitOptions = {},
): Promise<void> {
  const intervalMs = requireDuration(
    options.intervalMs ?? DEFAULT_INTERVAL_MS,
    'the poll interval',
    label,
  );
  const stallMs = requireDuration(options.stallMs ?? DEFAULT_STALL_MS, 'the stall window', label);
  const startedAt = performance.now();
  const backstopAt = options.backstopAt ?? startedAt + stallMs;
  if (!Number.isFinite(backstopAt)) {
    throw new Error(
      `the backstop for ${label} must be a finite monotonic-clock reading, got ${String(options.backstopAt)}`,
    );
  }
  if (predicate()) return;
  const containmentMs =
    options.backstopAt === undefined
      ? stallMs
      : remainingGrantMs(backstopAt, label, { minimumMs: intervalMs, now: () => startedAt });
  const stallWindowMs = Math.min(stallMs, containmentMs);
  const cutNote =
    Math.round(stallWindowMs) < Math.round(stallMs)
      ? ` (the containment it runs inside cut the ${Math.round(stallMs)}ms it declared)`
      : '';
  let leadingAttachChars: number | null = null;
  const shellChars = (): number => {
    const text = stream.read();
    if (leadingAttachChars === null) {
      const beyondAttach = shellOutputBeyondAttach(text);
      if (beyondAttach.length === 0) return 0;
      leadingAttachChars = text.length - beyondAttach.length;
    }
    return text.length - leadingAttachChars;
  };
  let advanced = shellChars();
  let lastAdvanceAt = startedAt;
  for (;;) {
    const failure = stream.failure();
    if (failure !== null) {
      throw new Error(
        `shell failed before ${label}: ${failure} (after ${Math.round(performance.now() - startedAt)}ms, received ${describeReceived(stream.read())})`,
      );
    }
    const now = performance.now();
    const seen = shellChars();
    if (seen !== advanced) {
      advanced = seen;
      lastAdvanceAt = now;
    }
    if (now - lastAdvanceAt >= stallWindowMs) {
      throw new Error(
        `timeout waiting for: ${label} after ${Math.round(stallWindowMs)}ms${cutNote} without ${advanced === 0 ? 'any' : 'new'} shell output, the only progress signal this wait watches (received ${describeReceived(stream.read())})`,
      );
    }
    if (now >= backstopAt) {
      throw new Error(
        `${label} was not reached inside its ${Math.round(containmentMs)}ms containment; the stream last advanced ${Math.round(now - lastAdvanceAt)}ms ago, ${advanced} characters past the shell's first output (received ${describeReceived(stream.read())})`,
      );
    }
    await sleep(intervalMs);
    if (predicate()) return;
  }
}

export async function waitForShellReady(
  stream: PtyStream,
  label: string,
  options: ShellReadyOptions = {},
): Promise<void> {
  const quietSamples = options.quietSamples ?? DEFAULT_QUIET_SAMPLES;
  const intervalMs = requireDuration(
    options.intervalMs ?? DEFAULT_READY_INTERVAL_MS,
    'the poll interval',
    label,
  );
  const stallMs = requireDuration(
    options.stallMs ?? DEFAULT_READY_STALL_MS,
    'the stall window',
    label,
  );
  const quietWindowMs = quietSamples * intervalMs;
  if (!(stallMs > quietWindowMs)) {
    throw new Error(
      `the stall window for ${label} must outlast the ${quietWindowMs}ms of quiet it counts as ready, got ${stallMs}ms`,
    );
  }
  if (options.backstopAt !== undefined && Number.isFinite(options.backstopAt)) {
    const containmentMs = options.backstopAt - performance.now();
    if (!(containmentMs > quietWindowMs)) {
      throw new HarnessBudgetRefusal(
        `the grant for ${label} was spent before the wait could count ${quietSamples} quiet polls: ${Math.round(containmentMs)}ms left does not outlast the ${quietWindowMs}ms they take`,
      );
    }
  }
  let previous: string | null = null;
  let stable = 0;
  await waitForCondition(
    stream,
    () => {
      const current = stream.read();
      stable = current.length > 0 && current === previous ? stable + 1 : 0;
      previous = current;
      return stable >= quietSamples;
    },
    label,
    {
      stallMs,
      intervalMs,
      ...(options.backstopAt === undefined ? {} : { backstopAt: options.backstopAt }),
    },
  );
}

export interface EvaluatedInputProbe {
  input: string;
  marker: string;
}

export interface EvaluatedInputOptions extends Omit<WaitOptions, 'stallMs' | 'backstopAt'> {
  budgetMs: number;
  roundTripStallMs?: number;
}

export interface EvaluatedInputTiming {
  firstOutputMs: number;
  firstOutput: string;
  roundTripMs: number;
}

export interface HarnessTimeouts {
  budgetMs: number;
  verdictDeadlineMs: number;
  testTimeoutMs: number;
}

export function harnessTimeouts(platform: NodeJS.Platform): HarnessTimeouts {
  const tier = platform === 'win32' ? 'win32' : 'default';
  const budgetMs = HARNESS_BUDGET_MS_BY_TIER[tier];
  const verdictDeadlineMs = budgetMs + HARNESS_VERDICT_GRACE_MS_BY_TIER[tier];
  return {
    budgetMs,
    verdictDeadlineMs,
    testTimeoutMs: verdictDeadlineMs + HARNESS_TEARDOWN_GRACE_MS,
  };
}

export interface HarnessBudget {
  grantMs(before: string): number;
}

export class HarnessBudgetRefusal extends Error {
  override readonly name = 'HarnessBudgetRefusal';
}

export function createHarnessBudget(
  budgetMs: number,
  reserveMs: number,
  now: () => number = () => performance.now(),
): HarnessBudget {
  requireDuration(budgetMs, 'the budget', 'the harness');
  requireDuration(reserveMs, 'the report reserve', 'the harness');
  const startedAt = now();
  const remainingMs = (): number => budgetMs - (now() - startedAt);
  return {
    grantMs: (before) => {
      const granted = Math.min(remainingMs() - reserveMs, remainingMs() / 2);
      if (granted <= 0) {
        throw new HarnessBudgetRefusal(
          `the ${budgetMs}ms harness budget was spent before ${before}`,
        );
      }
      return granted;
    },
  };
}

export function remainingGrantMs(
  deadlineAt: number,
  before: string,
  options: { minimumMs?: number; now?: () => number } = {},
): number {
  const minimumMs = options.minimumMs ?? DEFAULT_INTERVAL_MS;
  const remainingMs = deadlineAt - (options.now ?? (() => performance.now()))();
  if (!(remainingMs >= minimumMs)) {
    throw new HarnessBudgetRefusal(
      `the grant for ${before} was spent before the wait could poll once: ${String(Math.round(remainingMs))}ms left of the ${Math.round(minimumMs)}ms one poll takes`,
    );
  }
  return remainingMs;
}

export function resolveHarnessBudgetMs(raw: string | undefined, defaultMs: number): number {
  if (raw === undefined || raw === '') return defaultMs;
  const override = requireDuration(
    Number(raw),
    'the OK_PTY_HARNESS_BUDGET_MS override',
    'the harness budget',
  );
  return Math.min(override, defaultMs);
}

type AttachMatch =
  | { kind: 'attach'; length: number }
  | { kind: 'cut-mid-attach' }
  | { kind: 'shell' };

function conptyTitleMatch(text: string): AttachMatch {
  if (CONPTY_TITLE_INTRODUCER.startsWith(text)) return { kind: 'cut-mid-attach' };
  if (!text.startsWith(CONPTY_TITLE_INTRODUCER)) return { kind: 'shell' };
  for (let at = CONPTY_TITLE_INTRODUCER.length; at < text.length; at += 1) {
    const terminator = CONPTY_TITLE_TERMINATORS.find((candidate) => text.startsWith(candidate, at));
    if (terminator !== undefined) return { kind: 'attach', length: at + terminator.length };
    const char = text[at] as string;
    if (char < '\u0020' && char !== '\u001b') return { kind: 'attach', length: at };
  }
  return { kind: 'cut-mid-attach' };
}

function attachMatch(text: string, host: { paintsTitles: boolean }): AttachMatch {
  const sequence = CONPTY_ATTACH_SEQUENCES.find((candidate) => text.startsWith(candidate));
  if (sequence !== undefined) return { kind: 'attach', length: sequence.length };
  if (CONPTY_ATTACH_SEQUENCES.some((candidate) => candidate.startsWith(text)) && text.length > 0) {
    return { kind: 'cut-mid-attach' };
  }
  return host.paintsTitles ? conptyTitleMatch(text) : { kind: 'shell' };
}

export function shellOutputBeyondAttach(text: string): string {
  let rest = text;
  let bundledConptyAttached = false;
  for (;;) {
    const match = attachMatch(rest, { paintsTitles: !bundledConptyAttached });
    if (match.kind === 'attach') {
      bundledConptyAttached ||= ONLY_THE_BUNDLED_CONPTY_WRITES.has(rest.slice(0, match.length));
      rest = rest.slice(match.length);
      continue;
    }
    return match.kind === 'cut-mid-attach' ? '' : rest;
  }
}

async function waitForShellFirstOutput(
  stream: PtyStream,
  label: string,
  options: { timeoutMs: number; intervalMs?: number },
): Promise<{ firstOutputMs: number; firstOutput: string }> {
  const startedAt = performance.now();
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = startedAt + options.timeoutMs;
  for (;;) {
    const beyondAttach = shellOutputBeyondAttach(stream.read());
    if (beyondAttach.length > 0) {
      return {
        firstOutputMs: performance.now() - startedAt,
        firstOutput: describeLeading(beyondAttach),
      };
    }
    const failure = stream.failure();
    if (failure !== null) {
      throw new Error(
        `shell died before producing output for ${label}, probe unwritten: ${failure} (after ${Math.round(performance.now() - startedAt)}ms, received ${describeReceived(stream.read())})`,
      );
    }
    if (performance.now() >= deadline) {
      throw new Error(
        `shell never produced output before ${label} within ${Math.round(options.timeoutMs)}ms (received ${describeReceived(stream.read())})`,
      );
    }
    await sleep(intervalMs);
  }
}

export async function waitForEvaluatedInput(
  stream: PtyStream,
  send: (data: string) => void,
  probe: EvaluatedInputProbe,
  label: string,
  options: EvaluatedInputOptions,
): Promise<EvaluatedInputTiming> {
  if (probe.input.includes(probe.marker)) {
    throw new Error(`readiness probe input must not contain its marker: ${probe.marker}`);
  }
  const budgetMs = requireDuration(options.budgetMs, 'the budget', label);
  const roundTripStallMs = requireDuration(
    options.roundTripStallMs ?? DEFAULT_INPUT_READY_STALL_MS,
    'the round-trip stall window',
    label,
  );
  const interval = options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs };
  const { firstOutputMs, firstOutput } = await waitForShellFirstOutput(stream, label, {
    timeoutMs: budgetMs,
    ...interval,
  });
  const remainingMs = budgetMs - firstOutputMs;
  if (remainingMs <= 0) {
    throw new HarnessBudgetRefusal(
      `the ${Math.round(budgetMs)}ms grant for ${label} was spent before the round trip could start: first output after ${Math.round(firstOutputMs)}ms left nothing`,
    );
  }
  const startedAt = performance.now();
  send(probe.input);
  await waitForCondition(stream, () => stream.read().includes(probe.marker), label, {
    stallMs: roundTripStallMs,
    backstopAt: startedAt + remainingMs,
    ...interval,
  });
  return { firstOutputMs, firstOutput, roundTripMs: performance.now() - startedAt };
}

export function buildCwdFileProofCommand(platform: NodeJS.Platform, fileName: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(fileName) || fileName === '.' || fileName === '..') {
    throw new Error(`invalid cwd proof file name: ${fileName}`);
  }
  if (platform === 'win32') {
    return `Write-Output "CWD_PROOF=$(Get-Content -Raw -LiteralPath './${fileName}')"`;
  }
  return `printf 'CWD_PROOF=%s\\n' "$(cat './${fileName}')"`;
}
