import { statSync as nodeStatSync, readFileSync } from 'node:fs';
import type { App, Dialog } from 'electron';

export interface BundleReplaceDetectorInput {
  infoPlistPath: string;
  processStartTimeMs: number;
  currentVersion: string;
  statSync: (path: string) => { mtimeMs: number } | null;
  readOnDiskVersion: (path: string) => string | null;
}

type BundleReplaceState =
  | { kind: 'unchanged' }
  | { kind: 'no-divergence' }
  | { kind: 'unreadable' }
  | { kind: 'upgraded'; onDiskVersion: string; currentVersion: string };

export function detectBundleReplace(input: BundleReplaceDetectorInput): BundleReplaceState {
  const stats = input.statSync(input.infoPlistPath);
  if (!stats) return { kind: 'unreadable' };
  if (stats.mtimeMs <= input.processStartTimeMs) return { kind: 'unchanged' };
  const onDiskVersion = input.readOnDiskVersion(input.infoPlistPath);
  if (!onDiskVersion) return { kind: 'unreadable' };
  if (onDiskVersion === input.currentVersion) return { kind: 'no-divergence' };
  return { kind: 'upgraded', onDiskVersion, currentVersion: input.currentVersion };
}

export function extractShortVersionFromPlist(xml: string): string | null {
  if (typeof xml !== 'string' || xml.length === 0) return null;
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
  if (!match || typeof match[1] !== 'string') return null;
  return match[1].trim();
}

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
  getCurrentVersion: () => string;
  dialog: Pick<Dialog, 'showMessageBox'>;
  app: Pick<App, 'relaunch' | 'quit'>;
  intervalMs?: number;
  processStartTimeMs?: number;
  statSync?: BundleReplaceDetectorInput['statSync'];
  readOnDiskVersion?: BundleReplaceDetectorInput['readOnDiskVersion'];
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  logger?: {
    info(msg: string, ctx?: object): void;
    warn(msg: string, ctx?: object): void;
  };
}

export interface BundleReplaceWatcherHandle {
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
        if (!stopped) armed = true;
        logger.warn('dialog failed, re-armed for next tick', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
  };

  timerHandle = setIntervalFn(tick, intervalMs);

  return { stop };
}
