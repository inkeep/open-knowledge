import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, vi } from 'vitest';
import type { WaterfallPhase } from '../../../src/main/startup-waterfall.ts';
import {
  BOOT_HEARTBEAT_EVENTS,
  DESKTOP_BOOT_EVENT,
  DESKTOP_OPEN_PROJECT_FAILED_EVENT,
  SPAWN_WAIT_HEARTBEAT_MS,
  startupMarkLine,
  UTILITY_INIT_TIMEOUT_MS,
} from '../../../src/shared/boot-narration.ts';
import {
  BOOT_LOG_CAP_MS,
  BOOT_LOG_POLL_MS,
  BOOT_LOG_STALL_MS,
  bootLogDirFor,
  EVERY_STARTUP_PHASE,
  type LaunchAdvancement,
  type ReadinessPath,
  type ReadyWaitGiveUpReason,
  readinessWorstCaseMs,
  readyWaitsFor,
  UTILITY_TIMEOUT_OBSERVATION_MARGIN_MS,
  type WaitForWindowOptions,
  waitForWindowByMode,
} from './launch-readiness.ts';

export type ReadinessCallOptions = Pick<WaitForWindowOptions, 'capMs' | 'stallMs' | 'pollMs'>;

export const READINESS_PATHS: readonly ReadinessPath[] = ['fork', 'packaged'];

interface ReadinessCall {
  label: string;
  source: string;
  options: ReadinessCallOptions;
}

export const READINESS_CALLS: readonly ReadinessCall[] = [
  {
    label: 'a plain call',
    source: 'return waitForWindowByMode(app, mode);',
    options: {},
  },
  {
    label: 'a call with an inline capMs',
    source: "waitForWindowByMode(app, 'navigator', { capMs: 60_000 })",
    options: { capMs: 60_000 },
  },
  {
    label: 'a call whose capMs falls between two polls',
    source: `waitForWindowByMode(app, 'editor', { capMs: ${BOOT_LOG_CAP_MS + 1} })`,
    options: { capMs: BOOT_LOG_CAP_MS + 1 },
  },
  {
    label: 'a call with an inline stallMs',
    source: `waitForWindowByMode(app, 'editor', { stallMs: ${2 * BOOT_LOG_STALL_MS} })`,
    options: { stallMs: 2 * BOOT_LOG_STALL_MS },
  },
];

export function pollIntervalOf(options: ReadinessCallOptions): number {
  return options.pollMs ?? BOOT_LOG_POLL_MS;
}

function firstPollAtOrAfter(atMs: number, pollMs: number): number {
  return Math.ceil(atMs / pollMs) * pollMs;
}

interface NarrationLine {
  atMs: number;
  text: string;
}

type HomeLog = 'own' | 'earlier';

interface UnreadableStretch {
  log: HomeLog;
  fromMs: number;
  untilMs: number;
}

export interface ScriptedLaunch {
  name: string;
  options: ReadinessCallOptions;
  narrationUntil: (untilMs: number) => NarrationLine[];
  earlierLog?: readonly NarrationLine[];
  unreadable?: UnreadableStretch;
}

const WAIT_STARTED_AT = Date.UTC(2026, 8, 24);

function lineAt(atMs: number, body: Record<string, unknown>): NarrationLine {
  return {
    atMs,
    text: JSON.stringify({ time: new Date(WAIT_STARTED_AT + atMs).toISOString(), ...body }),
  };
}

function stageAt(phase: WaterfallPhase, atMs: number): NarrationLine {
  return lineAt(atMs, startupMarkLine(phase, atMs));
}

function utilityBeatAt(atMs: number, elapsedMs: number): NarrationLine {
  return lineAt(atMs, {
    event: BOOT_HEARTBEAT_EVENTS.utilityWait,
    elapsedMs,
    initTimeoutMs: UTILITY_INIT_TIMEOUT_MS,
  });
}

function utilityBeatsOnTheAppsCadenceFrom(forkAtMs: number): NarrationLine[] {
  const beats: NarrationLine[] = [];
  for (
    let elapsedMs = SPAWN_WAIT_HEARTBEAT_MS;
    elapsedMs <= UTILITY_INIT_TIMEOUT_MS;
    elapsedMs += SPAWN_WAIT_HEARTBEAT_MS
  ) {
    beats.push(utilityBeatAt(forkAtMs + elapsedMs, elapsedMs));
  }
  return beats;
}

function launchOpenedBeforeTheWait(pollMs: number): NarrationLine[] {
  return [lineAt(-pollMs, { event: DESKTOP_BOOT_EVENT }), stageAt('appReady', -pollMs)];
}

function mainNarratesUntil(untilMs: number): NarrationLine[] {
  const beats: NarrationLine[] = [];
  for (let atMs = SPAWN_WAIT_HEARTBEAT_MS; atMs <= untilMs; atMs += SPAWN_WAIT_HEARTBEAT_MS) {
    beats.push(lineAt(atMs, { event: BOOT_HEARTBEAT_EVENTS.boot, elapsedMs: atMs }));
  }
  return beats;
}

function waitBudgets(options: ReadinessCallOptions) {
  return {
    capMs: options.capMs ?? BOOT_LOG_CAP_MS,
    stallMs: options.stallMs ?? BOOT_LOG_STALL_MS,
    pollMs: pollIntervalOf(options),
  };
}

interface ScriptedStage {
  phase: WaterfallPhase;
  atMs: number;
}

function stagesLandingAsLateAsTheyCanRenew(options: ReadinessCallOptions): ScriptedStage[] {
  const { capMs, stallMs, pollMs } = waitBudgets(options);
  const lastRenewingStageAtMs = capMs + stallMs - pollMs;
  return [
    { phase: 'bootstrapDone', atMs: capMs - pollMs },
    { phase: 'serverSpawned', atMs: lastRenewingStageAtMs - pollMs },
    { phase: 'serverLockReady', atMs: lastRenewingStageAtMs - pollMs },
    { phase: 'windowCreated', atMs: lastRenewingStageAtMs },
    { phase: 'loadUrlResolved', atMs: lastRenewingStageAtMs },
  ];
}

function stagesRenewingAsLateAsTheyCan(options: ReadinessCallOptions): ScriptedLaunch {
  const { pollMs } = waitBudgets(options);
  return {
    name: 'startup stages that each arrive as late as they can still renew the wait',
    options,
    narrationUntil: (untilMs) => [
      ...launchOpenedBeforeTheWait(pollMs),
      ...stagesLandingAsLateAsTheyCanRenew(options).map(({ phase, atMs }) => stageAt(phase, atMs)),
      ...mainNarratesUntil(untilMs),
    ],
  };
}

export function utilityForkTheLastStageKeptAlive(
  options: ReadinessCallOptions,
): ScriptedLaunch & { appVerdictAtMs: number } {
  const { capMs, stallMs, pollMs } = waitBudgets(options);
  const forkAtMs = capMs + stallMs - SPAWN_WAIT_HEARTBEAT_MS;
  const appVerdictAtMs = forkAtMs + UTILITY_INIT_TIMEOUT_MS + pollMs;
  return {
    name: "a utility fork the last startup stage kept alive, beating on the app's own cadence until its budget runs out",
    options,
    appVerdictAtMs,
    narrationUntil: (untilMs) => [
      ...launchOpenedBeforeTheWait(pollMs),
      stageAt('bootstrapDone', capMs - pollMs),
      stageAt('serverSpawned', forkAtMs),
      ...utilityBeatsOnTheAppsCadenceFrom(forkAtMs),
      lineAt(appVerdictAtMs, { event: DESKTOP_OPEN_PROJECT_FAILED_EVENT }),
      ...mainNarratesUntil(untilMs),
    ],
  };
}

export function utilityForkWhoseFirstBeatLandsOnTheLastStagePoll(
  options: ReadinessCallOptions,
): ScriptedLaunch & { appVerdictAtMs: number } {
  const { capMs, stallMs, pollMs } = waitBudgets(options);
  const forkAtMs = firstPollAtOrAfter(capMs + stallMs, pollMs) - SPAWN_WAIT_HEARTBEAT_MS;
  const appVerdictAtMs = forkAtMs + UTILITY_INIT_TIMEOUT_MS + pollMs;
  return {
    name: 'a utility fork whose first beat lands on the last poll the stage window allows',
    options,
    appVerdictAtMs,
    narrationUntil: (untilMs) => [
      ...launchOpenedBeforeTheWait(pollMs),
      stageAt('bootstrapDone', capMs - pollMs),
      stageAt('serverSpawned', forkAtMs),
      ...utilityBeatsOnTheAppsCadenceFrom(forkAtMs),
      lineAt(appVerdictAtMs, { event: DESKTOP_OPEN_PROJECT_FAILED_EVENT }),
      ...mainNarratesUntil(untilMs),
    ],
  };
}

function budgetDeclaredButNeverSpent(options: ReadinessCallOptions): ScriptedLaunch {
  const { pollMs } = waitBudgets(options);
  const everyMs = UTILITY_TIMEOUT_OBSERVATION_MARGIN_MS - pollMs;
  return {
    name: 'utility beats the parser accepts, whose elapsed time never keeps up with the clock',
    options,
    narrationUntil: (untilMs) => {
      const beats: NarrationLine[] = [];
      let elapsedMs = UTILITY_INIT_TIMEOUT_MS - UTILITY_TIMEOUT_OBSERVATION_MARGIN_MS;
      for (let atMs = everyMs; atMs <= untilMs; atMs += everyMs) {
        elapsedMs += 1;
        beats.push(utilityBeatAt(atMs, elapsedMs));
      }
      return [
        ...launchOpenedBeforeTheWait(pollMs),
        stageAt('bootstrapDone', -pollMs),
        stageAt('serverSpawned', -pollMs),
        ...beats,
      ];
    },
  };
}

export const SCRIPTED_LAUNCHES = [
  stagesRenewingAsLateAsTheyCan,
  utilityForkTheLastStageKeptAlive,
  budgetDeclaredButNeverSpent,
] as const;

export const LAUNCH_REACHING_THE_CEILING_OF: Readonly<
  Record<ReadinessPath, (options: ReadinessCallOptions) => ScriptedLaunch>
> = {
  fork: budgetDeclaredButNeverSpent,
  packaged: stagesRenewingAsLateAsTheyCan,
};

function anEarlierLaunchThatFinished(pollMs: number, finishedAtMs = 0): NarrationLine[] {
  return [
    lineAt(finishedAtMs - (EVERY_STARTUP_PHASE.length + 1) * pollMs, { event: DESKTOP_BOOT_EVENT }),
    ...EVERY_STARTUP_PHASE.map((phase, index) =>
      stageAt(phase, finishedAtMs + (index - EVERY_STARTUP_PHASE.length) * pollMs),
    ),
  ];
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function aLaunchThatFinishedTheDayBefore(pollMs: number): NarrationLine[] {
  return anEarlierLaunchThatFinished(pollMs, -ONE_DAY_MS);
}

export function launchBootingAfterTheWaitsFirstRead(
  options: ReadinessCallOptions,
  home: { sharedWithAnEarlierLaunch: boolean },
): ScriptedLaunch & { bootAtMs: number; ownStageEvents: readonly string[] } {
  const { pollMs } = waitBudgets(options);
  const bootAtMs = pollMs / 2;
  const ownStages: ScriptedStage[] = [
    { phase: 'appReady', atMs: bootAtMs },
    ...stagesLandingAsLateAsTheyCanRenew(options),
  ];
  return {
    name: home.sharedWithAnEarlierLaunch
      ? "a launch booting after the wait's first read, into a home whose log an earlier launch already filled"
      : "a launch booting after the wait's first read, alone in its home",
    options,
    bootAtMs,
    ownStageEvents: ownStages.map(({ phase }) => startupMarkLine(phase, 0).event),
    narrationUntil: (untilMs) => [
      ...(home.sharedWithAnEarlierLaunch ? anEarlierLaunchThatFinished(pollMs) : []),
      lineAt(bootAtMs, { event: DESKTOP_BOOT_EVENT }),
      ...ownStages.map(({ phase, atMs }) => stageAt(phase, atMs)),
      ...mainNarratesUntil(untilMs),
    ],
  };
}

function anEarlierLaunchThatStoppedInItsUtilityWait(pollMs: number): NarrationLine[] {
  const forkAtMs = -(UTILITY_INIT_TIMEOUT_MS + pollMs);
  return [
    lineAt(forkAtMs - 2 * pollMs, { event: DESKTOP_BOOT_EVENT }),
    stageAt('appReady', forkAtMs - 2 * pollMs),
    stageAt('bootstrapDone', forkAtMs - pollMs),
    stageAt('serverSpawned', forkAtMs),
    ...utilityBeatsOnTheAppsCadenceFrom(forkAtMs),
  ];
}

export function utilityForkBootingAfterTheWaitsFirstRead(
  options: ReadinessCallOptions,
  home: { sharedWithALaunchThatStoppedInItsUtilityWait: boolean },
): ScriptedLaunch & { appVerdictAtMs: number } {
  const { capMs, pollMs } = waitBudgets(options);
  const bootAtMs = pollMs / 2;
  const forkAtMs = capMs - SPAWN_WAIT_HEARTBEAT_MS;
  const appVerdictAtMs = forkAtMs + UTILITY_INIT_TIMEOUT_MS + pollMs;
  return {
    name: home.sharedWithALaunchThatStoppedInItsUtilityWait
      ? "a utility fork booting after the wait's first read, into a home an earlier launch left inside its utility wait"
      : "a utility fork booting after the wait's first read, alone in its home",
    options,
    appVerdictAtMs,
    narrationUntil: (untilMs) => [
      ...(home.sharedWithALaunchThatStoppedInItsUtilityWait
        ? anEarlierLaunchThatStoppedInItsUtilityWait(pollMs)
        : []),
      lineAt(bootAtMs, { event: DESKTOP_BOOT_EVENT }),
      stageAt('appReady', bootAtMs),
      stageAt('bootstrapDone', forkAtMs - pollMs),
      stageAt('serverSpawned', forkAtMs),
      ...utilityBeatsOnTheAppsCadenceFrom(forkAtMs),
      lineAt(appVerdictAtMs, { event: DESKTOP_OPEN_PROJECT_FAILED_EVENT }),
      ...mainNarratesUntil(untilMs),
    ],
  };
}

export function utilityForkTheLastStageKeptAliveBesideTheDayBeforesLog(
  options: ReadinessCallOptions,
  ownLog: { unreadableOnOnePollOfTheDeclaredGrant: boolean },
): ScriptedLaunch & { appVerdictAtMs: number } {
  const launch = utilityForkTheLastStageKeptAlive(options);
  const { pollMs } = waitBudgets(options);
  const unreadableAtMs =
    firstPollAtOrAfter(readinessWorstCaseMs({ path: 'packaged', ...options }), pollMs) + pollMs;
  const unreadable: UnreadableStretch = {
    log: 'own',
    fromMs: unreadableAtMs,
    untilMs: unreadableAtMs + pollMs,
  };
  return {
    ...launch,
    name: ownLog.unreadableOnOnePollOfTheDeclaredGrant
      ? `${launch.name}, beside the log a launch the day before left, its own log unreadable on one poll of the grant it declared`
      : `${launch.name}, beside the log a launch the day before left`,
    earlierLog: aLaunchThatFinishedTheDayBefore(pollMs),
    ...(ownLog.unreadableOnOnePollOfTheDeclaredGrant ? { unreadable } : {}),
  };
}

export function launchBootingAfterTheWaitsFirstReadBesideTheDayBeforesLog(
  options: ReadinessCallOptions,
  earlierLog: { unreadableFromTheBootUntilMainsFirstHeartbeat: boolean },
): ScriptedLaunch & { ownStageEvents: readonly string[] } {
  const launch = launchBootingAfterTheWaitsFirstRead(options, { sharedWithAnEarlierLaunch: false });
  const { pollMs } = waitBudgets(options);
  const unreadable: UnreadableStretch = {
    log: 'earlier',
    fromMs: launch.bootAtMs,
    untilMs: SPAWN_WAIT_HEARTBEAT_MS,
  };
  return {
    ...launch,
    name: earlierLog.unreadableFromTheBootUntilMainsFirstHeartbeat
      ? "a launch booting after the wait's first read, beside the log a launch the day before left, which cannot be read from the boot until main's first heartbeat"
      : "a launch booting after the wait's first read, beside the log a launch the day before left",
    earlierLog: aLaunchThatFinishedTheDayBefore(pollMs),
    ...(earlierLog.unreadableFromTheBootUntilMainsFirstHeartbeat ? { unreadable } : {}),
  };
}

export interface GiveUp {
  gaveUpAtMs: number;
  message: string;
  reason: ReadyWaitGiveUpReason;
  decidingCapMs: number | undefined;
  declaredGrantMs: number | undefined;
  advancements: readonly LaunchAdvancement[];
}

type Reach = GiveUp | { admittedAtMs: number } | { stillWaitingAtMs: number };

function isGiveUp(reach: Reach): reach is GiveUp {
  return 'gaveUpAtMs' in reach;
}

export function giveUpOf(reach: Reach, launch: ScriptedLaunch): GiveUp {
  assert(
    isGiveUp(reach),
    `the readiness wait on ${launch.name} gave up, but it reached ${JSON.stringify(reach)}`,
  );
  return reach;
}

const reachCache = new Map<string, Reach>();

function byTime(lines: readonly NarrationLine[]): NarrationLine[] {
  return [...lines].sort((a, b) => a.atMs - b.atMs);
}

function dailyLogFileOf(launchLines: readonly NarrationLine[]): string {
  const startedAt = new Date(WAIT_STARTED_AT + (launchLines[0]?.atMs ?? 0));
  return `desktop.${startedAt.toISOString().slice(0, 10)}.log`;
}

async function waitOutLaunch(launch: ScriptedLaunch, watchMs: number): Promise<Reach> {
  const home = mkdtempSync(join(tmpdir(), 'ok-readiness-reach-'));
  vi.useFakeTimers({ now: WAIT_STARTED_AT, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    mkdirSync(bootLogDirFor(home), { recursive: true });
    const logs: { which: HomeLog; lines: NarrationLine[] }[] = [
      { which: 'own', lines: byTime(launch.narrationUntil(watchMs)) },
      ...(launch.earlierLog === undefined
        ? []
        : [{ which: 'earlier' as const, lines: byTime(launch.earlierLog) }]),
    ];
    const { unreadable } = launch;
    const publish = (atMs: number): void => {
      for (const log of logs) {
        const file = join(bootLogDirFor(home), dailyLogFileOf(log.lines));
        rmSync(file, { recursive: true, force: true });
        if (
          unreadable?.log === log.which &&
          atMs >= unreadable.fromMs &&
          atMs < unreadable.untilMs
        ) {
          mkdirSync(file);
          continue;
        }
        writeFileSync(
          file,
          log.lines
            .filter((line) => line.atMs <= atMs)
            .map((line) => `${line.text}\n`)
            .join(''),
          'utf8',
        );
      }
    };
    publish(0);
    const changesAtMs = new Set([
      ...logs.flatMap((log) => log.lines.map((line) => line.atMs)),
      ...(unreadable === undefined ? [] : [unreadable.fromMs, unreadable.untilMs]),
    ]);
    for (const atMs of [...changesAtMs].sort((a, b) => a - b)) {
      if (atMs > 0) setTimeout(() => publish(atMs), atMs);
    }
    const neverAnswers = { evaluate: () => new Promise<string | undefined>(() => {}) };
    const app = { windows: () => [neverAnswers] };
    let reach: Reach | undefined;
    let failure: { error: unknown } | undefined;
    void waitForWindowByMode(app, 'editor', {
      home,
      ...launch.options,
    }).then(
      () => {
        reach = { admittedAtMs: Date.now() - WAIT_STARTED_AT };
      },
      (error: unknown) => {
        const recorded = readyWaitsFor(app)?.[0];
        if (recorded === undefined || recorded.reason === 'none') {
          failure = { error };
          return;
        }
        reach = {
          gaveUpAtMs: Date.now() - WAIT_STARTED_AT,
          message: error instanceof Error ? error.message : String(error),
          reason: recorded.reason,
          decidingCapMs: recorded.capMs,
          declaredGrantMs: recorded.declaredGrantMs,
          advancements: recorded.advancements,
        };
      },
    );
    await vi.advanceTimersByTimeAsync(watchMs);
    if (failure !== undefined) throw failure.error;
    return reach ?? { stillWaitingAtMs: Date.now() - WAIT_STARTED_AT };
  } finally {
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  }
}

export async function reachOf(launch: ScriptedLaunch, watchMs: number): Promise<Reach> {
  const key = JSON.stringify([launch.name, launch.options, watchMs]);
  const cached = reachCache.get(key);
  if (cached !== undefined) return cached;
  const reach = await waitOutLaunch(launch, watchMs);
  reachCache.set(key, reach);
  return reach;
}
