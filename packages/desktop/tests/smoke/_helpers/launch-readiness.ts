import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DESKTOP_BOOT_EVENT,
  isBootHeartbeatEvent,
  SPAWN_WAIT_HEARTBEAT_MS,
  startupMarkLine,
} from '../../../src/shared/boot-narration.ts';

export const BOOT_LOG_HEARTBEAT_MS = SPAWN_WAIT_HEARTBEAT_MS;

export const BOOT_LOG_STALL_MS = BOOT_LOG_HEARTBEAT_MS * 3;

export const BOOT_LOG_POLL_MS = 250;

export const BOOT_LOG_CAP_MS = 25_000;

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

function bootPrefix(lines: readonly string[]): string[] {
  const launch = currentLaunch(lines);
  const end = launch.findIndex((line) => parseEvent(line) === BOOT_COMPLETE_EVENT);
  return end === -1 ? launch : launch.slice(0, end + 1);
}

export function hasBootCompleted(all: readonly string[]): boolean {
  return currentLaunch(all).some((line) => parseEvent(line) === BOOT_COMPLETE_EVENT);
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
  | 'boot-complete'
  | 'teardown-read'
  | 'teardown-read-shared-home';

export function describeMissingBootLog(snapshot: BootLogSnapshot): string {
  switch (classifyBootLog(snapshot)) {
    case 'unreadable':
      return snapshot.unreadableReason !== undefined
        ? `log dir unreadable (${snapshot.unreadableReason})`
        : `log files unreadable: ${snapshot.unreadableFiles.join(', ')}`;
    case 'notfound':
      return 'no desktop log file at teardown (a test.afterEach removed the launch home before the fixture could read it, or the app wrote no log file)';
    case 'empty':
      return 'log files present but empty';
    case 'ok':
      return 'log files present and readable';
  }
}

export interface BootGapLine {
  slot: number;
  source: BootGapSource;
  firstWait?: ReadyWaitRecord;
  readyWaitCount?: number;
  summary: BootLogGapSummary | undefined;
  reason?: string;
}

export function bootGapSourceFor(input: {
  hasLines: boolean;
  snapshotted: boolean;
  homeShared: boolean;
}): BootGapSource {
  if (!input.hasLines) return 'unavailable';
  if (input.snapshotted) return 'boot-complete';
  return input.homeShared ? 'teardown-read-shared-home' : 'teardown-read';
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
          'firstWaitWhat=none',
          'firstWaitGaveUp=none',
          'firstWaitReason=none',
        ]
      : [
          `firstWaitMs=${line.firstWait.elapsedMs}`,
          `firstWaitCapMs=${line.firstWait.capMs}`,
          `firstWaitWhat=${JSON.stringify(line.firstWait.what)}`,
          `firstWaitGaveUp=${line.firstWait.gaveUp}`,
          `firstWaitReason=${line.firstWait.reason}`,
        ]),
  ];
  if (line.summary === undefined) {
    parts.push(`reason=${JSON.stringify(line.reason ?? 'unknown')}`);
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
      return (
        `Boot log: ${snapshot.dir} (NOT FOUND — the app may have died before it could log, ` +
        'or a required build artifact is missing)'
      );
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
  reason: 'stalled' | 'cap',
  what: string,
  elapsedMs: number,
  stallMs: number,
  snapshot: BootLogSnapshot,
  probeError: ProbeErrorSummary | undefined,
): string {
  const phase = snapshot.lastEvent ?? '(no boot event recorded)';
  const state = classifyBootLog(snapshot);
  const head =
    state !== 'ok'
      ? `${what} did not arrive within ${elapsedMs}ms, and the boot log cannot say why.`
      : reason === 'stalled'
        ? `${what} did not arrive, and the app logged no new boot activity for ${stallMs}ms ` +
          `(gave up after ${elapsedMs}ms). Main narrates every ${BOOT_LOG_HEARTBEAT_MS}ms from ` +
          'process start until the first window is shown, so this silence after phase ' +
          `${phase} means the app stopped making progress.`
        : `${what} did not arrive within ${elapsedMs}ms, though the app kept logging boot activity.`;
  const lines = [head, `Last main-process boot event: ${phase}`, describeBootLog(snapshot)];
  lines.push(
    probeError === undefined
      ? 'Probe errors: none on any poll.'
      : `Probe threw on ${probeError.threwPolls} of ${probeError.totalPolls} polls; ` +
          `last: ${probeError.last}`,
  );
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

export async function waitForReadySignal<T>(options: ReadySignalOptions<T>): Promise<T> {
  const stallMs = options.stallMs ?? BOOT_LOG_STALL_MS;
  const capMs = options.capMs ?? BOOT_LOG_CAP_MS;
  const pollMs = options.pollMs ?? BOOT_LOG_POLL_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const readLog = options.readLog ?? readBootLog;

  const startedAt = now();
  let lastProgressAt = startedAt;
  let cursor = -1;
  let snapshot = emptyBootLog(bootLogDirFor(options.home));
  const explicitLiveness = options.liveness;
  let lastProbeError: string | undefined;
  let threwPolls = 0;
  let totalPolls = 0;

  for (;;) {
    totalPolls += 1;
    try {
      const hit = await options.probe();
      if (hit !== undefined) return hit;
    } catch (error) {
      lastProbeError = error instanceof Error ? error.message : String(error);
      threwPolls += 1;
    }

    snapshot = readLog(options.home);
    if (snapshot.lineCount > cursor) {
      cursor = snapshot.lineCount;
      lastProgressAt = now();
    }

    const probeError: ProbeErrorSummary | undefined =
      lastProbeError === undefined ? undefined : { last: lastProbeError, threwPolls, totalPolls };
    const elapsed = now() - startedAt;
    const stallArmed =
      explicitLiveness !== undefined
        ? explicitLiveness === 'boot'
        : !hasBootCompleted(snapshot.lines);
    if (stallArmed && now() - lastProgressAt >= stallMs) {
      throw new ReadySignalGiveUp(
        describeFailure('stalled', options.what, elapsed, stallMs, snapshot, probeError),
        giveUpReason('stall', snapshot),
      );
    }
    if (elapsed >= capMs) {
      throw new ReadySignalGiveUp(
        describeFailure('cap', options.what, elapsed, stallMs, snapshot, probeError),
        giveUpReason('cap', snapshot),
      );
    }
    await sleep(pollMs);
  }
}

export type WindowMode = 'editor' | 'navigator' | 'terminal' | 'note';

interface ModeProbePage {
  evaluate(fn: () => string | undefined): Promise<string | undefined>;
}

interface ModeProbeApp<TPage> {
  windows(): TPage[];
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
  gaveUp: boolean;
  reason: ReadyWaitGiveUpReason;
}

const READY_WAITS_BY_APP = new WeakMap<object, ReadyWaitRecord[]>();

export function rememberLaunchHome(app: object, home: string): void {
  HOME_BY_APP.set(app, home);
}

export function tryLaunchHomeFor(app: object): string | undefined {
  return HOME_BY_APP.get(app);
}

export function rememberBootLog(app: object, lines: readonly string[]): void {
  if (lines.length === 0) return;
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
  const startedAt = Date.now();
  let succeeded = false;
  let reason: ReadyWaitGiveUpReason = 'none';
  try {
    const found = await waitForReadySignal<TPage>({
      home,
      what,
      ...(options.liveness !== undefined ? { liveness: options.liveness } : {}),
      ...(options.stallMs !== undefined ? { stallMs: options.stallMs } : {}),
      capMs,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      probe: async () => {
        let lastError: Error | undefined;
        let readCleanly = false;
        for (const page of app.windows()) {
          try {
            const found = await evaluateWindowMode(page);
            readCleanly = true;
            if (found === mode) return page;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
          }
        }
        if (!readCleanly && lastError !== undefined) throw lastError;
        return undefined;
      },
    });
    succeeded = true;
    rememberBootLog(app, readBootLogLines(home));
    return found;
  } catch (error) {
    if (error instanceof ReadySignalGiveUp) reason = error.reason;
    throw error;
  } finally {
    rememberReadyWait(app, {
      what,
      elapsedMs: Date.now() - startedAt,
      capMs,
      gaveUp: !succeeded,
      reason,
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
