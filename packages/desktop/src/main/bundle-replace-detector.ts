/**
 * Detect a drag-replace upgrade that happened mid-session and prompt the
 * user to restart so the new bundle's metadata reaches the running process.
 *
 * Why this exists. AppKit caches `Info.plist` values at process launch via
 * `CFBundleGetValueForInfoDictionaryKey`. The cache is per-process and is
 * NOT invalidated when the underlying file changes on disk. When a user
 * drag-replaces `/Applications/OpenKnowledge.app` over an existing running
 * build, the still-running process keeps serving the OLD bundle's metadata
 * — the About panel (`role: 'about'` delegates to `orderFrontStandardAboutPanel:`,
 * which reads from `NSBundle.mainBundle`), Activity Monitor's Get Info, and
 * any in-process consumer that reads `CFBundleShortVersionString` /
 * `CFBundleVersion`.
 *
 * The detector polls the on-disk Info.plist's mtime + version on a periodic
 * timer. A mtime newer than process start AND an on-disk version different
 * from the running process's `app.getVersion()` together prove a mid-session
 * upgrade. The mtime gate alone is too loose (codesigning, quarantine
 * attribute writes can update mtime without an upgrade); pairing it with the
 * version comparison keeps false positives near zero.
 *
 * The auto-updater path doesn't surface this divergence in practice: even
 * though Squirrel.Mac's ShipIt staging overlaps the running process
 * momentarily, the relaunch step terminates the original process before
 * any in-process consumer can read stale metadata. Only manual
 * drag-replace-while-running leaves a long-lived stale process behind.
 *
 * Single-shot per session: once a prompt is shown to the user, subsequent
 * ticks no-op until the user responds. A transient dialog failure (window
 * destroyed mid-show, framework rejection) re-arms so the next tick can
 * retry — without re-arm a single transient failure would silently strand
 * the user with no upgrade signal for the rest of the session. The watcher
 * is destroyed on `will-quit` via the returned handle.
 */

import { statSync as nodeStatSync, readFileSync } from 'node:fs';
import type { App, Dialog } from 'electron';

export interface BundleReplaceDetectorInput {
  /** Absolute path to the running bundle's `Info.plist`. */
  infoPlistPath: string;
  /** Epoch ms at which the running process started. */
  processStartTimeMs: number;
  /** The running process's `app.getVersion()` — what AppKit cached at launch. */
  currentVersion: string;
  /** Returns `{ mtimeMs }` for the path, or `null` on ENOENT / permission error. */
  statSync: (path: string) => { mtimeMs: number } | null;
  /** Reads the on-disk Info.plist's `CFBundleShortVersionString`, or null on failure. */
  readOnDiskVersion: (path: string) => string | null;
}

type BundleReplaceState =
  /** mtime predates process start — no upgrade happened during this session. */
  | { kind: 'unchanged' }
  /** mtime is newer than process start but the on-disk version matches running — file touched without an upgrade. */
  | { kind: 'no-divergence' }
  /** Couldn't stat or parse the plist — be conservative, no prompt. */
  | { kind: 'unreadable' }
  /** Drag-replace detected: prompt user to restart. */
  | { kind: 'upgraded'; onDiskVersion: string; currentVersion: string };

/**
 * Pure: classify the running process against the on-disk bundle state.
 */
export function detectBundleReplace(input: BundleReplaceDetectorInput): BundleReplaceState {
  const stats = input.statSync(input.infoPlistPath);
  if (!stats) return { kind: 'unreadable' };
  // Strict greater-than: a swap that landed at the exact ms of process start
  // is indistinguishable from "this process WAS launched from that bundle."
  if (stats.mtimeMs <= input.processStartTimeMs) return { kind: 'unchanged' };
  const onDiskVersion = input.readOnDiskVersion(input.infoPlistPath);
  if (!onDiskVersion) return { kind: 'unreadable' };
  if (onDiskVersion === input.currentVersion) return { kind: 'no-divergence' };
  return { kind: 'upgraded', onDiskVersion, currentVersion: input.currentVersion };
}

/**
 * Extract `CFBundleShortVersionString` from a plist XML string. Returns null
 * when the key is absent, the input is non-XML (e.g., binary plist), or
 * parsing fails for any reason. The regex tolerates whitespace + newlines
 * between the `<key>` and the following `<string>` tag.
 *
 * Pure — no I/O. Exported for tests.
 */
export function extractShortVersionFromPlist(xml: string): string | null {
  if (typeof xml !== 'string' || xml.length === 0) return null;
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
  if (!match || typeof match[1] !== 'string') return null;
  return match[1].trim();
}

/**
 * Production reader: read the on-disk Info.plist and extract its short
 * version string. Returns null on any read or parse failure (the watcher
 * treats null as `unreadable`, which is the conservative no-prompt branch).
 */
function readPlistShortVersionString(filePath: string): string | null {
  try {
    const contents = readFileSync(filePath, 'utf8');
    return extractShortVersionFromPlist(contents);
  } catch {
    return null;
  }
}

interface BundleReplaceWatcherDeps {
  infoPlistPath: string;
  /** Read at each tick — the running process's `app.getVersion()`. */
  getCurrentVersion: () => string;
  dialog: Pick<Dialog, 'showMessageBox'>;
  app: Pick<App, 'relaunch' | 'quit'>;
  /** Default: 5 min. */
  intervalMs?: number;
  /** Default: `Date.now() - process.uptime() * 1000`. Injectable for tests. */
  processStartTimeMs?: number;
  /** Default: `node:fs.statSync` with try/catch → null on error. */
  statSync?: BundleReplaceDetectorInput['statSync'];
  /** Default: `readPlistShortVersionString`. */
  readOnDiskVersion?: BundleReplaceDetectorInput['readOnDiskVersion'];
  /** Default: global `setInterval`. */
  setInterval?: typeof setInterval;
  /** Default: global `clearInterval`. */
  clearInterval?: typeof clearInterval;
  logger?: {
    info(msg: string, ctx?: object): void;
    warn(msg: string, ctx?: object): void;
  };
}

export interface BundleReplaceWatcherHandle {
  /** Stop the periodic timer. Idempotent. */
  stop: () => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

function defaultStatSync(path: string): { mtimeMs: number } | null {
  try {
    const s = nodeStatSync(path);
    return { mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

const DEFAULT_LOGGER: NonNullable<BundleReplaceWatcherDeps['logger']> = {
  info: (...args) => console.info('[bundle-replace-detector]', ...args),
  warn: (...args) => console.warn('[bundle-replace-detector]', ...args),
};

/**
 * Arm a periodic check for mid-session drag-replace upgrades. Returns a
 * handle whose `stop()` clears the interval — wire on `will-quit`. The
 * watcher fires the restart prompt at most once per session, regardless of
 * how the user responds (Restart now → quits; Later → de-arms until next
 * launch).
 */
export function startBundleReplaceWatcher(
  deps: BundleReplaceWatcherDeps,
): BundleReplaceWatcherHandle {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const processStartTimeMs =
    deps.processStartTimeMs ?? Date.now() - Math.floor(process.uptime() * 1000);
  const statSync = deps.statSync ?? defaultStatSync;
  const readOnDiskVersion = deps.readOnDiskVersion ?? readPlistShortVersionString;
  const setIntervalFn = deps.setInterval ?? setInterval;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;
  const logger = deps.logger ?? DEFAULT_LOGGER;

  let armed = true;
  let stopped = false;
  let timerHandle: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (timerHandle !== null) {
      clearIntervalFn(timerHandle);
      timerHandle = null;
    }
    armed = false;
    stopped = true;
  };

  const tick = (): void => {
    if (!armed) return;
    let state: BundleReplaceState;
    try {
      state = detectBundleReplace({
        infoPlistPath: deps.infoPlistPath,
        processStartTimeMs,
        currentVersion: deps.getCurrentVersion(),
        statSync,
        readOnDiskVersion,
      });
    } catch (err) {
      logger.warn('detector threw', {
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (state.kind !== 'upgraded') return;

    // Disarm BEFORE awaiting the dialog so a slow user response doesn't allow
    // a second tick to fire a second prompt.
    armed = false;
    logger.info('drag-replace detected', {
      onDiskVersion: state.onDiskVersion,
      runningVersion: state.currentVersion,
    });

    deps.dialog
      .showMessageBox({
        type: 'info',
        message: 'An update was installed.',
        detail:
          `OpenKnowledge ${state.onDiskVersion} is installed on disk, but this window is still ` +
          `running ${state.currentVersion}. Restart to finish the upgrade.`,
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        // If the watcher was stopped while the dialog was pending (will-quit
        // ran on a concurrent quit path, or any teardown caller invoked
        // `stop()`), do not schedule a fresh relaunch+quit on top of the
        // already-in-flight shutdown. The user response is silently dropped
        // because there is no observable surface left to act on.
        if (stopped) return;
        if (result.response === 0) {
          logger.info('user accepted restart');
          deps.app.relaunch();
          deps.app.quit();
        } else {
          logger.info('user deferred restart');
        }
      })
      .catch((err: unknown) => {
        // Re-arm: a rejected dialog (window destroyed mid-show, framework
        // error) is treated as transient. Without re-arm a single transient
        // failure would silently strand the user with no upgrade signal for
        // the rest of the session. If the failure is persistent, the warn
        // log accumulates one entry per interval — bounded by intervalMs.
        if (!stopped) armed = true;
        logger.warn('dialog failed, re-armed for next tick', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
  };

  timerHandle = setIntervalFn(tick, intervalMs);

  return { stop };
}
