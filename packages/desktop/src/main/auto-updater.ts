import type { OutgoingHttpHeaders } from 'node:http';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { EventChannels } from '../shared/ipc-events.ts';
import { createHandler } from '../shared/ipc-handler.ts';
import { type SendableWebContents, sendToRenderer } from '../shared/ipc-send.ts';
import type { AppState, UpdateChannel } from './state-store.ts';

const GITHUB_OWNER = 'inkeep';
const GITHUB_REPO = 'open-knowledge';

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel: string | null;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  forceDevUpdateConfig: boolean;
  setFeedURL(
    urlOrOptions:
      | string
      | { provider: 'generic'; url: string }
      | { provider: 'github'; owner: string; repo: string },
  ): void;
  requestHeaders: OutgoingHttpHeaders | null;
  on(event: 'checking-for-update', listener: () => void): this;
  on(event: 'update-available', listener: (info: { version?: string }) => void): this;
  on(event: 'update-not-available', listener: (info: { version?: string }) => void): this;
  on(
    event: 'download-progress',
    listener: (info: { percent?: number; bytesPerSecond?: number }) => void,
  ): this;
  on(event: 'update-downloaded', listener: (info: { version?: string }) => void): this;
  on(event: 'error', listener: (err: Error & { code?: string }) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface IpcMainLike extends Pick<IpcMain, 'handle' | 'removeHandler'> {}

interface Clock {
  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export type DispatchKind =
  | 'update-downloaded-toast-a'
  | 'update-downloaded-deduped'
  | 'update-downloaded-empty-version'
  | 'whats-new-toast-b'
  | 'whats-new-dismiss-broadcast'
  | 'stuck-hint-toast-c'
  | 'check-success'
  | 'error-classified'
  | 'error-unclassified'
  | 'relaunch-now'
  | 'relaunching-broadcast'
  | 'relaunch-failed-rearm'
  | 'relaunch-error-event'
  | 'relaunch-watchdog-fired'
  | 'skipped-dev-mode'
  | 'stale-pending-cleared'
  | 'attempted-install-reconciled'
  | 'install-failed-on-boot'
  | 'cross-channel-blocked';

interface StartAutoUpdaterOpts {
  updater: UpdaterLike;
  ipcMain: IpcMainLike;
  readState: () => AppState;
  writeState: (next: AppState) => void;
  getPrimaryWindow: () => { webContents: SendableWebContents } | null;
  getAllWindows?: () => readonly { webContents: SendableWebContents }[];
  getAppVersion: () => string;
  isPackaged: boolean;
  forceDevBypass?: boolean;
  feedUrl?: string;
  proxyFeed?: { base: string; channels: ReadonlySet<UpdateChannel> };
  whenRendererReady?: (fn: () => void) => void;
  prepareForRelaunch?: () => void | Promise<void>;
  showCheckNowResult?: (result: CheckNowResult) => void;
  clock?: Clock;
  now?: () => Date;
  random?: () => number;
  onDispatch?: (kind: DispatchKind) => void;
  logger?: Logger;
}

type CheckNowResult =
  | { kind: 'available'; currentVersion: string; latestVersion: string }
  | { kind: 'not-available'; currentVersion: string }
  | { kind: 'error'; message: string };

export interface StartAutoUpdaterHandle {
  destroy(): void;
  checkForUpdatesNow(): Promise<unknown>;
  getActiveWhatsNew(): { version: string; releaseUrl: string } | null;
}

interface Logger {
  info(msg: string, ctx?: object): void;
  warn(msg: string, ctx?: object): void;
  error(msg: string, ctx?: object): void;
  debug(msg: string, ctx?: object): void;
}

const DEFAULT_CLOCK: Clock = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (h) => {
    globalThis.clearTimeout(h);
  },
};

const DEFAULT_LOGGER: Logger = {
  info: (msg, ctx) => console.info('[updater]', msg, ctx ?? ''),
  warn: (msg, ctx) => console.warn('[updater]', msg, ctx ?? ''),
  error: (msg, ctx) => console.error('[updater]', msg, ctx ?? ''),
  debug: (msg, ctx) => console.debug('[updater]', msg, ctx ?? ''),
};

export const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export const UPDATE_CHECK_JITTER_MS = 30 * 1000;

export const RELAUNCH_WATCHDOG_MS = 15_000;

export const STUCK_HINT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export const STUCK_HINT_DOWNLOAD_URL = 'https://inkeep.com/open-knowledge/download';

const WHATS_NEW_LIVE_WINDOW_MS = 60_000;

export function releaseUrlFor(version: string): string {
  return `https://github.com/inkeep/open-knowledge/releases/tag/v${encodeURIComponent(version)}`;
}

export function isClassifiedUpdaterError(err: unknown): err is Error & { code: string } {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return code.startsWith('ERR_UPDATER_') || code.startsWith('HTTP_ERROR_');
}

export function applyChannelSettings(
  updater: Pick<UpdaterLike, 'channel' | 'allowPrerelease' | 'allowDowngrade'>,
  channel: UpdateChannel,
): void {
  updater.channel = channel;
  updater.allowPrerelease = channel === 'beta';
  updater.allowDowngrade = false;
}

export function channelFromVersion(version: string): UpdateChannel {
  if (typeof version !== 'string' || version === '') return 'latest';
  const stripped = version.split('+', 1)[0] ?? version;
  const match = /^\d+\.\d+\.\d+(?:-([\w.-]+))?$/.exec(stripped);
  if (!match) return 'latest';
  return match[1] ? 'beta' : 'latest';
}

export function buildCheckNowResultFromError(err: unknown, currentVersion: string): CheckNowResult {
  const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
    return { kind: 'not-available', currentVersion };
  }
  const message =
    err instanceof Error
      ? err.message || 'Update check failed'
      : typeof err === 'string'
        ? err || 'Update check failed'
        : 'Update check failed';
  return { kind: 'error', message };
}

export function versionAtLeast(running: string, pending: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    if (typeof v !== 'string') return null;
    const stripped = v.split(/[-+]/, 1)[0] ?? v;
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(stripped);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const r = parse(running);
  const p = parse(pending);
  if (!r || !p) return false;
  if (r[0] !== p[0]) return r[0] > p[0];
  if (r[1] !== p[1]) return r[1] > p[1];
  return r[2] >= p[2];
}

export function installReached(running: string, attempted: string): boolean {
  const parse = (v: string): { mmp: [number, number, number]; pre: string[] } | null => {
    if (typeof v !== 'string') return null;
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
    if (!m) return null;
    return {
      mmp: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] ? m[4].split('.') : [],
    };
  };
  const r = parse(running);
  const a = parse(attempted);
  if (!r || !a) return true;
  for (let i = 0; i < 3; i++) {
    if (r.mmp[i] !== a.mmp[i]) return (r.mmp[i] as number) > (a.mmp[i] as number);
  }
  if (r.pre.length === 0 && a.pre.length === 0) return true;
  if (r.pre.length === 0) return true; // running is stable, attempted is a prerelease
  if (a.pre.length === 0) return false; // running is a prerelease, attempted is stable
  const len = Math.min(r.pre.length, a.pre.length);
  for (let i = 0; i < len; i++) {
    const ri = r.pre[i] as string;
    const ai = a.pre[i] as string;
    if (ri === ai) continue;
    const rNum = /^\d+$/.test(ri);
    const aNum = /^\d+$/.test(ai);
    if (rNum && aNum) return Number(ri) > Number(ai);
    if (rNum !== aNum) return aNum; // numeric identifiers rank below non-numeric
    return ri > ai; // both non-numeric — ASCII order
  }
  return r.pre.length >= a.pre.length;
}

export function startAutoUpdater(opts: StartAutoUpdaterOpts): StartAutoUpdaterHandle {
  const {
    updater,
    ipcMain,
    readState,
    writeState,
    getPrimaryWindow,
    getAllWindows,
    getAppVersion,
    isPackaged,
    forceDevBypass = false,
    feedUrl,
    proxyFeed,
    whenRendererReady,
    showCheckNowResult,
    clock = DEFAULT_CLOCK,
    now = () => new Date(),
    random = Math.random,
    onDispatch,
    logger = DEFAULT_LOGGER,
  } = opts;

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  const buildChannel = channelFromVersion(getAppVersion());
  applyChannelSettings(updater, buildChannel);

  updater.forceDevUpdateConfig = forceDevBypass;
  let usingProxyFeed = false;
  let proxyFallbackTried = false;
  if (feedUrl) {
    updater.setFeedURL(feedUrl);
    logger.info('setFeedURL (dev override) — updater will pull manifest from local mock', {
      feedUrl,
    });
  } else if (proxyFeed?.channels.has(buildChannel)) {
    const channelPath = buildChannel === 'beta' ? 'beta' : 'stable';
    updater.setFeedURL({ provider: 'generic', url: `${proxyFeed.base}/${channelPath}` });
    updater.requestHeaders = {
      'x-ok-from-version': getAppVersion(),
      'x-ok-channel': channelPath,
    };
    usingProxyFeed = true;
    logger.info('setFeedURL (proxy) — updater feed pointed at the openknowledge.ai proxy', {
      channel: channelPath,
    });
  }

  const revertToGithubFeed = (cause: string): void => {
    if (!usingProxyFeed || proxyFallbackTried) return;
    proxyFallbackTried = true;
    usingProxyFeed = false;
    updater.requestHeaders = null;
    try {
      updater.setFeedURL({ provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO });
    } catch (err) {
      logger.error('proxy-feed fallback setFeedURL threw', {
        cause,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    logger.warn('proxy feed failed — reverted to GitHub provider for this session', { cause });
    void updater.checkForUpdates().catch((err: Error & { code?: string }) => {
      const ctx = {
        code: err?.code,
        message: err instanceof Error ? err.message : String(err),
      };
      if (isClassifiedUpdaterError(err)) {
        logger.warn('post-fallback checkForUpdates rejected', ctx);
      } else {
        logger.debug('post-fallback checkForUpdates rejected', ctx);
      }
    });
  };

  const broadcast = <K extends keyof EventChannels>(
    channel: K,
    payload: EventChannels[K]['payload'],
  ): void => {
    const target = getPrimaryWindow();
    if (!target) {
      logger.debug('broadcast skipped — no primary window');
      return;
    }
    sendToRenderer(target.webContents, channel, payload);
  };

  const broadcastToAllWindows = <K extends keyof EventChannels>(
    channel: K,
    payload: EventChannels[K]['payload'],
  ): void => {
    const all = getAllWindows?.();
    if (!all || all.length === 0) {
      broadcast(channel, payload);
      return;
    }
    for (const win of all) {
      sendToRenderer(win.webContents, channel, payload);
    }
  };

  const persistSafely = (next: AppState, ctx: string): boolean => {
    try {
      writeState(next);
      return true;
    } catch (err) {
      logger.error('writeState failed — state gate not armed', {
        ctx,
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  const maybeFireStuckHint = (): void => {
    const state = readState();
    if (state.stuckHintShown) return;
    if (!state.lastSuccessfulCheckAt) return; // no baseline yet — fresh install can't be "stuck"
    const last = Date.parse(state.lastSuccessfulCheckAt);
    if (Number.isNaN(last)) return;
    const elapsedMs = now().getTime() - last;
    if (elapsedMs < STUCK_HINT_THRESHOLD_MS) return;

    if (!persistSafely({ ...state, stuckHintShown: true }, 'stuck-hint')) return;

    const fireToastC = () => {
      broadcast('ok:update:stuck-hint', { downloadUrl: STUCK_HINT_DOWNLOAD_URL });
      logger.warn('stuck-hint dispatched', {
        lastSuccessfulCheckAt: state.lastSuccessfulCheckAt,
        elapsedDays: Math.floor(elapsedMs / (24 * 60 * 60 * 1000)),
      });
      onDispatch?.('stuck-hint-toast-c');
    };
    if (whenRendererReady) whenRendererReady(fireToastC);
    else fireToastC();
  };

  const markCheckSucceeded = (): void => {
    const state = readState();
    if (
      !persistSafely(
        {
          ...state,
          lastSuccessfulCheckAt: now().toISOString(),
          stuckHintShown: false,
        },
        'check-success',
      )
    )
      return;
    onDispatch?.('check-success');
  };

  const onCheckingForUpdate = (): void => {
    logger.info('checking-for-update');
  };

  let menuCheckPending = false;

  let relaunchInFlight: {
    version: string;
    watchdog: ReturnType<typeof setTimeout>;
  } | null = null;

  const failRelaunch = (
    version: string,
    message: string | undefined,
    kind: DispatchKind,
    /** Original error context (error-event trigger only) — correlates this
     * recovery log line with the classified/unclassified onError entry. */
    cause?: { code?: string; stack?: string },
  ): void => {
    if (relaunchInFlight) {
      clock.clearTimeout(relaunchInFlight.watchdog);
      relaunchInFlight = null;
    }
    if (
      persistSafely({ ...readState(), versionPendingInstall: version }, 'relaunch-failed-restore')
    ) {
      broadcastToAllWindows('ok:update:downloaded', { version });
    }
    broadcastToAllWindows('ok:update:relaunch-failed', { version, message });
    logger.warn('relaunch failed — restored pending install and re-armed windows', {
      version,
      kind,
      message,
      causeCode: cause?.code,
      causeStack: cause?.stack,
    });
    onDispatch?.(kind);
  };

  let activeWhatsNew: { version: string; releaseUrl: string; firedAt: number } | null = null;

  const runMenuDrivenCheck = (): Promise<unknown> => {
    menuCheckPending = true;
    const checkPromise = updater.checkForUpdates();
    void checkPromise.catch((err: unknown) => {
      const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
      const logFn = isClassifiedUpdaterError(err) ? logger.warn : logger.debug;
      logFn('check-now checkForUpdates rejected', {
        code,
        message: err instanceof Error ? err.message : String(err),
        timestamp: now().toISOString(),
      });
      if (menuCheckPending) {
        menuCheckPending = false;
        showCheckNowResult?.(buildCheckNowResultFromError(err, getAppVersion()));
      }
    });
    return checkPromise;
  };

  const classifyOffer = (
    offeredVersion: string | undefined,
  ): 'same-channel' | 'empty-version' | 'channel-mismatch' => {
    if (typeof offeredVersion !== 'string' || offeredVersion === '') {
      return 'empty-version';
    }
    return channelFromVersion(offeredVersion) === buildChannel
      ? 'same-channel'
      : 'channel-mismatch';
  };

  const onUpdateAvailable = (info: { version?: string }): void => {
    logger.info('update-available', { version: info.version });
    const offerClass = classifyOffer(info.version);
    if (offerClass !== 'same-channel') {
      logger.warn('update-available vetoed', {
        reason: offerClass,
        buildChannel,
        offeredVersion: info.version,
        offeredChannel:
          offerClass === 'channel-mismatch' ? channelFromVersion(info.version ?? '') : null,
      });
      markCheckSucceeded();
      onDispatch?.('cross-channel-blocked');
      return;
    }
    markCheckSucceeded();
    void updater.downloadUpdate().catch((err: unknown) => {
      const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
      const logFn = isClassifiedUpdaterError(err) ? logger.warn : logger.debug;
      logFn('downloadUpdate rejected', {
        code,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        timestamp: now().toISOString(),
      });
    });
  };

  const onUpdateAvailableForMenuCheck = (info: { version?: string }): void => {
    if (!menuCheckPending) return;
    menuCheckPending = false;
    if (classifyOffer(info.version) !== 'same-channel') {
      showCheckNowResult?.({ kind: 'not-available', currentVersion: getAppVersion() });
      return;
    }
    showCheckNowResult?.({
      kind: 'available',
      currentVersion: getAppVersion(),
      latestVersion: typeof info.version === 'string' ? info.version : 'unknown',
    });
  };

  const onUpdateNotAvailable = (info: { version?: string }): void => {
    logger.info('update-not-available', { version: info.version });
    markCheckSucceeded();
    if (menuCheckPending) {
      menuCheckPending = false;
      showCheckNowResult?.({
        kind: 'not-available',
        currentVersion: getAppVersion(),
      });
    }
  };

  const onDownloadProgress = (info: { percent?: number; bytesPerSecond?: number }): void => {
    logger.debug('download-progress', {
      percent: info.percent,
      bytesPerSecond: info.bytesPerSecond,
    });
  };

  const onUpdateDownloaded = (info: { version?: string }): void => {
    logger.info('update-downloaded', { version: info.version });
    const version = typeof info.version === 'string' ? info.version : '';
    if (!version) {
      logger.warn('update-downloaded with empty version — skipping dispatch');
      onDispatch?.('update-downloaded-empty-version');
      return;
    }
    const state = readState();
    if (state.versionPendingInstall === version) {
      logger.info('update-downloaded re-fired for same pending version — deduped', { version });
      onDispatch?.('update-downloaded-deduped');
      return;
    }
    if (
      !persistSafely(
        { ...state, versionPendingInstall: version, attemptedInstall: version },
        'update-downloaded',
      )
    )
      return;
    const fireToastA = () => {
      broadcastToAllWindows('ok:update:downloaded', { version });
      logger.info('update-downloaded dispatched Toast A (all windows)', { version });
      onDispatch?.('update-downloaded-toast-a');
    };
    if (whenRendererReady) whenRendererReady(fireToastA);
    else fireToastA();
  };

  const onError = (err: Error & { code?: string }): void => {
    if (isClassifiedUpdaterError(err)) {
      logger.warn('error (classified)', {
        code: err.code,
        message: err.message,
        timestamp: now().toISOString(),
      });
      onDispatch?.('error-classified');
    } else {
      logger.error('error (unclassified)', {
        message: err.message,
        stack: err.stack,
        timestamp: now().toISOString(),
      });
      onDispatch?.('error-unclassified');
    }
    revertToGithubFeed(err.code ?? err.message);
    if (relaunchInFlight) {
      failRelaunch(
        relaunchInFlight.version,
        err.message || 'update error during relaunch',
        'relaunch-error-event',
        { code: err.code, stack: err.stack },
      );
    }
    if (menuCheckPending) {
      menuCheckPending = false;
      showCheckNowResult?.(buildCheckNowResultFromError(err, getAppVersion()));
    }
    maybeFireStuckHint();
  };

  updater.on('checking-for-update', onCheckingForUpdate);
  updater.on('update-available', onUpdateAvailable);
  updater.on('update-available', onUpdateAvailableForMenuCheck);
  updater.on('update-not-available', onUpdateNotAvailable);
  updater.on('download-progress', onDownloadProgress);
  updater.on('update-downloaded', onUpdateDownloaded);
  updater.on('error', onError);

  const register = createHandler(ipcMain as IpcMain);
  register('ok:update:relaunch-now', async (_event: IpcMainInvokeEvent): Promise<undefined> => {
    const snapshot = readState();
    if (!snapshot.versionPendingInstall) {
      logger.warn('relaunch-now invoked without versionPendingInstall — ignoring');
      return undefined;
    }
    const pending = snapshot.versionPendingInstall;
    if (!persistSafely({ ...snapshot, versionPendingInstall: null }, 'relaunch-now'))
      return undefined;
    broadcastToAllWindows('ok:update:relaunching', { version: pending });
    onDispatch?.('relaunching-broadcast');
    if (opts.prepareForRelaunch) {
      try {
        await opts.prepareForRelaunch();
      } catch (err) {
        logger.warn('prepareForRelaunch threw — proceeding to quitAndInstall anyway', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    logger.info('relaunch-now invoked — calling autoUpdater.quitAndInstall', { pending });
    onDispatch?.('relaunch-now');
    try {
      updater.quitAndInstall();
    } catch (err) {
      failRelaunch(
        pending,
        err instanceof Error ? err.message : String(err),
        'relaunch-failed-rearm',
      );
      throw err;
    }
    if (isPackaged) {
      const watchdog = clock.setTimeout(() => {
        failRelaunch(pending, 'the update timed out', 'relaunch-watchdog-fired');
      }, RELAUNCH_WATCHDOG_MS);
      relaunchInFlight = { version: pending, watchdog };
    }
    return undefined;
  });

  register('ok:update:check-now', (_event: IpcMainInvokeEvent): undefined => {
    void runMenuDrivenCheck();
    return undefined;
  });

  register(
    'ok:update:whats-new-dismiss',
    (_event: IpcMainInvokeEvent, payload: { version: string }): undefined => {
      const version = typeof payload?.version === 'string' ? payload.version : '';
      if (activeWhatsNew && activeWhatsNew.version === version) {
        activeWhatsNew = null;
      }
      broadcastToAllWindows('ok:update:whats-new-dismissed', { version });
      onDispatch?.('whats-new-dismiss-broadcast');
      return undefined;
    },
  );

  const currentVersion = getAppVersion();
  let state = readState();

  if (state.versionPendingInstall && versionAtLeast(currentVersion, state.versionPendingInstall)) {
    const cleared = state.versionPendingInstall;
    const next = { ...state, versionPendingInstall: null };
    if (persistSafely(next, 'stale-pending-cleared')) {
      state = next;
      logger.info('cleared stale versionPendingInstall — running has caught up', {
        cleared,
        running: currentVersion,
      });
      onDispatch?.('stale-pending-cleared');
    }
  }

  if (state.attemptedInstall) {
    const attempted = state.attemptedInstall;
    if (installReached(currentVersion, attempted)) {
      const next = { ...state, attemptedInstall: null };
      if (persistSafely(next, 'attempted-install-reconciled')) {
        state = next;
        onDispatch?.('attempted-install-reconciled');
      } else {
        logger.warn('failed to persist attempted-install-reconciled', {
          attempted,
          running: currentVersion,
        });
      }
    } else {
      const next = { ...state, versionPendingInstall: attempted };
      if (persistSafely(next, 'install-failed-on-boot')) {
        state = next;
        logger.warn('attempted install did not take — surfacing failure notice', {
          attempted,
          running: currentVersion,
        });
        const fireInstallFailed = (): void => {
          broadcastToAllWindows('ok:update:relaunch-failed', {
            version: attempted,
            downloadUrl: STUCK_HINT_DOWNLOAD_URL,
          });
        };
        if (whenRendererReady) whenRendererReady(fireInstallFailed);
        else fireInstallFailed();
        onDispatch?.('install-failed-on-boot');
      }
    }
  }

  const shouldShowVersionNotice =
    state.lastSeenVersion !== null && state.lastSeenVersion !== currentVersion;
  const needsStateAdvance = state.lastSeenVersion !== currentVersion;

  if (needsStateAdvance) {
    const advanced = persistSafely(
      { ...state, lastSeenVersion: currentVersion },
      'lastSeenVersion-advance',
    );
    if (advanced && shouldShowVersionNotice) {
      const fireToastB = (): void => {
        const releaseUrl = releaseUrlFor(currentVersion);
        activeWhatsNew = { version: currentVersion, releaseUrl, firedAt: now().getTime() };
        broadcastToAllWindows('ok:update:whats-new', {
          version: currentVersion,
          releaseUrl,
        });
        logger.info('whats-new dispatched Toast B (all windows)', {
          from: state.lastSeenVersion,
          to: currentVersion,
        });
        onDispatch?.('whats-new-toast-b');
      };
      if (whenRendererReady) whenRendererReady(fireToastB);
      else fireToastB();
    }
  }

  let timerHandle: ReturnType<typeof setTimeout> | null = null;

  const nextCheckDelayMs = (): number =>
    UPDATE_CHECK_INTERVAL_MS + Math.floor(random() * UPDATE_CHECK_JITTER_MS);

  const scheduleNextCheck = (): void => {
    const delayMs = nextCheckDelayMs();
    timerHandle = clock.setTimeout(() => {
      timerHandle = null;
      void updater.checkForUpdates().catch((err: unknown) => {
        logger.debug('checkForUpdates rejected', {
          message: err instanceof Error ? err.message : String(err),
        });
      });
      scheduleNextCheck();
    }, delayMs);
    logger.debug('next update check scheduled', { delayMs });
  };

  const startPeriodicChecks = (): void => {
    if (timerHandle) return;
    scheduleNextCheck();
  };

  if (isPackaged || forceDevBypass) {
    void updater
      .checkForUpdates()
      .then(() => {
        startPeriodicChecks();
      })
      .catch((err: unknown) => {
        logger.debug('first-launch checkForUpdates rejected', {
          message: err instanceof Error ? err.message : String(err),
        });
        revertToGithubFeed('first-check-rejected');
        startPeriodicChecks();
      });
  } else {
    logger.info(
      'skipping checkForUpdates — app.isPackaged=false and OK_UPDATER_FORCE_DEV unset (handlers remain wired for tests + IPC)',
    );
    onDispatch?.('skipped-dev-mode');
  }

  return {
    checkForUpdatesNow(): Promise<unknown> {
      logger.info('check-now invoked from menu');
      return runMenuDrivenCheck();
    },
    getActiveWhatsNew(): { version: string; releaseUrl: string } | null {
      if (!activeWhatsNew) return null;
      if (now().getTime() - activeWhatsNew.firedAt >= WHATS_NEW_LIVE_WINDOW_MS) {
        return null;
      }
      return { version: activeWhatsNew.version, releaseUrl: activeWhatsNew.releaseUrl };
    },
    destroy(): void {
      if (timerHandle) {
        clock.clearTimeout(timerHandle);
        timerHandle = null;
      }
      if (relaunchInFlight) {
        clock.clearTimeout(relaunchInFlight.watchdog);
        relaunchInFlight = null;
      }
      const detach = (event: string, handler: (...args: unknown[]) => void): void => {
        try {
          updater.off(event, handler);
        } catch (err) {
          logger.warn('updater.off failed during destroy', {
            event,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      };
      detach('checking-for-update', onCheckingForUpdate as (...args: unknown[]) => void);
      detach('update-available', onUpdateAvailable as (...args: unknown[]) => void);
      detach('update-available', onUpdateAvailableForMenuCheck as (...args: unknown[]) => void);
      detach('update-not-available', onUpdateNotAvailable as (...args: unknown[]) => void);
      detach('download-progress', onDownloadProgress as (...args: unknown[]) => void);
      detach('update-downloaded', onUpdateDownloaded as (...args: unknown[]) => void);
      detach('error', onError as (...args: unknown[]) => void);
      const removeHandlerSafely = (channel: string): void => {
        try {
          ipcMain.removeHandler(channel);
        } catch (err) {
          logger.warn('ipcMain.removeHandler failed during destroy', {
            channel,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      };
      removeHandlerSafely('ok:update:relaunch-now');
      removeHandlerSafely('ok:update:check-now');
      removeHandlerSafely('ok:update:whats-new-dismiss');
      logger.info('destroyed');
    },
  };
}

interface ElectronUpdaterModule {
  autoUpdater?: UpdaterLike;
  default?: { autoUpdater?: UpdaterLike };
}

function resolveAutoUpdater(mod: ElectronUpdaterModule): UpdaterLike | null {
  return mod.default?.autoUpdater ?? mod.autoUpdater ?? null;
}

export async function bootAutoUpdater(
  importUpdater: () => Promise<ElectronUpdaterModule>,
  opts: Omit<StartAutoUpdaterOpts, 'updater'>,
): Promise<StartAutoUpdaterHandle | null> {
  const logger = opts.logger ?? DEFAULT_LOGGER;
  try {
    const mod = await importUpdater();
    const autoUpdater = resolveAutoUpdater(mod);
    if (!autoUpdater) {
      throw new Error(
        "electron-updater did not expose 'autoUpdater' on either the module namespace or .default — check electron-updater version + Node ESM-CJS interop",
      );
    }
    return startAutoUpdater({ updater: autoUpdater, ...opts });
  } catch (err) {
    logger.error('auto-updater boot failed — app will run without updates this session', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return null;
  }
}
