import type { OutgoingHttpHeaders } from 'node:http';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { EventChannels } from '../shared/ipc-events.ts';
import { createHandler } from '../shared/ipc-handler.ts';
import { type SendableWebContents, sendToRenderer } from '../shared/ipc-send.ts';
import {
  classifyInstallFailure,
  type LinuxManualInstallContext,
  manualInstallPlanFor,
} from './linux-install-fallback.ts';
import type { AppState, UpdateChannel } from './state-store.ts';
import type { WindowsUpdateSurvivorSweepResult } from './windows-update-survivor-sweep.ts';

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
  on(
    event: 'update-downloaded',
    listener: (info: { version?: string; downloadedFile?: string }) => void,
  ): this;
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
  | 'install-in-flight-deferred'
  | 'install-never-committed-reoffered'
  | 'install-failed-on-boot'
  | 'install-failed-giveup'
  | 'attempted-install-cross-channel'
  | 'cross-channel-blocked'
  | 'staged-cache-reclaimed'
  | 'linux-manual-fallback-no-auth'
  | 'linux-manual-fallback-after-error'
  | 'download-skipped-already-staged'
  | 'download-skipped-install-armed'
  | 'relaunch-refresh-found-newer'
  | 'relaunch-refresh-up-to-date'
  | 'relaunch-refresh-timed-out'
  | 'relaunch-awaited-in-flight-staging'
  | 'relaunch-double-invoke-blocked'
  | 'toast-a-deferred-post-update-quiet'
  | 'toast-a-quiet-window-elapsed';

interface StartAutoUpdaterOpts {
  updater: UpdaterLike;
  ipcMain: IpcMainLike;
  readState: () => AppState;
  writeState: (next: AppState) => void;
  getPrimaryWindow: () => { webContents: SendableWebContents } | null;
  getAllWindows?: () => readonly { webContents: SendableWebContents }[];
  getAppVersion: () => string;
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  forceDevBypass?: boolean;
  feedUrl?: string;
  proxyFeed?: { base: string; channels: ReadonlySet<UpdateChannel> };
  whenRendererReady?: (fn: () => void) => void;
  prepareForRelaunch?: () => void | Promise<void>;
  sweepUpdateSurvivors?: () => WindowsUpdateSurvivorSweepResult | undefined;
  reclaimStagedUpdateCache?: () => undefined | Promise<unknown>;
  linuxInstallSupport?: {
    hasGraphicalAuth: () => boolean;
    showManualInstallFallback: (ctx: LinuxManualInstallContext) => undefined | Promise<unknown>;
    stagedInstallerExists?: (path: string) => boolean;
  };
  showCheckNowResult?: (result: CheckNowResult) => void;
  clock?: Clock;
  now?: () => Date;
  random?: () => number;
  onDispatch?: (kind: DispatchKind) => void;
  logger?: Logger;
}

type CheckNowResult =
  | { kind: 'available'; currentVersion: string; latestVersion: string }
  | { kind: 'ready-to-install'; currentVersion: string; stagedVersion: string }
  | { kind: 'not-available'; currentVersion: string }
  | { kind: 'error'; message: string };

export interface StartAutoUpdaterHandle {
  destroy(): void;
  checkForUpdatesNow(): Promise<unknown>;
  getActiveWhatsNew(): { version: string; releaseUrl: string } | null;
  isWithinPostUpdateQuietWindow(): boolean;
  suppressAutoInstallOnQuit(): void;
  recordInstallHandoffOnQuit(): void;
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

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export const UPDATE_CHECK_JITTER_MS = 5 * 60 * 1000;

export const RELAUNCH_WATCHDOG_MS = 15_000;

export const STUCK_HINT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export const INSTALL_FAILURE_MAX_SURFACES = 3;

const INSTALL_IN_FLIGHT_GRACE_MS = 30 * 60 * 1000;

const INSTALL_DEFER_MAX_BOOTS = 3;

export const STUCK_HINT_DOWNLOAD_URL = 'https://github.com/inkeep/open-knowledge/releases';

export const RELAUNCH_REFRESH_CHECK_MS = 4_000;

export const RELAUNCH_REFRESH_DOWNLOAD_MS = 120_000;

export const POST_UPDATE_QUIET_MS = 10 * 60 * 1000;

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
  if (r.pre.length === 0) return true;
  if (a.pre.length === 0) return false;
  const len = Math.min(r.pre.length, a.pre.length);
  for (let i = 0; i < len; i++) {
    const ri = r.pre[i] as string;
    const ai = a.pre[i] as string;
    if (ri === ai) continue;
    const rNum = /^\d+$/.test(ri);
    const aNum = /^\d+$/.test(ai);
    if (rNum && aNum) return Number(ri) > Number(ai);
    if (rNum !== aNum) return aNum;
    return ri > ai;
  }
  return r.pre.length >= a.pre.length;
}

function installHandoffAgeMs(handoffAt: number | null, nowMs: number): number | null {
  if (handoffAt === null) return null;
  const elapsed = nowMs - handoffAt;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function resolveInstallHandoffMoment(state: AppState, stagedAt: number | null): number | null {
  return state.attemptedInstallHandoffAt ?? stagedAt;
}

interface InstallInFlightVerdict {
  attemptedVersion: string;
  handoffAt: number;
  recordedHandoff: boolean;
}

function hasRecordedHandoff(state: AppState): boolean {
  return state.attemptedInstallHandoffAt !== null;
}

function installInFlightAt(
  state: AppState,
  nowMs: number,
  stagedAt: number | null,
  enforceDeferBudget: boolean,
): InstallInFlightVerdict | null {
  const attempted = state.attemptedInstall;
  if (attempted === null) return null;
  const handoffAt = resolveInstallHandoffMoment(state, stagedAt);
  const handoffAgeMs = installHandoffAgeMs(handoffAt, nowMs);
  if (
    handoffAt === null ||
    handoffAgeMs === null ||
    handoffAgeMs > INSTALL_IN_FLIGHT_GRACE_MS ||
    (enforceDeferBudget && state.attemptedInstallDeferredBoots >= INSTALL_DEFER_MAX_BOOTS)
  ) {
    return null;
  }
  return {
    attemptedVersion: attempted,
    handoffAt,
    recordedHandoff: hasRecordedHandoff(state),
  };
}

export function installMayStillBeRunning(
  state: AppState,
  nowMs: number,
  stagedAt: number | null,
): InstallInFlightVerdict | null {
  return installInFlightAt(state, nowMs, stagedAt, true);
}

export function installWasInFlightDuring(
  state: AppState,
  span: { deathFromMs: number; deathToMs: number },
  stagedAt: number | null,
): InstallInFlightVerdict | null {
  const { deathFromMs, deathToMs } = span;
  if (!Number.isFinite(deathToMs)) return null;
  const spanStartMs =
    hasRecordedHandoff(state) && Number.isFinite(deathFromMs)
      ? Math.min(deathFromMs, deathToMs)
      : deathToMs;
  const spanCollapsed = spanStartMs === deathToMs;
  const handoffAt = resolveInstallHandoffMoment(state, stagedAt);
  const anchorMs =
    handoffAt === null ? deathToMs : Math.min(Math.max(handoffAt, spanStartMs), deathToMs);
  return installInFlightAt(state, anchorMs, stagedAt, spanCollapsed);
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
    platform = process.platform,
    forceDevBypass = false,
    feedUrl,
    proxyFeed,
    whenRendererReady,
    reclaimStagedUpdateCache,
    linuxInstallSupport,
    showCheckNowResult,
    clock = DEFAULT_CLOCK,
    now = () => new Date(),
    random = Math.random,
    onDispatch,
    logger = DEFAULT_LOGGER,
  } = opts;

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = platform !== 'linux';
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

  const updatesEnabled = isPackaged || forceDevBypass;

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
        err,
      });
      return;
    }
    logger.warn('proxy feed failed — reverted to GitHub provider for this session', { cause });
    void updater.checkForUpdates().catch((err: Error & { code?: string }) => {
      const ctx = {
        code: err?.code,
        err,
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
        err,
      });
      return false;
    }
  };

  const maybeFireStuckHint = (): void => {
    const state = readState();
    if (state.stuckHintShown) return;
    if (!state.lastSuccessfulCheckAt) return;
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

  let stagingInFlight: { version: string } | null = null;

  let stagedThisSession: string | null = null;

  const declinedForStagedVersion = (offeredVersion: string | undefined): string | null => {
    if (stagedThisSession === null) return null;
    if (stagedThisSession === offeredVersion) return stagedThisSession;
    return platform === 'darwin' ? stagedThisSession : null;
  };

  const currentStaging = (): { version: string } | null => stagingInFlight;

  let checkOutcomeWaiters: Array<(outcome: 'available' | 'settled') => void> = [];
  let stagingWaiters: Array<(ok: boolean) => void> = [];

  const settleCheckWaiters = (outcome: 'available' | 'settled'): void => {
    const waiters = checkOutcomeWaiters;
    checkOutcomeWaiters = [];
    for (const resolve of waiters) resolve(outcome);
  };

  const settleStagingWaiters = (ok: boolean): void => {
    const waiters = stagingWaiters;
    stagingWaiters = [];
    for (const resolve of waiters) resolve(ok);
  };

  let postUpdateQuietUntil: number | null = null;

  let quietWindowTimer: ReturnType<typeof setTimeout> | null = null;

  const withinPostUpdateQuietWindow = (): boolean =>
    postUpdateQuietUntil !== null && now().getTime() < postUpdateQuietUntil;

  let installRequested = false;

  let stagedInstallerPath: string | null = null;

  const usableStagedInstallerPath = (): string | null => {
    if (stagedInstallerPath === null) return null;
    const exists = linuxInstallSupport?.stagedInstallerExists;
    if (exists && !exists(stagedInstallerPath)) return null;
    return stagedInstallerPath;
  };

  const offerManualInstallFallback = (version: string, kind: DispatchKind): boolean => {
    if (platform !== 'linux' || !linuxInstallSupport) return false;
    const installerPath = usableStagedInstallerPath();
    const plan = manualInstallPlanFor(installerPath);
    if (!plan || installerPath === null) return false;
    logger.warn('offering manual-install fallback', {
      version,
      packageKind: plan.packageKind,
      trigger: kind,
    });
    onDispatch?.(kind);
    void Promise.resolve(
      linuxInstallSupport.showManualInstallFallback({
        version,
        installerPath,
        ...plan,
      }),
    ).catch((err: unknown) => {
      logger.error('manual-install fallback dialog failed', { err });
    });
    return true;
  };

  const failRelaunch = (
    version: string,
    message: string | undefined,
    kind: DispatchKind,
    cause?: { code?: string; stack?: string },
  ): void => {
    if (relaunchInFlight) {
      clock.clearTimeout(relaunchInFlight.watchdog);
      relaunchInFlight = null;
    }
    installRequested = false;
    const restored = persistSafely(
      { ...readState(), versionPendingInstall: version },
      'relaunch-failed-restore',
    );
    if (restored) {
      broadcastToAllWindows('ok:update:downloaded', { version });
    } else if (platform !== 'darwin') {
      logger.warn(
        stagedThisSession === null
          ? 'relaunch-failed restore did not persist — no single-flight arm was held'
          : 'relaunch-failed restore did not persist — releasing the single-flight arm',
        { version, kind, armedVersion: stagedThisSession },
      );
      stagedThisSession = null;
    } else {
      logger.warn(
        stagedThisSession === null
          ? 'relaunch-failed restore did not persist — no single-flight arm was held'
          : 'relaunch-failed restore did not persist — keeping the single-flight arm (darwin: ShipIt may still be waiting)',
        { version, kind, armedVersion: stagedThisSession },
      );
    }
    broadcastToAllWindows('ok:update:relaunch-failed', {
      version,
      message,
      ...(restored ? {} : { dismissPending: true }),
    });
    logger.warn(
      restored
        ? 'relaunch failed — restored pending install and re-armed windows'
        : 'relaunch failed — pending install NOT restored',
      {
        version,
        kind,
        message,
        causeCode: cause?.code,
        causeStack: cause?.stack,
      },
    );
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
        err,
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
    const offeredVersion = info.version;
    const offerClass = classifyOffer(offeredVersion);
    if (offerClass !== 'same-channel') {
      logger.warn('update-available vetoed', {
        reason: offerClass,
        buildChannel,
        offeredVersion: info.version,
        offeredChannel:
          offerClass === 'channel-mismatch' ? channelFromVersion(info.version ?? '') : null,
      });
      markCheckSucceeded();
      settleCheckWaiters('settled');
      onDispatch?.('cross-channel-blocked');
      return;
    }
    markCheckSucceeded();
    const armedVersion = declinedForStagedVersion(offeredVersion);
    if (armedVersion !== null) {
      const reOffer = armedVersion === offeredVersion;
      const logFn = reOffer ? logger.debug : logger.warn;
      logFn(
        reOffer
          ? 'update-available for the already-staged version — skipping re-download'
          : 'update-available while an install is already armed — skipping re-download',
        { version: offeredVersion, armedVersion },
      );
      settleCheckWaiters('settled');
      onDispatch?.(reOffer ? 'download-skipped-already-staged' : 'download-skipped-install-armed');
      return;
    }
    if (usingProxyFeed && offeredVersion) {
      updater.requestHeaders = {
        ...updater.requestHeaders,
        'x-ok-to-version': offeredVersion,
      };
    }
    stagingInFlight = { version: offeredVersion ?? 'unknown' };
    settleCheckWaiters('available');
    void updater.downloadUpdate().catch((err: unknown) => {
      const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
      const logFn = isClassifiedUpdaterError(err) ? logger.warn : logger.debug;
      logFn('downloadUpdate rejected', {
        code,
        err,
        timestamp: now().toISOString(),
      });
      if (stagingInFlight) {
        stagingInFlight = null;
        settleStagingWaiters(false);
      }
    });
  };

  const onUpdateAvailableForMenuCheck = (info: { version?: string }): void => {
    if (!menuCheckPending) return;
    menuCheckPending = false;
    if (classifyOffer(info.version) !== 'same-channel') {
      showCheckNowResult?.({ kind: 'not-available', currentVersion: getAppVersion() });
      return;
    }
    const armedVersion = declinedForStagedVersion(info.version);
    if (armedVersion !== null) {
      showCheckNowResult?.({
        kind: 'ready-to-install',
        currentVersion: getAppVersion(),
        stagedVersion: armedVersion,
      });
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
    settleCheckWaiters('settled');
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

  const onUpdateDownloaded = (info: { version?: string; downloadedFile?: string }): void => {
    logger.info('update-downloaded', { version: info.version });
    stagingInFlight = null;
    settleStagingWaiters(true);
    if (typeof info.downloadedFile === 'string' && info.downloadedFile !== '') {
      stagedInstallerPath = info.downloadedFile;
    }
    const version = typeof info.version === 'string' ? info.version : '';
    if (!version) {
      logger.warn('update-downloaded with empty version — skipping dispatch');
      onDispatch?.('update-downloaded-empty-version');
      return;
    }
    stagedThisSession = version;
    const state = readState();
    if (state.versionPendingInstall === version) {
      logger.info('update-downloaded re-fired for same pending version — deduped', { version });
      onDispatch?.('update-downloaded-deduped');
      return;
    }
    const installCommittedAtDownload = platform !== 'linux';
    if (
      !persistSafely(
        {
          ...state,
          versionPendingInstall: version,
          stagedInstallerPath,
          versionPendingInstallStagedAt: now().getTime(),
          attemptedInstallStagingAgeMs: null,
          attemptedInstallHandoffAt: null,
          ...(installCommittedAtDownload
            ? {
                attemptedInstall: version,
                attemptedInstallSurfacedCount:
                  state.attemptedInstall === version ? state.attemptedInstallSurfacedCount : 0,
                attemptedInstallDeferredBoots:
                  state.attemptedInstall === version ? state.attemptedInstallDeferredBoots : 0,
              }
            : {}),
        },
        'update-downloaded',
      )
    )
      return;
    const fireToastA = () => {
      broadcastToAllWindows('ok:update:downloaded', { version });
      logger.info('update-downloaded dispatched Toast A (all windows)', { version });
      onDispatch?.('update-downloaded-toast-a');
    };
    if (withinPostUpdateQuietWindow()) {
      const remainingMs = (postUpdateQuietUntil ?? 0) - now().getTime();
      logger.info('update-downloaded within post-update quiet window — deferring Toast A', {
        version,
        remainingMs,
      });
      onDispatch?.('toast-a-deferred-post-update-quiet');
      if (quietWindowTimer) clock.clearTimeout(quietWindowTimer);
      quietWindowTimer = clock.setTimeout(
        () => {
          quietWindowTimer = null;
          postUpdateQuietUntil = null;
          onDispatch?.('toast-a-quiet-window-elapsed');
          if (whenRendererReady) whenRendererReady(fireToastA);
          else fireToastA();
        },
        Math.max(0, remainingMs),
      );
      return;
    }
    if (whenRendererReady) whenRendererReady(fireToastA);
    else fireToastA();
  };

  const onError = (err: Error & { code?: string }): void => {
    if (isClassifiedUpdaterError(err)) {
      logger.warn('error (classified)', {
        code: err.code,
        err,
        timestamp: now().toISOString(),
      });
      onDispatch?.('error-classified');
    } else {
      logger.error('error (unclassified)', {
        err,
        timestamp: now().toISOString(),
      });
      onDispatch?.('error-unclassified');
    }
    settleCheckWaiters('settled');
    if (stagingInFlight) {
      stagingInFlight = null;
      settleStagingWaiters(false);
    }
    revertToGithubFeed(err.code ?? err.message);
    if (relaunchInFlight) {
      const failedVersion = relaunchInFlight.version;
      const failureClass = platform === 'linux' ? classifyInstallFailure(err.message) : null;
      failRelaunch(
        failedVersion,
        failureClass === 'cancelled'
          ? 'authorization was cancelled'
          : err.message || 'update error during relaunch',
        'relaunch-error-event',
        { code: err.code, stack: err.stack },
      );
      if (failureClass === 'infrastructure') {
        offerManualInstallFallback(failedVersion, 'linux-manual-fallback-after-error');
      }
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

  const firstOf = <T>(
    register: (finish: (value: T) => void) => void,
    timeoutMs: number,
    onTimeout: T,
  ): Promise<T> =>
    new Promise<T>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: T): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clock.clearTimeout(timer);
        resolve(value);
      };
      timer = clock.setTimeout(() => finish(onTimeout), timeoutMs);
      register(finish);
    });

  const refreshBeforeInstall = async (): Promise<void> => {
    if (stagingInFlight) {
      logger.info('relaunch-now waiting on in-flight staging before install', {
        version: stagingInFlight.version,
      });
      onDispatch?.('relaunch-awaited-in-flight-staging');
      await firstOf<boolean>(
        (finish) => stagingWaiters.push(finish),
        RELAUNCH_REFRESH_DOWNLOAD_MS,
        false,
      );
      return;
    }
    const result = await firstOf<'available' | 'settled' | 'timeout'>(
      (finish) => {
        checkOutcomeWaiters.push(finish);
        void updater.checkForUpdates().then(
          () => finish('settled'),
          (err: unknown) => {
            logger.debug('relaunch-now refresh checkForUpdates rejected', { err });
            finish('settled');
          },
        );
      },
      RELAUNCH_REFRESH_CHECK_MS,
      'timeout',
    );
    if (result === 'timeout') {
      logger.info('relaunch-now refresh check timed out — installing the staged build');
      onDispatch?.('relaunch-refresh-timed-out');
      return;
    }
    const staging = currentStaging();
    if (result !== 'available' || !staging) {
      onDispatch?.('relaunch-refresh-up-to-date');
      return;
    }
    logger.info('relaunch-now found a newer build — fetching it before installing', {
      version: staging.version,
    });
    onDispatch?.('relaunch-refresh-found-newer');
    await firstOf<boolean>(
      (finish) => stagingWaiters.push(finish),
      RELAUNCH_REFRESH_DOWNLOAD_MS,
      false,
    );
  };

  const register = createHandler(ipcMain as IpcMain);
  register('ok:update:relaunch-now', async (_event: IpcMainInvokeEvent): Promise<undefined> => {
    if (installRequested) {
      logger.warn('relaunch-now invoked while an install is already committed — ignoring');
      onDispatch?.('relaunch-double-invoke-blocked');
      return undefined;
    }
    const preRefresh = readState();
    if (!preRefresh.versionPendingInstall) {
      logger.warn('relaunch-now invoked without versionPendingInstall — ignoring');
      return undefined;
    }
    installRequested = true;
    broadcastToAllWindows('ok:update:fetching-latest', {
      version: preRefresh.versionPendingInstall,
    });
    await refreshBeforeInstall();
    const snapshot = readState();
    if (!snapshot.versionPendingInstall) {
      logger.warn('relaunch-now lost its staged build during the freshness check — ignoring');
      installRequested = false;
      broadcastToAllWindows('ok:update:relaunch-failed', {
        version: preRefresh.versionPendingInstall,
        message: 'the update stopped being available',
        dismissPending: true,
      });
      return undefined;
    }
    const pending = snapshot.versionPendingInstall;
    if (
      platform === 'linux' &&
      linuxInstallSupport &&
      manualInstallPlanFor(usableStagedInstallerPath()) !== null &&
      !linuxInstallSupport.hasGraphicalAuth()
    ) {
      installRequested = false;
      broadcastToAllWindows('ok:update:downloaded', { version: pending });
      offerManualInstallFallback(pending, 'linux-manual-fallback-no-auth');
      return undefined;
    }

    const stagedAt = snapshot.versionPendingInstallStagedAt;
    const rawStagingAge = stagedAt === null ? null : now().getTime() - stagedAt;
    const stagingAgeMs = rawStagingAge !== null && rawStagingAge > 0 ? rawStagingAge : null;
    if (
      !persistSafely(
        {
          ...snapshot,
          versionPendingInstall: null,
          attemptedInstallStagingAgeMs: stagingAgeMs,
          attemptedInstallHandoffAt: now().getTime(),
          ...(platform === 'linux'
            ? {
                attemptedInstall: pending,
                attemptedInstallSurfacedCount:
                  snapshot.attemptedInstall === pending
                    ? snapshot.attemptedInstallSurfacedCount
                    : 0,
                attemptedInstallDeferredBoots:
                  snapshot.attemptedInstall === pending
                    ? snapshot.attemptedInstallDeferredBoots
                    : 0,
              }
            : {}),
        },
        'relaunch-now',
      )
    ) {
      installRequested = false;
      broadcastToAllWindows('ok:update:downloaded', { version: pending });
      broadcastToAllWindows('ok:update:relaunch-failed', {
        version: pending,
        message: 'could not save the update state',
      });
      throw new Error('could not save the update state');
    }
    broadcastToAllWindows('ok:update:relaunching', { version: pending });
    onDispatch?.('relaunching-broadcast');
    if (opts.prepareForRelaunch) {
      try {
        await opts.prepareForRelaunch();
      } catch (err) {
        logger.warn('prepareForRelaunch threw — proceeding to quitAndInstall anyway', {
          err,
        });
      }
    }
    if (opts.sweepUpdateSurvivors) {
      try {
        const result = opts.sweepUpdateSurvivors();
        if (result && (result.scanFailed || result.revalidationFailed || result.failedCount > 0)) {
          logger.warn('update survivor sweep incomplete — proceeding to quitAndInstall anyway', {
            result,
          });
        }
      } catch (err) {
        logger.warn('update survivor sweep threw — proceeding to quitAndInstall anyway', { err });
      }
    }
    logger.info('relaunch-now invoked — calling autoUpdater.quitAndInstall', {
      pending,
      stagingAgeMs,
    });
    onDispatch?.('relaunch-now');
    if (isPackaged) {
      const watchdog = clock.setTimeout(() => {
        failRelaunch(pending, 'the update timed out', 'relaunch-watchdog-fired');
      }, RELAUNCH_WATCHDOG_MS);
      relaunchInFlight = { version: pending, watchdog };
    }
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

  const attemptStagedAt = state.versionPendingInstallStagedAt;

  if (state.versionPendingInstall && versionAtLeast(currentVersion, state.versionPendingInstall)) {
    const cleared = state.versionPendingInstall;
    const next = {
      ...state,
      versionPendingInstall: null,
      stagedInstallerPath: null,
      versionPendingInstallStagedAt: null,
    };
    if (persistSafely(next, 'stale-pending-cleared')) {
      state = next;
      logger.info('cleared stale versionPendingInstall — running has caught up', {
        cleared,
        running: currentVersion,
      });
      onDispatch?.('stale-pending-cleared');
    }
  }

  let installGaveUpThisBoot = false;
  if (state.attemptedInstall) {
    const attempted = state.attemptedInstall;
    if (installReached(currentVersion, attempted)) {
      const next = {
        ...state,
        attemptedInstall: null,
        attemptedInstallSurfacedCount: 0,
        attemptedInstallStagingAgeMs: null,
        attemptedInstallHandoffAt: null,
        attemptedInstallDeferredBoots: 0,
      };
      if (persistSafely(next, 'attempted-install-reconciled')) {
        state = next;
        onDispatch?.('attempted-install-reconciled');
      } else {
        logger.warn('failed to persist attempted-install-reconciled', {
          attempted,
          running: currentVersion,
        });
      }
    } else if (channelFromVersion(attempted) !== channelFromVersion(currentVersion)) {
      const next = {
        ...state,
        attemptedInstall: null,
        attemptedInstallSurfacedCount: 0,
        versionPendingInstall: null,
        stagedInstallerPath: null,
        versionPendingInstallStagedAt: null,
        attemptedInstallStagingAgeMs: null,
        attemptedInstallHandoffAt: null,
        attemptedInstallDeferredBoots: 0,
      };
      if (persistSafely(next, 'attempted-install-cross-channel')) {
        state = next;
        logger.info('cleared cross-channel attemptedInstall residue', {
          attempted,
          running: currentVersion,
        });
        onDispatch?.('attempted-install-cross-channel');
      }
    } else if (updatesEnabled) {
      const reconciledAtMs = now().getTime();
      const handoffStampedAt = state.attemptedInstallHandoffAt;
      const handoffAt = resolveInstallHandoffMoment(state, attemptStagedAt);
      const handoffAgeMs = installHandoffAgeMs(handoffAt, reconciledAtMs);
      if (installMayStillBeRunning(state, reconciledAtMs, attemptStagedAt) !== null) {
        const next = {
          ...state,
          attemptedInstallDeferredBoots: state.attemptedInstallDeferredBoots + 1,
        };
        if (persistSafely(next, 'install-in-flight-deferred')) {
          state = next;
        } else {
          logger.warn('failed to persist install-in-flight-deferred', {
            attempted,
            running: currentVersion,
          });
        }
        logger.info('attempted install may still be running — deferring the failure verdict', {
          attempted,
          running: currentVersion,
          handoffAgeMs,
          handoffAt,
          recordedHandoff: state.attemptedInstallHandoffAt !== null,
          stagingAgeMs: state.attemptedInstallStagingAgeMs,
          surfaced: state.attemptedInstallSurfacedCount,
          deferredBoots: state.attemptedInstallDeferredBoots,
        });
        onDispatch?.('install-in-flight-deferred');
      } else if (handoffStampedAt === null) {
        const next = {
          ...state,
          versionPendingInstall: attempted,
        };
        if (persistSafely(next, 'install-never-committed-reoffered')) {
          state = next;
          logger.info('no commit point ran for the staged install — re-offering it', {
            attempted,
            running: currentVersion,
            stagedAgeMs: installHandoffAgeMs(attemptStagedAt, reconciledAtMs),
          });
          const fireReoffer = (): void => {
            broadcastToAllWindows('ok:update:downloaded', { version: attempted });
          };
          if (whenRendererReady) whenRendererReady(fireReoffer);
          else fireReoffer();
          onDispatch?.('install-never-committed-reoffered');
        } else {
          logger.warn('failed to persist install-never-committed-reoffered', {
            attempted,
            running: currentVersion,
          });
        }
      } else if (state.attemptedInstallSurfacedCount >= INSTALL_FAILURE_MAX_SURFACES) {
        const next = {
          ...state,
          attemptedInstall: null,
          attemptedInstallSurfacedCount: 0,
          versionPendingInstall: null,
          stagedInstallerPath: null,
          versionPendingInstallStagedAt: null,
          attemptedInstallStagingAgeMs: null,
          attemptedInstallHandoffAt: null,
          attemptedInstallDeferredBoots: 0,
        };
        if (persistSafely(next, 'install-failed-giveup')) {
          state = next;
          installGaveUpThisBoot = true;
          logger.warn('attempted install exhausted its retry budget — clearing record', {
            attempted,
            running: currentVersion,
            surfaced: INSTALL_FAILURE_MAX_SURFACES,
            handoffAgeMs,
          });
          onDispatch?.('install-failed-giveup');
        }
      } else {
        const next = {
          ...state,
          versionPendingInstall: attempted,
          attemptedInstallSurfacedCount: state.attemptedInstallSurfacedCount + 1,
        };
        if (persistSafely(next, 'install-failed-on-boot')) {
          state = next;
          logger.warn('attempted install did not take — surfacing failure notice', {
            attempted,
            running: currentVersion,
            surfaced: next.attemptedInstallSurfacedCount,
            stagingAgeMs: state.attemptedInstallStagingAgeMs,
            handoffAt,
            handoffAgeMs,
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
  }

  const shouldShowVersionNotice =
    state.lastSeenVersion !== null && state.lastSeenVersion !== currentVersion;
  const needsStateAdvance = state.lastSeenVersion !== currentVersion;

  if (shouldShowVersionNotice && updater.autoInstallOnAppQuit) {
    postUpdateQuietUntil = now().getTime() + POST_UPDATE_QUIET_MS;
    logger.info('post-update quiet window armed', {
      from: state.lastSeenVersion,
      to: currentVersion,
      untilMs: postUpdateQuietUntil,
    });
  }

  if (needsStateAdvance) {
    const advanced = persistSafely(
      { ...state, lastSeenVersion: currentVersion },
      'lastSeenVersion-advance',
    );
    if (advanced && shouldShowVersionNotice && updatesEnabled) {
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

  stagedInstallerPath = state.stagedInstallerPath;

  let reclaimSettled: Promise<void> | null = null;
  if (
    reclaimStagedUpdateCache &&
    state.versionPendingInstall === null &&
    state.attemptedInstall === null &&
    !installGaveUpThisBoot
  ) {
    try {
      reclaimSettled = Promise.resolve(reclaimStagedUpdateCache()).then(
        () => undefined,
        (err: unknown) => {
          logger.warn('staged-update cache reclaim failed', { err });
        },
      );
      onDispatch?.('staged-cache-reclaimed');
    } catch (err) {
      logger.warn('staged-update cache reclaim threw synchronously', { err });
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
          err,
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

  const runLaunchCheck = (): void => {
    void updater
      .checkForUpdates()
      .then(() => {
        startPeriodicChecks();
      })
      .catch((err: unknown) => {
        logger.debug('first-launch checkForUpdates rejected', {
          err,
        });
        revertToGithubFeed('first-check-rejected');
        startPeriodicChecks();
      });
  };

  if (updatesEnabled) {
    if (reclaimSettled) {
      void reclaimSettled.then(runLaunchCheck);
    } else {
      runLaunchCheck();
    }
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
    isWithinPostUpdateQuietWindow(): boolean {
      return withinPostUpdateQuietWindow();
    },
    suppressAutoInstallOnQuit(): void {
      updater.autoInstallOnAppQuit = false;
      logger.info('autoInstallOnAppQuit suppressed for uninstall');
    },
    recordInstallHandoffOnQuit(): void {
      if (!updater.autoInstallOnAppQuit) return;
      const current = readState();
      if (current.attemptedInstall === null) return;
      if (current.attemptedInstallHandoffAt !== null) return;
      const handoffAt = now().getTime();
      const stagedAt = current.versionPendingInstallStagedAt;
      const rawStagingAge = stagedAt === null ? null : handoffAt - stagedAt;
      const stagingAgeMs = rawStagingAge !== null && rawStagingAge > 0 ? rawStagingAge : null;
      if (
        persistSafely(
          {
            ...current,
            attemptedInstallHandoffAt: handoffAt,
            attemptedInstallStagingAgeMs: stagingAgeMs,
          },
          'handoff-on-quit',
        )
      ) {
        logger.info('quit commits the staged install — recording the handoff moment', {
          attempted: current.attemptedInstall,
          handoffAt,
          stagingAgeMs,
        });
      } else {
        logger.warn('failed to persist install handoff moment — next boot will re-offer', {
          attempted: current.attemptedInstall,
          handoffAt,
          stagingAgeMs,
        });
      }
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
      if (quietWindowTimer) {
        clock.clearTimeout(quietWindowTimer);
        quietWindowTimer = null;
      }
      settleCheckWaiters('settled');
      stagingInFlight = null;
      settleStagingWaiters(false);
      const detach = (event: string, handler: (...args: unknown[]) => void): void => {
        try {
          updater.off(event, handler);
        } catch (err) {
          logger.warn('updater.off failed during destroy', {
            event,
            err,
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
            err,
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
      err,
    });
    return null;
  }
}
