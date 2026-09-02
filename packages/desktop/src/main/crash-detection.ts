import {
  type Dirent,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { OkBugReportCrashDetectedEvent } from '@inkeep/open-knowledge-core';
import { asReportableAppVersion } from './crashed-app-version.ts';
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

const GPU_PROCESS_TYPE = 'GPU';

const GPU_DUMP_PROCESS_TYPE = 'gpu-process';

const GPU_CRASH_INVITE_THRESHOLD = 3;

const GPU_CRASH_WINDOW_MS = 5 * 60_000;

const INVITE_SUPERSEDE_AFTER_MS = 5 * 60_000;

const MAX_ACKED_EVENT_IDS = 50;

const DECLINED_DEATH_DUMP_MATCH_MS = 30_000;

const MAX_DECLINED_DEATHS = 20;

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

export interface CrashDetectionDeps {
  sentinelPath: string;
  ackStorePath: string;
  crashDumpsDir: string;
  appBundleRoot: string;
  appVersion: string;
  platform?: NodeJS.Platform;
  emit(event: OkBugReportCrashDetectedEvent): boolean;
  now(): Date;
  currentBootSessionUuid(): string | null;
  installInFlight?(span: { deathFromMs: number; deathToMs: number }): InstallInFlight | null;
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
  noteAlive(): void;
  noteOsShutdown(reasons?: readonly string[]): void;
  noteSuspend(): void;
  noteResume(): void;
  handleRenderProcessGone(details: { reason: string; exitCode?: number }): void;
  handleChildProcessGone(details: {
    type: string;
    reason: string;
    exitCode?: number;
    name?: string;
  }): void;
  notifyRendererReady(): void;
  ack(eventId: string): void;
  newestMinidumpForReport(): MinidumpReportLookup;
}

export interface MinidumpReportLookup {
  path: string | null;
  foreignSkipped: number;
  unknownSkipped: number;
}

export function startLocalCrashReporter(reporter: {
  start(options: { uploadToServer: boolean }): void;
}): void {
  reporter.start({ uploadToServer: false });
}

function isFileMissingError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
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
    if (!entry.name.endsWith('.dmp')) continue;
    try {
      out.push({ path: entryPath, mtimeMs: statSync(entryPath).mtimeMs });
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

  let recentGpuCrashes: number[] = [];

  let sentinel: SentinelState | null = null;
  let cleanQuitMarked = false;

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
      return at !== null && Math.abs(entry.mtimeMs - at) <= DECLINED_DEATH_DUMP_MATCH_MS;
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
    if (deps.emit(active.event)) {
      active.delivered = true;
    }
  }

  function armInvite(event: OkBugReportCrashDetectedEvent): boolean {
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
    const entries: MinidumpEntry[] = [];
    collectMinidumpEntries(deps.crashDumpsDir, MINIDUMP_SCAN_DEPTH, entries);
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
      if (unnamedNearDeclineCount > 0) {
        deps.logger.info(
          {
            event: 'crash-detection.dump-beside-decline-unnamed',
            count: unnamedNearDeclineCount,
          },
          'a minidump beside a declined death named no process type, so it still arms',
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
      const arming = (d: ClassifiedDump): boolean =>
        d.ownership !== 'foreign' && d.crashKind !== 'non-crash' && d.declined.matched === null;
      const newDumps = freshDumps.filter(arming).map((d) => d.entry.mtimeMs);
      const ownedDumpCount = freshDumps.filter(
        (d) => d.ownership === 'ours' && d.crashKind !== 'non-crash',
      ).length;

      const rebootedBetweenSessions =
        prevBootSessionUuid !== null &&
        bootSessionUuid !== null &&
        prevBootSessionUuid !== bootSessionUuid;
      const machineLevelDeath =
        sentinelPresent &&
        (rebootedBetweenSessions || prevPendingOsShutdownAt !== null || prevSuspendedAt !== null);

      const detectedAtMs = detectedAt.getTime();
      const lastAliveMs = epochMsOrNull(prevLastAliveAt);
      const deathFromMs = lastAliveMs ?? detectedAtMs;
      const deathFromSource = lastAliveMs !== null ? 'last-alive' : 'detected-at';
      const installInFlight =
        deps.installInFlight?.({ deathFromMs, deathToMs: detectedAtMs }) ?? null;
      const updateInstallDeath = sentinelPresent && installInFlight !== null;

      let armed: OkBugReportCrashDetectedEvent | null = null;
      if ((machineLevelDeath || updateInstallDeath) && newDumps.length === 0) {
        const reason = rebootedBetweenSessions
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
          suspendedAt: prevSuspendedAt,
          pendingOsShutdownAt: prevPendingOsShutdownAt,
          osShutdownReasons: prevOsShutdownReasons,
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
                : 'previous session was killed by an update install — suppressing the report prompt',
          );
        }
      } else if (sentinelPresent || newDumps.length > 0) {
        const dumpDriven = !sentinelPresent || machineLevelDeath || updateInstallDeath;
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
          const event: OkBugReportCrashDetectedEvent = {
            eventId,
            kind: 'boot',
            context: { dirtyShutdown: !dumpDriven, newMinidumps: newDumps.length },
            minidumpAvailable: ownedDumpCount > 0,
            ...(crashedAppVersion !== null ? { crashedAppVersion } : {}),
          };
          if (armInvite(event)) {
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

      return armed;
    },

    markCleanQuit(): void {
      cleanQuitMarked = true;
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
      if (!CRASH_REASONS.has(details.reason)) return;
      const owned = newestOwnedMinidump();
      deps.logger.warn(
        {
          event: 'crash-detection.render-process-gone',
          reason: details.reason,
          exitCode: details.exitCode,
          foreignDumpsIgnored: owned.foreignSkipped,
          unreadableDumpsSkipped: owned.unknownSkipped,
          nonCrashDumpsSkipped: owned.nonCrashSkipped,
        },
        'renderer process died abnormally',
      );
      if (
        armInvite({
          eventId: `crash:render:${deps.now().getTime()}:${runtimeSeq++}`,
          kind: 'render-process-gone',
          context: {
            reason: details.reason,
            ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
          },
          minidumpAvailable: owned.entry !== null,
        })
      ) {
        tryDeliver();
      }
    },

    handleChildProcessGone(details): void {
      if (!CRASH_REASONS.has(details.reason)) return;
      const owned = newestOwnedMinidump();
      const gpu = details.type === GPU_PROCESS_TYPE ? noteGpuCrash() : null;
      deps.logger.warn(
        {
          event: 'crash-detection.child-process-gone',
          processType: details.type,
          reason: details.reason,
          exitCode: details.exitCode,
          foreignDumpsIgnored: owned.foreignSkipped,
          unreadableDumpsSkipped: owned.unknownSkipped,
          nonCrashDumpsSkipped: owned.nonCrashSkipped,
          ...(gpu === null ? {} : { gpuCrashesInWindow: gpu.countInWindow }),
          ...(gpu?.suppressInvite === true ? { invitationSuppressed: 'gpu-recoverable' } : {}),
        },
        'child process died abnormally',
      );
      if (gpu?.suppressInvite === true) {
        recordDeclinedDeath(GPU_DUMP_PROCESS_TYPE);
        return;
      }
      if (gpu !== null) clearDeclinedDeaths(GPU_DUMP_PROCESS_TYPE);
      if (
        armInvite({
          eventId: `crash:child:${deps.now().getTime()}:${runtimeSeq++}`,
          kind: 'child-process-gone',
          context: {
            reason: details.reason,
            processType: details.type,
            ...(details.name !== undefined ? { name: details.name } : {}),
            ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
          },
          minidumpAvailable: owned.entry !== null,
        })
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
        return at !== null && at + DECLINED_DEATH_DUMP_MATCH_MS > baselineMs;
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
  };
}
