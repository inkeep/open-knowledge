import {
  type Dirent,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  MINIDUMP_FILE_EXTENSION,
  type OkBugReportCrashDetectedEvent,
} from '@inkeep/open-knowledge-core';
import { asReportableAppVersion } from './crashed-app-version.ts';
import type { DesktopCrashProcessSnapshot } from './desktop-process-observability.ts';
import {
  classifyPreviousLiveness,
  classifyPreviousStall,
  isFileMissingError,
  livenessLogFields,
  type MainThreadWatchdog,
  type MainThreadWatchdogHandle,
  type PreviousFileRead,
  readPreviousFile,
  stallLogFields,
} from './main-thread-watchdog.ts';
import {
  classifyMinidumpCrashKind,
  classifyMinidumpOwnership,
  type MinidumpCrashKind,
  type MinidumpOwnership,
  readMinidumpAccessibilityMode,
  readMinidumpAppVersion,
  readMinidumpProcessType,
} from './minidump-ownership.ts';

const CRASH_REASONS = new Set(['crashed', 'oom', 'launch-failed', 'integrity-failure']);

export function isProcessCrashReason(reason: string): boolean {
  return CRASH_REASONS.has(reason);
}

const GPU_PROCESS_TYPE = 'GPU';

const GPU_DUMP_PROCESS_TYPE = 'gpu-process';

export const GPU_CRASH_INVITE_THRESHOLD = 3;

export const GPU_CRASH_WINDOW_MS = 5 * 60_000;

const INVITE_SUPERSEDE_AFTER_MS = 5 * 60_000;

export const HANDOFF_TEARDOWN_WINDOW_MS = 30_000;

export const INVITE_EXPIRE_AFTER_MS = 24 * 60 * 60_000;

export const STALE_CRASH_AFTER_MS = 7 * 24 * 60 * 60_000;

const MAX_ACKED_EVENT_IDS = 50;

const MAX_BOUND_INVITATIONS = 16;

const DEATH_DUMP_MATCH_MS = 30_000;

export const MAX_DECLINED_DEATHS = 600;

const MINIDUMP_SCAN_DEPTH = 3;

const OS_SHUTDOWN_MARKER_TTL_MS = 120_000;

export const SENTINEL_HEARTBEAT_INTERVAL_MS = 60_000;

interface CrashLogger {
  info(payload: Record<string, unknown>, msg: string): void;
  warn(payload: Record<string, unknown>, msg: string): void;
}

interface DeclinedDeath {
  at: string;
  processType: string;
}

type ProcessTypeRead = 'named' | 'unnamed' | 'parse-failed' | 'not-asked';

interface DeclinedDeathMatch {
  matched: DeclinedDeath | null;
  read: ProcessTypeRead;
}

interface ClassifiedDump {
  entry: MinidumpEntry;
  ownership: MinidumpOwnership;
  crashKind: MinidumpCrashKind | null;
  declined: DeclinedDeathMatch;
  handoffShadowed: boolean;
}

interface CrashAckStore {
  ackedEventIds: string[];
  minidumpBaselineAt: string;
  declinedDeaths: DeclinedDeath[];
}

interface SentinelState {
  bootId: string;
  startedAt: string;
  lastAliveAt: string;
  bootSessionUuid?: string;
  pendingOsShutdownAt?: string;
  osShutdownReasons?: string[];
  suspendedAt?: string;
  appVersion?: string;
}

export interface MainExitRecord {
  readonly schemaVersion: 1;
  readonly bootId: string;
  readonly exitedAt: string;
  readonly exitCode: number;
}

type MainExitEvidence = 'matched' | 'absent' | 'unreadable' | 'no-previous-boot' | 'boot-mismatch';

interface MainExitLogFields {
  mainExit: { exitCode: number; exitedAt: string } | null;
  mainExitEvidence: MainExitEvidence;
}

export function parseMainExitRecord(raw: string): MainExitRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (p.schemaVersion !== 1) return null;
  if (typeof p.bootId !== 'string' || p.bootId === '') return null;
  if (typeof p.exitedAt !== 'string' || !Number.isFinite(Date.parse(p.exitedAt))) return null;
  if (typeof p.exitCode !== 'number' || !Number.isInteger(p.exitCode)) return null;
  return { schemaVersion: 1, bootId: p.bootId, exitedAt: p.exitedAt, exitCode: p.exitCode };
}

function mainExitLogFields(
  read: PreviousFileRead<MainExitRecord>,
  prevBootId: string | null,
): MainExitLogFields {
  if (read.kind !== 'record') return { mainExit: null, mainExitEvidence: read.kind };
  if (prevBootId === null) return { mainExit: null, mainExitEvidence: 'no-previous-boot' };
  if (read.value.bootId !== prevBootId)
    return { mainExit: null, mainExitEvidence: 'boot-mismatch' };
  return {
    mainExit: { exitCode: read.value.exitCode, exitedAt: read.value.exitedAt },
    mainExitEvidence: 'matched',
  };
}

export interface CrashDetectionDeps {
  sentinelPath: string;
  mainExitPath: string;
  ackStorePath: string;
  crashDumpsDir: string;
  appBundleRoot: string;
  appVersion: string;
  platform?: NodeJS.Platform;
  emit(event: OkBugReportCrashDetectedEvent): boolean;
  now(): Date;
  currentBootSessionUuid(): string | null;
  installInFlight?(span: { deathFromMs: number; deathToMs: number }): InstallInFlight | null;
  mainThreadWatchdog: Pick<MainThreadWatchdog, 'readPrevious' | 'readPreviousStall' | 'start'>;
  logger: CrashLogger;
}

export interface InstallInFlight {
  attemptedVersion: string;
  handoffAt: number;
  recordedHandoff: boolean;
}

export interface CrashDetection {
  detectBootCrash(): OkBugReportCrashDetectedEvent | null;
  markCleanQuit(): void;
  noteProcessExit(code: number): void;
  noteAlive(): void;
  noteOsShutdown(reasons?: readonly string[]): void;
  noteSuspend(): void;
  noteResume(): void;
  handleRenderProcessGone(details: {
    reason: string;
    exitCode?: number;
    processSnapshot?: DesktopCrashProcessSnapshot;
  }): void;
  handleChildProcessGone(details: {
    type: string;
    reason: string;
    exitCode?: number;
    name?: string;
    serviceName?: string;
    processSnapshot?: DesktopCrashProcessSnapshot;
  }): void;
  notifyRendererReady(): void;
  ack(eventId: string): void;
  newestMinidumpForReport(): MinidumpReportLookup;
  minidumpForCrashEvent(eventId: string): CrashEventMinidumpLookup;
}

export interface MinidumpReportLookup {
  path: string | null;
  foreignSkipped: number;
  unknownSkipped: number;
}

export type BoundMinidumpOmission =
  | 'invitation-unbound'
  | 'bound-dump-missing'
  | 'bound-dump-changed'
  | 'bound-dump-ambiguous'
  | 'bound-dump-not-owned'
  | 'bound-dump-unreadable'
  | 'bound-dump-non-crash';

export type CrashEventMinidumpLookup =
  | { status: 'bound'; path: string }
  | { status: 'none-bound' }
  | { status: 'omitted'; reason: BoundMinidumpOmission };

interface BoundMinidump {
  fileName: string;
  sizeBytes: number;
  mtimeMs: number;
}

type WithoutMinidumpAvailable<E> = E extends unknown ? Omit<E, 'minidumpAvailable'> : never;

type RuntimeCrashEventDraft = WithoutMinidumpAvailable<
  Exclude<OkBugReportCrashDetectedEvent, { kind: 'boot' }>
>;

type SettledFrom = 'scan' | 'held' | 'held-missing' | 'none';

type InvitationBinding =
  | { state: 'settled'; dump: BoundMinidump | null }
  | { state: 'settling'; deathMs: number; dump: BoundMinidump | null };

interface DeathWindowScan {
  entry: MinidumpEntry | null;
  dumpsNearDeath: number;
  acknowledgedSkipped: number;
  foreignSkipped: number;
  unknownSkipped: number;
  nonCrashSkipped: number;
  declinedSkipped: number;
}

function deathWindowFacts(scan: DeathWindowScan): Record<string, string | number | null> {
  return {
    deathWindowOutcome:
      scan.entry !== null
        ? 'bound'
        : scan.dumpsNearDeath === 0
          ? 'no-dump-near-death'
          : 'none-attachable',
    deathWindowDump: scan.entry === null ? null : basename(scan.entry.path),
    deathWindowDumpCount: scan.dumpsNearDeath,
    deathWindowAcknowledgedSkipped: scan.acknowledgedSkipped,
    deathWindowForeignSkipped: scan.foreignSkipped,
    deathWindowUnreadableSkipped: scan.unknownSkipped,
    deathWindowSnapshotSkipped: scan.nonCrashSkipped,
    deathWindowDeclinedSkipped: scan.declinedSkipped,
  };
}

function toBoundMinidump(entry: MinidumpEntry): BoundMinidump {
  return { fileName: basename(entry.path), sizeBytes: entry.sizeBytes, mtimeMs: entry.mtimeMs };
}

export function startLocalCrashReporter(reporter: {
  start(options: { uploadToServer: boolean }): void;
}): void {
  reporter.start({ uploadToServer: false });
}

function epochMsOrNull(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function parseDeclinedDeaths(raw: unknown): DeclinedDeath[] {
  if (!Array.isArray(raw)) return [];
  const out: DeclinedDeath[] = [];
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))) continue;
    if (typeof entry.processType !== 'string' || entry.processType === '') continue;
    out.push({ at: entry.at, processType: entry.processType });
  }
  return out;
}

function parseAckStore(raw: string): CrashAckStore | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (!Array.isArray(p.ackedEventIds)) return null;
    if (!p.ackedEventIds.every((id): id is string => typeof id === 'string')) return null;
    if (typeof p.minidumpBaselineAt !== 'string') return null;
    if (!Number.isFinite(Date.parse(p.minidumpBaselineAt))) return null;
    return {
      ackedEventIds: p.ackedEventIds,
      minidumpBaselineAt: p.minidumpBaselineAt,
      declinedDeaths: parseDeclinedDeaths(p.declinedDeaths),
    };
  } catch {
    return null;
  }
}

interface MinidumpEntry {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

function collectMinidumpEntries(dir: string, depth: number, out: MinidumpEntry[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) collectMinidumpEntries(entryPath, depth - 1, out);
      continue;
    }
    if (!entry.name.endsWith(MINIDUMP_FILE_EXTENSION)) continue;
    try {
      const stats = statSync(entryPath);
      out.push({ path: entryPath, mtimeMs: stats.mtimeMs, sizeBytes: stats.size });
    } catch {}
  }
}

export function createCrashDetection(deps: CrashDetectionDeps): CrashDetection {
  let active: {
    event: OkBugReportCrashDetectedEvent;
    delivered: boolean;
    armedAtMs: number;
  } | null = null;
  let runtimeSeq = 0;
  const boundDumps = new Map<string, InvitationBinding>();

  let recentGpuCrashes: number[] = [];

  let sentinel: SentinelState | null = null;
  let cleanQuitMarked = false;
  let watchdog: MainThreadWatchdogHandle | null = null;

  type SentinelWriteContext = 'arm' | 'alive' | 'os-shutdown' | 'suspend' | 'resume';

  function writeSentinel(context: SentinelWriteContext): void {
    if (sentinel === null || cleanQuitMarked) return;
    try {
      mkdirSync(dirname(deps.sentinelPath), { recursive: true });
      writeFileSync(deps.sentinelPath, `${JSON.stringify(sentinel)}\n`);
    } catch (err) {
      deps.logger.warn(
        {
          event: 'crash-detection.sentinel-write-failed',
          context,
          err,
        },
        context === 'arm'
          ? 'could not arm the dirty-shutdown sentinel'
          : 'could not update the dirty-shutdown sentinel',
      );
    }
  }

  let storeNeedsInit = false;
  let store: CrashAckStore;
  {
    let parsed: CrashAckStore | null = null;
    try {
      parsed = parseAckStore(readFileSync(deps.ackStorePath, 'utf8'));
    } catch {}
    if (parsed === null) {
      store = {
        ackedEventIds: [],
        minidumpBaselineAt: deps.now().toISOString(),
        declinedDeaths: [],
      };
      storeNeedsInit = true;
    } else {
      store = parsed;
    }
  }

  type StoreWriteContext = 'init' | 'ack' | 'record-declined-death' | 'clear-declined-deaths';

  function persistStore(context: StoreWriteContext): void {
    try {
      mkdirSync(dirname(deps.ackStorePath), { recursive: true });
      writeFileSync(deps.ackStorePath, `${JSON.stringify(store)}\n`);
    } catch (err) {
      const failsClosed = context === 'clear-declined-deaths';
      deps.logger.warn(
        { event: 'crash-detection.store-write-failed', context, failsClosed, err },
        failsClosed
          ? 'could not forget declined deaths — the next boot may suppress the report for this crash'
          : 'could not persist crash acknowledgment state',
      );
    }
  }

  function recordDeclinedDeath(processType: string): void {
    store.declinedDeaths.push({ at: deps.now().toISOString(), processType });
    if (store.declinedDeaths.length > MAX_DECLINED_DEATHS) {
      store.declinedDeaths.splice(0, store.declinedDeaths.length - MAX_DECLINED_DEATHS);
    }
    persistStore('record-declined-death');
  }

  function clearDeclinedDeaths(processType: string): void {
    const cleared = store.declinedDeaths.filter(
      (declined) => declined.processType === processType,
    ).length;
    if (cleared === 0) return;
    store.declinedDeaths = store.declinedDeaths.filter(
      (declined) => declined.processType !== processType,
    );
    deps.logger.info(
      { event: 'crash-detection.declined-deaths-cleared', processType, cleared },
      'a death of this kind was raised, so its earlier declines no longer retire dumps',
    );
    persistStore('clear-declined-deaths');
  }

  function declinedDeathForDump(entry: MinidumpEntry): DeclinedDeathMatch {
    const near = store.declinedDeaths.filter((declined) => {
      const at = epochMsOrNull(declined.at);
      return at !== null && Math.abs(entry.mtimeMs - at) <= DEATH_DUMP_MATCH_MS;
    });
    if (near.length === 0) return { matched: null, read: 'not-asked' };
    const { processType, parseFailed } = readMinidumpProcessType(entry.path);
    if (processType === null) {
      return { matched: null, read: parseFailed ? 'parse-failed' : 'unnamed' };
    }
    return {
      matched: near.find((declined) => declined.processType === processType) ?? null,
      read: 'named',
    };
  }

  function tryDeliver(): void {
    if (active === null || active.delivered) return;
    const nowMs = deps.now().getTime();
    const pendingAgeMs = nowMs - active.armedAtMs;
    if (pendingAgeMs >= INVITE_EXPIRE_AFTER_MS) {
      deps.logger.info(
        {
          event: 'crash-detection.invitation-expired',
          eventId: active.event.eventId,
          pendingAgeMs,
          expireAfterMs: INVITE_EXPIRE_AFTER_MS,
        },
        'crash invitation went unanswered past its staleness bound — dropping it undelivered',
      );
      active = null;
      return;
    }
    if (boundDumps.get(active.event.eventId)?.state === 'settling') {
      const minidumpAvailable =
        (settleInvitation(active.event.eventId, nowMs)?.dump ?? null) !== null;
      if (active.event.minidumpAvailable !== minidumpAvailable) {
        deps.logger.info(
          {
            event: 'crash-detection.invitation-dump-availability-changed',
            eventId: active.event.eventId,
            minidumpAvailable,
          },
          'the dump of this death changed before the invitation was delivered',
        );
        active.event = { ...active.event, minidumpAvailable };
      }
    }
    if (deps.emit(active.event)) {
      active.delivered = true;
    }
  }

  function bindInvitation(eventId: string, binding: InvitationBinding): void {
    boundDumps.delete(eventId);
    boundDumps.set(eventId, binding);
    while (boundDumps.size > MAX_BOUND_INVITATIONS) {
      const oldest = boundDumps.keys().next();
      if (oldest.done === true) break;
      boundDumps.delete(oldest.value);
    }
  }

  function listMinidumpEntries(): MinidumpEntry[] {
    const entries: MinidumpEntry[] = [];
    collectMinidumpEntries(deps.crashDumpsDir, MINIDUMP_SCAN_DEPTH, entries);
    return entries;
  }

  function scanDeathWindow(
    deathMs: number,
    entries: readonly MinidumpEntry[] = listMinidumpEntries(),
  ): DeathWindowScan {
    const near = entries
      .map((entry) => ({ entry, distanceMs: Math.abs(entry.mtimeMs - deathMs) }))
      .filter(({ distanceMs }) => distanceMs <= DEATH_DUMP_MATCH_MS)
      .sort((a, b) => a.distanceMs - b.distanceMs || a.entry.mtimeMs - b.entry.mtimeMs);
    const baselineMs = Date.parse(store.minidumpBaselineAt);
    const scan: DeathWindowScan = {
      entry: null,
      dumpsNearDeath: near.length,
      acknowledgedSkipped: 0,
      foreignSkipped: 0,
      unknownSkipped: 0,
      nonCrashSkipped: 0,
      declinedSkipped: 0,
    };
    for (const { entry } of near) {
      if (!(entry.mtimeMs > baselineMs)) {
        scan.acknowledgedSkipped += 1;
        continue;
      }
      const ownership = classifyDump(entry.path);
      if (ownership !== 'ours') {
        if (ownership === 'foreign') scan.foreignSkipped += 1;
        else scan.unknownSkipped += 1;
        continue;
      }
      if (crashKindOf(entry.path) === 'non-crash') {
        scan.nonCrashSkipped += 1;
        continue;
      }
      if (declinedDeathForDump(entry).matched !== null) {
        scan.declinedSkipped += 1;
        continue;
      }
      scan.entry = entry;
      break;
    }
    return scan;
  }

  function findHeldDump(
    dump: BoundMinidump,
    entries: readonly MinidumpEntry[],
  ): BoundMinidump | null {
    const matches = entries.filter((entry) => basename(entry.path) === dump.fileName);
    const match = matches[0];
    if (match === undefined) return null;
    return matches.length === 1 ? toBoundMinidump(match) : dump;
  }

  function settleBinding(
    eventId: string,
    binding: InvitationBinding,
    nowMs: number,
  ): InvitationBinding {
    if (binding.state === 'settled') return binding;
    const windowOpen = nowMs < binding.deathMs + DEATH_DUMP_MATCH_MS;
    const entries = listMinidumpEntries();
    const scan = scanDeathWindow(binding.deathMs, entries);
    const held = binding.dump === null ? null : findHeldDump(binding.dump, entries);
    const heldDumpVanished = binding.dump !== null && held === null;
    let settledFrom: SettledFrom = heldDumpVanished ? 'held-missing' : 'none';
    if (!heldDumpVanished) {
      if (scan.entry !== null) {
        const next = toBoundMinidump(scan.entry);
        if (binding.dump === null) {
          deps.logger.info(
            { event: 'crash-detection.invitation-dump-bound', eventId, ...deathWindowFacts(scan) },
            'a dump of this death appeared after the invitation armed and is now bound to it',
          );
        } else if (binding.dump.fileName !== next.fileName) {
          deps.logger.info(
            {
              event: 'crash-detection.invitation-dump-rebound',
              eventId,
              previousDump: binding.dump.fileName,
              ...deathWindowFacts(scan),
            },
            'a dump closer to this death replaced the one bound to its invitation',
          );
        }
        binding.dump = next;
        settledFrom = 'scan';
      } else if (held !== null) {
        binding.dump = held;
        settledFrom = 'held';
      }
    }
    if (windowOpen) return binding;
    deps.logger.info(
      {
        event: 'crash-detection.invitation-dump-settled',
        eventId,
        settledDump: binding.dump?.fileName ?? null,
        settledFrom,
        heldDumpVanished,
        ...deathWindowFacts(scan),
      },
      heldDumpVanished
        ? 'the dump bound to this death is gone, so its binding settles on the missing file'
        : 'the dump bound to this death is now fixed',
    );
    return { state: 'settled', dump: binding.dump };
  }

  function settleInvitation(eventId: string, nowMs: number): InvitationBinding | undefined {
    const binding = boundDumps.get(eventId);
    if (binding === undefined) return undefined;
    const settled = settleBinding(eventId, binding, nowMs);
    if (settled !== binding) boundDumps.set(eventId, settled);
    return settled;
  }

  function armRuntimeInvite(
    event: RuntimeCrashEventDraft,
    deathMs: number,
    entry: MinidumpEntry | null,
  ): boolean {
    return armInvite(
      { ...event, minidumpAvailable: entry !== null },
      {
        state: 'settling',
        deathMs,
        dump: entry === null ? null : toBoundMinidump(entry),
      },
    );
  }

  function armInvite(event: OkBugReportCrashDetectedEvent, binding: InvitationBinding): boolean {
    const nowMs = deps.now().getTime();
    if (active !== null) {
      const pendingAgeMs = nowMs - active.armedAtMs;
      if (pendingAgeMs < INVITE_SUPERSEDE_AFTER_MS) {
        deps.logger.info(
          {
            event: 'crash-detection.suppressed',
            eventId: event.eventId,
            pendingEventId: active.event.eventId,
            pendingAgeMs,
          },
          'crash invitation already pending — new signal stays silent',
        );
        return false;
      }
      deps.logger.warn(
        {
          event: 'crash-detection.superseded',
          eventId: event.eventId,
          supersededEventId: active.event.eventId,
          supersededAgeMs: pendingAgeMs,
        },
        'stale crash invitation superseded by a newer crash',
      );
    }
    active = { event, delivered: false, armedAtMs: nowMs };
    bindInvitation(event.eventId, binding);
    return true;
  }

  function noteGpuCrash(): { countInWindow: number; suppressInvite: boolean } {
    const nowMs = deps.now().getTime();
    recentGpuCrashes = recentGpuCrashes.filter((at) => nowMs - at < GPU_CRASH_WINDOW_MS);
    recentGpuCrashes.push(nowMs);
    return {
      countInWindow: recentGpuCrashes.length,
      suppressInvite: recentGpuCrashes.length < GPU_CRASH_INVITE_THRESHOLD,
    };
  }

  function classifyDump(path: string): MinidumpOwnership {
    return classifyMinidumpOwnership(path, deps.appBundleRoot);
  }

  function crashKindOf(path: string) {
    return classifyMinidumpCrashKind(path, deps.platform ?? process.platform);
  }

  function freshMinidumpEntries(): MinidumpEntry[] {
    const entries = listMinidumpEntries();
    const baselineMs = Date.parse(store.minidumpBaselineAt);
    return entries.filter((e) => e.mtimeMs > baselineMs).sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  function newestOwnedMinidump(): {
    entry: MinidumpEntry | null;
    foreignSkipped: number;
    unknownSkipped: number;
    nonCrashSkipped: number;
  } {
    let foreignSkipped = 0;
    let unknownSkipped = 0;
    let nonCrashSkipped = 0;
    for (const entry of freshMinidumpEntries()) {
      const ownership = classifyDump(entry.path);
      if (ownership === 'ours') {
        if (crashKindOf(entry.path) === 'non-crash') {
          nonCrashSkipped += 1;
          continue;
        }
        return { entry, foreignSkipped, unknownSkipped, nonCrashSkipped };
      }
      if (ownership === 'foreign') foreignSkipped += 1;
      else unknownSkipped += 1;
    }
    return { entry: null, foreignSkipped, unknownSkipped, nonCrashSkipped };
  }

  return {
    detectBootCrash(): OkBugReportCrashDetectedEvent | null {
      const detectedAt = deps.now();
      const bootSessionUuid = deps.currentBootSessionUuid();
      if (
        bootSessionUuid === null &&
        (process.platform === 'darwin' || process.platform === 'linux')
      ) {
        deps.logger.warn(
          { event: 'crash-detection.boot-session-unavailable', platform: process.platform },
          'kernel boot-session identity unavailable — reboot suppression is disabled this launch',
        );
      }

      let sentinelPresent = false;
      let sentinelRaw: string | null = null;
      try {
        sentinelRaw = readFileSync(deps.sentinelPath, 'utf8');
        sentinelPresent = true;
      } catch (err) {
        sentinelPresent = !isFileMissingError(err);
        if (sentinelPresent) {
          deps.logger.warn(
            { event: 'crash-detection.sentinel-read-failed', err },
            'dirty-shutdown sentinel exists but could not be read, so the previous session is dated by this boot alone',
          );
        }
      }
      let prevBootId: string | null = null;
      let prevBootSessionUuid: string | null = null;
      let prevLastAliveAt: string | null = null;
      let prevPendingOsShutdownAt: string | null = null;
      let prevOsShutdownReasons: string[] | null = null;
      let prevSuspendedAt: string | null = null;
      let prevAppVersion: string | null = null;
      if (sentinelRaw !== null) {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(sentinelRaw) as Record<string, unknown> | null;
        } catch (err) {
          deps.logger.warn(
            { event: 'crash-detection.sentinel-parse-failed', err },
            'dirty-shutdown sentinel did not parse, so the previous session is dated by this boot alone',
          );
        }
        const field = (key: string): string | null => {
          const value = parsed?.[key];
          return typeof value === 'string' && value !== '' ? value : null;
        };
        prevBootId = field('bootId');
        prevBootSessionUuid = field('bootSessionUuid');
        prevLastAliveAt = field('lastAliveAt');
        prevPendingOsShutdownAt = field('pendingOsShutdownAt');
        const rawReasons = parsed?.osShutdownReasons;
        if (Array.isArray(rawReasons)) {
          const usable = rawReasons.filter(
            (value): value is string => typeof value === 'string' && value !== '',
          );
          prevOsShutdownReasons = usable.length > 0 ? usable : null;
        }
        prevSuspendedAt = field('suspendedAt');
        prevAppVersion = asReportableAppVersion(field('appVersion'));
      }

      const detectedAtMs = detectedAt.getTime();
      const lastAliveMs = epochMsOrNull(prevLastAliveAt);
      const deathFromMs = lastAliveMs ?? detectedAtMs;
      const deathFromSource = lastAliveMs !== null ? 'last-alive' : 'detected-at';
      const installInFlight =
        deps.installInFlight?.({ deathFromMs, deathToMs: detectedAtMs }) ?? null;
      const shadowingHandoffAt = installInFlight?.recordedHandoff
        ? installInFlight.handoffAt
        : null;

      const liveness = classifyPreviousLiveness(
        deps.mainThreadWatchdog.readPrevious(),
        prevBootId,
        epochMsOrNull(prevLastAliveAt),
      );
      const previousSessionFields = {
        ...livenessLogFields(liveness),
        ...stallLogFields(
          classifyPreviousStall(deps.mainThreadWatchdog.readPreviousStall(), prevBootId, liveness),
        ),
        ...mainExitLogFields(
          readPreviousFile(
            deps.mainExitPath,
            parseMainExitRecord,
            deps.logger,
            'crash-detection.main-exit-read-failed',
            'exit record',
          ),
          prevBootId,
        ),
      };

      const freshDumps: ClassifiedDump[] = freshMinidumpEntries().map((entry) => {
        const ownership = classifyDump(entry.path);
        return {
          entry,
          ownership,
          crashKind: ownership === 'ours' ? crashKindOf(entry.path) : null,
          declined:
            ownership === 'ours'
              ? declinedDeathForDump(entry)
              : { matched: null, read: 'not-asked' },
          handoffShadowed:
            ownership === 'ours' &&
            shadowingHandoffAt !== null &&
            entry.mtimeMs >= shadowingHandoffAt &&
            entry.mtimeMs - shadowingHandoffAt <= HANDOFF_TEARDOWN_WINDOW_MS,
        };
      });
      const foreignDumpCount = freshDumps.filter((d) => d.ownership === 'foreign').length;
      const unreadableDumpCount = freshDumps.filter((d) => d.ownership === 'unknown').length;
      const nonCrashDumpCount = freshDumps.filter((d) => d.crashKind === 'non-crash').length;
      const retired = freshDumps.flatMap((d) =>
        d.declined.matched === null ? [] : [{ entry: d.entry, declined: d.declined.matched }],
      );
      for (const { entry, declined } of retired) {
        deps.logger.info(
          {
            event: 'crash-detection.dump-retired',
            dumpMtimeAt: new Date(entry.mtimeMs).toISOString(),
            declinedAt: declined.at,
            processType: declined.processType,
          },
          'ignored a minidump written by a death this app declined to report',
        );
      }
      const unnamedNearDeclineCount = freshDumps.filter(
        (d) => d.declined.read === 'unnamed',
      ).length;
      const annotationParseFailedCount = freshDumps.filter(
        (d) => d.declined.read === 'parse-failed',
      ).length;
      if (unnamedNearDeclineCount > 0 || annotationParseFailedCount > 0) {
        deps.logger.info(
          {
            event: 'crash-detection.dump-beside-decline-unclassified',
            unnamed: unnamedNearDeclineCount,
            parseFailed: annotationParseFailedCount,
          },
          'a minidump beside a declined death could not be classified against it, so it still arms',
        );
      }
      if (foreignDumpCount > 0 || unreadableDumpCount > 0 || nonCrashDumpCount > 0) {
        deps.logger.info(
          {
            event: 'crash-detection.foreign-dumps-ignored',
            count: foreignDumpCount,
            unreadable: unreadableDumpCount,
            nonCrash: nonCrashDumpCount,
          },
          'ignored minidumps that this app could not claim',
        );
      }
      if (shadowingHandoffAt !== null) {
        const shadowingHandoffAtIso = new Date(shadowingHandoffAt).toISOString();
        for (const shadowed of freshDumps.filter((d) => d.handoffShadowed)) {
          deps.logger.info(
            {
              event: 'crash-detection.dump-handoff-shadowed',
              dumpMtimeAt: new Date(shadowed.entry.mtimeMs).toISOString(),
              handoffAt: shadowingHandoffAtIso,
              teardownWindowMs: HANDOFF_TEARDOWN_WINDOW_MS,
              attemptedInstall: installInFlight?.attemptedVersion ?? null,
            },
            'ignored a minidump written after this app committed to quitting for an update install',
          );
        }
      }
      const arming = (d: ClassifiedDump): boolean =>
        d.ownership !== 'foreign' &&
        d.crashKind !== 'non-crash' &&
        d.declined.matched === null &&
        !d.handoffShadowed;
      const newDumps = freshDumps.filter(arming).map((d) => d.entry.mtimeMs);
      const attachableDumps = freshDumps.filter(
        (d) => d.ownership === 'ours' && d.crashKind !== 'non-crash',
      );
      const boundDump = (attachableDumps.find(arming) ?? attachableDumps[0])?.entry ?? null;

      const rebootedBetweenSessions =
        prevBootSessionUuid !== null &&
        bootSessionUuid !== null &&
        prevBootSessionUuid !== bootSessionUuid;
      const machineLevelDeath =
        sentinelPresent &&
        (rebootedBetweenSessions || prevPendingOsShutdownAt !== null || prevSuspendedAt !== null);

      const updateInstallDeath = sentinelPresent && installInFlight !== null;
      const suppressibleDeath = machineLevelDeath || updateInstallDeath;
      const sentinelAgeMs = lastAliveMs === null ? null : detectedAtMs - lastAliveMs;
      const sentinelOutdatedByDump =
        sentinelPresent && sentinelAgeMs !== null && sentinelAgeMs >= STALE_CRASH_AFTER_MS;
      const newestDumpMs = newDumps.length > 0 ? Math.max(...newDumps) : null;
      const datableLastAliveMs =
        lastAliveMs === null || lastAliveMs > detectedAtMs ? null : lastAliveMs;
      const deathAtMs =
        newestDumpMs === null || datableLastAliveMs === null
          ? (newestDumpMs ?? datableLastAliveMs)
          : Math.max(newestDumpMs, datableLastAliveMs);
      const deathAtSource =
        deathAtMs === null ? null : deathAtMs === newestDumpMs ? 'dump-mtime' : 'last-alive';
      const deathAgeMs = deathAtMs === null ? null : detectedAtMs - deathAtMs;
      const crashTooOld = deathAgeMs !== null && deathAgeMs >= STALE_CRASH_AFTER_MS;
      const somethingToReport = sentinelPresent || newDumps.length > 0;

      const machineSuppressed = suppressibleDeath && newDumps.length === 0;

      let armed: OkBugReportCrashDetectedEvent | null = null;
      if (machineSuppressed || crashTooOld) {
        const reason = !machineSuppressed
          ? 'stale-crash'
          : rebootedBetweenSessions
            ? 'system-reboot'
            : prevPendingOsShutdownAt !== null
              ? 'os-shutdown'
              : prevSuspendedAt !== null
                ? 'suspended'
                : 'update-install';
        const breadcrumb = {
          event: 'crash-detection.machine-level-death',
          reason,
          attemptedInstall: installInFlight?.attemptedVersion ?? null,
          recordedHandoff: installInFlight?.recordedHandoff ?? null,
          handoffAtIso:
            installInFlight !== null ? new Date(installInFlight.handoffAt).toISOString() : null,
          deathFrom: new Date(deathFromMs).toISOString(),
          deathFromSource,
          deathSpanMs: Math.max(0, detectedAtMs - deathFromMs),
          detectedAt: detectedAt.toISOString(),
          prevBootId,
          prevBootSessionUuid,
          currentBootSessionUuid: bootSessionUuid,
          lastAliveAt: prevLastAliveAt,
          sentinelAgeMs,
          deathAgeMs,
          deathAt: deathAtMs === null ? null : new Date(deathAtMs).toISOString(),
          deathAtSource,
          staleAfterMs: STALE_CRASH_AFTER_MS,
          class: machineSuppressed ? 'external' : 'stale',
          machineCause: rebootedBetweenSessions
            ? 'system-reboot'
            : prevPendingOsShutdownAt !== null
              ? 'os-shutdown'
              : prevSuspendedAt !== null
                ? 'suspended'
                : null,
          suspendedAt: prevSuspendedAt,
          pendingOsShutdownAt: prevPendingOsShutdownAt,
          osShutdownReasons: prevOsShutdownReasons,
          ...previousSessionFields,
        };
        if (reason === 'os-shutdown') {
          deps.logger.warn(
            breadcrumb,
            'previous session was killed during an OS shutdown — suppressing the report prompt',
          );
        } else {
          deps.logger.info(
            breadcrumb,
            reason === 'system-reboot'
              ? 'previous session was killed by a system reboot — suppressing the report prompt'
              : reason === 'suspended'
                ? 'previous session died asleep without resuming — suppressing the report prompt'
                : reason === 'stale-crash'
                  ? 'previous session died too long ago to report usefully — suppressing the report prompt'
                  : 'previous session was killed by an update install — suppressing the report prompt',
          );
        }
      } else if (somethingToReport) {
        const dumpDriven =
          (!sentinelPresent || suppressibleDeath || sentinelOutdatedByDump) &&
          deathAtSource === 'dump-mtime';
        const eventId = dumpDriven
          ? `boot:dump:${Math.max(...newDumps)}`
          : `boot:${prevBootId ?? `unreadable:${detectedAt.getTime()}`}`;
        if (!store.ackedEventIds.includes(eventId)) {
          const eventDump = dumpDriven ? freshDumps.find(arming) : undefined;
          const dumpVersion =
            eventDump === undefined ? null : readMinidumpAppVersion(eventDump.entry.path);
          const dumpAccessibilityMode =
            eventDump === undefined ? null : readMinidumpAccessibilityMode(eventDump.entry.path);
          const crashedAppVersion = dumpDriven ? (dumpVersion?.version ?? null) : prevAppVersion;
          const crashedAtMs = dumpDriven ? (eventDump?.entry.mtimeMs ?? null) : datableLastAliveMs;
          const event: OkBugReportCrashDetectedEvent = {
            eventId,
            kind: 'boot',
            context: { dirtyShutdown: !dumpDriven, newMinidumps: newDumps.length },
            minidumpAvailable: boundDump !== null,
            ...(crashedAppVersion !== null ? { crashedAppVersion } : {}),
            ...(crashedAtMs !== null ? { crashedAt: new Date(crashedAtMs).toISOString() } : {}),
          };
          if (
            armInvite(event, {
              state: 'settled',
              dump: boundDump === null ? null : toBoundMinidump(boundDump),
            })
          ) {
            armed = event;
            deps.logger.info(
              {
                event: 'crash-detection.boot',
                eventId,
                detectedAt: detectedAt.toISOString(),
                dirtyShutdown: !dumpDriven,
                newMinidumps: newDumps.length,
                lastAliveAt: prevLastAliveAt,
                suspendedAt: prevSuspendedAt,
                pendingOsShutdownAt: prevPendingOsShutdownAt,
                attemptedInstall: installInFlight?.attemptedVersion ?? null,
                crashedAppVersion,
                crashedAppVersionParseFailed: dumpVersion?.parseFailed ?? false,
                ...(dumpAccessibilityMode !== null
                  ? {
                      crashedAccessibilityMode: dumpAccessibilityMode.mode,
                      crashedAccessibilityModeParseFailed: dumpAccessibilityMode.parseFailed,
                    }
                  : {}),
                detectingAppVersion: deps.appVersion,
                ...previousSessionFields,
              },
              'previous session ended uncleanly — arming report invitation',
            );
          }
        }
      }

      if (storeNeedsInit) {
        persistStore('init');
        storeNeedsInit = false;
      }

      sentinel = {
        bootId: String(detectedAt.getTime()),
        startedAt: detectedAt.toISOString(),
        lastAliveAt: detectedAt.toISOString(),
        appVersion: deps.appVersion,
        ...(bootSessionUuid !== null ? { bootSessionUuid } : {}),
      };
      writeSentinel('arm');
      watchdog?.stop();
      watchdog = deps.mainThreadWatchdog.start(sentinel.bootId);

      return armed;
    },

    markCleanQuit(): void {
      cleanQuitMarked = true;
      watchdog?.stop();
      watchdog = null;
      try {
        rmSync(deps.sentinelPath, { force: true });
      } catch (err) {
        deps.logger.warn(
          {
            event: 'crash-detection.sentinel-clear-failed',
            err,
          },
          'could not clear the dirty-shutdown sentinel — next boot may prompt spuriously',
        );
      }
    },

    noteProcessExit(code: number): void {
      if (sentinel === null || cleanQuitMarked) return;
      const record: MainExitRecord = {
        schemaVersion: 1,
        bootId: sentinel.bootId,
        exitedAt: deps.now().toISOString(),
        exitCode: code,
      };
      try {
        mkdirSync(dirname(deps.mainExitPath), { recursive: true });
        writeFileSync(deps.mainExitPath, `${JSON.stringify(record)}\n`);
      } catch (err) {
        try {
          deps.logger.warn(
            { event: 'crash-detection.main-exit-write-failed', err, exitCode: code },
            'could not record how the main process exited',
          );
        } catch {}
      }
    },

    noteAlive(): void {
      if (sentinel === null || cleanQuitMarked) return;
      const nowAt = deps.now();
      if (sentinel.pendingOsShutdownAt !== undefined) {
        const announcedMs = epochMsOrNull(sentinel.pendingOsShutdownAt);
        if (announcedMs !== null && nowAt.getTime() - announcedMs > OS_SHUTDOWN_MARKER_TTL_MS) {
          delete sentinel.pendingOsShutdownAt;
          delete sentinel.osShutdownReasons;
        }
      }
      sentinel.lastAliveAt = nowAt.toISOString();
      writeSentinel('alive');
    },

    noteOsShutdown(reasons?: readonly string[]): void {
      if (sentinel === null || cleanQuitMarked) return;
      sentinel.pendingOsShutdownAt = deps.now().toISOString();
      const usable = Array.isArray(reasons)
        ? reasons.filter((value): value is string => typeof value === 'string' && value !== '')
        : [];
      if (usable.length > 0) {
        sentinel.osShutdownReasons = usable;
      } else {
        delete sentinel.osShutdownReasons;
      }
      writeSentinel('os-shutdown');
    },

    noteSuspend(): void {
      if (sentinel === null || cleanQuitMarked) return;
      sentinel.suspendedAt = deps.now().toISOString();
      writeSentinel('suspend');
    },

    noteResume(): void {
      if (sentinel === null || cleanQuitMarked) return;
      delete sentinel.suspendedAt;
      sentinel.lastAliveAt = deps.now().toISOString();
      writeSentinel('resume');
    },

    handleRenderProcessGone(details): void {
      if (!isProcessCrashReason(details.reason)) return;
      const deathMs = deps.now().getTime();
      const eventId = `crash:render:${deathMs}:${runtimeSeq++}`;
      const scan = scanDeathWindow(deathMs);
      deps.logger.warn(
        {
          event: 'crash-detection.render-process-gone',
          eventId,
          reason: details.reason,
          exitCode: details.exitCode,
          ...deathWindowFacts(scan),
          ...(details.processSnapshot === undefined
            ? {}
            : { processSnapshot: details.processSnapshot }),
        },
        'renderer process died abnormally',
      );
      if (
        armRuntimeInvite(
          {
            eventId,
            kind: 'render-process-gone',
            context: {
              reason: details.reason,
              ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
            },
          },
          deathMs,
          scan.entry,
        )
      ) {
        tryDeliver();
      }
    },

    handleChildProcessGone(details): void {
      if (!isProcessCrashReason(details.reason)) return;
      const gpu = details.type === GPU_PROCESS_TYPE ? noteGpuCrash() : null;
      const suppressInvite = gpu?.suppressInvite === true;
      if (!suppressInvite && gpu !== null) clearDeclinedDeaths(GPU_DUMP_PROCESS_TYPE);
      const deathMs = suppressInvite ? null : deps.now().getTime();
      const eventId = deathMs === null ? null : `crash:child:${deathMs}:${runtimeSeq++}`;
      const scan = deathMs === null ? null : scanDeathWindow(deathMs);
      deps.logger.warn(
        {
          event: 'crash-detection.child-process-gone',
          ...(eventId === null ? {} : { eventId }),
          processType: details.type,
          reason: details.reason,
          exitCode: details.exitCode,
          ...(details.name === undefined ? {} : { name: details.name }),
          ...(scan === null ? {} : deathWindowFacts(scan)),
          ...(details.processSnapshot === undefined
            ? {}
            : { processSnapshot: details.processSnapshot }),
          ...(gpu === null ? {} : { gpuCrashesInWindow: gpu.countInWindow }),
          ...(suppressInvite ? { invitationSuppressed: 'gpu-recoverable' } : {}),
        },
        'child process died abnormally',
      );
      if (deathMs === null || eventId === null || scan === null) {
        recordDeclinedDeath(GPU_DUMP_PROCESS_TYPE);
        return;
      }
      if (
        armRuntimeInvite(
          {
            eventId,
            kind: 'child-process-gone',
            context: {
              reason: details.reason,
              processType: details.type,
              ...(details.name !== undefined ? { name: details.name } : {}),
              ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
            },
          },
          deathMs,
          scan.entry,
        )
      ) {
        tryDeliver();
      }
    },

    notifyRendererReady(): void {
      tryDeliver();
    },

    ack(eventId: string): void {
      if (!store.ackedEventIds.includes(eventId)) {
        store.ackedEventIds.push(eventId);
        if (store.ackedEventIds.length > MAX_ACKED_EVENT_IDS) {
          store.ackedEventIds.splice(0, store.ackedEventIds.length - MAX_ACKED_EVENT_IDS);
        }
      }
      store.minidumpBaselineAt = deps.now().toISOString();
      const baselineMs = Date.parse(store.minidumpBaselineAt);
      store.declinedDeaths = store.declinedDeaths.filter((declined) => {
        const at = epochMsOrNull(declined.at);
        return at !== null && at + DEATH_DUMP_MATCH_MS > baselineMs;
      });
      persistStore('ack');
      if (active?.event.eventId === eventId) {
        active = null;
      }
    },

    newestMinidumpForReport(): MinidumpReportLookup {
      const owned = newestOwnedMinidump();
      return {
        path: owned.entry?.path ?? null,
        foreignSkipped: owned.foreignSkipped,
        unknownSkipped: owned.unknownSkipped,
      };
    },

    minidumpForCrashEvent(eventId: string): CrashEventMinidumpLookup {
      const binding = settleInvitation(eventId, deps.now().getTime());
      if (binding === undefined) return { status: 'omitted', reason: 'invitation-unbound' };
      const bound = binding.dump;
      if (bound === null) return { status: 'none-bound' };
      const matches = listMinidumpEntries().filter(
        (entry) => basename(entry.path) === bound.fileName,
      );
      const match = matches[0];
      if (match === undefined) return { status: 'omitted', reason: 'bound-dump-missing' };
      if (matches.length > 1) return { status: 'omitted', reason: 'bound-dump-ambiguous' };
      if (match.sizeBytes !== bound.sizeBytes || match.mtimeMs !== bound.mtimeMs) {
        return { status: 'omitted', reason: 'bound-dump-changed' };
      }
      const ownership = classifyDump(match.path);
      if (ownership === 'unknown') return { status: 'omitted', reason: 'bound-dump-unreadable' };
      if (ownership === 'foreign') return { status: 'omitted', reason: 'bound-dump-not-owned' };
      if (crashKindOf(match.path) === 'non-crash') {
        return { status: 'omitted', reason: 'bound-dump-non-crash' };
      }
      return { status: 'bound', path: match.path };
    },
  };
}
