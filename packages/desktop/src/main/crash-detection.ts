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
 *     GPU deaths are filtered twice: Chromium replaces that process on its
 *     own, so an isolated one is presumed recovered and stays a log line —
 *     only a repeat inside the window is worth asking the user about.
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
 * Not every dump in the crash database is ours. Crashpad's exception handler
 * is inherited by every descendant process, so the directory also collects
 * dumps for programs the app merely spawned. Both consumers of the dump scan
 * therefore classify by the dump's own main module (`minidump-ownership.ts`),
 * with deliberately opposite defaults for an unreadable dump: arming fails
 * open (a dismissible question), attachment fails closed (process memory
 * leaving the machine under a consent that describes THIS app).
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
import { asReportableAppVersion } from './crashed-app-version.ts';
import {
  classifyMinidumpOwnership,
  type MinidumpOwnership,
  readMinidumpAppVersion,
} from './minidump-ownership.ts';

/**
 * Process-gone reasons that read as genuine crashes. `clean-exit` and
 * `killed` are routine teardown (window closed mid-load, OS/user kill);
 * `abnormal-exit` is a managed child exiting nonzero — those children own
 * their failure UX (e.g. the server utility's spawn-error surface), so a
 * report prompt for each would nag.
 */
const CRASH_REASONS = new Set(['crashed', 'oom', 'launch-failed', 'integrity-failure']);

/** Electron's `details.type` for the GPU child process. */
const GPU_PROCESS_TYPE = 'GPU';

/**
 * How many GPU deaths inside the window it takes before one is worth a prompt.
 *
 * The GPU process is the one child Chromium replaces on its own: it relaunches
 * a dead one and re-issues the lost graphics context in about a second, so an
 * isolated death leaves the user with nothing to describe. Inviting anyway
 * produces a report whose author saw no failure, and costs a triage cycle to
 * conclude "recovered" — the reason this threshold exists.
 *
 * Repetition is the opposite signal. A GPU process that will not stay up
 * degrades every window and eventually drops the app to software rendering,
 * which the user does feel, so the prompt is delayed rather than removed. The
 * reason is deliberately not consulted: `crashed` and `oom` recover by the same
 * mechanism, and a genuinely broken GPU reaches the threshold either way.
 */
const GPU_CRASH_INVITE_THRESHOLD = 3;

/**
 * Deaths only compound while they are related. Spread across a long session
 * they are independent blips that each recovered, so the count is taken over a
 * trailing window rather than for the life of the process.
 */
const GPU_CRASH_WINDOW_MS = 5 * 60_000;

/**
 * How long a pending invitation keeps a later crash silent. The single-slot
 * guard exists to stop one incident stacking prompts, so its reach has to end
 * where the incident does — the same relatedness horizon `GPU_CRASH_WINDOW_MS`
 * draws, for the same reason. Beyond it an unanswered invitation is not
 * "the prompt already on screen" but a prompt the user walked away from, and
 * letting it mute an independent crash means the app recovers in silence.
 */
const INVITE_SUPERSEDE_AFTER_MS = 5 * 60_000;

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
 * On-disk sentinel contents for the running session. No FORMAT version field —
 * forward/backward compatibility instead relies on every field staying
 * add-only (never renamed or repurposed) and `field()` in `detectBootCrash`
 * returning null for any key a reader doesn't recognize, since this file is
 * read across app-version boundaries (auto-update can start a new binary
 * against a sentinel an older one wrote). `appVersion` below names the app,
 * not this file's shape — it is content, covered by that contract like any
 * other field rather than being an exception to it.
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
  /**
   * App version of the session that wrote this sentinel. Read back by the NEXT
   * session to name the build that actually crashed: an auto-update between
   * the two is precisely when it differs from the running one. Absent on a
   * sentinel written before this field existed, which reads as unknown.
   */
  appVersion?: string;
}

export interface CrashDetectionDeps {
  /** Dirty-shutdown sentinel — written each boot, removed on clean quit. */
  sentinelPath: string;
  /** Acknowledgment store (JSON) recording which crash events the user already saw. */
  ackStorePath: string;
  /** Electron's `app.getPath('crashDumps')`; scanned for fresh `.dmp` files. */
  crashDumpsDir: string;
  /**
   * Root that every process of this app launches from (`app.getPath('exe')`
   * reduced by `appBundleRootFromExecutable`). A dump in `crashDumpsDir` is
   * only ours when its main module resolves inside this root — Crashpad's
   * exception handler is inherited by every descendant process, so the crash
   * database also collects dumps for programs we merely spawned.
   */
  appBundleRoot: string;
  /**
   * Version of the RUNNING session, recorded into this boot's sentinel so the
   * next boot can name it if this one dies. Never used to describe a crash
   * detected during this boot — that crash belongs to an earlier session.
   */
  appVersion: string;
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
  /**
   * Every child death still logs; only GPU deaths are held back from the
   * prompt, and only until they repeat inside the window — Chromium replaces
   * that one process transparently, so an isolated death is invisible to the
   * user being asked about it.
   */
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
   * The newest minidump not yet covered by an acknowledgment (strictly newer
   * than the ack baseline) AND provably written for one of our own processes —
   * the dump belonging to whatever crash the user is currently invited to
   * report. `path` is null when the un-acked crash left no dump (e.g. dirty
   * shutdown without a native crash), when every dump is already acked, or
   * when the only fresh dumps belong to descendant processes that inherited
   * our crash handler. The two skip counts say which of those it was, which is
   * the difference between a bundle that arrived without a dump for a knowable
   * reason and one that is a mystery after the fact.
   *
   * Minidumps carry raw process memory that text redaction cannot scrub, so
   * bundle inclusion stays behind the report dialog's crash-dump checkbox
   * (pre-checked for a crash invite, opt-out) plus the review-before-send step
   * that calls this — never a silent attach. Ownership is the same consent
   * question one level down: the dialog's copy describes THIS app's memory, so
   * a dump we cannot prove is ours must not be offered. This path therefore
   * fails CLOSED on an unreadable dump, unlike `detectBootCrash`, which only
   * asks a dismissible question and fails open.
   */
  newestMinidumpForReport(): MinidumpReportLookup;
}

/**
 * What one report-time minidump lookup found. The skip counts are what the
 * ownership walk rejected on its way to the answer, carried alongside the path
 * so a caller that logs the outcome can say WHY there was no dump without
 * running a second classification pass.
 */
export interface MinidumpReportLookup {
  /** Absolute path of the attachable dump, or null when there is none. */
  path: string | null;
  /** Fresh dumps skipped because they belong to a descendant process. */
  foreignSkipped: number;
  /** Fresh dumps skipped because they could not be parsed at all. */
  unknownSkipped: number;
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
  /**
   * The one invitation in flight; a new signal while this is unacked and still
   * recent stays silent. `armedAtMs` is what bounds "still recent".
   */
  let active: {
    event: OkBugReportCrashDetectedEvent;
    delivered: boolean;
    armedAtMs: number;
  } | null = null;
  let runtimeSeq = 0;

  /**
   * GPU-death timestamps still inside the trailing window, oldest first. In
   * memory only: the counter asks whether the GPU is failing to stay up *right
   * now*, and a fresh process means a fresh GPU that has not yet failed.
   */
  let recentGpuCrashes: number[] = [];

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
          err,
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
   * Returns false when a recent invitation is still unanswered (new signals
   * stay silent rather than stacking prompts); a pending one that has gone
   * stale is superseded instead, so the newer crash is the one the user is
   * asked about rather than being dropped behind a prompt nobody answered.
   */
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
      // Warn, not info: the superseded invitation is one the user never
      // answered, so this line is the only record that a crash they were
      // offered a prompt for went unaddressed before the next one arrived.
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

  /**
   * Record a GPU death and decide whether it is still the recoverable kind.
   * Returns the in-window count too, so the log line carries the number the
   * decision was made on rather than leaving it to be inferred.
   */
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

  /** Baseline-filtered dumps from one scan of the crash-dumps dir, newest first. */
  function freshMinidumpEntries(): MinidumpEntry[] {
    const entries: MinidumpEntry[] = [];
    collectMinidumpEntries(deps.crashDumpsDir, MINIDUMP_SCAN_DEPTH, entries);
    const baselineMs = Date.parse(store.minidumpBaselineAt);
    return entries.filter((e) => e.mtimeMs > baselineMs).sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * Newest un-acked minidump this app can prove it owns, or null. Shared by
   * the report-time path lookup and the per-event availability signal so the
   * checkbox is only offered when there is a dump the bundle may actually
   * carry. Walks newest-first and stops at the first owned dump, so a quiet
   * crash database costs one parse rather than one per file.
   *
   * The two skip counts report what the walk rejected on its way there, which
   * is what the runtime callers log. They are kept apart because they mean
   * different things to whoever reads that line: `foreignSkipped` is a
   * descendant process crashing, an ordinary event, while `unknownSkipped` is a
   * dump we could not read at all — a half-flushed one, or the first sign that
   * the format drifted out from under the parser. Counting as the walk goes
   * keeps the short-circuit intact; asking for totals afterwards would mean
   * classifying every fresh dump on every renderer crash.
   */
  function newestOwnedMinidump(): {
    entry: MinidumpEntry | null;
    foreignSkipped: number;
    unknownSkipped: number;
  } {
    let foreignSkipped = 0;
    let unknownSkipped = 0;
    for (const entry of freshMinidumpEntries()) {
      const ownership = classifyDump(entry.path);
      if (ownership === 'ours') return { entry, foreignSkipped, unknownSkipped };
      if (ownership === 'foreign') foreignSkipped += 1;
      else unknownSkipped += 1;
    }
    return { entry: null, foreignSkipped, unknownSkipped };
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
      let prevAppVersion: string | null = null;
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
          // Must be read here, before this boot overwrites the file below:
          // afterwards the value on disk is the RUNNING version, which is the
          // wrong answer in exactly the update-between-sessions case that
          // makes the question worth asking. Gated like the minidump's
          // annotation because it reaches the same line of the same report,
          // and this file is no more trustworthy than that one.
          prevAppVersion = asReportableAppVersion(field('appVersion'));
        } catch {
          // Torn write from the crashed session — presence alone is the signal.
        }
      }

      // Every fresh dump is classified before it can influence anything: the
      // crash database also collects dumps for descendant processes that
      // inherited our exception handler, and an unrelated program aborting is
      // not this app crashing. Without this the app prompts "the previous
      // session crashed" after a perfectly clean quit.
      const freshDumps = freshMinidumpEntries().map((entry) => ({
        entry,
        ownership: classifyDump(entry.path),
      }));
      const foreignDumpCount = freshDumps.filter((d) => d.ownership === 'foreign').length;
      const unreadableDumpCount = freshDumps.filter((d) => d.ownership === 'unknown').length;
      if (foreignDumpCount > 0 || unreadableDumpCount > 0) {
        // Otherwise a suppressed prompt and a detection pipeline that never
        // ran are indistinguishable in the logs. The unreadable count is the
        // one to watch: a dump we cannot parse at all is either half-flushed
        // or the first sign the format moved out from under the parser, and
        // unlike a foreign dump it leaves no other trace.
        deps.logger.info(
          {
            event: 'crash-detection.foreign-dumps-ignored',
            count: foreignDumpCount,
            unreadable: unreadableDumpCount,
          },
          'ignored minidumps that this app could not claim',
        );
      }
      // Arming fails OPEN on an unparseable dump: a dump truncated by the very
      // crash that wrote it is more likely ours than not, and the cost of being
      // wrong is one prompt the user dismisses once. The attachment side takes
      // the opposite default, so an un-ownable dump can still never be sent.
      const newDumps = freshDumps
        .filter((d) => d.ownership !== 'foreign')
        .map((d) => d.entry.mtimeMs);
      const ownedDumpCount = freshDumps.filter((d) => d.ownership === 'ours').length;

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
          // The version of the session that DIED, which an auto-update between
          // the crash and this launch makes different from the running one.
          //
          // Both witnesses can be present at once — a reboot that killed a
          // session with a fresh dump leaves a sentinel AND a dump — so this
          // is a priority rule, not a partition of disjoint cases. The dump
          // wins wherever it decides the event: it was stamped at the instant
          // the process died, while the sentinel only names whichever session
          // happened to be running.
          //
          // Skipping foreign dumps is load-bearing rather than tidiness.
          // Crashpad stamps OUR annotations onto dumps it writes for
          // descendant processes, so a foreign one carries the CURRENT version
          // while describing an unrelated program's death — and, being newer,
          // would sort ahead of ours. Skipping it is what makes the first
          // entry of this newest-first list the same dump `newDumps` took the
          // event id's maximum from.
          //
          // Unknown stays unknown. Falling back to the running version here
          // would reproduce the misattribution this exists to remove, in a
          // form no reader could detect.
          const eventDump = dumpDriven
            ? freshDumps.find((d) => d.ownership !== 'foreign')
            : undefined;
          const dumpVersion =
            eventDump === undefined ? null : readMinidumpAppVersion(eventDump.entry.path);
          const crashedAppVersion = dumpDriven ? (dumpVersion?.version ?? null) : prevAppVersion;
          const event: OkBugReportCrashDetectedEvent = {
            eventId,
            kind: 'boot',
            context: { dirtyShutdown: !dumpDriven, newMinidumps: newDumps.length },
            // Availability is the stricter question — it decides whether the
            // dialog offers a checkbox that attaches process memory — so it
            // counts only dumps we proved are ours, never the fail-open set
            // that decided whether to prompt at all.
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
                // Logged even when null: this line is what an incident gets
                // reconstructed from, and "we could not tell" is itself the
                // finding when the two sources both come up empty.
                crashedAppVersion,
                // Which kind of silence that was. A dump predating the
                // annotation and a parser that broke on a Crashpad layout
                // change both reach the report as no version at all, and they
                // send whoever debugs it in opposite directions.
                crashedAppVersionParseFailed: dumpVersion?.parseFailed ?? false,
                detectingAppVersion: deps.appVersion,
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
      const owned = newestOwnedMinidump();
      deps.logger.warn(
        {
          event: 'crash-detection.render-process-gone',
          reason: details.reason,
          exitCode: details.exitCode,
          // Otherwise an absent crash-dump checkbox is unreadable after the
          // fact: a dump Crashpad had not finished flushing and a dump written
          // for a descendant process both reach the operator as "no dump".
          // Carried on this line rather than the boot path's separate
          // breadcrumb so the counts sit with the crash they explain.
          foreignDumpsIgnored: owned.foreignSkipped,
          unreadableDumpsSkipped: owned.unknownSkipped,
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
      // Logged at warn even when the prompt is held back: this line is the only
      // record that the GPU died at all, and a suppressed death that left no
      // breadcrumb is indistinguishable from one that never happened.
      deps.logger.warn(
        {
          event: 'crash-detection.child-process-gone',
          processType: details.type,
          reason: details.reason,
          exitCode: details.exitCode,
          foreignDumpsIgnored: owned.foreignSkipped,
          unreadableDumpsSkipped: owned.unknownSkipped,
          ...(gpu === null ? {} : { gpuCrashesInWindow: gpu.countInWindow }),
          ...(gpu?.suppressInvite === true ? { invitationSuppressed: 'gpu-recoverable' } : {}),
        },
        'child process died abnormally',
      );
      if (gpu?.suppressInvite === true) return;
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
      // Advancing the baseline marks this crash's minidumps as handled, so the
      // boot-time scan never re-invites for an event the user already answered.
      store.minidumpBaselineAt = deps.now().toISOString();
      persistStore();
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
