import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WaterfallPhase } from '../../../src/main/startup-waterfall.ts';
import {
  BOOT_HEARTBEAT_EVENTS,
  DESKTOP_BOOT_EVENT,
  DESKTOP_OPEN_PROJECT_FAILED_EVENT,
  isBootHeartbeatEvent,
  SPAWN_WAIT_HEARTBEAT_MS,
  type StartupMarkLine,
  startupMarkLine,
  UTILITY_INIT_TIMEOUT_MS,
} from '../../../src/shared/boot-narration.ts';

export const BOOT_LOG_HEARTBEAT_MS = SPAWN_WAIT_HEARTBEAT_MS;

export const BOOT_LOG_STALL_MS = BOOT_LOG_HEARTBEAT_MS * 3;

export const BOOT_LOG_POLL_MS = 250;

export const BOOT_LOG_CAP_MS = 25_000;

export const UTILITY_TIMEOUT_OBSERVATION_MARGIN_MS = 5_000;

const BOOT_LOG_TAIL_LINES = 12;

export interface BootLogSnapshot {
  dir: string;
  exists: boolean;
  fileCount: number;
  unreadableReason: string | undefined;
  unreadableFiles: string[];
  lines: string[];
  lineCount: number;
  lastEvent: string | undefined;
  tail: string;
}

export function bootLogDirFor(home: string): string {
  return join(home, '.ok', 'logs');
}

function emptyBootLog(dir: string, unreadableReason?: string): BootLogSnapshot {
  return {
    dir,
    exists: false,
    fileCount: 0,
    unreadableReason,
    unreadableFiles: [],
    lines: [],
    lineCount: 0,
    lastEvent: undefined,
    tail: '',
  };
}

function parseEvent(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as { event?: unknown; msg?: unknown };
    if (typeof parsed.event === 'string') return parsed.event;
    if (typeof parsed.msg === 'string') return parsed.msg;
  } catch {}
  return undefined;
}

export function readBootLog(home: string): BootLogSnapshot {
  const dir = bootLogDirFor(home);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith('desktop.') && n.endsWith('.log'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return emptyBootLog(dir, code === undefined || code === 'ENOENT' ? undefined : code);
  }
  const lines: string[] = [];
  const unreadableFiles: string[] = [];
  for (const name of names.sort()) {
    try {
      const raw = readFileSync(join(dir, name), 'utf8');
      for (const line of raw.split('\n')) {
        if (line.trim().length > 0) lines.push(line);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      unreadableFiles.push(`${name} (${code})`);
    }
  }
  let lastEvent: string | undefined;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const event = parseEvent(line);
    if (event !== undefined) {
      lastEvent = event;
      break;
    }
  }
  return {
    dir,
    exists: names.length > 0,
    fileCount: names.length,
    unreadableReason: undefined,
    unreadableFiles,
    lines,
    lineCount: lines.length,
    lastEvent,
    tail: lines.slice(-BOOT_LOG_TAIL_LINES).join('\n'),
  };
}

export function readBootLogLines(home: string): string[] {
  return readBootLog(home).lines;
}

export interface BootLogGapSummary {
  totalBootMs: number;
  lineCount: number;
  maxGapMs: number;
  maxGapAfterPhase: string | undefined;
  openStageMs: number;
  beatsSeen: number;
  lastBeatPhase?: string;
  bootComplete: boolean;
  phases: string[];
}

function parseTime(line: string): number | undefined {
  try {
    const parsed = JSON.parse(line) as { time?: unknown };
    if (typeof parsed.time === 'string') {
      const ms = Date.parse(parsed.time);
      return Number.isNaN(ms) ? undefined : ms;
    }
    if (typeof parsed.time === 'number') return parsed.time;
  } catch {}
  return undefined;
}

const BOOT_COMPLETE_EVENT = startupMarkLine('windowShown', 0).event;

function currentLaunch(lines: readonly string[]): string[] {
  const lastBoot = lines.map(parseEvent).lastIndexOf(DESKTOP_BOOT_EVENT);
  return lastBoot === -1 ? [...lines] : lines.slice(lastBoot);
}

const STARTUP_STAGE_PHASES = {
  appReady: true,
  bootstrapDone: true,
  serverSpawned: true,
  serverLockReady: true,
  windowCreated: true,
  loadUrlResolved: true,
  windowShown: true,
} as const satisfies Record<WaterfallPhase, true>;

export const EVERY_STARTUP_PHASE = Object.keys(STARTUP_STAGE_PHASES) as ReadonlyArray<
  keyof typeof STARTUP_STAGE_PHASES
>;

const STARTUP_STAGE_EVENTS: ReadonlySet<string> = new Set(
  EVERY_STARTUP_PHASE.map((phase) => startupMarkLine(phase, 0).event),
);

type StartupStageEvent = StartupMarkLine['event'];

function isStartupStageEvent(event: string): event is StartupStageEvent {
  return STARTUP_STAGE_EVENTS.has(event);
}

function isLaunchNarrationLine(line: string): boolean {
  const event = parseEvent(line);
  return event !== undefined && (isStartupStageEvent(event) || isBootHeartbeatEvent(event));
}

function lastLaunchNarrationIndex(launch: readonly string[]): number {
  for (let i = launch.length - 1; i >= 0; i -= 1) {
    const line = launch[i];
    if (line !== undefined && isLaunchNarrationLine(line)) return i;
  }
  return -1;
}

function bootPrefix(lines: readonly string[]): string[] {
  const launch = currentLaunch(lines);
  const end = launch.findIndex((line) => parseEvent(line) === BOOT_COMPLETE_EVENT);
  if (end === -1) return launch;
  return lastLaunchNarrationIndex(launch) > end ? launch : launch.slice(0, end + 1);
}

export function hasBootCompleted(all: readonly string[]): boolean {
  return currentLaunch(all).some((line) => parseEvent(line) === BOOT_COMPLETE_EVENT);
}

const DECLARED_PHASE_OPEN_EVENT = startupMarkLine('serverSpawned', 0).event;

const DECLARED_PHASE_CLOSED_EVENT = startupMarkLine('serverLockReady', 0).event;

function openDeclaredPhaseStart(launch: readonly string[]): number {
  const openedAt = launch.map(parseEvent).lastIndexOf(DECLARED_PHASE_OPEN_EVENT);
  if (openedAt === -1) return -1;
  for (let i = openedAt + 1; i < launch.length; i += 1) {
    const line = launch[i];
    if (line === undefined) continue;
    const event = parseEvent(line);
    if (event === DECLARED_PHASE_CLOSED_EVENT || event === DESKTOP_OPEN_PROJECT_FAILED_EVENT)
      return -1;
  }
  return openedAt;
}

export function hasOpenDeclaredPhase(all: readonly string[]): boolean {
  return openDeclaredPhaseStart(currentLaunch(all)) !== -1;
}

function isUsableDurationField(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export interface DeclaredPhaseBudget {
  elapsedMs: number;
  initTimeoutMs: number;
}

export function parseDeclaredPhaseBudget(line: string): DeclaredPhaseBudget | undefined {
  try {
    const parsed = JSON.parse(line) as {
      event?: unknown;
      elapsedMs?: unknown;
      initTimeoutMs?: unknown;
    };
    if (parsed.event !== BOOT_HEARTBEAT_EVENTS.utilityWait) return undefined;
    const { elapsedMs, initTimeoutMs } = parsed;
    if (!isUsableDurationField(elapsedMs) || !isUsableDurationField(initTimeoutMs))
      return undefined;
    if (initTimeoutMs > UTILITY_INIT_TIMEOUT_MS) return undefined;
    if (elapsedMs < 0 || elapsedMs > initTimeoutMs) return undefined;
    return { elapsedMs, initTimeoutMs };
  } catch {}
  return undefined;
}

function newestDeclaredPhaseBudget(all: readonly string[]): DeclaredPhaseBudget | undefined {
  const launch = currentLaunch(all);
  const openedAt = openDeclaredPhaseStart(launch);
  if (openedAt === -1) return undefined;
  for (let i = launch.length - 1; i > openedAt; i -= 1) {
    const line = launch[i];
    if (line === undefined) continue;
    const budget = parseDeclaredPhaseBudget(line);
    if (budget !== undefined) return budget;
  }
  return undefined;
}

export interface LaunchAdvancement {
  event: StartupStageEvent;
  atMs: number;
}

export function launchAdvancementPhases(all: readonly string[]): StartupStageEvent[] {
  const ordered: StartupStageEvent[] = [];
  for (const line of currentLaunch(all)) {
    const event = parseEvent(line);
    if (event === undefined || !isStartupStageEvent(event)) continue;
    if (!ordered.includes(event)) ordered.push(event);
  }
  return ordered;
}

function parseLastPhase(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as { lastPhase?: unknown };
    if (typeof parsed.lastPhase === 'string') return parsed.lastPhase;
  } catch {}
  return undefined;
}

export function bootLogGapSummary(all: readonly string[]): BootLogGapSummary {
  const lines = bootPrefix(all);
  const stamped = lines
    .map((line) => ({
      at: parseTime(line),
      event: parseEvent(line),
      beat: isBootHeartbeatEvent(parseEvent(line) ?? ''),
      lastPhase: parseLastPhase(line),
    }))
    .filter((entry) => entry.at !== undefined);
  const phases = stamped.filter((entry) => !entry.beat);
  let maxGapMs = 0;
  let maxGapAfterPhase: string | undefined;
  for (let i = 1; i < phases.length; i += 1) {
    const prev = phases[i - 1];
    const cur = phases[i];
    if (prev === undefined || cur === undefined) continue;
    const gap = (cur.at as number) - (prev.at as number);
    if (gap > maxGapMs) {
      maxGapMs = gap;
      maxGapAfterPhase = prev.event;
    }
  }
  const lastStageAt = phases.at(-1)?.at;
  const lastLineAt = stamped.at(-1)?.at;
  const openStageMs =
    lastStageAt !== undefined && lastLineAt !== undefined ? lastLineAt - lastStageAt : 0;
  if (openStageMs > maxGapMs) {
    maxGapMs = openStageMs;
    maxGapAfterPhase = phases.at(-1)?.event;
  }
  const firstAt = stamped[0]?.at;
  const lastAt = stamped.at(-1)?.at;
  const totalBootMs = firstAt !== undefined && lastAt !== undefined ? lastAt - firstAt : 0;
  const beatsSeen = stamped.length - phases.length;
  const lastBeatPhase = stamped
    .filter((e) => e.beat && e.lastPhase !== undefined)
    .at(-1)?.lastPhase;
  return {
    totalBootMs,
    lineCount: lines.length,
    maxGapMs,
    maxGapAfterPhase,
    openStageMs,
    beatsSeen,
    ...(lastBeatPhase === undefined ? {} : { lastBeatPhase }),
    bootComplete: hasBootCompleted(lines),
    phases: phases.map((s) => s.event).filter((e): e is string => e !== undefined),
  };
}

type BootGapSource =
  | 'unavailable'
  | 'wait-snapshot'
  | 'teardown-read'
  | 'teardown-read-shared-home';

const UNDETERMINED_ABSENT_LOG_CAUSE =
  'the cause is not determined here (it may have been removed, never written, or written elsewhere)';

export function describeMissingBootLog(snapshot: BootLogSnapshot): string {
  switch (classifyBootLog(snapshot)) {
    case 'unreadable':
      return snapshot.unreadableReason !== undefined
        ? `log dir unreadable (${snapshot.unreadableReason})`
        : `log files unreadable: ${snapshot.unreadableFiles.join(', ')}`;
    case 'notfound':
      return `no desktop log file when the fixture read it; ${UNDETERMINED_ABSENT_LOG_CAUSE}`;
    case 'empty':
      return 'log files present but empty';
    case 'ok':
      return 'log files present and readable';
  }
}

export type BootGapLine = {
  slot: number;
  source: BootGapSource;
  firstWait?: ReadyWaitRecord;
  readyWaitCount?: number;
} & ({ summary: BootLogGapSummary; reason?: never } | { summary?: never; reason: string });

export function bootGapSourceFor(input: {
  hasLines: boolean;
  snapshotted: boolean;
  homeShared: boolean;
}): BootGapSource {
  if (!input.hasLines) return 'unavailable';
  if (input.snapshotted) return 'wait-snapshot';
  return input.homeShared ? 'teardown-read-shared-home' : 'teardown-read';
}

class NarrationOfOneRead {
  readonly lines: readonly string[];
  readonly snapshotted: boolean;
  readonly #read: BootLogSnapshot;

  constructor(atBoot: readonly string[] | undefined, onDisk: BootLogSnapshot) {
    const useDisk = isMoreCompleteNarration(onDisk.lines, atBoot);
    this.lines = useDisk ? onDisk.lines : (atBoot ?? []);
    this.snapshotted = !useDisk && atBoot !== undefined;
    this.#read = onDisk;
  }

  get missingLogReason(): string | undefined {
    return this.lines.length === 0 ? describeMissingBootLog(this.#read) : undefined;
  }
}

export type BootNarration = NarrationOfOneRead;

export function bootNarrationFor(
  atBoot: readonly string[] | undefined,
  onDisk: BootLogSnapshot,
): BootNarration {
  return new NarrationOfOneRead(atBoot, onDisk);
}

export function bootGapLineFor(input: {
  slot: number;
  narration: BootNarration;
  readyWaitCount: number;
  firstWait?: ReadyWaitRecord;
  homeShared: boolean;
}): BootGapLine {
  const { narration } = input;
  const reason = narration.missingLogReason;
  const base = {
    slot: input.slot,
    source: bootGapSourceFor({
      hasLines: reason === undefined,
      snapshotted: narration.snapshotted,
      homeShared: input.homeShared,
    }),
    readyWaitCount: input.readyWaitCount,
    ...(input.firstWait === undefined ? {} : { firstWait: input.firstWait }),
  };
  return reason === undefined
    ? { ...base, summary: bootLogGapSummary(narration.lines) }
    : { ...base, reason };
}

export function lastAdvancementMs(wait: ReadyWaitRecord): number | undefined {
  return wait.advancements.at(-1)?.atMs;
}

export function sinceLastAdvancementMs(wait: ReadyWaitRecord): number | undefined {
  const last = lastAdvancementMs(wait);
  return last === undefined ? undefined : wait.elapsedMs - last;
}

export function formatBootGapLine(line: BootGapLine): string {
  const parts = [
    `[boot-gap] slot=${line.slot}`,
    `source=${line.source}`,
    `stallMs=${BOOT_LOG_STALL_MS}`,
    `readyWaitCount=${line.readyWaitCount ?? 0}`,
    ...(line.firstWait === undefined
      ? [
          'firstWaitMs=none',
          'firstWaitCapMs=none',
          'firstWaitRequestedCapMs=none',
          'firstWaitWhat=none',
          'firstWaitGaveUp=none',
          'firstWaitReason=none',
          'firstWaitAdvancements=none',
          'firstWaitLastAdvancementMs=none',
          'firstWaitSinceAdvancementMs=none',
        ]
      : [
          `firstWaitMs=${line.firstWait.elapsedMs}`,
          `firstWaitCapMs=${line.firstWait.capMs}`,
          `firstWaitRequestedCapMs=${line.firstWait.requestedCapMs}`,
          `firstWaitWhat=${JSON.stringify(line.firstWait.what)}`,
          `firstWaitGaveUp=${line.firstWait.gaveUp}`,
          `firstWaitReason=${line.firstWait.reason}`,
          `firstWaitAdvancements=${JSON.stringify(
            line.firstWait.advancements.map((advancement) => advancement.event),
          )}`,
          `firstWaitLastAdvancementMs=${lastAdvancementMs(line.firstWait) ?? 'none'}`,
          `firstWaitSinceAdvancementMs=${sinceLastAdvancementMs(line.firstWait) ?? 'none'}`,
        ]),
  ];
  if (line.summary === undefined) {
    parts.push(`reason=${JSON.stringify(line.reason)}`);
    return parts.join(' ');
  }
  parts.push(
    `totalBootMs=${line.summary.totalBootMs}`,
    `maxGapMs=${line.summary.maxGapMs}`,
    `openStageMs=${line.summary.openStageMs}`,
    `beatsSeen=${line.summary.beatsSeen}`,
    `lineCount=${line.summary.lineCount}`,
    `bootComplete=${line.summary.bootComplete}`,
    `afterPhase=${JSON.stringify(line.summary.maxGapAfterPhase ?? '')}`,
    `lastBeatPhase=${JSON.stringify(line.summary.lastBeatPhase ?? '')}`,
  );
  return parts.join(' ');
}

export type ReadyLiveness = 'boot' | 'none';

export interface ReadySignalOptions<T> {
  probe: () => Promise<T | undefined>;
  home: string;
  what: string;
  liveness?: ReadyLiveness;
  stallMs?: number;
  capMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readLog?: (home: string) => BootLogSnapshot;
  startDeadline?: (ms: number) => ReadyDeadline;
  isProbePending?: () => boolean;
  onCapExtended?: (capMs: number) => void;
  onAdvancement?: (advancement: LaunchAdvancement) => void;
}

export interface ReadyDeadline {
  readonly expired: Promise<void>;
  cancel(): void;
}

export interface ProbeErrorSummary {
  last: string;
  threwPolls: number;
  totalPolls: number;
}

export type BootLogState = 'unreadable' | 'notfound' | 'empty' | 'ok';

export function classifyBootLog(snapshot: BootLogSnapshot): BootLogState {
  if (snapshot.unreadableReason !== undefined || snapshot.unreadableFiles.length > 0)
    return 'unreadable';
  if (!snapshot.exists) return 'notfound';
  if (snapshot.lineCount === 0) return 'empty';
  return 'ok';
}

function describeBootLog(snapshot: BootLogSnapshot): string {
  switch (classifyBootLog(snapshot)) {
    case 'unreadable':
      return snapshot.unreadableReason !== undefined
        ? `Boot log: ${snapshot.dir} (UNREADABLE, ${snapshot.unreadableReason} — this is a runner ` +
            'filesystem problem, not evidence about the app)'
        : `Boot log: ${snapshot.dir} (${snapshot.lineCount} line(s) read; UNREADABLE files: ` +
            `${snapshot.unreadableFiles.join(', ')} — a runner filesystem problem, not evidence ` +
            'about the app)';
    case 'notfound':
      return `Boot log: ${snapshot.dir} (NOT FOUND, ${UNDETERMINED_ABSENT_LOG_CAUSE})`;
    case 'empty':
      return (
        `Boot log: ${snapshot.dir} (${snapshot.fileCount} file(s) present but EMPTY — the app ` +
        'opened its log and wrote nothing)'
      );
    case 'ok':
      return `Boot log: ${snapshot.dir}`;
  }
}

function describeFailure(
  reason: 'stalled' | 'stalled-in-declared-phase' | 'cap',
  what: string,
  elapsedMs: number,
  stallMs: number,
  snapshot: BootLogSnapshot,
  probeError: ProbeErrorSummary | undefined,
  probePending: boolean,
): string {
  const phase = snapshot.lastEvent ?? '(no boot event recorded)';
  const state = classifyBootLog(snapshot);
  const silence =
    `${what} did not arrive, and the app logged no new boot activity for ${stallMs}ms ` +
    `(gave up after ${elapsedMs}ms). `;
  const head =
    state !== 'ok'
      ? `${what} did not arrive within ${elapsedMs}ms, and the boot log cannot say why.`
      : reason === 'stalled'
        ? `${silence}Main narrates every ${BOOT_LOG_HEARTBEAT_MS}ms from ` +
          'process start until the first window is shown, so this silence after phase ' +
          `${phase} means the app stopped making progress.`
        : reason === 'stalled-in-declared-phase'
          ? `${silence}Main beats every ${BOOT_LOG_HEARTBEAT_MS}ms while a startup phase it ` +
            'declared is still open, and it had shown a window before this silence, so this ' +
            `silence after phase ${phase} means the app stopped making progress inside that ` +
            'open phase rather than before its first window.'
          : probePending
            ? `${what} did not arrive within ${elapsedMs}ms.`
            : `${what} did not arrive within ${elapsedMs}ms, though the app kept logging boot activity.`;
  const lines = [head, `Last main-process boot event: ${phase}`, describeBootLog(snapshot)];
  lines.push(
    probeError === undefined
      ? 'Probe errors: none on any poll.'
      : `Probe threw on ${probeError.threwPolls} of ${probeError.totalPolls} polls; ` +
          `last: ${probeError.last}`,
  );
  if (probePending) lines.push('The last probe had not answered when the cap fired.');
  if (snapshot.tail.length > 0) lines.push('', 'Boot log tail:', snapshot.tail);
  return lines.join('\n');
}

class ReadySignalGiveUp extends Error {
  readonly reason: ReadyWaitGiveUpReason;
  constructor(message: string, reason: ReadyWaitGiveUpReason) {
    super(message);
    this.reason = reason;
  }
}

export function giveUpReason(
  base: 'stall' | 'cap',
  snapshot: BootLogSnapshot,
): ReadyWaitGiveUpReason {
  switch (classifyBootLog(snapshot)) {
    case 'unreadable':
      return 'unreadable';
    case 'notfound':
      return 'notfound';
    case 'empty':
      return 'empty';
    case 'ok':
      return base;
  }
}

const DEADLINE_PASSED = Symbol('ready-signal-deadline-passed');

function startTimerDeadline(ms: number): ReadyDeadline {
  const reached = Promise.withResolvers<void>();
  const timer = setTimeout(reached.resolve, ms);
  return { expired: reached.promise, cancel: () => clearTimeout(timer) };
}

export async function waitForReadySignal<T>(options: ReadySignalOptions<T>): Promise<T> {
  const stallMs = options.stallMs ?? BOOT_LOG_STALL_MS;
  const capMs = options.capMs ?? BOOT_LOG_CAP_MS;
  const pollMs = options.pollMs ?? BOOT_LOG_POLL_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const readLog = options.readLog ?? readBootLog;
  const startDeadline = options.startDeadline ?? startTimerDeadline;

  const startedAt = now();
  let lastProgressAt = startedAt;
  let cursor = -1;
  const advancementSeen = new Set<string>();
  let lastLegibleReadAt: number | undefined;
  let lastStageRenewalAt: number | undefined;
  let snapshot = emptyBootLog(bootLogDirFor(options.home));
  const explicitLiveness = options.liveness;
  let lastProbeError: string | undefined;
  let threwPolls = 0;
  let totalPolls = 0;

  let capElapsed = false;
  const armCapReached = (armed: ReadyDeadline): Promise<typeof DEADLINE_PASSED> =>
    armed.expired.then((): typeof DEADLINE_PASSED => {
      capElapsed = true;
      return DEADLINE_PASSED;
    });
  let deadline = startDeadline(capMs);
  let capReached = armCapReached(deadline);
  let armedCapMs = capMs;
  let grantedElapsedMs = Number.NEGATIVE_INFINITY;
  let derivedDeadlineAt: number | undefined;
  let probePendingAtGiveUp = false;

  try {
    for (;;) {
      if (!capElapsed) {
        totalPolls += 1;
        try {
          const settled = await Promise.race([
            options.probe().then((hit) => ({ hit })),
            capReached,
          ]);
          if (settled === DEADLINE_PASSED) probePendingAtGiveUp = true;
          else if (settled.hit !== undefined) return settled.hit;
        } catch (error) {
          lastProbeError = error instanceof Error ? error.message : String(error);
          threwPolls += 1;
        }
      }

      snapshot = readLog(options.home);
      const readAt = now();
      if (snapshot.lineCount > cursor) {
        cursor = snapshot.lineCount;
        lastProgressAt = readAt;
      }

      for (const event of launchAdvancementPhases(snapshot.lines)) {
        if (advancementSeen.has(event)) continue;
        advancementSeen.add(event);
        options.onAdvancement?.({ event, atMs: readAt - startedAt });
        if (lastLegibleReadAt !== undefined) {
          lastStageRenewalAt = probePendingAtGiveUp ? lastLegibleReadAt : readAt;
        }
      }
      if (classifyBootLog(snapshot) !== 'unreadable') lastLegibleReadAt = readAt;

      const declaredPhaseOpen = hasOpenDeclaredPhase(snapshot.lines);
      if (declaredPhaseOpen) {
        const budget = newestDeclaredPhaseBudget(snapshot.lines);
        if (budget !== undefined && budget.elapsedMs > grantedElapsedMs) {
          grantedElapsedMs = budget.elapsedMs;
          const remaining = Math.max(
            budget.initTimeoutMs - budget.elapsedMs,
            UTILITY_TIMEOUT_OBSERVATION_MARGIN_MS,
          );
          derivedDeadlineAt = Math.max(derivedDeadlineAt ?? 0, now() + remaining);
        }
      }
      const effectiveCapMs = Math.max(
        capMs,
        derivedDeadlineAt === undefined ? capMs : derivedDeadlineAt - startedAt,
        lastStageRenewalAt === undefined
          ? capMs
          : Math.min(lastStageRenewalAt - startedAt + stallMs, capMs + stallMs),
      );
      if (effectiveCapMs > armedCapMs) {
        deadline.cancel();
        capElapsed = false;
        probePendingAtGiveUp = false;
        armedCapMs = effectiveCapMs;
        options.onCapExtended?.(armedCapMs);
        deadline = startDeadline(Math.max(startedAt + armedCapMs - now(), 0));
        capReached = armCapReached(deadline);
      }

      const probeError: ProbeErrorSummary | undefined =
        lastProbeError === undefined ? undefined : { last: lastProbeError, threwPolls, totalPolls };
      const elapsed = now() - startedAt;
      const probePending = probePendingAtGiveUp || options.isProbePending?.() === true;
      const stallArmed =
        explicitLiveness !== undefined
          ? explicitLiveness === 'boot'
          : !hasBootCompleted(snapshot.lines) || declaredPhaseOpen;
      if (stallArmed && now() - lastProgressAt >= stallMs) {
        throw new ReadySignalGiveUp(
          describeFailure(
            declaredPhaseOpen && hasBootCompleted(snapshot.lines)
              ? 'stalled-in-declared-phase'
              : 'stalled',
            options.what,
            elapsed,
            stallMs,
            snapshot,
            probeError,
            probePending,
          ),
          giveUpReason('stall', snapshot),
        );
      }
      if (capElapsed || elapsed >= effectiveCapMs) {
        throw new ReadySignalGiveUp(
          describeFailure(
            'cap',
            options.what,
            elapsed,
            stallMs,
            snapshot,
            probeError,
            probePending,
          ),
          giveUpReason('cap', snapshot),
        );
      }
      await sleep(pollMs);
    }
  } finally {
    deadline.cancel();
  }
}

export type WindowMode = 'editor' | 'navigator' | 'terminal' | 'note';

interface ModeProbePage {
  evaluate(fn: () => string | undefined): Promise<string | undefined>;
}

interface ModeProbeApp<TPage> {
  windows(): TPage[];
}

type ModeProbeResult =
  | { kind: 'mode'; value: string | undefined }
  | { kind: 'error'; error: Error };

interface ModeProbeState {
  pending: boolean;
  result: ModeProbeResult | undefined;
}

const HOME_BY_APP = new WeakMap<object, string>();

const BOOT_LOG_BY_APP = new WeakMap<object, string[]>();

export const READY_WAIT_GIVE_UP_REASONS = [
  'stall',
  'cap',
  'unreadable',
  'notfound',
  'empty',
  'none',
] as const;

export type ReadyWaitGiveUpReason = (typeof READY_WAIT_GIVE_UP_REASONS)[number];

export interface ReadyWaitRecord {
  ordinal: number;
  what: string;
  elapsedMs: number;
  capMs: number;
  requestedCapMs: number;
  gaveUp: boolean;
  reason: ReadyWaitGiveUpReason;
  advancements: readonly LaunchAdvancement[];
}

const READY_WAITS_BY_APP = new WeakMap<object, ReadyWaitRecord[]>();

export function rememberLaunchHome(app: object, home: string): void {
  HOME_BY_APP.set(app, home);
}

export function tryLaunchHomeFor(app: object): string | undefined {
  return HOME_BY_APP.get(app);
}

export function isMoreCompleteNarration(
  candidate: readonly string[],
  held: readonly string[] | undefined,
): boolean {
  return candidate.length > (held?.length ?? 0);
}

export function rememberBootLog(app: object, lines: readonly string[]): void {
  if (!isMoreCompleteNarration(lines, BOOT_LOG_BY_APP.get(app))) return;
  BOOT_LOG_BY_APP.set(app, [...lines]);
}

export function tryBootLogFor(app: object): string[] | undefined {
  return BOOT_LOG_BY_APP.get(app);
}

export function rememberReadyWait(app: object, record: Omit<ReadyWaitRecord, 'ordinal'>): void {
  const existing = READY_WAITS_BY_APP.get(app);
  if (existing === undefined) {
    READY_WAITS_BY_APP.set(app, [{ ordinal: 0, ...record }]);
    return;
  }
  existing.push({ ordinal: existing.length, ...record });
}

export function readyWaitsFor(app: object): readonly ReadyWaitRecord[] | undefined {
  return READY_WAITS_BY_APP.get(app);
}

export function tryFirstWaitFor(app: object): ReadyWaitRecord | undefined {
  return READY_WAITS_BY_APP.get(app)?.[0];
}

export function launchHomeFor(app: object): string {
  const home = HOME_BY_APP.get(app);
  if (home === undefined) {
    throw new Error(
      'This ElectronApplication was not launched through launchDesktopApp(), so the smoke ' +
        'harness cannot locate its boot log. Launch via launchDesktopApp({ home }) or pass ' +
        '{ home } explicitly to the readiness helper.',
    );
  }
  return home;
}

export interface WaitForWindowOptions {
  home?: string;
  liveness?: ReadyLiveness;
  stallMs?: number;
  capMs?: number;
  pollMs?: number;
}

function evaluateWindowMode(page: ModeProbePage): Promise<string | undefined> {
  return page.evaluate(
    () => (window as { okDesktop?: { config?: { mode?: string } } }).okDesktop?.config?.mode,
  );
}

export async function waitForWindowByMode<TPage extends ModeProbePage>(
  app: ModeProbeApp<TPage>,
  mode: WindowMode,
  options: WaitForWindowOptions = {},
): Promise<TPage> {
  const home = options.home ?? launchHomeFor(app);
  const what = `${mode} window`;
  const capMs = options.capMs ?? BOOT_LOG_CAP_MS;
  let decidingCapMs = capMs;
  const startedAt = Date.now();
  const probeStates = new WeakMap<TPage, ModeProbeState>();
  let pendingProbeCount = 0;
  let succeeded = false;
  let reason: ReadyWaitGiveUpReason = 'none';
  const advancements: LaunchAdvancement[] = [];
  try {
    const found = await waitForReadySignal<TPage>({
      home,
      what,
      ...(options.liveness !== undefined ? { liveness: options.liveness } : {}),
      ...(options.stallMs !== undefined ? { stallMs: options.stallMs } : {}),
      capMs,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      isProbePending: () => pendingProbeCount > 0,
      onCapExtended: (extended) => {
        decidingCapMs = extended;
      },
      onAdvancement: (advancement) => {
        advancements.push(advancement);
      },
      probe: async () => {
        const pages = app.windows();
        for (const page of pages) {
          let state = probeStates.get(page);
          if (state === undefined) {
            state = { pending: false, result: undefined };
            probeStates.set(page, state);
          }
          if (state.pending || state.result !== undefined) continue;
          state.pending = true;
          pendingProbeCount += 1;
          try {
            void evaluateWindowMode(page).then(
              (value) => {
                state.pending = false;
                pendingProbeCount -= 1;
                state.result = { kind: 'mode', value };
              },
              (error: unknown) => {
                state.pending = false;
                pendingProbeCount -= 1;
                state.result = {
                  kind: 'error',
                  error: error instanceof Error ? error : new Error(String(error)),
                };
              },
            );
          } catch (error) {
            state.pending = false;
            pendingProbeCount -= 1;
            state.result = {
              kind: 'error',
              error: error instanceof Error ? error : new Error(String(error)),
            };
          }
        }

        await Promise.resolve();
        let lastError: Error | undefined;
        let readCleanly = false;
        for (const page of pages) {
          const state = probeStates.get(page);
          const result = state?.result;
          if (state === undefined || result === undefined) continue;
          state.result = undefined;
          if (result.kind === 'mode') {
            readCleanly = true;
            if (result.value === mode) return page;
          } else {
            lastError = result.error;
          }
        }
        if (!readCleanly && lastError !== undefined) throw lastError;
        return undefined;
      },
    });
    succeeded = true;
    return found;
  } catch (error) {
    if (error instanceof ReadySignalGiveUp) reason = error.reason;
    throw error;
  } finally {
    rememberBootLog(app, readBootLogLines(home));
    rememberReadyWait(app, {
      what,
      elapsedMs: Date.now() - startedAt,
      capMs: decidingCapMs,
      requestedCapMs: capMs,
      gaveUp: !succeeded,
      reason,
      advancements,
    });
  }
}

export interface DesktopLauncher<TApp> {
  launch(options: object): Promise<TApp>;
}

export async function launchDesktopApp<TApp>(
  launcher: DesktopLauncher<TApp>,
  launchOptions: object,
  options: { home: string; readLog?: (home: string) => BootLogSnapshot },
): Promise<TApp> {
  const readLog = options.readLog ?? readBootLog;
  try {
    const app = await launcher.launch(launchOptions);
    if (typeof app === 'object' && app !== null) rememberLaunchHome(app, options.home);
    return app;
  } catch (error) {
    const snapshot = readLog(options.home);
    const reason = error instanceof Error ? error.message : String(error);
    const detail = [
      reason,
      '',
      `Last main-process boot event: ${snapshot.lastEvent ?? '(no boot event recorded)'}`,
      describeBootLog(snapshot),
    ];
    if (snapshot.tail.length > 0) detail.push('', 'Boot log tail:', snapshot.tail);
    throw new Error(detail.join('\n'), { cause: error });
  }
}
