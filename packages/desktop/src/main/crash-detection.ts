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
   * redaction cannot scrub, so bundle inclusion must stay behind the report
   * dialog's explicit opt-in that calls this.
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

  return {
    detectBootCrash(): OkBugReportCrashDetectedEvent | null {
      const detectedAt = deps.now();

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
      if (sentinelRaw !== null) {
        try {
          const parsed: unknown = JSON.parse(sentinelRaw);
          const bootId = (parsed as Record<string, unknown> | null)?.bootId;
          if (typeof bootId === 'string' && bootId !== '') prevBootId = bootId;
        } catch {
          // Torn write from the crashed session — presence alone is the signal.
        }
      }

      const dumpEntries: MinidumpEntry[] = [];
      collectMinidumpEntries(deps.crashDumpsDir, MINIDUMP_SCAN_DEPTH, dumpEntries);
      const baselineMs = Date.parse(store.minidumpBaselineAt);
      const newDumps = dumpEntries.filter((e) => e.mtimeMs > baselineMs).map((e) => e.mtimeMs);

      let armed: OkBugReportCrashDetectedEvent | null = null;
      if (sentinelPresent || newDumps.length > 0) {
        // Sentinel-derived ids stay stable for the same crashed session, so an
        // ack survives even if detection runs again before this boot rewrites
        // the sentinel. The dump-only and unreadable-sentinel fallbacks only
        // need in-session stability — the sentinel is replaced below either way.
        const eventId = sentinelPresent
          ? `boot:${prevBootId ?? `unreadable:${detectedAt.getTime()}`}`
          : `boot:dump:${Math.max(...newDumps)}`;
        if (!store.ackedEventIds.includes(eventId)) {
          const event: OkBugReportCrashDetectedEvent = {
            eventId,
            kind: 'boot',
            context: { dirtyShutdown: sentinelPresent, newMinidumps: newDumps.length },
          };
          if (armInvite(event)) {
            armed = event;
            deps.logger.info(
              {
                event: 'crash-detection.boot',
                eventId,
                dirtyShutdown: sentinelPresent,
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

      try {
        mkdirSync(dirname(deps.sentinelPath), { recursive: true });
        writeFileSync(
          deps.sentinelPath,
          `${JSON.stringify({ bootId: String(detectedAt.getTime()), startedAt: detectedAt.toISOString() })}\n`,
        );
      } catch (err) {
        deps.logger.warn(
          {
            event: 'crash-detection.sentinel-write-failed',
            cause: err instanceof Error ? err.message : String(err),
          },
          'could not arm the dirty-shutdown sentinel',
        );
      }

      return armed;
    },

    markCleanQuit(): void {
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
      const entries: MinidumpEntry[] = [];
      collectMinidumpEntries(deps.crashDumpsDir, MINIDUMP_SCAN_DEPTH, entries);
      const baselineMs = Date.parse(store.minidumpBaselineAt);
      let newest: MinidumpEntry | null = null;
      for (const entry of entries) {
        if (entry.mtimeMs <= baselineMs) continue;
        if (newest === null || entry.mtimeMs > newest.mtimeMs) newest = entry;
      }
      return newest === null ? null : newest.path;
    },
  };
}
