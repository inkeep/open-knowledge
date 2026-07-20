/**
 * First-party crash detection for the desktop main process. Three signal
 * sources feed one invitation pipeline:
 *
 *   - Electron's `crashReporter` runs with `uploadToServer: false` — Crashpad
 *     writes native-crash minidumps to `app.getPath('crashDumps')` and
 *     nothing ever leaves the machine (standing policy: first-party only, no
 *     vendor crash SDKs).
 *   - `render-process-gone` / `child-process-gone` signals, filtered to
 *     genuine crash reasons, invite a report while the app is still running.
 *   - A boot-time scan pairs a dirty-shutdown sentinel (written each boot,
 *     removed on clean quit) with a minidump-freshness check to catch
 *     main-process/native crashes that leave no live-session signal.
 *
 * Every detection only ever *invites*: the renderer opens the report dialog
 * and the user decides; nothing is sent automatically. Each crash event
 * prompts at most once — delivery is once per event, at most one invitation
 * is armed at a time, and acknowledgments persist (userData JSON) so an
 * acked event never re-prompts across restarts.
 *
 * A dirty shutdown only merits a prompt when the app itself died. The
 * sentinel records the kernel boot-session identity plus liveness/power
 * markers; when the next boot sees a different kernel session (the machine
 * rebooted out from under the previous session) or an OS-shutdown marker,
 * the invitation is suppressed — a reboot or power loss is not an app bug,
 * so it becomes a log breadcrumb, never a report prompt. A fresh minidump
 * overrides suppression: kernel panics never write app minidumps, so a dump
 * proves the app native-crashed before the machine went down.
 *
 * Deliberately absent: a userland `uncaughtException` handler. Electron
 * defers its main-process crash dialog to such a handler whenever one exists
 * (see `process-safety-net.ts`) — the boot-time sentinel/minidump scan is how
 * main-process crashes are covered instead.
 *
 * Electron-free by construction (paths, clock, and the renderer push are all
 * injected) so the whole pipeline is testable without a live app.
 */

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

/**
 * Process-gone reasons that read as genuine crashes. `clean-exit` and
 * `killed` are routine teardown (window closed mid-load, OS/user kill);
 * `abnormal-exit` is a managed child exiting nonzero — those children own
 * their failure UX (e.g. the server utility's spawn-error surface), so a
 * report prompt for each would nag.
 */
const CRASH_REASONS = new Set(['crashed', 'oom', 'launch-failed', 'integrity-failure']);

/**
 * Acked ids older than the store's minidump baseline can never fire again,
 * so the list only needs to outlive a plausible burst of distinct events.
 */
const MAX_ACKED_EVENT_IDS = 50;

/** Crashpad nests dumps (`pending/`, `completed/`, `new/`) — walk a bounded depth. */
const MINIDUMP_SCAN_DEPTH = 3;

/**
 * A real OS shutdown kills the process within seconds of the announcement.
 * If heartbeats are still arriving this long after one, the shutdown was
 * cancelled — the marker must be dropped so a later genuine crash in the same
 * session isn't misread as an OS-shutdown kill and wrongly suppressed. Must
 * stay greater than `SENTINEL_HEARTBEAT_INTERVAL_MS` — cancelled-shutdown
 * recovery relies on at least one heartbeat landing inside the TTL window so
 * a later one can observe it's expired.
 */
const OS_SHUTDOWN_MARKER_TTL_MS = 120_000;

/** How often the sentinel's `lastAliveAt` is refreshed while the app runs. */
export const SENTINEL_HEARTBEAT_INTERVAL_MS = 60_000;

interface CrashLogger {
  info(payload: Record<string, unknown>, msg: string): void;
  warn(payload: Record<string, unknown>, msg: string): void;
}

/** Persisted acknowledgment state (userData JSON). */
interface CrashAckStore {
  ackedEventIds: string[];
  /** Minidumps at or older than this instant are considered already handled. */
  minidumpBaselineAt: string;
}

/**
 * On-disk sentinel contents for the running session. No version field —
 * forward/backward compatibility instead relies on every field staying
 * add-only (never renamed or repurposed) and `field()` in `detectBootCrash`
 * returning null for any key a reader doesn't recognize, since this file is
 * read across app-version boundaries (auto-update can start a new binary
 * against a sentinel an older one wrote).
 */
interface SentinelState {
  bootId: string;
  startedAt: string;
  /** Refreshed by the heartbeat; how close to death the session was known alive. */
  lastAliveAt: string;
  /** Kernel session identity; absent when the platform probe returned null. */
  bootSessionUuid?: string;
  /** Set when the OS announced a shutdown/restart; TTL-cleared if we survive it. */
  pendingOsShutdownAt?: string;
  /** Set on suspend, cleared on resume — a never-resumed sentinel died asleep. */
  suspendedAt?: string;
}

export interface CrashDetectionDeps {
  /** Dirty-shutdown sentinel — written each boot, removed on clean quit. */
  sentinelPath: string;
  /** Acknowledgment store (JSON) recording which crash events the user already saw. */
  ackStorePath: string;
  /** Electron's `app.getPath('crashDumps')`; scanned for fresh `.dmp` files. */
  crashDumpsDir: string;
  /**
   * Push one crash-detected event to a live renderer. Returns false when no
   * renderer could take it — the event stays armed and is re-offered on the
   * next `notifyRendererReady`.
   */
  emit(event: OkBugReportCrashDetectedEvent): boolean;
  now(): Date;
  /**
   * Identity of the running kernel session (`kern.bootsessionuuid` on macOS);
   * changes if and only if the kernel rebooted. Null when unavailable —
   * detection then skips the reboot classification entirely (fail-open
   * toward prompting, i.e. the pre-classification behavior).
   */
  currentBootSessionUuid(): string | null;
  logger: CrashLogger;
}

export interface CrashDetection {
  /**
   * Boot-time scan: reads the previous session's sentinel and the minidump
   * directory, arms at most one boot invitation (unless already acked), then
   * writes this session's sentinel. Returns what it armed, for callers'
   * logging; delivery waits for `notifyRendererReady`.
   */
  detectBootCrash(): OkBugReportCrashDetectedEvent | null;
  /** Clean-quit path: removes the sentinel so the next boot reads as clean. */
  markCleanQuit(): void;
  /**
   * Liveness heartbeat: refreshes the sentinel's `lastAliveAt` (and expires a
   * stale OS-shutdown marker). No-op after `markCleanQuit` — a straggling
   * timer tick must never resurrect the sentinel an orderly quit removed,
   * which would turn every clean quit into next boot's phantom crash.
   */
  noteAlive(): void;
  /**
   * The OS announced a shutdown/restart. If the process is killed before the
   * quit sequence completes, the next boot suppresses the report prompt (and
   * warns about the unfinished quit) instead of blaming the app.
   */
  noteOsShutdown(): void;
  /** System is suspending; a sentinel that never resumes died asleep (power loss). */
  noteSuspend(): void;
  noteResume(): void;
  handleRenderProcessGone(details: { reason: string; exitCode?: number }): void;
  handleChildProcessGone(details: {
    type: string;
    reason: string;
    exitCode?: number;
    name?: string;
  }): void;
  /** A renderer finished loading — deliver the armed invitation if one is waiting. */
  notifyRendererReady(): void;
  /** Persist an acknowledgment so the event never re-prompts, and disarm it. */
  ack(eventId: string): void;
  /**
   * Absolute path of the newest minidump not yet covered by an acknowledgment
   * (strictly newer than the ack baseline) — the dump belonging to whatever
   * crash the user is currently invited to report. Null when the un-acked
   * crash left no dump (e.g. dirty shutdown without a native crash) or every
   * dump is already acked. Minidumps carry raw process memory that text
   * redaction cannot scrub, so bundle inclusion stays behind the report
   * dialog's crash-dump checkbox (pre-checked for a crash invite, opt-out)
   * plus the review-before-send step that calls this — never a silent attach.
   */
  newestMinidumpPath(): string | null;
}

/**
 * Start Electron's crash reporter in local-only mode: Crashpad collects
 * minidumps on disk and uploads nothing. Isolated behind this wrapper so the
 * no-upload contract is pinned by a unit test rather than trusted to a call
 * site nothing exercises.
 */
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

function parseAckStore(raw: string): CrashAckStore | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (!Array.isArray(p.ackedEventIds)) return null;
    if (!p.ackedEventIds.every((id): id is string => typeof id === 'string')) return null;
    if (typeof p.minidumpBaselineAt !== 'string') return null;
    if (!Number.isFinite(Date.parse(p.minidumpBaselineAt))) return null;
    return { ackedEventIds: p.ackedEventIds, minidumpBaselineAt: p.minidumpBaselineAt };
  } catch {
    return null;
  }
}

interface MinidumpEntry {
  path: string;
  mtimeMs: number;
}

/** Collect `.dmp` files under `dir` with mtimes, tolerating a dir Crashpad hasn't created yet. */
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
    } catch {
      // Raced with Crashpad's own upload/cleanup rotation — skip the entry.
    }
  }
}

export function createCrashDetection(deps: CrashDetectionDeps): CrashDetection {
  /** The one invitation in flight; a new signal while this is unacked stays silent. */
  let active: { event: OkBugReportCrashDetectedEvent; delivered: boolean } | null = null;
  let runtimeSeq = 0;

  /** This session's sentinel; null until `detectBootCrash` writes the first version. */
  let sentinel: SentinelState | null = null;
  /** Freezes every sentinel writer once the file was removed by an orderly quit. */
  let cleanQuitMarked = false;

  /**
   * Which caller triggered the write — surfaced in the failure log so a
   * write that fails on `noteOsShutdown` (losing the shutdown marker this
   * feature depends on) doesn't read as "could not arm," which would send an
   * investigator toward "did detection even run?" instead of "did the
   * shutdown marker persist?"
   */
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
          cause: err instanceof Error ? err.message : String(err),
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
    } catch {
      // Missing on first run; unreadable otherwise — both re-baseline below.
    }
    if (parsed === null) {
      // Fresh baseline: minidumps that predate this store (from before the
      // feature existed, or from before the store was lost) never prompt.
      store = { ackedEventIds: [], minidumpBaselineAt: deps.now().toISOString() };
      storeNeedsInit = true;
    } else {
      store = parsed;
    }
  }

  function persistStore(): void {
    try {
      mkdirSync(dirname(deps.ackStorePath), { recursive: true });
      writeFileSync(deps.ackStorePath, `${JSON.stringify(store)}\n`);
    } catch (err) {
      // Detection stays usable in-session even when userData is unwritable;
      // only the cross-restart memory degrades.
      deps.logger.warn(
        {
          event: 'crash-detection.store-write-failed',
          cause: err instanceof Error ? err.message : String(err),
        },
        'could not persist crash acknowledgment state',
      );
    }
  }

  function tryDeliver(): void {
    if (active === null || active.delivered) return;
    if (deps.emit(active.event)) {
      active.delivered = true;
    }
  }

  /**
   * Arm an invitation without delivering — boot events wait for the first
   * renderer-ready signal, runtime events follow up with `tryDeliver`.
   * Returns false when a prior invitation is still unanswered (new signals
   * stay silent rather than stacking prompts).
   */
  function armInvite(event: OkBugReportCrashDetectedEvent): boolean {
    if (active !== null) {
      deps.logger.info(
        {
          event: 'crash-detection.suppressed',
          eventId: event.eventId,
          pendingEventId: active.event.eventId,
        },
        'crash invitation already pending — new signal stays silent',
      );
      return false;
    }
    active = { event, delivered: false };
    return true;
  }

  /**
   * Newest minidump strictly newer than the ack baseline, or null. Shared by
   * the report-time path lookup and the per-event availability signal so both
   * answer from the same baseline-filtered scan of the crash-dumps dir.
   */
  function newestMinidumpEntry(): MinidumpEntry | null {
    const entries: MinidumpEntry[] = [];
    collectMinidumpEntries(deps.crashDumpsDir, MINIDUMP_SCAN_DEPTH, entries);
    const baselineMs = Date.parse(store.minidumpBaselineAt);
    let newest: MinidumpEntry | null = null;
    for (const entry of entries) {
      if (entry.mtimeMs <= baselineMs) continue;
      if (newest === null || entry.mtimeMs > newest.mtimeMs) newest = entry;
    }
    return newest;
  }

  return {
    detectBootCrash(): OkBugReportCrashDetectedEvent | null {
      const detectedAt = deps.now();
      const bootSessionUuid = deps.currentBootSessionUuid();
      if (
        bootSessionUuid === null &&
        (process.platform === 'darwin' || process.platform === 'linux')
      ) {
        // Reboot suppression silently stops working if this ever goes null on
        // a platform it should work on (sysctl timeout, sandboxed exec,
        // renamed binary) — nothing else would surface why every reboot
        // started prompting again.
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
        // A non-ENOENT read failure still means the file exists — the
        // previous session did not clean-quit.
        sentinelPresent = !isFileMissingError(err);
      }
      let prevBootId: string | null = null;
      let prevBootSessionUuid: string | null = null;
      let prevLastAliveAt: string | null = null;
      let prevPendingOsShutdownAt: string | null = null;
      let prevSuspendedAt: string | null = null;
      if (sentinelRaw !== null) {
        try {
          const parsed = JSON.parse(sentinelRaw) as Record<string, unknown> | null;
          const field = (key: string): string | null => {
            const value = parsed?.[key];
            return typeof value === 'string' && value !== '' ? value : null;
          };
          prevBootId = field('bootId');
          prevBootSessionUuid = field('bootSessionUuid');
          prevLastAliveAt = field('lastAliveAt');
          prevPendingOsShutdownAt = field('pendingOsShutdownAt');
          prevSuspendedAt = field('suspendedAt');
        } catch {
          // Torn write from the crashed session — presence alone is the signal.
        }
      }

      const dumpEntries: MinidumpEntry[] = [];
      collectMinidumpEntries(deps.crashDumpsDir, MINIDUMP_SCAN_DEPTH, dumpEntries);
      const baselineMs = Date.parse(store.minidumpBaselineAt);
      const newDumps = dumpEntries.filter((e) => e.mtimeMs > baselineMs).map((e) => e.mtimeMs);

      // A boot-session mismatch means the kernel rebooted after the previous
      // session was last alive; an os-shutdown marker means the OS killed the
      // app past its quit grace; a never-resumed suspend marker means the
      // session died asleep (e.g. the battery ran out) — safe-sleep resume
      // preserves the kernel boot session (Apple's IOPMrootDomain docs:
      // BootSessionUUID "remain[s] same across sleep/wake/hibernate cycle"),
      // so a reboot never happens for this case and it needs its own signal.
      // Either way the machine ended the session, not the app. Missing
      // identity on either side (old-format sentinel, probe failure) skips
      // the reboot classification — fail-open toward prompting. Note this
      // reboot signal has an inherent false-negative: an app crash followed
      // by an unrelated user-initiated reboot before relaunch reads
      // identically to "the reboot killed the app" and is suppressed too —
      // accepted tradeoff of comparing boot-session identity alone. The
      // suspend marker has an analogous narrow window: a whole-process crash
      // between the OS delivering wake and `noteResume()`'s synchronous clear
      // reads as "died asleep" too — mitigated by the fresh-minidump override
      // below for native crashes, and by `noteResume()` running as the first
      // step of the `resume` handler.
      const rebootedBetweenSessions =
        prevBootSessionUuid !== null &&
        bootSessionUuid !== null &&
        prevBootSessionUuid !== bootSessionUuid;
      const machineLevelDeath =
        sentinelPresent &&
        (rebootedBetweenSessions || prevPendingOsShutdownAt !== null || prevSuspendedAt !== null);

      let armed: OkBugReportCrashDetectedEvent | null = null;
      if (machineLevelDeath && newDumps.length === 0) {
        const reason = rebootedBetweenSessions
          ? 'system-reboot'
          : prevPendingOsShutdownAt !== null
            ? 'os-shutdown'
            : 'suspended';
        const breadcrumb = {
          event: 'crash-detection.machine-level-death',
          reason,
          detectedAt: detectedAt.toISOString(),
          prevBootId,
          prevBootSessionUuid,
          currentBootSessionUuid: bootSessionUuid,
          lastAliveAt: prevLastAliveAt,
          suspendedAt: prevSuspendedAt,
          pendingOsShutdownAt: prevPendingOsShutdownAt,
        };
        if (reason === 'os-shutdown') {
          // Same kernel session yet the shutdown marker survived: our quit
          // sequence never completed before the OS killed the app. That gap
          // is ours to watch in logs, but not the user's to report.
          deps.logger.warn(
            breadcrumb,
            'previous session was killed during an OS shutdown — suppressing the report prompt',
          );
        } else {
          deps.logger.info(
            breadcrumb,
            reason === 'system-reboot'
              ? 'previous session was killed by a system reboot — suppressing the report prompt'
              : 'previous session died asleep without resuming — suppressing the report prompt',
          );
        }
      } else if (sentinelPresent || newDumps.length > 0) {
        // Sentinel-derived ids stay stable for the same crashed session, so an
        // ack survives even if detection runs again before this boot rewrites
        // the sentinel. The dump-only and unreadable-sentinel fallbacks only
        // need in-session stability — the sentinel is replaced below either way.
        //
        // A machine-level death with fresh dumps still prompts, but as the
        // dump-driven variant: the reboot ended the session, the dump is the
        // crash — framing it as an app dirty-shutdown would misattribute.
        const dumpDriven = !sentinelPresent || machineLevelDeath;
        const eventId = dumpDriven
          ? `boot:dump:${Math.max(...newDumps)}`
          : `boot:${prevBootId ?? `unreadable:${detectedAt.getTime()}`}`;
        if (!store.ackedEventIds.includes(eventId)) {
          const event: OkBugReportCrashDetectedEvent = {
            eventId,
            kind: 'boot',
            context: { dirtyShutdown: !dumpDriven, newMinidumps: newDumps.length },
            // A prior-session dump is already on disk, so the freshness scan
            // that produced newDumps is the authoritative availability answer.
            minidumpAvailable: newDumps.length > 0,
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
              },
              'previous session ended uncleanly — arming report invitation',
            );
          }
        }
      }

      if (storeNeedsInit) {
        persistStore();
        storeNeedsInit = false;
      }

      sentinel = {
        bootId: String(detectedAt.getTime()),
        startedAt: detectedAt.toISOString(),
        lastAliveAt: detectedAt.toISOString(),
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
            cause: err instanceof Error ? err.message : String(err),
          },
          'could not clear the dirty-shutdown sentinel — next boot may prompt spuriously',
        );
      }
    },

    noteAlive(): void {
      if (sentinel === null || cleanQuitMarked) return;
      const nowAt = deps.now();
      if (sentinel.pendingOsShutdownAt !== undefined) {
        const announcedMs = Date.parse(sentinel.pendingOsShutdownAt);
        if (
          Number.isFinite(announcedMs) &&
          nowAt.getTime() - announcedMs > OS_SHUTDOWN_MARKER_TTL_MS
        ) {
          delete sentinel.pendingOsShutdownAt;
        }
      }
      sentinel.lastAliveAt = nowAt.toISOString();
      writeSentinel('alive');
    },

    noteOsShutdown(): void {
      if (sentinel === null || cleanQuitMarked) return;
      sentinel.pendingOsShutdownAt = deps.now().toISOString();
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
      deps.logger.warn(
        {
          event: 'crash-detection.render-process-gone',
          reason: details.reason,
          exitCode: details.exitCode,
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
          // Best-effort: Crashpad may still be flushing the dump when this
          // signal fires. A dump that lands just after reads as unavailable
          // here (no checkbox); the boot-time path is the reliable one.
          minidumpAvailable: newestMinidumpEntry() !== null,
        })
      ) {
        tryDeliver();
      }
    },

    handleChildProcessGone(details): void {
      if (!CRASH_REASONS.has(details.reason)) return;
      deps.logger.warn(
        {
          event: 'crash-detection.child-process-gone',
          processType: details.type,
          reason: details.reason,
          exitCode: details.exitCode,
        },
        'child process died abnormally',
      );
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
          minidumpAvailable: newestMinidumpEntry() !== null,
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
      // Advancing the baseline marks this crash's minidumps as handled, so the
      // boot-time scan never re-invites for an event the user already answered.
      store.minidumpBaselineAt = deps.now().toISOString();
      persistStore();
      if (active?.event.eventId === eventId) {
        active = null;
      }
    },

    newestMinidumpPath(): string | null {
      return newestMinidumpEntry()?.path ?? null;
    },
  };
}
