import { type SpawnOptions, spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type PtyHostIncomingMessage,
  type PtyHostOutgoingMessage,
  type SetupPtyHostDeps,
  type SpawnPty,
  setupPtyHost,
} from '../../src/utility/pty-host.ts';
import { createWindowsPtyStartupCoordinator } from './pty-startup-trace.test-helper.ts';
import { harnessScenarioTitles } from './real-io-harness-roster.test-helper.ts';
import {
  WINDOWS_OS_MAX_BUDGET_MS,
  type WindowsOsStateOptions,
} from './windows-os-state.test-helper.ts';

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
  snapshotStartup(): void;
  captureFailure(): Promise<void>;
  cancelCapture(): void;
  killActive(): void;
}

export interface PtyHostProbeOptions {
  spawn: SpawnPty;
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  shellExists?: (path: string) => boolean;
  logger?: SetupPtyHostDeps['logger'];
  startupTrace?:
    | (NonNullable<SetupPtyHostDeps['startupTrace']> & { native?: never })
    | { native: boolean; aroundSpawn?: never };
  osCaptureDeadlineAt?: () => number;
  spawnQuery?: WindowsOsStateOptions['spawnQuery'];
}

export function createPtyHostProbe(options: PtyHostProbeOptions): PtyHostProbe {
  let handler: ((event: { data: unknown }) => void) | null = null;
  const data = new Map<string, string>();
  const exits = new Map<string, { exitCode: number | undefined; signal: number | null }>();
  const errors = new Map<string, string>();
  const coordinator = options.startupTrace?.native
    ? createWindowsPtyStartupCoordinator({
        platform: options.platform ?? process.platform,
        deadlineAt:
          options.osCaptureDeadlineAt ?? (() => performance.now() + WINDOWS_OS_MAX_BUDGET_MS),
        ...(options.spawnQuery === undefined ? {} : { spawnQuery: options.spawnQuery }),
      })
    : null;
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
    startupTrace: coordinator?.trace ?? options.startupTrace,
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
    snapshotStartup: () => handle.snapshotStartup?.(),
    captureFailure: async () => {
      await coordinator?.captureFailure();
    },
    cancelCapture: () => coordinator?.cancelCapture(),
    killActive: () => handle.killActive(),
    streamOf: (ptyId) => ({
      read: () => dataOf(ptyId),
      failure: () => {
        const error = errorOf(ptyId);
        if (error !== null) return `spawn-error: ${error}`;
        const exit = exitOf(ptyId);
        if (exit === null) return null;
        return describeExit(exit);
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

export interface HarnessReadinessObserver {
  waitForCondition(
    predicate: () => boolean,
    label: string,
    options?: Omit<WaitOptions, 'backstopAt'>,
  ): Promise<void>;
  waitForCompletion(
    predicate: () => boolean,
    label: string,
    options?: Omit<WaitOptions, 'backstopAt'>,
  ): Promise<HarnessCompletion>;
  waitForShellReady(label: string, options?: Omit<ShellReadyOptions, 'backstopAt'>): Promise<void>;
  waitForEvaluatedInput(
    send: (data: string) => void,
    probe: EvaluatedInputProbe,
    label: string,
    options?: Omit<EvaluatedInputOptions, 'budgetMs'>,
  ): Promise<EvaluatedInputTiming>;
}

export interface HarnessCompletion {
  readonly observedAt: number;
}

export interface HarnessCompletionBounds {
  readonly after: HarnessCompletion;
  readonly initialDeadlineAt: number;
  readonly reportDeadlineAt: number;
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
export const HARNESS_REPORT_RESERVE_MS = 1_000;
export const HARNESS_WINDOWS_LAUNCH_STALL_MS = 20_000;
export const HARNESS_EXIT_AFTER_KILL_STALL_MS = 12_000;

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

function describeExit(exit: { exitCode: number | undefined; signal: number | null }): string {
  return `exited (code ${exit.exitCode ?? 'none'}, signal ${exit.signal ?? 'none'})`;
}

interface ShellOutputObservation {
  advanced: number;
  lastAdvanceAt: number | null;
  observe(stream: PtyStream, now: number): void;
}

function createShellOutputObservation(): ShellOutputObservation {
  let leadingAttachChars: number | null = null;
  return {
    advanced: 0,
    lastAdvanceAt: null,
    observe(stream, now) {
      const text = stream.read();
      if (leadingAttachChars === null) {
        const beyondAttach = shellOutputBeyondAttach(text);
        if (beyondAttach.length === 0) return;
        leadingAttachChars = text.length - beyondAttach.length;
      }
      const seen = text.length - leadingAttachChars;
      if (seen > this.advanced) {
        this.advanced = seen;
        this.lastAdvanceAt = now;
      }
    },
  };
}

interface ReadinessState {
  initialDeadline: WaitDeadline;
  reportDeadlineAt: number;
  output: ShellOutputObservation;
}

interface WaitDeadline {
  at: number;
  bound: string;
}

function cappedByReportDeadline(phase: WaitDeadline, reportDeadlineAt: number): WaitDeadline {
  return reportDeadlineAt <= phase.at
    ? { at: reportDeadlineAt, bound: 'the report deadline' }
    : phase;
}

function readinessDeadline(readiness: ReadinessState, stallMs: number): WaitDeadline {
  const { lastAdvanceAt } = readiness.output;
  const stallEndsAt = lastAdvanceAt === null ? null : lastAdvanceAt + stallMs;
  return cappedByReportDeadline(
    stallEndsAt !== null && stallEndsAt > readiness.initialDeadline.at
      ? { at: stallEndsAt, bound: `its ${Math.round(stallMs)}ms stall window ran out` }
      : readiness.initialDeadline,
    readiness.reportDeadlineAt,
  );
}

function harnessExitDeadline(bounds: HarnessCompletionBounds): WaitDeadline {
  const windowEndsAt = bounds.after.observedAt + HARNESS_EXIT_AFTER_KILL_STALL_MS;
  return cappedByReportDeadline(
    bounds.initialDeadlineAt > windowEndsAt
      ? { at: bounds.initialDeadlineAt, bound: 'its initial allowance ended' }
      : { at: windowEndsAt, bound: `its ${HARNESS_EXIT_AFTER_KILL_STALL_MS}ms exit window ended` },
    bounds.reportDeadlineAt,
  );
}

function throwIfShellFailed(stream: PtyStream, label: string, startedAt: number): void {
  const failure = stream.failure();
  if (failure !== null) {
    throw new Error(
      `shell failed before ${label}: ${failure} (after ${Math.round(performance.now() - startedAt)}ms, received ${describeReceived(stream.read())})`,
    );
  }
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
  const declaredWindowSpansContainment = stallWindowMs >= containmentMs;
  const cutNote =
    Math.round(stallWindowMs) < Math.round(stallMs)
      ? ` (the containment it runs inside cut the ${Math.round(stallMs)}ms it declared)`
      : '';
  const output = createShellOutputObservation();
  output.observe(stream, startedAt);
  let lastAdvanceAt = output.lastAdvanceAt ?? startedAt;
  for (;;) {
    throwIfShellFailed(stream, label, startedAt);
    const now = performance.now();
    output.observe(stream, now);
    lastAdvanceAt = output.lastAdvanceAt ?? lastAdvanceAt;
    if (now >= backstopAt) {
      const silentPastWindow = now - lastAdvanceAt >= stallWindowMs;
      if (declaredWindowSpansContainment && silentPastWindow) {
        throw new Error(
          `timeout waiting for: ${label} after ${Math.round(stallWindowMs)}ms${cutNote} without ${output.advanced === 0 ? 'any' : 'new'} shell output, the only progress signal this wait watches (received ${describeReceived(stream.read())})`,
        );
      }
      const stallNote = silentPastWindow
        ? `, longer than its ${Math.round(stallWindowMs)}ms stall window`
        : '';
      throw new Error(
        output.advanced === 0
          ? `${label} was not reached inside its ${Math.round(containmentMs)}ms containment without any shell output (received ${describeReceived(stream.read())})`
          : `${label} was not reached inside its ${Math.round(containmentMs)}ms containment; the stream last advanced ${Math.round(now - lastAdvanceAt)}ms ago${stallNote}, ${output.advanced} characters counted from the shell's first output on (received ${describeReceived(stream.read())})`,
      );
    }
    await sleep(intervalMs);
    if (predicate()) return;
  }
}

async function waitForReadinessCondition(
  stream: PtyStream,
  predicate: () => boolean,
  label: string,
  readiness: ReadinessState,
  options: Omit<WaitOptions, 'backstopAt'>,
): Promise<HarnessCompletion> {
  const intervalMs = requireDuration(
    options.intervalMs ?? DEFAULT_INTERVAL_MS,
    'the poll interval',
    label,
  );
  const stallMs = requireDuration(options.stallMs ?? DEFAULT_STALL_MS, 'the stall window', label);
  const startedAt = performance.now();
  const { output } = readiness;
  for (;;) {
    throwIfShellFailed(stream, label, startedAt);
    const now = performance.now();
    output.observe(stream, now);
    const deadline = readinessDeadline(readiness, stallMs);
    if (now >= deadline.at) {
      throw new Error(
        output.lastAdvanceAt === null
          ? `${label} was not reached before ${deadline.bound}, without any shell output (received ${describeReceived(stream.read())})`
          : `${label} was not reached before ${deadline.bound}; the stream last advanced ${Math.round(now - output.lastAdvanceAt)}ms ago, ${output.advanced} characters counted from the shell's first output on (received ${describeReceived(stream.read())})`,
      );
    }
    if (predicate()) return { observedAt: now };
    await sleep(intervalMs);
  }
}

export async function waitForHarnessExit(
  stream: PtyStream,
  exitOf: () => { exitCode: number | undefined; signal: number | null } | null,
  label: string,
  bounds: HarnessCompletionBounds,
): Promise<HarnessCompletion> {
  const deadline = harnessExitDeadline(bounds);
  const startedAt = performance.now();
  for (;;) {
    const now = performance.now();
    if (now >= deadline.at) {
      const exit = exitOf();
      const elapsedMs = Math.round(now - bounds.after.observedAt);
      throw new Error(
        exit === null
          ? `${label} was not reached before ${deadline.bound}: no exit observed (${elapsedMs}ms after the completion it follows, received ${describeReceived(stream.read())})`
          : `${label} was not reached before ${deadline.bound}: the exit (${describeExit(exit)}) was observed only after that bound (${elapsedMs}ms after the completion it follows, received ${describeReceived(stream.read())})`,
      );
    }
    if (exitOf() !== null) return { observedAt: now };
    throwIfShellFailed(stream, label, startedAt);
    await sleep(DEFAULT_INTERVAL_MS);
  }
}

export function createHarnessReadinessAfterCompletion(
  stream: PtyStream,
  bounds: HarnessCompletionBounds,
): HarnessReadinessObserver {
  const windowEndsAt = bounds.after.observedAt + DEFAULT_STALL_MS;
  const initialDeadline = cappedByReportDeadline(
    bounds.initialDeadlineAt > windowEndsAt
      ? { at: bounds.initialDeadlineAt, bound: 'its initial allowance ended' }
      : { at: windowEndsAt, bound: `its ${DEFAULT_STALL_MS}ms first-output window ended` },
    bounds.reportDeadlineAt,
  );
  return createReadinessObserver(stream, initialDeadline, bounds.reportDeadlineAt);
}

interface QuietShellWait {
  quietSamples: number;
  quietWindowMs: number;
  pacing: { stallMs: number; intervalMs: number };
  isQuiet: () => boolean;
}

function quietShellWait(
  stream: PtyStream,
  label: string,
  options: Omit<ShellReadyOptions, 'backstopAt'>,
): QuietShellWait {
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
  let previous: string | null = null;
  let stable = 0;
  return {
    quietSamples,
    quietWindowMs,
    pacing: { stallMs, intervalMs },
    isQuiet: () => {
      const current = stream.read();
      stable = current.length > 0 && current === previous ? stable + 1 : 0;
      previous = current;
      return stable >= quietSamples;
    },
  };
}

export async function waitForShellReady(
  stream: PtyStream,
  label: string,
  options: ShellReadyOptions = {},
): Promise<void> {
  const { quietSamples, quietWindowMs, pacing, isQuiet } = quietShellWait(stream, label, options);
  if (options.backstopAt !== undefined && Number.isFinite(options.backstopAt)) {
    const containmentMs = options.backstopAt - performance.now();
    if (!(containmentMs > quietWindowMs)) {
      throw new HarnessBudgetRefusal(
        `the grant for ${label} was spent before the wait could count ${quietSamples} quiet polls: ${Math.round(containmentMs)}ms left does not outlast the ${quietWindowMs}ms they take`,
      );
    }
  }
  await waitForCondition(stream, isQuiet, label, {
    ...pacing,
    ...(options.backstopAt === undefined ? {} : { backstopAt: options.backstopAt }),
  });
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
  readonly reportDeadlineAt: number;
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
    reportDeadlineAt: startedAt + budgetMs - reserveMs,
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

async function runEvaluatedInputProbe(
  stream: PtyStream,
  send: (data: string) => void,
  probe: EvaluatedInputProbe,
  firstOutputWait: () => Promise<{ firstOutputMs: number; firstOutput: string }>,
  prepareReply: (
    firstOutputMs: number,
    predicate: () => boolean,
  ) => (startedAt: number) => Promise<void>,
): Promise<EvaluatedInputTiming> {
  if (probe.input.includes(probe.marker)) {
    throw new Error(`readiness probe input must not contain its marker: ${probe.marker}`);
  }
  const { firstOutputMs, firstOutput } = await firstOutputWait();
  const replyWait = prepareReply(firstOutputMs, () => stream.read().includes(probe.marker));
  const startedAt = performance.now();
  send(probe.input);
  await replyWait(startedAt);
  return { firstOutputMs, firstOutput, roundTripMs: performance.now() - startedAt };
}

export async function waitForEvaluatedInput(
  stream: PtyStream,
  send: (data: string) => void,
  probe: EvaluatedInputProbe,
  label: string,
  options: EvaluatedInputOptions,
): Promise<EvaluatedInputTiming> {
  const budgetMs = requireDuration(options.budgetMs, 'the budget', label);
  const roundTripStallMs = requireDuration(
    options.roundTripStallMs ?? DEFAULT_INPUT_READY_STALL_MS,
    'the round-trip stall window',
    label,
  );
  const interval = options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs };
  return runEvaluatedInputProbe(
    stream,
    send,
    probe,
    () => waitForShellFirstOutput(stream, label, { timeoutMs: budgetMs, ...interval }),
    (firstOutputMs, predicate) => {
      const remainingMs = budgetMs - firstOutputMs;
      if (remainingMs <= 0) {
        throw new HarnessBudgetRefusal(
          `the ${Math.round(budgetMs)}ms grant for ${label} was spent before the round trip could start: first output after ${Math.round(firstOutputMs)}ms left nothing`,
        );
      }
      return (startedAt) =>
        waitForCondition(stream, predicate, label, {
          stallMs: roundTripStallMs,
          backstopAt: startedAt + remainingMs,
          ...interval,
        });
    },
  );
}

export function createHarnessReadinessObserver(
  stream: PtyStream,
  initialDeadlineAt: number,
  reportDeadlineAt: number,
): HarnessReadinessObserver {
  return createReadinessObserver(
    stream,
    { at: initialDeadlineAt, bound: 'its initial allowance ended' },
    reportDeadlineAt,
  );
}

function createReadinessObserver(
  stream: PtyStream,
  initialDeadline: WaitDeadline,
  reportDeadlineAt: number,
): HarnessReadinessObserver {
  const readiness: ReadinessState = {
    initialDeadline,
    reportDeadlineAt,
    output: createShellOutputObservation(),
  };
  return {
    waitForCondition: (predicate, label, options = {}) =>
      waitForReadinessCondition(stream, predicate, label, readiness, options).then(() => undefined),
    waitForCompletion: (predicate, label, options = {}) =>
      waitForReadinessCondition(stream, predicate, label, readiness, options),
    waitForShellReady: async (label, options = {}) => {
      const { pacing, isQuiet } = quietShellWait(stream, label, options);
      await waitForReadinessCondition(stream, isQuiet, label, readiness, pacing);
    },
    waitForEvaluatedInput: (send, probe, label, options = {}) => {
      const roundTripStallMs = requireDuration(
        options.roundTripStallMs ?? DEFAULT_INPUT_READY_STALL_MS,
        'the round-trip stall window',
        label,
      );
      const interval = options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs };
      return runEvaluatedInputProbe(
        stream,
        send,
        probe,
        async () => {
          const startedAt = performance.now();
          await waitForReadinessCondition(
            stream,
            () => shellOutputBeyondAttach(stream.read()).length > 0,
            label,
            readiness,
            { stallMs: DEFAULT_INPUT_READY_STALL_MS, ...interval },
          );
          return {
            firstOutputMs: performance.now() - startedAt,
            firstOutput: describeLeading(shellOutputBeyondAttach(stream.read())),
          };
        },
        (_firstOutputMs, predicate) => {
          return async () => {
            await waitForReadinessCondition(stream, predicate, label, readiness, {
              stallMs: roundTripStallMs,
              ...interval,
            });
          };
        },
      );
    },
  };
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

const HARNESS = fileURLToPath(new URL('../utility/pty-host.real-io-harness.ts', import.meta.url));
const TRACE_PRELOAD = new URL('./pty-startup-trace-preload.test-helper.mjs', import.meta.url).href;
const HARNESS_TIMEOUTS = harnessTimeouts(process.platform);
const SUCCESS_RESULT = `HARNESS_RESULT ok=${harnessScenarioTitles(process.platform).length} fail=0 refused=0`;

interface HarnessProcess {
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  kill(): unknown;
  unref(): unknown;
}

export type HarnessSpawn = (file: string, args: string[], options: SpawnOptions) => HarnessProcess;

export async function runHarness(
  outputDir: string,
  extraEnv: Record<string, string> = {},
  spawnChild: HarnessSpawn = spawn,
): Promise<string> {
  const outputPath = join(outputDir, 'output.log');
  const outputFd = openSync(outputPath, 'w');
  const child = (() => {
    try {
      return spawnChild(process.execPath, ['--import', TRACE_PRELOAD, HARNESS], {
        env: {
          ...process.env,
          TEMP: outputDir,
          TMP: outputDir,
          TMPDIR: outputDir,
          ...extraEnv,
        },
        stdio: ['ignore', outputFd, outputFd],
        windowsHide: true,
      });
    } finally {
      closeSync(outputFd);
    }
  })();

  let spawnError = null as Error | null;
  let exitResult = null as { code: number | null; signal: string | null } | null;
  let resolveExit: () => void = () => undefined;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  child.once('error', (error) => {
    spawnError = error;
  });
  child.once('exit', (code, signal) => {
    exitResult = { code, signal };
    resolveExit();
  });

  async function terminateChild(): Promise<void> {
    if (exitResult === null) {
      child.kill();
      await Promise.race([exitPromise, sleep(HARNESS_CHILD_KILL_WAIT_MS)]);
    }
    child.unref();
  }

  try {
    const deadline = Date.now() + HARNESS_TIMEOUTS.verdictDeadlineMs;
    while (Date.now() < deadline) {
      const output = readFileSync(outputPath, 'utf8');
      if (spawnError !== null) {
        throw new Error(`real-PTY harness could not start: ${spawnError.message}\n${output}`);
      }

      const completeLines = output.split(/\r?\n/u);
      completeLines.pop();
      const resultLine = completeLines.find((line) => line.startsWith('HARNESS_RESULT '));
      if (resultLine !== undefined) {
        if (resultLine !== SUCCESS_RESULT) {
          throw new Error(`real-PTY harness reported failure:\n${output}`);
        }
        if (exitResult !== null && exitResult.code !== 0) {
          throw new Error(
            `real-PTY harness exited ${exitResult.code ?? exitResult.signal} after success:\n${output}`,
          );
        }
        return output;
      }

      if (exitResult !== null) {
        throw new Error(
          `real-PTY harness exited ${exitResult.code ?? exitResult.signal} without a verdict:\n${output}`,
        );
      }
      await sleep(HARNESS_VERDICT_POLL_INTERVAL_MS);
    }

    const output = readFileSync(outputPath, 'utf8');
    throw new Error(`real-PTY harness timed out without a verdict:\n${output}`);
  } finally {
    await terminateChild();
  }
}
