import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import type { OutgoingHttpHeaders } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANUAL_CHECK_WATCHDOG_MS } from '@inkeep/open-knowledge-core';
import { describe, expect, test, vi } from 'vitest';
import {
  bootAutoUpdater,
  buildCheckNowResultFromError,
  type DispatchKind,
  INSTALL_FAILURE_MAX_SURFACES,
  type IpcMainLike,
  installReached,
  isClassifiedUpdaterError,
  MANUAL_CHECK_TIMED_OUT_MESSAGE,
  POST_UPDATE_QUIET_MS,
  RELAUNCH_REFRESH_CHECK_MS,
  RELAUNCH_REFRESH_DOWNLOAD_MS,
  RELAUNCH_WATCHDOG_MS,
  releaseUrlFor,
  STUCK_HINT_DOWNLOAD_URL,
  STUCK_HINT_THRESHOLD_MS,
  startAutoUpdater,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_JITTER_MS,
  type UpdaterLike,
  versionAtLeast,
} from '../../src/main/auto-updater.ts';
import {
  type AppState,
  emptyState,
  evaluateSchemaCompatibility,
  MAX_SUPPORTED_SCHEMA_VERSION,
} from '../../src/main/state-store.ts';
import type { SendableWebContents } from '../../src/shared/ipc-send.ts';

interface SendTarget {
  webContents: SendableWebContents;
}

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  channel: string | null = null;
  allowPrerelease = true;
  allowDowngrade = true;
  forceDevUpdateConfig = false;
  requestHeaders: OutgoingHttpHeaders | null = null;
  setFeedURL = vi.fn(
    (
      _urlOrOptions:
        | string
        | { provider: 'generic'; url: string }
        | { provider: 'github'; owner: string; repo: string },
    ) => {},
  );
  checkForUpdates = vi.fn(() => Promise.resolve(undefined));
  downloadUpdate = vi.fn(() => Promise.resolve([] as unknown[]));
  quitAndInstall = vi.fn(() => {});
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

interface FakeIpc extends IpcMainLike {
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
  invoke(channel: string, ...args: unknown[]): unknown;
}

function makeFakeIpc(): FakeIpc {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      handlers.set(channel, listener);
    },
    removeHandler(channel: string): void {
      handlers.delete(channel);
    },
    invoke(channel: string, ...args: unknown[]): unknown {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return handler({}, ...args);
    },
  } as FakeIpc;
}

interface CapturedSend {
  channel: string;
  payload: unknown;
}

function makeFakeWindow(captured: CapturedSend[]): SendTarget {
  return {
    webContents: {
      send: (channel: string, ...args: unknown[]) => {
        captured.push({ channel, payload: args[0] });
      },
    },
  };
}

function manualCheckPhases(rig: TestRig): Array<'started' | 'settled'> {
  return rig.captured
    .filter((entry) => entry.channel === 'ok:update:manual-check')
    .map((entry) => (entry.payload as { phase: 'started' | 'settled' }).phase);
}

interface FakeClock {
  setTimeout: ReturnType<typeof vi.fn>;
  clearTimeout: ReturnType<typeof vi.fn>;
  lastCallback: (() => void) | null;
  lastHandle: unknown;
  lastMs: number | null;
}

function makeFakeClock(): FakeClock {
  const clock: FakeClock = {
    setTimeout: vi.fn(() => Symbol('timer-handle')),
    clearTimeout: vi.fn(() => {}),
    lastCallback: null,
    lastHandle: null,
    lastMs: null,
  };
  clock.setTimeout = vi.fn((cb: () => void, ms: number) => {
    clock.lastCallback = cb;
    clock.lastMs = ms;
    const handle = Symbol('timer-handle');
    clock.lastHandle = handle;
    return handle as unknown as ReturnType<typeof setTimeout>;
  });
  clock.clearTimeout = vi.fn((h: unknown) => {
    if (h === clock.lastHandle) {
      clock.lastCallback = null;
      clock.lastHandle = null;
    }
  });
  return clock;
}

interface TestRig {
  updater: FakeUpdater;
  ipc: FakeIpc;
  clock: FakeClock;
  captured: CapturedSend[];
  windows: CapturedSend[][];
  state: AppState;
  failNextPersist: boolean;
  dispatches: DispatchKind[];
  now: Date;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
}

function makeRig(
  overrides?: Partial<AppState> & {
    appVersion?: string;
    isPackaged?: boolean;
    platform?: NodeJS.Platform;
    forceDevBypass?: boolean;
    feedUrl?: string;
    proxyFeed?: { base: string; channels: ReadonlySet<'latest' | 'beta'> };
    updaterSetup?: (u: FakeUpdater) => void;
    extraWindowCount?: number;
    prepareForRelaunch?: () => void;
    sweepUpdateSurvivors?: Parameters<typeof startAutoUpdater>[0]['sweepUpdateSurvivors'];
    showCheckNowResult?: Parameters<typeof startAutoUpdater>[0]['showCheckNowResult'];
    reclaimStagedUpdateCache?: Parameters<typeof startAutoUpdater>[0]['reclaimStagedUpdateCache'];
    linuxInstallSupport?: Parameters<typeof startAutoUpdater>[0]['linuxInstallSupport'];
    random?: () => number;
    nowAt?: Date;
  },
): {
  rig: TestRig;
  handle: ReturnType<typeof startAutoUpdater>;
} {
  const {
    appVersion = '0.3.1',
    isPackaged = true,
    platform = 'darwin',
    forceDevBypass,
    feedUrl,
    proxyFeed,
    updaterSetup,
    extraWindowCount = 0,
    prepareForRelaunch,
    sweepUpdateSurvivors,
    showCheckNowResult,
    reclaimStagedUpdateCache,
    linuxInstallSupport,
    random = () => 0,
    nowAt,
    ...stateOverrides
  } = overrides ?? {};
  const primaryCaptured: CapturedSend[] = [];
  const rig: TestRig = {
    updater: new FakeUpdater(),
    ipc: makeFakeIpc(),
    clock: makeFakeClock(),
    captured: primaryCaptured,
    windows: [primaryCaptured],
    state: { ...emptyState(), lastSeenVersion: appVersion, ...stateOverrides },
    failNextPersist: false,
    dispatches: [],
    now: nowAt ?? new Date('2026-04-21T12:00:00.000Z'),
    logger: {
      info: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      debug: vi.fn(() => {}),
    },
  };
  const primaryWindow = makeFakeWindow(primaryCaptured);
  const fanOutTargets: SendTarget[] = [primaryWindow];
  for (let i = 0; i < extraWindowCount; i++) {
    const buf: CapturedSend[] = [];
    rig.windows.push(buf);
    fanOutTargets.push(makeFakeWindow(buf));
  }
  updaterSetup?.(rig.updater as FakeUpdater);
  const handle = startAutoUpdater({
    updater: rig.updater,
    ipcMain: rig.ipc,
    readState: () => rig.state,
    writeState: (next) => {
      if (rig.failNextPersist) throw new Error('disk full');
      rig.state = next;
    },
    getPrimaryWindow: () => primaryWindow,
    getAllWindows: extraWindowCount > 0 ? () => fanOutTargets : undefined,
    getAppVersion: () => appVersion,
    isPackaged,
    platform,
    forceDevBypass,
    feedUrl,
    proxyFeed,
    prepareForRelaunch,
    sweepUpdateSurvivors,
    showCheckNowResult,
    reclaimStagedUpdateCache,
    linuxInstallSupport,
    clock: rig.clock,
    now: () => rig.now,
    random,
    onDispatch: (kind) => {
      rig.dispatches.push(kind);
    },
    logger: rig.logger,
  });
  return { rig, handle };
}

const COMMITTED_LONG_AGO = new Date('2020-01-01T00:00:00.000Z').getTime();

const CLASSIFIED_CODES: readonly string[] = [
  'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
  'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
  'ERR_UPDATER_INVALID_RELEASE_FEED',
  'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
  'ERR_UPDATER_INVALID_UPDATE_INFO',
  'ERR_UPDATER_NO_FILES_PROVIDED',
  'ERR_UPDATER_NO_CHECKSUM',
  'ERR_UPDATER_INVALID_VERSION',
  'ERR_UPDATER_INVALID_CHANNEL',
  'ERR_UPDATER_ZIP_FILE_NOT_FOUND',
  'ERR_CHECKSUM_MISMATCH',
  'HTTP_ERROR_404',
  'HTTP_ERROR_429',
  'HTTP_ERROR_500',
];

describe('startAutoUpdater — initial configuration (parent §8.10 LOCKED)', () => {
  test('sets autoDownload=false, autoInstallOnAppQuit=true, channel=latest', () => {
    const { rig } = makeRig();
    expect(rig.updater.autoDownload).toBe(false);
    expect(rig.updater.autoInstallOnAppQuit).toBe(true);
    expect(rig.updater.channel).toBe('latest');
  });

  test('suppressAutoInstallOnQuit disables install-on-quit for self-uninstall', () => {
    const { rig, handle } = makeRig();
    expect(rig.updater.autoInstallOnAppQuit).toBe(true);
    handle.suppressAutoInstallOnQuit();
    expect(rig.updater.autoInstallOnAppQuit).toBe(false);
  });

  test('Linux carve-out: autoInstallOnAppQuit is OFF on linux', () => {
    const { rig } = makeRig({ platform: 'linux' });
    expect(rig.updater.autoInstallOnAppQuit).toBe(false);
    expect(rig.updater.autoDownload).toBe(false);
  });

  test('win32 keeps install-on-quit (NSIS installs silently, like Squirrel.Mac)', () => {
    const { rig } = makeRig({ platform: 'win32' });
    expect(rig.updater.autoInstallOnAppQuit).toBe(true);
  });

  test('linux: update-downloaded arms the banner but NOT attemptedInstall (no install commit on plain quit)', () => {
    const { rig } = makeRig({ platform: 'linux' });
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
    expect(rig.state.attemptedInstall).toBeNull();
  });

  test('linux: relaunch-now is the install-commit point — it arms attemptedInstall', async () => {
    const { rig } = makeRig({ platform: 'linux' });
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(rig.state.attemptedInstall).toBe('0.3.2');
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
  });

  test('darwin: update-downloaded still arms attemptedInstall at download time', () => {
    const { rig } = makeRig({ platform: 'darwin' });
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    expect(rig.state.attemptedInstall).toBe('0.3.2');
  });

  test('feedUrl opt → updater.setFeedURL(url) called before first check', () => {
    const { rig } = makeRig({ feedUrl: 'http://127.0.0.1:54321' } as Partial<AppState> & {
      feedUrl?: string;
    });
    expect(rig.updater.setFeedURL).toHaveBeenCalledTimes(1);
    expect(rig.updater.setFeedURL).toHaveBeenCalledWith('http://127.0.0.1:54321');
  });

  test('feedUrl unset → setFeedURL NOT called (production default path)', () => {
    const { rig } = makeRig();
    expect(rig.updater.setFeedURL).not.toHaveBeenCalled();
  });

  test('forceDevBypass=true flips updater.forceDevUpdateConfig so checkForUpdates hits network', () => {
    const { rig } = makeRig({
      appVersion: '0.3.0',
      isPackaged: false,
      forceDevBypass: true,
    } as Partial<AppState> & {
      appVersion?: string;
      isPackaged?: boolean;
      forceDevBypass?: boolean;
    });
    expect(rig.updater.forceDevUpdateConfig).toBe(true);
  });

  test('forceDevBypass=false (default) leaves forceDevUpdateConfig=false (prod default)', () => {
    const { rig } = makeRig();
    expect(rig.updater.forceDevUpdateConfig).toBe(false);
  });

  test('stable build version → channel=latest, allowPrerelease=false, allowDowngrade=false', () => {
    const { rig } = makeRig({ appVersion: '0.4.0' });
    expect(rig.updater.channel).toBe('latest');
    expect(rig.updater.allowPrerelease).toBe(false);
    expect(rig.updater.allowDowngrade).toBe(false);
  });

  test('prerelease build version → channel=beta, allowPrerelease=true, allowDowngrade=false', () => {
    const { rig } = makeRig({ appVersion: '0.4.0-beta.36' });
    expect(rig.updater.channel).toBe('beta');
    expect(rig.updater.allowPrerelease).toBe(true);
    expect(rig.updater.allowDowngrade).toBe(false);
  });

  test('channel is build-derived only — no persisted preference is consulted', () => {
    const stable = makeRig({ appVersion: '0.4.0' });
    expect(stable.rig.updater.channel).toBe('latest');
    expect(stable.rig.updater.allowPrerelease).toBe(false);

    const beta = makeRig({ appVersion: '0.4.0-beta.36' });
    expect(beta.rig.updater.channel).toBe('beta');
    expect(beta.rig.updater.allowPrerelease).toBe(true);
  });

  const PROXY_BASE = 'https://openknowledge.ai/updates';

  test('proxyFeed: beta build with beta enabled → generic feed + version/channel headers', () => {
    const { rig } = makeRig({
      appVersion: '0.4.0-beta.7',
      proxyFeed: { base: PROXY_BASE, channels: new Set(['beta']) },
    });
    expect(rig.updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: `${PROXY_BASE}/beta`,
    });
    expect(rig.updater.requestHeaders).toEqual({
      'x-ok-from-version': '0.4.0-beta.7',
      'x-ok-channel': 'beta',
    });
  });

  test('proxyFeed: stable build maps the latest channel to the proxy /stable path', () => {
    const { rig } = makeRig({
      appVersion: '0.4.0',
      proxyFeed: { base: PROXY_BASE, channels: new Set(['latest']) },
    });
    expect(rig.updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: `${PROXY_BASE}/stable`,
    });
    expect(rig.updater.requestHeaders).toEqual({
      'x-ok-from-version': '0.4.0',
      'x-ok-channel': 'stable',
    });
  });

  test('proxyFeed: an accepted offer tags the artifact fetch with x-ok-to-version', () => {
    const { rig } = makeRig({
      appVersion: '0.4.0',
      proxyFeed: { base: PROXY_BASE, channels: new Set(['latest']) },
    });
    rig.updater.emit('update-available', { version: '0.5.0' });
    expect(rig.updater.downloadUpdate).toHaveBeenCalled();
    expect(rig.updater.requestHeaders).toEqual({
      'x-ok-from-version': '0.4.0',
      'x-ok-channel': 'stable',
      'x-ok-to-version': '0.5.0',
    });
  });

  test('proxyFeed: a vetoed cross-channel offer does NOT tag a to-version', () => {
    const { rig } = makeRig({
      appVersion: '0.4.0',
      proxyFeed: { base: PROXY_BASE, channels: new Set(['latest']) },
    });
    rig.updater.emit('update-available', { version: '0.6.0-beta.0' });
    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.updater.requestHeaders).toEqual({
      'x-ok-from-version': '0.4.0',
      'x-ok-channel': 'stable',
    });
  });

  test('proxyFeed off: an accepted offer leaves GitHub-bound headers untouched', () => {
    const { rig } = makeRig({ appVersion: '0.4.0' });
    rig.updater.emit('update-available', { version: '0.5.0' });
    expect(rig.updater.downloadUpdate).toHaveBeenCalled();
    expect(rig.updater.requestHeaders).toBeNull();
  });

  test('proxyFeed: default-off — channel not in the set leaves the GitHub default', () => {
    const { rig } = makeRig({
      appVersion: '0.4.0',
      proxyFeed: { base: PROXY_BASE, channels: new Set(['beta']) },
    });
    expect(rig.updater.setFeedURL).not.toHaveBeenCalled();
    expect(rig.updater.requestHeaders).toBeNull();
  });

  test('proxyFeed: a dev feedUrl override takes precedence over the proxy', () => {
    const { rig } = makeRig({
      appVersion: '0.4.0',
      feedUrl: 'http://127.0.0.1:54321',
      proxyFeed: { base: PROXY_BASE, channels: new Set(['latest']) },
    });
    expect(rig.updater.setFeedURL).toHaveBeenCalledTimes(1);
    expect(rig.updater.setFeedURL).toHaveBeenCalledWith('http://127.0.0.1:54321');
    expect(rig.updater.requestHeaders).toBeNull();
  });

  test('proxyFeed: a first-check failure reverts to the GitHub provider for the session', async () => {
    const { rig } = makeRig({
      appVersion: '0.4.0-beta.7',
      proxyFeed: { base: PROXY_BASE, channels: new Set(['beta']) },
      updaterSetup: (u) => {
        let firstCall = true;
        u.checkForUpdates = vi.fn(() => {
          if (firstCall) {
            firstCall = false;
            return Promise.reject(new Error('proxy 503'));
          }
          return Promise.resolve(undefined);
        });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(rig.updater.requestHeaders).toBeNull();
    expect(rig.clock.setTimeout).toHaveBeenCalledTimes(1);
  });

  test('proxyFeed: an error EVENT (not a rejection) reverts to the GitHub provider', async () => {
    const { rig } = makeRig({
      appVersion: '0.4.0-beta.7',
      proxyFeed: { base: PROXY_BASE, channels: new Set(['beta']) },
    });
    expect(rig.updater.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: `${PROXY_BASE}/beta`,
    });
    expect(rig.updater.requestHeaders).not.toBeNull();

    rig.updater.emit(
      'error',
      Object.assign(new Error('proxy 503'), { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rig.updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(rig.updater.requestHeaders).toBeNull();
  });

  test('proxyFeed: a second error event after fallback is a no-op (idempotency guard)', async () => {
    const { rig } = makeRig({
      appVersion: '0.4.0-beta.7',
      proxyFeed: { base: PROXY_BASE, channels: new Set(['beta']) },
    });
    rig.updater.emit(
      'error',
      Object.assign(new Error('proxy 503'), { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const callsAfterFallback = rig.updater.setFeedURL.mock.calls.length;
    expect(callsAfterFallback).toBe(2);

    rig.updater.emit(
      'error',
      Object.assign(new Error('still broken'), { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.updater.setFeedURL.mock.calls.length).toBe(callsAfterFallback);
  });

  test('proxyFeed: a throw from the fallback setFeedURL is contained (no re-check)', async () => {
    const { rig } = makeRig({
      appVersion: '0.4.0-beta.7',
      proxyFeed: { base: PROXY_BASE, channels: new Set(['beta']) },
      updaterSetup: (u) => {
        const original = u.setFeedURL;
        u.setFeedURL = vi.fn((arg) => {
          if (typeof arg === 'object' && arg?.provider === 'github') {
            throw new Error('setFeedURL boom');
          }
          return original(arg);
        });
      },
    });
    const checksBeforeError = rig.updater.checkForUpdates.mock.calls.length;
    rig.updater.emit(
      'error',
      Object.assign(new Error('proxy 503'), { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.updater.checkForUpdates.mock.calls.length).toBe(checksBeforeError);
    expect(rig.logger.error).toHaveBeenCalled();
  });
});

describe('staging age — how long the update sat before the install was requested', () => {
  test('records the staged-at moment when a version is armed', () => {
    const { rig } = makeRig({ platform: 'darwin' });
    rig.now = new Date('2026-04-21T12:00:00.000Z');
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    expect(rig.state.versionPendingInstallStagedAt).toBe(Date.parse('2026-04-21T12:00:00.000Z'));
  });

  test('relaunch-now records the staging age and logs it', async () => {
    const { rig } = makeRig({ platform: 'darwin' });
    rig.now = new Date('2026-04-21T12:00:00.000Z');
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    rig.now = new Date('2026-04-21T12:00:02.060Z');
    await rig.ipc.invoke('ok:update:relaunch-now');

    expect(rig.state.attemptedInstallStagingAgeMs).toBe(2060);
    expect(rig.logger.info).toHaveBeenCalledWith(
      'relaunch-now invoked — calling autoUpdater.quitAndInstall',
      expect.objectContaining({ stagingAgeMs: 2060 }),
    );
    expect(rig.state.versionPendingInstall).toBeNull();
    expect(rig.state.versionPendingInstallStagedAt).toBe(Date.parse('2026-04-21T12:00:00.000Z'));
  });

  test('reports null rather than zero when the clock moved backwards while staged', async () => {
    const { rig } = makeRig({ platform: 'darwin' });
    rig.now = new Date('2026-04-21T12:00:00.000Z');
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    rig.now = new Date('2026-04-21T11:59:57.000Z');
    await rig.ipc.invoke('ok:update:relaunch-now');

    expect(rig.state.attemptedInstallStagingAgeMs).toBeNull();
  });

  test('the boot-time failure notice reports the age persisted before the quit', () => {
    const { rig } = makeRig({
      attemptedInstall: '0.16.0-beta.3',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      appVersion: '0.16.0-beta.1',
      attemptedInstallStagingAgeMs: 2060,
    });
    expect(rig.logger.warn).toHaveBeenCalledWith(
      'attempted install did not take — surfacing failure notice',
      expect.objectContaining({ stagingAgeMs: 2060 }),
    );
  });

  test('reports null rather than zero when no relaunch click preceded the failure', () => {
    const { rig } = makeRig({
      attemptedInstall: '0.16.0-beta.3',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      appVersion: '0.16.0-beta.1',
    });
    expect(rig.logger.warn).toHaveBeenCalledWith(
      'attempted install did not take — surfacing failure notice',
      expect.objectContaining({ stagingAgeMs: null }),
    );
  });

  test('a newly armed version does not inherit an earlier version staging age', async () => {
    const { rig: session, handle } = makeRig({ platform: 'darwin' });
    session.now = new Date('2026-04-21T12:00:00.000Z');
    session.updater.emit('update-downloaded', { version: '0.3.2' });
    session.now = new Date('2026-04-21T12:00:02.060Z');
    await session.ipc.invoke('ok:update:relaunch-now');
    expect(session.state.attemptedInstallStagingAgeMs).toBe(2060);

    session.now = new Date('2026-04-21T13:00:00.000Z');
    session.updater.emit('update-downloaded', { version: '0.3.3' });
    handle.recordInstallHandoffOnQuit();
    expect(session.state.attemptedInstall).toBe('0.3.3');

    const { rig: nextBoot } = makeRig({ ...session.state });
    expect(nextBoot.logger.warn).toHaveBeenCalledWith(
      'attempted install did not take — surfacing failure notice',
      expect.objectContaining({ attempted: '0.3.3', stagingAgeMs: null }),
    );
  });

  test('a reconciled successful install leaves no staging age behind', () => {
    const { rig } = makeRig({
      appVersion: '0.3.1',
      attemptedInstall: '0.3.1',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      attemptedInstallStagingAgeMs: 2060,
    });
    expect(rig.state.attemptedInstall).toBeNull();
    expect(rig.state.attemptedInstallStagingAgeMs).toBeNull();
  });
});

describe('cross-channel veto on update-available', () => {
  test('beta build offered a stable version → veto records the check as successful (mirrors update-not-available)', () => {
    const priorCheckAt = '2026-05-01T00:00:00.000Z';
    const { rig } = makeRig({
      appVersion: '0.5.0-beta.5',
      lastSuccessfulCheckAt: priorCheckAt,
    });
    rig.updater.emit('update-available', { version: '0.5.0' });
    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.state.lastSuccessfulCheckAt).toBe(rig.now.toISOString());
    expect(rig.dispatches).toContain('cross-channel-blocked' as DispatchKind);
    expect(rig.dispatches).toContain('check-success' as DispatchKind);
  });

  test('stable build offered a beta version → veto records the check as successful (mirrors update-not-available)', () => {
    const priorCheckAt = '2026-05-01T00:00:00.000Z';
    const { rig } = makeRig({
      appVersion: '0.5.0',
      lastSuccessfulCheckAt: priorCheckAt,
    });
    rig.updater.emit('update-available', { version: '0.6.0-beta.0' });
    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.state.lastSuccessfulCheckAt).toBe(rig.now.toISOString());
    expect(rig.dispatches).toContain('cross-channel-blocked' as DispatchKind);
    expect(rig.dispatches).toContain('check-success' as DispatchKind);
  });

  test('beta receiving stable-only offers for 8 days does NOT fire stuck-hint on a transient error', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const { rig } = makeRig({
      appVersion: '0.5.0-beta.5',
      lastSuccessfulCheckAt: eightDaysAgo,
      stuckHintShown: false,
    });
    rig.now = new Date();
    rig.updater.emit('update-available', { version: '0.5.0' });
    expect(rig.state.lastSuccessfulCheckAt).toBe(rig.now.toISOString());
    expect(rig.state.stuckHintShown).toBe(false);

    rig.updater.emit('error', new Error('transient network'));
    const hint = rig.captured.filter((c) => c.channel === 'ok:update:stuck-hint');
    expect(hint).toHaveLength(0);
    expect(rig.state.stuckHintShown).toBe(false);
  });

  test('beta-to-beta same-channel offer → downloadUpdate called + markCheckSucceeded runs', () => {
    const { rig } = makeRig({ appVersion: '0.5.0-beta.5' });
    rig.updater.emit('update-available', { version: '0.5.0-beta.6' });
    expect(rig.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(rig.state.lastSuccessfulCheckAt).toBe(rig.now.toISOString());
    expect(rig.dispatches).not.toContain('cross-channel-blocked' as DispatchKind);
  });

  test('stable-to-stable same-channel offer → downloadUpdate called + markCheckSucceeded runs', () => {
    const { rig } = makeRig({ appVersion: '0.3.1' });
    rig.updater.emit('update-available', { version: '0.3.2' });
    expect(rig.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(rig.state.lastSuccessfulCheckAt).toBe(rig.now.toISOString());
  });

  test('menu-driven check: cross-channel offer remaps to not-available + does not download', () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({ appVersion: '0.5.0-beta.5', showCheckNowResult });
    rig.ipc.invoke('ok:update:check-now');
    rig.updater.emit('update-available', { version: '0.5.0' });
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'not-available',
      currentVersion: '0.5.0-beta.5',
    });
    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
  });

  test('empty version is treated as a veto (no download, check still recorded as successful)', () => {
    const priorCheckAt = '2026-05-01T00:00:00.000Z';
    const { rig } = makeRig({ appVersion: '0.3.1', lastSuccessfulCheckAt: priorCheckAt });
    rig.updater.emit('update-available', {});
    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.dispatches).toContain('cross-channel-blocked' as DispatchKind);
    expect(rig.state.lastSuccessfulCheckAt).toBe(rig.now.toISOString());
  });
});

describe('schemaVersion boot-incompatibility check (US-007 AC5)', () => {
  test('persisted schemaVersion > MAX_SUPPORTED → incompatible diagnostic', () => {
    const persisted = { ...emptyState(), schemaVersion: 999 };
    const result = evaluateSchemaCompatibility(persisted, MAX_SUPPORTED_SCHEMA_VERSION, '0.4.0');
    expect(result.status).toBe('incompatible');
    if (result.status === 'incompatible') {
      expect(result.diagnostic).toEqual({
        currentBuild: '0.4.0',
        persistedSchemaVersion: 999,
        maxSupported: MAX_SUPPORTED_SCHEMA_VERSION,
      });
    }
  });

  test('persisted schemaVersion === MAX_SUPPORTED → ok (today is the no-op path)', () => {
    const persisted = { ...emptyState(), schemaVersion: MAX_SUPPORTED_SCHEMA_VERSION };
    const result = evaluateSchemaCompatibility(persisted, MAX_SUPPORTED_SCHEMA_VERSION, '0.4.0');
    expect(result.status).toBe('ok');
  });

  test('persisted schemaVersion === MAX_SUPPORTED + 1 → incompatible at the boundary', () => {
    const persisted = { ...emptyState(), schemaVersion: MAX_SUPPORTED_SCHEMA_VERSION + 1 };
    const result = evaluateSchemaCompatibility(persisted, MAX_SUPPORTED_SCHEMA_VERSION, '0.4.0');
    expect(result.status).toBe('incompatible');
  });
});

describe('persist-before-emit ordering (Finding #2)', () => {
  test('update-downloaded: writeState failure → NO Toast A dispatch', () => {
    const { rig, handle } = makeRig();
    handle.destroy();

    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const captured: CapturedSend[] = [];
    const primaryWindow = makeFakeWindow(captured);
    const state: AppState = emptyState();
    const dispatches: DispatchKind[] = [];
    const logger = {
      info: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      debug: vi.fn(() => {}),
    };
    startAutoUpdater({
      updater,
      ipcMain: ipc,
      readState: () => state,
      writeState: () => {
        throw new Error('EACCES');
      },
      getPrimaryWindow: () => primaryWindow,
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      clock,
      now: () => new Date(),
      onDispatch: (k) => dispatches.push(k),
      logger,
    });

    updater.emit('update-downloaded', { version: '0.3.2' });
    expect(captured.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(0);
    expect(dispatches).not.toContain('update-downloaded-toast-a' as DispatchKind);
    expect(state.versionPendingInstall).toBeNull();
    expect(logger.error).toHaveBeenCalled();
    expect(state.versionPendingInstall).toBeNull();
    void rig;
  });

  test('stuck-hint: writeState failure → NO Toast C dispatch', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const captured: CapturedSend[] = [];
    const primaryWindow = makeFakeWindow(captured);
    const state: AppState = { ...emptyState(), lastSuccessfulCheckAt: eightDaysAgo };
    const dispatches: DispatchKind[] = [];
    startAutoUpdater({
      updater,
      ipcMain: ipc,
      readState: () => state,
      writeState: () => {
        throw new Error('EACCES');
      },
      getPrimaryWindow: () => primaryWindow,
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      clock,
      now: () => new Date(),
      onDispatch: (k) => dispatches.push(k),
      logger: {
        info: vi.fn(() => {}),
        warn: vi.fn(() => {}),
        error: vi.fn(() => {}),
        debug: vi.fn(() => {}),
      },
    });

    updater.emit('error', new Error('network'));
    expect(captured.filter((c) => c.channel === 'ok:update:stuck-hint')).toHaveLength(0);
    expect(dispatches).not.toContain('stuck-hint-toast-c' as DispatchKind);
    expect(state.stuckHintShown).toBe(false);
  });
});

describe('event subscription surface (AC2)', () => {
  test('registers listeners for the six AC2 events', () => {
    const { rig } = makeRig();
    expect(rig.updater.listenerCount('checking-for-update')).toBe(1);
    expect(rig.updater.listenerCount('update-available')).toBe(2);
    expect(rig.updater.listenerCount('update-not-available')).toBe(1);
    expect(rig.updater.listenerCount('download-progress')).toBe(1);
    expect(rig.updater.listenerCount('update-downloaded')).toBe(1);
    expect(rig.updater.listenerCount('error')).toBe(1);
  });

  test('does NOT subscribe to login / update-cancelled / appimage-filename-updated', () => {
    const { rig } = makeRig();
    expect(rig.updater.listenerCount('login')).toBe(0);
    expect(rig.updater.listenerCount('update-cancelled')).toBe(0);
    expect(rig.updater.listenerCount('appimage-filename-updated')).toBe(0);
  });
});

describe('update-downloaded → Toast A (AC6)', () => {
  test('first dispatch for a new version fires ok:update:downloaded + records versionPendingInstall', () => {
    const { rig } = makeRig();
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    const toastA = rig.captured.filter((c) => c.channel === 'ok:update:downloaded');
    expect(toastA).toHaveLength(1);
    expect(toastA[0]?.payload).toEqual({ version: '0.3.2' });
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
    expect(rig.dispatches).toContain('update-downloaded-toast-a' as DispatchKind);
  });

  test('re-firing with the SAME version is deduped — no second dispatch', () => {
    const { rig } = makeRig();
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    const toastA = rig.captured.filter((c) => c.channel === 'ok:update:downloaded');
    expect(toastA).toHaveLength(1);
    expect(rig.dispatches).toContain('update-downloaded-deduped' as DispatchKind);
  });

  test('re-firing with a NEWER version dispatches a new Toast A and updates state', () => {
    const { rig } = makeRig();
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    rig.updater.emit('update-downloaded', { version: '0.3.3' });
    const toastA = rig.captured.filter((c) => c.channel === 'ok:update:downloaded');
    expect(toastA).toHaveLength(2);
    expect(toastA[1]?.payload).toEqual({ version: '0.3.3' });
    expect(rig.state.versionPendingInstall).toBe('0.3.3');
  });

  test('empty-version payload is skipped defensively (no dispatch, no state write)', () => {
    const { rig } = makeRig();
    rig.updater.emit('update-downloaded', {});
    const toastA = rig.captured.filter((c) => c.channel === 'ok:update:downloaded');
    expect(toastA).toHaveLength(0);
    expect(rig.state.versionPendingInstall).toBeNull();
    expect(rig.dispatches).toContain('update-downloaded-empty-version' as DispatchKind);
  });
});

describe('error routing (AC3, D5)', () => {
  test.each(CLASSIFIED_CODES)('classified err.code %s → bracket log, no IPC dispatch', (code) => {
    const { rig } = makeRig();
    const err = Object.assign(new Error(`failure ${code}`), { code });
    rig.updater.emit('error', err);
    expect(rig.captured.some((c) => c.channel.startsWith('ok:update:error'))).toBe(false);
    const isClassified = code.startsWith('ERR_UPDATER_') || code.startsWith('HTTP_ERROR_');
    expect(
      rig.dispatches.includes(
        (isClassified ? 'error-classified' : 'error-unclassified') as DispatchKind,
      ),
    ).toBe(true);
  });

  test('bare Error (no .code) → unclassified log + no dispatch', () => {
    const { rig } = makeRig();
    const err = new Error('signature mismatch from Squirrel.Mac');
    rig.updater.emit('error', err);
    expect(rig.captured).toHaveLength(0);
    expect(rig.dispatches).toContain('error-unclassified' as DispatchKind);
    expect(rig.logger.error).toHaveBeenCalled();
  });

  test('error with non-matching .code prefix → unclassified branch', () => {
    const { rig } = makeRig();
    const err = Object.assign(new Error('oops'), { code: 'EPERM' });
    rig.updater.emit('error', err);
    expect(rig.dispatches).toContain('error-unclassified' as DispatchKind);
  });

  test('isClassifiedUpdaterError narrows the type correctly', () => {
    expect(isClassifiedUpdaterError(new Error('bare'))).toBe(false);
    expect(isClassifiedUpdaterError(Object.assign(new Error('x'), { code: 'ERR_UPDATER_X' }))).toBe(
      true,
    );
    expect(
      isClassifiedUpdaterError(Object.assign(new Error('x'), { code: 'HTTP_ERROR_500' })),
    ).toBe(true);
    expect(
      isClassifiedUpdaterError(Object.assign(new Error('x'), { code: 'SOMETHING_ELSE' })),
    ).toBe(false);
    expect(isClassifiedUpdaterError(null)).toBe(false);
    expect(isClassifiedUpdaterError('string')).toBe(false);
  });
});

describe('stuck-hint logic (AC17, D12)', () => {
  test('update-not-available updates lastSuccessfulCheckAt', () => {
    const { rig } = makeRig();
    rig.updater.emit('update-not-available', { version: '0.3.1' });
    expect(rig.state.lastSuccessfulCheckAt).toBe(rig.now.toISOString());
  });

  test('update-available also counts as a successful check', () => {
    const { rig } = makeRig();
    rig.updater.emit('update-available', { version: '0.3.2' });
    expect(rig.state.lastSuccessfulCheckAt).toBe(rig.now.toISOString());
  });

  test('error does NOT update lastSuccessfulCheckAt', () => {
    const { rig } = makeRig({ lastSuccessfulCheckAt: '2026-01-01T00:00:00.000Z' });
    rig.updater.emit('error', new Error('boom'));
    expect(rig.state.lastSuccessfulCheckAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('>7 days since last success + error fires ok:update:stuck-hint exactly once', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const { rig } = makeRig({
      lastSuccessfulCheckAt: eightDaysAgo,
      stuckHintShown: false,
    });
    rig.now = new Date();

    rig.updater.emit('error', new Error('network'));
    const hint = rig.captured.filter((c) => c.channel === 'ok:update:stuck-hint');
    expect(hint).toHaveLength(1);
    expect(hint[0]?.payload).toEqual({ downloadUrl: STUCK_HINT_DOWNLOAD_URL });
    expect(rig.state.stuckHintShown).toBe(true);
    expect(rig.dispatches).toContain('stuck-hint-toast-c' as DispatchKind);

    rig.updater.emit('error', new Error('network again'));
    const hint2 = rig.captured.filter((c) => c.channel === 'ok:update:stuck-hint');
    expect(hint2).toHaveLength(1);
  });

  test('<7 days since last success + error does NOT fire stuck-hint', () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const { rig } = makeRig({
      lastSuccessfulCheckAt: sixDaysAgo,
      stuckHintShown: false,
    });
    rig.now = new Date();
    rig.updater.emit('error', new Error('network'));
    const hint = rig.captured.filter((c) => c.channel === 'ok:update:stuck-hint');
    expect(hint).toHaveLength(0);
    expect(rig.state.stuckHintShown).toBe(false);
  });

  test('no baseline (lastSuccessfulCheckAt=null) + error does NOT fire — fresh install cannot be stuck', () => {
    const { rig } = makeRig({ lastSuccessfulCheckAt: null, stuckHintShown: false });
    rig.updater.emit('error', new Error('boom'));
    expect(rig.captured).toHaveLength(0);
    expect(rig.state.stuckHintShown).toBe(false);
  });

  test('successful check resets stuckHintShown so gate re-arms', () => {
    const { rig } = makeRig({
      lastSuccessfulCheckAt: '2026-01-01T00:00:00.000Z',
      stuckHintShown: true,
    });
    rig.updater.emit('update-not-available', {});
    expect(rig.state.stuckHintShown).toBe(false);
    expect(rig.state.lastSuccessfulCheckAt).toBe(rig.now.toISOString());

    rig.state.lastSuccessfulCheckAt = new Date(
      rig.now.getTime() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    rig.updater.emit('error', new Error('stuck again'));
    const hint = rig.captured.filter((c) => c.channel === 'ok:update:stuck-hint');
    expect(hint).toHaveLength(1);
    expect(rig.state.stuckHintShown).toBe(true);
  });

  test('malformed lastSuccessfulCheckAt (not ISO) — does not throw, no dispatch', () => {
    const { rig } = makeRig({
      lastSuccessfulCheckAt: 'not-a-date',
      stuckHintShown: false,
    });
    expect(() => rig.updater.emit('error', new Error('boom'))).not.toThrow();
    expect(rig.captured).toHaveLength(0);
  });

  test('STUCK_HINT_THRESHOLD_MS equals 7 days', () => {
    expect(STUCK_HINT_THRESHOLD_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('first-launch version notice (Toast B — AC7, D9)', () => {
  test('lastSeenVersion differs from current → dispatch whats-new + update state', () => {
    const { rig } = makeRig({ lastSeenVersion: '0.3.0', appVersion: '0.3.1' });
    const whatsNew = rig.captured.filter((c) => c.channel === 'ok:update:whats-new');
    expect(whatsNew).toHaveLength(1);
    expect(whatsNew[0]?.payload).toEqual({
      version: '0.3.1',
      releaseUrl: releaseUrlFor('0.3.1'),
    });
    expect(rig.state.lastSeenVersion).toBe('0.3.1');
    expect(rig.dispatches).toContain('whats-new-toast-b' as DispatchKind);
  });

  test('lastSeenVersion === current → no dispatch, no state change', () => {
    const { rig } = makeRig({ lastSeenVersion: '0.3.1', appVersion: '0.3.1' });
    const whatsNew = rig.captured.filter((c) => c.channel === 'ok:update:whats-new');
    expect(whatsNew).toHaveLength(0);
    expect(rig.state.lastSeenVersion).toBe('0.3.1');
  });

  test('lastSeenVersion is null (fresh install) → no dispatch, state seeds silently', () => {
    const { rig } = makeRig({ lastSeenVersion: null, appVersion: '0.3.1' });
    const whatsNew = rig.captured.filter((c) => c.channel === 'ok:update:whats-new');
    expect(whatsNew).toHaveLength(0);
    expect(rig.dispatches).not.toContain('whats-new-toast-b' as DispatchKind);
    expect(rig.state.lastSeenVersion).toBe('0.3.1');
  });

  test('releaseUrlFor produces the GitHub tag URL', () => {
    expect(releaseUrlFor('1.2.3')).toBe(
      'https://github.com/inkeep/open-knowledge/releases/tag/v1.2.3',
    );
  });

  test('releaseUrlFor percent-encodes path-traversal chars (Finding #11)', () => {
    expect(releaseUrlFor('../../../etc/passwd')).toBe(
      'https://github.com/inkeep/open-knowledge/releases/tag/v..%2F..%2F..%2Fetc%2Fpasswd',
    );
    expect(releaseUrlFor('1.2.3/..')).toBe(
      'https://github.com/inkeep/open-knowledge/releases/tag/v1.2.3%2F..',
    );
  });
});

describe('boot-time stale versionPendingInstall reconciliation', () => {
  test('running version equals pending → cleared on boot (install-on-quit case)', () => {
    const { rig } = makeRig({ versionPendingInstall: '0.4.1', appVersion: '0.4.1' });
    expect(rig.state.versionPendingInstall).toBeNull();
    expect(rig.dispatches).toContain('stale-pending-cleared' as DispatchKind);
  });

  test('running version is past pending → cleared on boot (manual upgrade / catch-up case)', () => {
    const { rig } = makeRig({ versionPendingInstall: '0.4.0', appVersion: '0.4.1' });
    expect(rig.state.versionPendingInstall).toBeNull();
    expect(rig.dispatches).toContain('stale-pending-cleared' as DispatchKind);
  });

  test('running version is behind pending → preserved (genuinely pending update)', () => {
    const { rig } = makeRig({ versionPendingInstall: '0.4.2', appVersion: '0.4.1' });
    expect(rig.state.versionPendingInstall).toBe('0.4.2');
    expect(rig.dispatches).not.toContain('stale-pending-cleared' as DispatchKind);
  });

  test('versionPendingInstall is null → no-op (nothing to clear)', () => {
    const { rig } = makeRig({ versionPendingInstall: null, appVersion: '0.4.1' });
    expect(rig.state.versionPendingInstall).toBeNull();
    expect(rig.dispatches).not.toContain('stale-pending-cleared' as DispatchKind);
  });

  test('persist failure → state unchanged, no dispatch (gate not silently broken)', () => {
    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const primaryWindow = makeFakeWindow([]);
    const state: AppState = { ...emptyState(), versionPendingInstall: '0.4.0' };
    const dispatches: DispatchKind[] = [];
    startAutoUpdater({
      updater,
      ipcMain: ipc,
      readState: () => state,
      writeState: () => {
        throw new Error('EACCES');
      },
      getPrimaryWindow: () => primaryWindow,
      getAppVersion: () => '0.4.1',
      isPackaged: true,
      clock,
      now: () => new Date(),
      onDispatch: (k) => dispatches.push(k),
      logger: {
        info: vi.fn(() => {}),
        warn: vi.fn(() => {}),
        error: vi.fn(() => {}),
        debug: vi.fn(() => {}),
      },
    });
    expect(state.versionPendingInstall).toBe('0.4.0');
    expect(dispatches).not.toContain('stale-pending-cleared' as DispatchKind);
  });
});

describe('boot-time failed-install detection', () => {
  test('handoff on record, long past the grace (same-MMP beta) → relaunch-failed w/ downloadUrl, re-arm, stays armed', () => {
    const { rig } = makeRig({
      attemptedInstall: '0.16.0-beta.3',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      appVersion: '0.16.0-beta.1',
    });
    const failed = rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toEqual({
      version: '0.16.0-beta.3',
      downloadUrl: STUCK_HINT_DOWNLOAD_URL,
    });
    expect(rig.state.attemptedInstall).toBe('0.16.0-beta.3');
    expect(rig.state.versionPendingInstall).toBe('0.16.0-beta.3');
    expect(rig.dispatches).toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.dispatches).not.toContain('attempted-install-reconciled' as DispatchKind);
  });

  test('persistent failure across reboots keeps re-surfacing (attemptedInstall not consumed)', () => {
    const state: AppState = {
      ...emptyState(),
      lastSeenVersion: '0.16.0-beta.1',
      attemptedInstall: '0.16.0-beta.3',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
    };
    const boot = () => {
      const captured: CapturedSend[] = [];
      const dispatches: DispatchKind[] = [];
      startAutoUpdater({
        updater: new FakeUpdater(),
        ipcMain: makeFakeIpc(),
        readState: () => state,
        writeState: (next) => {
          Object.assign(state, next);
        },
        getPrimaryWindow: () => makeFakeWindow(captured),
        getAppVersion: () => '0.16.0-beta.1',
        isPackaged: true,
        clock: makeFakeClock(),
        now: () => new Date(),
        onDispatch: (k) => dispatches.push(k),
        logger: {
          info: vi.fn(() => {}),
          warn: vi.fn(() => {}),
          error: vi.fn(() => {}),
          debug: vi.fn(() => {}),
        },
      });
      return { captured, dispatches };
    };
    const first = boot();
    expect(first.dispatches).toContain('install-failed-on-boot' as DispatchKind);
    const second = boot();
    expect(second.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(
      1,
    );
    expect(second.dispatches).toContain('install-failed-on-boot' as DispatchKind);
  });

  test('attempted reached (running == attempted) → silently cleared, no failure notice', () => {
    const { rig } = makeRig({
      attemptedInstall: '0.16.0-beta.3',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      appVersion: '0.16.0-beta.3',
      attemptedInstallSurfacedCount: 2,
    });
    const failed = rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed');
    expect(failed).toHaveLength(0);
    expect(rig.state.attemptedInstall).toBeNull();
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
    expect(rig.dispatches).toContain('attempted-install-reconciled' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
  });

  test('attempted reached (running past attempted, stable over beta) → silently cleared', () => {
    const { rig } = makeRig({
      attemptedInstall: '0.16.0-beta.3',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      appVersion: '0.16.0',
      attemptedInstallSurfacedCount: 2,
    });
    expect(rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(0);
    expect(rig.state.attemptedInstall).toBeNull();
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
    expect(rig.dispatches).toContain('attempted-install-reconciled' as DispatchKind);
  });

  test('no attemptedInstall → no-op (nothing to reconcile)', () => {
    const { rig } = makeRig({ attemptedInstall: null, appVersion: '0.16.0-beta.1' });
    expect(rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(0);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.dispatches).not.toContain('attempted-install-reconciled' as DispatchKind);
  });

  test('update-downloaded arms attemptedInstall alongside versionPendingInstall', () => {
    const { rig } = makeRig();
    rig.updater.emit('update-downloaded', { version: '0.16.0-beta.3' });
    expect(rig.state.versionPendingInstall).toBe('0.16.0-beta.3');
    expect(rig.state.attemptedInstall).toBe('0.16.0-beta.3');
  });

  test('cross-channel residue (stable attempted, beta running) → silently cleared, no notice', () => {
    const { rig } = makeRig({
      attemptedInstall: '0.24.0',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      versionPendingInstall: '0.24.0',
      stagedInstallerPath: '/tmp/staged-cross-channel.deb',
      appVersion: '0.23.0-beta.1',
    });
    expect(rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(0);
    expect(rig.state.attemptedInstall).toBeNull();
    expect(rig.state.versionPendingInstall).toBeNull();
    expect(rig.state.stagedInstallerPath).toBeNull();
    expect(rig.dispatches).toContain('attempted-install-cross-channel' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.dispatches).not.toContain('attempted-install-reconciled' as DispatchKind);
  });

  test('cross-channel residue (beta attempted, older stable running) → silently cleared', () => {
    const { rig } = makeRig({
      attemptedInstall: '0.23.0-beta.5',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      appVersion: '0.22.0',
    });
    expect(rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(0);
    expect(rig.state.attemptedInstall).toBeNull();
    expect(rig.dispatches).toContain('attempted-install-cross-channel' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
  });

  test('same-channel failure below budget → surfaces AND increments the counter', () => {
    const { rig } = makeRig({
      attemptedInstall: '0.16.0-beta.3',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      appVersion: '0.16.0-beta.1',
      attemptedInstallSurfacedCount: 1,
    });
    expect(rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(1);
    expect(rig.state.attemptedInstallSurfacedCount).toBe(2);
    expect(rig.dispatches).toContain('install-failed-on-boot' as DispatchKind);
  });

  test('retry budget exhausted → gives up, clears the record incl. pending marker', () => {
    const { rig } = makeRig({
      attemptedInstall: '0.17.0-beta.1',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      versionPendingInstall: '0.17.0-beta.1',
      stagedInstallerPath: '/tmp/staged-giveup.deb',
      appVersion: '0.16.0-beta.1',
      attemptedInstallSurfacedCount: INSTALL_FAILURE_MAX_SURFACES,
    });
    expect(rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(0);
    expect(rig.state.attemptedInstall).toBeNull();
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
    expect(rig.state.versionPendingInstall).toBeNull();
    expect(rig.state.stagedInstallerPath).toBeNull();
    expect(rig.dispatches).toContain('install-failed-giveup' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
  });

  test('surfaces exactly INSTALL_FAILURE_MAX_SURFACES times across reboots, then gives up', () => {
    const state: AppState = {
      ...emptyState(),
      lastSeenVersion: '0.16.0-beta.1',
      attemptedInstall: '0.16.0-beta.3',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
    };
    const boot = () => {
      const captured: CapturedSend[] = [];
      const dispatches: DispatchKind[] = [];
      startAutoUpdater({
        updater: new FakeUpdater(),
        ipcMain: makeFakeIpc(),
        readState: () => state,
        writeState: (next) => {
          Object.assign(state, next);
        },
        getPrimaryWindow: () => makeFakeWindow(captured),
        getAppVersion: () => '0.16.0-beta.1',
        isPackaged: true,
        clock: makeFakeClock(),
        now: () => new Date(),
        onDispatch: (k) => dispatches.push(k),
        logger: {
          info: vi.fn(() => {}),
          warn: vi.fn(() => {}),
          error: vi.fn(() => {}),
          debug: vi.fn(() => {}),
        },
      });
      return { captured, dispatches };
    };
    for (let i = 0; i < INSTALL_FAILURE_MAX_SURFACES; i++) {
      const b = boot();
      expect(b.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(1);
      expect(b.dispatches).toContain('install-failed-on-boot' as DispatchKind);
    }
    expect(state.attemptedInstallSurfacedCount).toBe(INSTALL_FAILURE_MAX_SURFACES);
    const giveup = boot();
    expect(giveup.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(
      0,
    );
    expect(giveup.dispatches).toContain('install-failed-giveup' as DispatchKind);
    expect(state.attemptedInstall).toBeNull();
    const after = boot();
    expect(after.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(after.dispatches).not.toContain('install-failed-giveup' as DispatchKind);
  });

  test('update-downloaded of a NEW version resets the surface counter', () => {
    const { rig } = makeRig({
      attemptedInstall: '0.16.0-beta.3',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      appVersion: '0.16.0-beta.1',
      attemptedInstallSurfacedCount: 1,
    });
    expect(rig.state.attemptedInstallSurfacedCount).toBe(2);
    rig.updater.emit('update-downloaded', { version: '0.16.0-beta.5' });
    expect(rig.state.attemptedInstall).toBe('0.16.0-beta.5');
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
  });

  test('update-downloaded of the SAME version preserves the surface counter', () => {
    const { rig } = makeRig({
      isPackaged: false,
      attemptedInstall: '0.16.0-beta.3',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      appVersion: '0.16.0-beta.1',
      attemptedInstallSurfacedCount: 2,
    });
    rig.updater.emit('update-downloaded', { version: '0.16.0-beta.3' });
    expect(rig.state.versionPendingInstall).toBe('0.16.0-beta.3');
    expect(rig.state.attemptedInstall).toBe('0.16.0-beta.3');
    expect(rig.state.attemptedInstallSurfacedCount).toBe(2);
  });

  test('persist failure on the cross-channel branch → no clear, no dispatch', () => {
    const captured: CapturedSend[] = [];
    const state: AppState = {
      ...emptyState(),
      lastSeenVersion: '0.23.0-beta.1',
      attemptedInstall: '0.24.0',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
    };
    const dispatches: DispatchKind[] = [];
    startAutoUpdater({
      updater: new FakeUpdater(),
      ipcMain: makeFakeIpc(),
      readState: () => state,
      writeState: () => {
        throw new Error('EACCES');
      },
      getPrimaryWindow: () => makeFakeWindow(captured),
      getAppVersion: () => '0.23.0-beta.1',
      isPackaged: true,
      clock: makeFakeClock(),
      now: () => new Date(),
      onDispatch: (k) => dispatches.push(k),
      logger: {
        info: vi.fn(() => {}),
        warn: vi.fn(() => {}),
        error: vi.fn(() => {}),
        debug: vi.fn(() => {}),
      },
    });
    expect(dispatches).not.toContain('attempted-install-cross-channel' as DispatchKind);
    expect(state.attemptedInstall).toBe('0.24.0');
  });

  test('persist failure on the never-committed re-offer → no dispatch, no toast, record stays armed', () => {
    const captured: CapturedSend[] = [];
    const state: AppState = {
      ...emptyState(),
      lastSeenVersion: '0.16.0-beta.1',
      attemptedInstall: '0.16.0-beta.3',
      attemptedInstallHandoffAt: null,
    };
    const warn = vi.fn(() => {});
    const dispatches: DispatchKind[] = [];
    startAutoUpdater({
      updater: new FakeUpdater(),
      ipcMain: makeFakeIpc(),
      readState: () => state,
      writeState: () => {
        throw new Error('EACCES');
      },
      getPrimaryWindow: () => makeFakeWindow(captured),
      getAppVersion: () => '0.16.0-beta.1',
      isPackaged: true,
      clock: makeFakeClock(),
      now: () => new Date(),
      onDispatch: (k) => dispatches.push(k),
      logger: {
        info: vi.fn(() => {}),
        warn,
        error: vi.fn(() => {}),
        debug: vi.fn(() => {}),
      },
    });

    expect(dispatches).not.toContain('install-never-committed-reoffered' as DispatchKind);
    expect(captured.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(0);
    expect(state.attemptedInstall).toBe('0.16.0-beta.3');
    expect(warn).toHaveBeenCalledWith(
      'failed to persist install-never-committed-reoffered',
      expect.objectContaining({ attempted: '0.16.0-beta.3', running: '0.16.0-beta.1' }),
    );
  });

  test('persist failure on the giveup branch → record stays armed, no dispatch', () => {
    const captured: CapturedSend[] = [];
    const state: AppState = {
      ...emptyState(),
      lastSeenVersion: '0.16.0-beta.1',
      attemptedInstall: '0.16.0-beta.3',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      attemptedInstallSurfacedCount: INSTALL_FAILURE_MAX_SURFACES,
    };
    const dispatches: DispatchKind[] = [];
    startAutoUpdater({
      updater: new FakeUpdater(),
      ipcMain: makeFakeIpc(),
      readState: () => state,
      writeState: () => {
        throw new Error('EACCES');
      },
      getPrimaryWindow: () => makeFakeWindow(captured),
      getAppVersion: () => '0.16.0-beta.1',
      isPackaged: true,
      clock: makeFakeClock(),
      now: () => new Date(),
      onDispatch: (k) => dispatches.push(k),
      logger: {
        info: vi.fn(() => {}),
        warn: vi.fn(() => {}),
        error: vi.fn(() => {}),
        debug: vi.fn(() => {}),
      },
    });
    expect(dispatches).not.toContain('install-failed-giveup' as DispatchKind);
    expect(state.attemptedInstall).toBe('0.16.0-beta.3');
    expect(state.attemptedInstallSurfacedCount).toBe(INSTALL_FAILURE_MAX_SURFACES);
  });

  test('persist failure on the failure branch → no broadcast, no dispatch', () => {
    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const captured: CapturedSend[] = [];
    const primaryWindow = makeFakeWindow(captured);
    const state: AppState = {
      ...emptyState(),
      lastSeenVersion: '0.16.0-beta.1',
      attemptedInstall: '0.16.0-beta.3',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
    };
    const dispatches: DispatchKind[] = [];
    startAutoUpdater({
      updater,
      ipcMain: ipc,
      readState: () => state,
      writeState: () => {
        throw new Error('EACCES');
      },
      getPrimaryWindow: () => primaryWindow,
      getAppVersion: () => '0.16.0-beta.1',
      isPackaged: true,
      clock,
      now: () => new Date(),
      onDispatch: (k) => dispatches.push(k),
      logger: {
        info: vi.fn(() => {}),
        warn: vi.fn(() => {}),
        error: vi.fn(() => {}),
        debug: vi.fn(() => {}),
      },
    });
    expect(captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(0);
    expect(dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(state.attemptedInstall).toBe('0.16.0-beta.3');
  });

  test('persist failure on the success branch → attemptedInstall stays armed, no dispatch', () => {
    const state: AppState = {
      ...emptyState(),
      lastSeenVersion: '0.16.0-beta.3',
      attemptedInstall: '0.16.0-beta.3',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
    };
    const dispatches: DispatchKind[] = [];
    startAutoUpdater({
      updater: new FakeUpdater(),
      ipcMain: makeFakeIpc(),
      readState: () => state,
      writeState: () => {
        throw new Error('EACCES');
      },
      getPrimaryWindow: () => makeFakeWindow([]),
      getAppVersion: () => '0.16.0-beta.3',
      isPackaged: true,
      clock: makeFakeClock(),
      now: () => new Date(),
      onDispatch: (k) => dispatches.push(k),
      logger: {
        info: vi.fn(() => {}),
        warn: vi.fn(() => {}),
        error: vi.fn(() => {}),
        debug: vi.fn(() => {}),
      },
    });
    expect(state.attemptedInstall).toBe('0.16.0-beta.3');
    expect(dispatches).not.toContain('attempted-install-reconciled' as DispatchKind);
  });

  test('retiring the attempted-install record retires its handoff moment with it', () => {
    const STALE_HANDOFF = new Date('2026-04-20T12:00:00.000Z').getTime();

    const { rig: reconciled } = makeRig({
      attemptedInstall: '0.16.0-beta.3',
      appVersion: '0.16.0-beta.3',
      attemptedInstallHandoffAt: STALE_HANDOFF,
      attemptedInstallDeferredBoots: 2,
    });
    expect(reconciled.dispatches).toContain('attempted-install-reconciled' as DispatchKind);
    expect(reconciled.state.attemptedInstall).toBeNull();
    expect(reconciled.state.attemptedInstallHandoffAt).toBeNull();
    expect(reconciled.state.attemptedInstallDeferredBoots).toBe(0);

    const { rig: crossChannel } = makeRig({
      attemptedInstall: '0.23.0-beta.5',
      appVersion: '0.22.0',
      attemptedInstallHandoffAt: STALE_HANDOFF,
      attemptedInstallDeferredBoots: 2,
    });
    expect(crossChannel.dispatches).toContain('attempted-install-cross-channel' as DispatchKind);
    expect(crossChannel.state.attemptedInstall).toBeNull();
    expect(crossChannel.state.attemptedInstallHandoffAt).toBeNull();
    expect(crossChannel.state.attemptedInstallDeferredBoots).toBe(0);

    const { rig: gaveUp } = makeRig({
      attemptedInstall: '0.17.0-beta.1',
      appVersion: '0.16.0-beta.1',
      attemptedInstallSurfacedCount: INSTALL_FAILURE_MAX_SURFACES,
      attemptedInstallHandoffAt: STALE_HANDOFF,
      attemptedInstallDeferredBoots: 2,
    });
    expect(gaveUp.dispatches).toContain('install-failed-giveup' as DispatchKind);
    expect(gaveUp.state.attemptedInstall).toBeNull();
    expect(gaveUp.state.attemptedInstallHandoffAt).toBeNull();
    expect(gaveUp.state.attemptedInstallDeferredBoots).toBe(0);
  });
});

describe('boot-time failed-install detection — install still in flight', () => {
  const RUNNING = '0.53.0-beta.0';
  const ATTEMPTED = '0.54.0-beta.0';
  const STAGED_AT = new Date('2026-08-12T00:24:18.000Z');
  const HANDED_OFF_AT = new Date('2026-08-12T00:40:04.000Z');
  const SECOND = 1_000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;

  async function stageAndCommit(
    via: 'relaunch-click' | 'plain-quit' | 'unobserved-quit',
    overrides: { running?: string; attempted?: string; committedAt?: Date } = {},
  ): Promise<AppState> {
    const { rig, handle } = makeRig({
      appVersion: overrides.running ?? RUNNING,
      platform: 'darwin',
    });
    rig.now = STAGED_AT;
    rig.updater.emit('update-downloaded', { version: overrides.attempted ?? ATTEMPTED });
    rig.now = overrides.committedAt ?? HANDED_OFF_AT;
    if (via === 'relaunch-click') await rig.ipc.invoke('ok:update:relaunch-now');
    else if (via === 'plain-quit') handle.recordInstallHandoffOnQuit();
    return rig.state;
  }

  function reopenAt(state: AppState, at: Date, running: string = RUNNING): TestRig {
    const { rig } = makeRig({ ...state, appVersion: running, platform: 'darwin', nowAt: at });
    return rig;
  }

  const failureCards = (rig: TestRig): CapturedSend[] =>
    rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed');

  const reofferCards = (rig: TestRig): CapturedSend[] =>
    rig.captured.filter((c) => c.channel === 'ok:update:downloaded');

  function reopenAndQuit(
    state: AppState,
    at: Date,
    versions: { running: string; attempted: string },
  ): TestRig {
    const { rig, handle } = makeRig({
      ...state,
      appVersion: versions.running,
      platform: 'darwin',
      nowAt: at,
    });
    rig.now = new Date(at.getTime() + 10 * SECOND);
    rig.updater.emit('update-downloaded', { version: versions.attempted });
    rig.now = new Date(at.getTime() + 20 * SECOND);
    handle.recordInstallHandoffOnQuit();
    return rig;
  }

  test('reopened while the handed-off install may still be running → no failure verdict', async () => {
    const rig = reopenAt(
      await stageAndCommit('relaunch-click'),
      new Date(HANDED_OFF_AT.getTime() + 62 * SECOND),
    );

    expect(failureCards(rig)).toHaveLength(0);
    expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.state.versionPendingInstall).toBeNull();
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
    expect(rig.state.attemptedInstall).toBe(ATTEMPTED);
  });

  test('reopened deep in the observed install-duration range → still no failure verdict', async () => {
    const rig = reopenAt(
      await stageAndCommit('relaunch-click'),
      new Date(HANDED_OFF_AT.getTime() + 4 * MINUTE),
    );

    expect(failureCards(rig)).toHaveLength(0);
    expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
  });

  test('reopened long after the handoff → the failure notice still fires', async () => {
    const rig = reopenAt(
      await stageAndCommit('relaunch-click'),
      new Date(HANDED_OFF_AT.getTime() + 24 * HOUR),
    );

    expect(failureCards(rig)).toHaveLength(1);
    expect(failureCards(rig)[0]?.payload).toEqual({
      version: ATTEMPTED,
      downloadUrl: STUCK_HINT_DOWNLOAD_URL,
    });
    expect(rig.dispatches).toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.state.versionPendingInstall).toBe(ATTEMPTED);
    expect(rig.state.attemptedInstallSurfacedCount).toBe(1);
  });

  test('reopened moments after a plain quit committed the install → no failure verdict', async () => {
    const rig = reopenAt(
      await stageAndCommit('plain-quit'),
      new Date(HANDED_OFF_AT.getTime() + 45 * SECOND),
    );

    expect(failureCards(rig)).toHaveLength(0);
    expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
    expect(rig.state.attemptedInstall).toBe(ATTEMPTED);
  });

  test('a session between the staging and the plain quit is not charged against the install', async () => {
    const QUIT_AT = new Date(STAGED_AT.getTime() + 3 * HOUR);
    const rig = reopenAt(
      await stageAndCommit('plain-quit', { committedAt: QUIT_AT }),
      new Date(QUIT_AT.getTime() + 1 * MINUTE),
    );

    expect(failureCards(rig)).toHaveLength(0);
    expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
    expect(rig.state.attemptedInstall).toBe(ATTEMPTED);
  });

  test('reopened a day after a plain quit committed the install → the failure notice still fires', async () => {
    const rig = reopenAt(
      await stageAndCommit('plain-quit'),
      new Date(HANDED_OFF_AT.getTime() + 24 * HOUR),
    );

    expect(failureCards(rig)).toHaveLength(1);
    expect(rig.dispatches).toContain('install-failed-on-boot' as DispatchKind);
  });

  test('a session that recorded no handoff is re-offered once nothing can still be installing', async () => {
    const rig = reopenAt(
      await stageAndCommit('unobserved-quit'),
      new Date(STAGED_AT.getTime() + 2 * HOUR),
    );

    expect(rig.dispatches).toContain('install-never-committed-reoffered' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-in-flight-deferred' as DispatchKind);
    expect(failureCards(rig)).toHaveLength(0);
    expect(reofferCards(rig)).toHaveLength(1);
    expect(reofferCards(rig)[0]?.payload).toEqual({ version: ATTEMPTED });
    expect(rig.state.versionPendingInstall).toBe(ATTEMPTED);
    expect(rig.state.attemptedInstall).toBe(ATTEMPTED);
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
  });

  test('a never-committed attempt inside the grace defers rather than re-offering', async () => {
    const rig = reopenAt(
      await stageAndCommit('unobserved-quit'),
      new Date(STAGED_AT.getTime() + 45 * SECOND),
    );

    expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-never-committed-reoffered' as DispatchKind);
    expect(reofferCards(rig)).toHaveLength(0);
    expect(failureCards(rig)).toHaveLength(0);
  });

  test('a session that recorded no handoff never becomes a failure verdict, however long ago', async () => {
    const rig = reopenAt(
      await stageAndCommit('unobserved-quit'),
      new Date(STAGED_AT.getTime() + 24 * HOUR),
    );

    expect(failureCards(rig)).toHaveLength(0);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.dispatches).toContain('install-never-committed-reoffered' as DispatchKind);
    expect(rig.state.versionPendingInstall).toBe(ATTEMPTED);
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
  });

  test('repeated never-committed boots keep re-offering instead of spending the give-up budget', async () => {
    let state = await stageAndCommit('unobserved-quit');
    for (let boot = 1; boot <= 4; boot += 1) {
      const rig = reopenAt(state, new Date(STAGED_AT.getTime() + boot * 24 * HOUR));
      expect(failureCards(rig)).toHaveLength(0);
      expect(rig.dispatches).not.toContain('install-failed-giveup' as DispatchKind);
      expect(reofferCards(rig)).toHaveLength(1);
      expect(rig.state.versionPendingInstall).toBe(ATTEMPTED);
      state = rig.state;
    }
  });

  test('a re-offer taken and then failing still produces a failure verdict on the next boot', async () => {
    const reoffered = reopenAt(
      await stageAndCommit('unobserved-quit'),
      new Date(STAGED_AT.getTime() + 24 * HOUR),
    );
    expect(reoffered.dispatches).toContain('install-never-committed-reoffered' as DispatchKind);

    reoffered.now = new Date(STAGED_AT.getTime() + 24 * HOUR + MINUTE);
    await reoffered.ipc.invoke('ok:update:relaunch-now');
    expect(reoffered.state.attemptedInstallHandoffAt).not.toBeNull();

    const reclaim = vi.fn();
    const { rig: afterFailedClick } = makeRig({
      ...reoffered.state,
      appVersion: RUNNING,
      platform: 'darwin',
      nowAt: new Date(STAGED_AT.getTime() + 48 * HOUR),
      reclaimStagedUpdateCache: reclaim,
    });

    expect(afterFailedClick.dispatches).toContain('install-failed-on-boot' as DispatchKind);
    expect(failureCards(afterFailedClick)).toHaveLength(1);
    expect(failureCards(afterFailedClick)[0]?.payload).toEqual({
      version: ATTEMPTED,
      downloadUrl: STUCK_HINT_DOWNLOAD_URL,
    });
    expect(reclaim).not.toHaveBeenCalled();
  });

  test('the re-arm is what restores an offer the stale-pending reconciliation cleared', async () => {
    const rig = reopenAt(
      await stageAndCommit('unobserved-quit', {
        running: '0.16.0-beta.1',
        attempted: '0.16.0-beta.3',
      }),
      new Date(STAGED_AT.getTime() + 24 * HOUR),
      '0.16.0-beta.1',
    );

    expect(rig.dispatches).toContain('stale-pending-cleared' as DispatchKind);
    expect(rig.dispatches).toContain('install-never-committed-reoffered' as DispatchKind);
    expect(rig.state.versionPendingInstall).toBe('0.16.0-beta.3');
    expect(reofferCards(rig)).toHaveLength(1);
  });

  test('a recorded handoff is still judged on its age — the in-flight grace is untouched', async () => {
    const committed = await stageAndCommit('plain-quit');

    const early = reopenAt(committed, new Date(HANDED_OFF_AT.getTime() + 45 * SECOND));
    expect(early.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(early.dispatches).not.toContain('install-never-committed-reoffered' as DispatchKind);

    const late = reopenAt(committed, new Date(HANDED_OFF_AT.getTime() + 24 * HOUR));
    expect(late.dispatches).toContain('install-failed-on-boot' as DispatchKind);
    expect(late.dispatches).not.toContain('install-never-committed-reoffered' as DispatchKind);
    expect(failureCards(late)).toHaveLength(1);
  });

  test('the uninstall quit claims no handoff', async () => {
    const { rig, handle } = makeRig({ appVersion: RUNNING, platform: 'darwin' });
    rig.now = STAGED_AT;
    rig.updater.emit('update-downloaded', { version: ATTEMPTED });
    handle.suppressAutoInstallOnQuit();
    rig.now = HANDED_OFF_AT;
    handle.recordInstallHandoffOnQuit();

    expect(rig.state.attemptedInstallHandoffAt).toBeNull();
    expect(rig.state.attemptedInstallStagingAgeMs).toBeNull();
  });

  test('a quit re-handing off an attempt does not buy it a fresh window', async () => {
    const state = await stageAndCommit('plain-quit');
    const { rig, handle } = makeRig({ ...state, appVersion: RUNNING, platform: 'darwin' });
    rig.now = new Date(HANDED_OFF_AT.getTime() + 25 * MINUTE);
    handle.recordInstallHandoffOnQuit();

    expect(rig.state.attemptedInstallHandoffAt).toBe(HANDED_OFF_AT.getTime());
    expect(rig.state.attemptedInstallStagingAgeMs).toBe(
      HANDED_OFF_AT.getTime() - STAGED_AT.getTime(),
    );

    const later = reopenAt(rig.state, new Date(HANDED_OFF_AT.getTime() + 31 * MINUTE));
    expect(failureCards(later)).toHaveLength(1);
    expect(later.dispatches).toContain('install-failed-on-boot' as DispatchKind);
  });

  test('deferring does not spend the surfacing budget', async () => {
    let state = await stageAndCommit('relaunch-click');
    const first = reopenAt(state, new Date(HANDED_OFF_AT.getTime() + 20 * SECOND));
    expect(failureCards(first)).toHaveLength(0);
    state = first.state;

    const second = reopenAt(state, new Date(HANDED_OFF_AT.getTime() + 90 * SECOND));
    expect(failureCards(second)).toHaveLength(0);
    state = second.state;

    const later = reopenAt(state, new Date(HANDED_OFF_AT.getTime() + 24 * HOUR));
    expect(failureCards(later)).toHaveLength(1);
    expect(later.state.attemptedInstallSurfacedCount).toBe(1);
  });

  test('an install that never lands is reported even when every reopen looks fresh', async () => {
    const RUNNING_BETA = '0.54.0-beta.0';
    const ATTEMPTED_BETA = '0.54.0-beta.1';
    const versions = { running: RUNNING_BETA, attempted: ATTEMPTED_BETA };

    let state = await stageAndCommit('relaunch-click', versions);
    let reopenedAt = new Date(HANDED_OFF_AT.getTime() + 45 * SECOND);
    for (let cycle = 1; cycle <= 3; cycle++) {
      const rig = reopenAndQuit(state, reopenedAt, versions);
      expect(failureCards(rig)).toHaveLength(0);
      expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
      expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
      expect(rig.dispatches).not.toContain('update-downloaded-deduped' as DispatchKind);
      expect(rig.state.attemptedInstallHandoffAt).toBe(reopenedAt.getTime() + 20 * SECOND);
      state = rig.state;
      reopenedAt = new Date(reopenedAt.getTime() + 1 * MINUTE);
    }

    const reported = reopenAt(state, reopenedAt, RUNNING_BETA);
    expect(failureCards(reported)).toHaveLength(1);
    expect(failureCards(reported)[0]?.payload).toEqual({
      version: ATTEMPTED_BETA,
      downloadUrl: STUCK_HINT_DOWNLOAD_URL,
    });
    expect(reported.dispatches).toContain('install-failed-on-boot' as DispatchKind);
    expect(reported.dispatches).not.toContain('install-in-flight-deferred' as DispatchKind);
    expect(reported.state.attemptedInstallSurfacedCount).toBe(1);
    expect(reported.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('did not take'),
      expect.objectContaining({ handoffAgeMs: 40 * SECOND }),
    );
  });

  test('a boot that cannot record the hold still holds', async () => {
    const state = await stageAndCommit('relaunch-click');
    const captured: CapturedSend[] = [];
    const dispatches: DispatchKind[] = [];
    startAutoUpdater({
      updater: new FakeUpdater(),
      ipcMain: makeFakeIpc(),
      readState: () => state,
      writeState: () => {
        throw new Error('EACCES');
      },
      getPrimaryWindow: () => makeFakeWindow(captured),
      getAppVersion: () => RUNNING,
      isPackaged: true,
      platform: 'darwin',
      clock: makeFakeClock(),
      now: () => new Date(HANDED_OFF_AT.getTime() + 62 * SECOND),
      onDispatch: (k) => dispatches.push(k),
      logger: {
        info: vi.fn(() => {}),
        warn: vi.fn(() => {}),
        error: vi.fn(() => {}),
        debug: vi.fn(() => {}),
      },
    });

    expect(captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(0);
    expect(dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(state.attemptedInstallDeferredBoots).toBe(0);
  });

  test('a newly attempted version gets its own hold, a re-armed one keeps the old', async () => {
    const RUNNING_BETA = '0.54.0-beta.0';
    const ATTEMPTED_BETA = '0.54.0-beta.1';
    const versions = { running: RUNNING_BETA, attempted: ATTEMPTED_BETA };

    let state = await stageAndCommit('relaunch-click', versions);
    let reopenedAt = new Date(HANDED_OFF_AT.getTime() + 45 * SECOND);
    for (let cycle = 1; cycle <= 3; cycle++) {
      const rig = reopenAndQuit(state, reopenedAt, versions);
      expect(failureCards(rig)).toHaveLength(0);
      state = rig.state;
      reopenedAt = new Date(reopenedAt.getTime() + 1 * MINUTE);
    }
    expect(failureCards(reopenAt(state, reopenedAt, RUNNING_BETA))).toHaveLength(1);

    const NEXT = '0.55.0-beta.0';
    const { rig: restaged, handle } = makeRig({
      ...state,
      appVersion: RUNNING_BETA,
      platform: 'darwin',
      nowAt: reopenedAt,
    });
    restaged.now = new Date(reopenedAt.getTime() + 1 * MINUTE);
    restaged.updater.emit('update-downloaded', { version: NEXT });
    expect(restaged.state.attemptedInstall).toBe(NEXT);
    restaged.now = new Date(reopenedAt.getTime() + 2 * MINUTE);
    handle.recordInstallHandoffOnQuit();

    const fresh = reopenAt(
      restaged.state,
      new Date(reopenedAt.getTime() + 3 * MINUTE),
      RUNNING_BETA,
    );
    expect(failureCards(fresh)).toHaveLength(0);
    expect(fresh.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(fresh.state.attemptedInstall).toBe(NEXT);
  });

  test('a handoff the clock cannot make sense of → fail closed, the notice fires', async () => {
    const rig = reopenAt(
      await stageAndCommit('relaunch-click'),
      new Date(HANDED_OFF_AT.getTime() - 1 * HOUR),
    );

    expect(failureCards(rig)).toHaveLength(1);
    expect(rig.dispatches).toContain('install-failed-on-boot' as DispatchKind);
  });

  test('same-MMP beta bump committed by a plain quit → no failure verdict', async () => {
    const RUNNING_BETA = '0.54.0-beta.0';
    const ATTEMPTED_BETA = '0.54.0-beta.1';
    const rig = reopenAt(
      await stageAndCommit('plain-quit', { running: RUNNING_BETA, attempted: ATTEMPTED_BETA }),
      new Date(HANDED_OFF_AT.getTime() + 45 * SECOND),
      RUNNING_BETA,
    );

    expect(rig.dispatches).toContain('stale-pending-cleared' as DispatchKind);

    expect(failureCards(rig)).toHaveLength(0);
    expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
    expect(rig.state.attemptedInstall).toBe(ATTEMPTED_BETA);
  });

  test('an unobserved commit on a same-MMP beta bump still defers', async () => {
    const RUNNING_BETA = '0.54.0-beta.0';
    const ATTEMPTED_BETA = '0.54.0-beta.1';
    const rig = reopenAt(
      await stageAndCommit('unobserved-quit', {
        running: RUNNING_BETA,
        attempted: ATTEMPTED_BETA,
      }),
      new Date(STAGED_AT.getTime() + 45 * SECOND),
      RUNNING_BETA,
    );

    expect(rig.dispatches).toContain('stale-pending-cleared' as DispatchKind);
    expect(rig.state.attemptedInstallHandoffAt).toBeNull();

    expect(failureCards(rig)).toHaveLength(0);
    expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
    expect(rig.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('defer'),
      expect.objectContaining({ recordedHandoff: false, handoffAt: STAGED_AT.getTime() }),
    );
  });

  test.todo(
    'an unobserved commit on a same-MMP beta bump survives a SECOND reopen (needs PRD-8291)',
  );

  test('a same-MMP beta bump survives a SECOND reopen inside the window', async () => {
    const RUNNING_BETA = '0.54.0-beta.0';
    const ATTEMPTED_BETA = '0.54.0-beta.1';
    const first = reopenAt(
      await stageAndCommit('plain-quit', { running: RUNNING_BETA, attempted: ATTEMPTED_BETA }),
      new Date(HANDED_OFF_AT.getTime() + 45 * SECOND),
      RUNNING_BETA,
    );
    expect(first.dispatches).toContain('stale-pending-cleared' as DispatchKind);
    expect(failureCards(first)).toHaveLength(0);

    const second = reopenAt(
      first.state,
      new Date(HANDED_OFF_AT.getTime() + 3 * MINUTE),
      RUNNING_BETA,
    );

    expect(failureCards(second)).toHaveLength(0);
    expect(second.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(second.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(second.state.attemptedInstallSurfacedCount).toBe(0);
  });

  test('a long wait before the click is measured from the click, not from the staging', async () => {
    const CLICKED_AT = new Date(STAGED_AT.getTime() + 3 * HOUR);
    const rig = reopenAt(
      await stageAndCommit('relaunch-click', { committedAt: CLICKED_AT }),
      new Date(CLICKED_AT.getTime() + 1 * MINUTE),
    );

    expect(failureCards(rig)).toHaveLength(0);
    expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
    expect(rig.state.attemptedInstall).toBe(ATTEMPTED);
  });

  test('a deferred boot records how long ago the install was handed off', async () => {
    const rig = reopenAt(
      await stageAndCommit('relaunch-click'),
      new Date(HANDED_OFF_AT.getTime() + 62 * SECOND),
    );

    expect(rig.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('defer'),
      expect.objectContaining({
        attempted: ATTEMPTED,
        handoffAgeMs: 62 * SECOND,
        handoffAt: HANDED_OFF_AT.getTime(),
        stagingAgeMs: HANDED_OFF_AT.getTime() - STAGED_AT.getTime(),
      }),
    );
  });

  test('a boot ten minutes after the handoff still defers', async () => {
    const rig = reopenAt(
      await stageAndCommit('relaunch-click'),
      new Date(HANDED_OFF_AT.getTime() + 10 * MINUTE),
    );

    expect(failureCards(rig)).toHaveLength(0);
    expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
  });

  test('a boot two hours after the handoff fires the notice', async () => {
    const rig = reopenAt(
      await stageAndCommit('relaunch-click'),
      new Date(HANDED_OFF_AT.getTime() + 2 * HOUR),
    );

    expect(failureCards(rig)).toHaveLength(1);
    expect(rig.dispatches).toContain('install-failed-on-boot' as DispatchKind);
  });

  test('a re-armed artifact records its own handoff instead of inheriting the last one', async () => {
    const NEXT = '0.55.0-beta.0';
    const RESTAGED_AT = new Date(HANDED_OFF_AT.getTime() + 5 * HOUR);
    const REQUIT_AT = new Date(RESTAGED_AT.getTime() + 10 * MINUTE);

    const { rig, handle } = makeRig({ appVersion: RUNNING, platform: 'darwin' });
    rig.now = STAGED_AT;
    rig.updater.emit('update-downloaded', { version: ATTEMPTED });
    rig.now = HANDED_OFF_AT;
    handle.recordInstallHandoffOnQuit();

    rig.now = RESTAGED_AT;
    rig.updater.emit('update-downloaded', { version: NEXT });
    expect(rig.state.attemptedInstall).toBe(NEXT);
    expect(rig.state.attemptedInstallHandoffAt).toBeNull();

    rig.now = REQUIT_AT;
    handle.recordInstallHandoffOnQuit();
    expect(rig.state.attemptedInstallHandoffAt).toBe(REQUIT_AT.getTime());

    const reopened = reopenAt(rig.state, new Date(REQUIT_AT.getTime() + 45 * SECOND));
    expect(failureCards(reopened)).toHaveLength(0);
    expect(reopened.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(reopened.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
  });
});

describe('installReached (prerelease-aware compare)', () => {
  test('equal versions → true', () => {
    expect(installReached('0.16.0-beta.3', '0.16.0-beta.3')).toBe(true);
    expect(installReached('1.2.3', '1.2.3')).toBe(true);
  });
  test('same MMP, running beta is behind attempted beta → false (the PRD-7149 case)', () => {
    expect(installReached('0.16.0-beta.1', '0.16.0-beta.3')).toBe(false);
    expect(installReached('0.16.0-beta.2', '0.16.0-beta.10')).toBe(false);
  });
  test('same MMP, running beta is ahead → true', () => {
    expect(installReached('0.16.0-beta.5', '0.16.0-beta.3')).toBe(true);
  });
  test('stable outranks a prerelease of the same MMP', () => {
    expect(installReached('0.16.0', '0.16.0-beta.3')).toBe(true);
    expect(installReached('0.16.0-beta.3', '0.16.0')).toBe(false);
  });
  test('MMP dominates prerelease', () => {
    expect(installReached('0.17.0-beta.1', '0.16.0-beta.3')).toBe(true);
    expect(installReached('0.15.9', '0.16.0-beta.1')).toBe(false);
    expect(installReached('1.0.0', '0.16.0')).toBe(true);
  });
  test('unparseable input → true (conservative: assume success, never cry wolf)', () => {
    expect(installReached('garbage', '0.16.0-beta.3')).toBe(true);
    expect(installReached('0.16.0-beta.3', 'garbage')).toBe(true);
  });
  test('non-numeric prerelease identifiers compare in ASCII order', () => {
    expect(installReached('1.0.0-beta', '1.0.0-alpha')).toBe(true);
    expect(installReached('1.0.0-alpha', '1.0.0-beta')).toBe(false);
  });
  test('a numeric identifier ranks below a non-numeric one (semver §11.4.3)', () => {
    expect(installReached('1.0.0-alpha', '1.0.0-1')).toBe(true);
    expect(installReached('1.0.0-1', '1.0.0-alpha')).toBe(false);
  });
  test('length tie-break: more identifiers outrank fewer when all preceding are equal', () => {
    expect(installReached('1.0.0-beta.1', '1.0.0-beta')).toBe(true);
    expect(installReached('1.0.0-beta', '1.0.0-beta.1')).toBe(false);
  });
});

describe('versionAtLeast (MMP compare)', () => {
  test('equal versions → true', () => {
    expect(versionAtLeast('0.4.1', '0.4.1')).toBe(true);
    expect(versionAtLeast('1.0.0', '1.0.0')).toBe(true);
  });

  test('running ahead in major / minor / patch → true', () => {
    expect(versionAtLeast('1.0.0', '0.9.9')).toBe(true);
    expect(versionAtLeast('0.5.0', '0.4.99')).toBe(true);
    expect(versionAtLeast('0.4.2', '0.4.1')).toBe(true);
  });

  test('running behind in major / minor / patch → false', () => {
    expect(versionAtLeast('0.9.9', '1.0.0')).toBe(false);
    expect(versionAtLeast('0.4.99', '0.5.0')).toBe(false);
    expect(versionAtLeast('0.4.1', '0.4.2')).toBe(false);
  });

  test('prerelease and build suffixes are dropped (MMP-only comparison)', () => {
    expect(versionAtLeast('0.4.1', '0.4.1-beta.5')).toBe(true);
    expect(versionAtLeast('0.4.1-beta.5', '0.4.1')).toBe(true);
    expect(versionAtLeast('0.4.1+build.42', '0.4.1')).toBe(true);
    expect(versionAtLeast('0.4.2-beta.1', '0.4.1')).toBe(true);
  });

  test('malformed input → false (conservative: keep gate armed on garbage)', () => {
    expect(versionAtLeast('', '0.4.1')).toBe(false);
    expect(versionAtLeast('0.4.1', '')).toBe(false);
    expect(versionAtLeast('not-a-version', '0.4.1')).toBe(false);
    expect(versionAtLeast('0.4.1', 'not-a-version')).toBe(false);
    expect(versionAtLeast('0.4', '0.4.1')).toBe(false);
    expect(versionAtLeast(null as unknown as string, '0.4.1')).toBe(false);
    expect(versionAtLeast('0.4.1', undefined as unknown as string)).toBe(false);
  });
});

describe('multi-window delivery: relaunch banner and "updated to" notice both reach every window', () => {
  test('manual check started and settled phases reach every open window', async () => {
    const { rig } = makeRig({ extraWindowCount: 2 });
    expect(rig.windows).toHaveLength(3);
    rig.ipc.invoke('ok:update:check-now');
    rig.updater.emit('update-not-available', { version: '0.3.1' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const win of rig.windows) {
      const phases = win
        .filter((entry) => entry.channel === 'ok:update:manual-check')
        .map((entry) => (entry.payload as { phase: 'started' | 'settled' }).phase);
      expect(phases).toEqual(['started', 'settled']);
    }
  });

  test('ok:update:downloaded (relaunch banner) reaches every open window', () => {
    const { rig } = makeRig({ extraWindowCount: 2 });
    expect(rig.windows).toHaveLength(3);
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    for (const win of rig.windows) {
      const toastA = win.filter((c) => c.channel === 'ok:update:downloaded');
      expect(toastA).toHaveLength(1);
      expect(toastA[0]?.payload).toEqual({ version: '0.3.2' });
    }
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
    expect(rig.dispatches.filter((d) => d === 'update-downloaded-toast-a')).toHaveLength(1);
  });

  test('no getAllWindows wired (default fixture) → relaunch banner falls back to the primary window', () => {
    const { rig } = makeRig();
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    expect(rig.windows).toHaveLength(1);
    expect(rig.windows[0]?.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(1);
  });

  test('ok:update:whats-new ("Updated to Version X") reaches every open window', () => {
    const { rig } = makeRig({
      lastSeenVersion: '0.3.0',
      appVersion: '0.3.1',
      extraWindowCount: 2,
    });
    expect(rig.windows).toHaveLength(3);
    for (const win of rig.windows) {
      const whatsNew = win.filter((c) => c.channel === 'ok:update:whats-new');
      expect(whatsNew).toHaveLength(1);
      expect(whatsNew[0]?.payload).toMatchObject({ version: '0.3.1' });
    }
    expect(rig.dispatches.filter((d) => d === 'whats-new-toast-b')).toHaveLength(1);
  });

  test('dedup holds across the fan-out — re-fired update-downloaded for the same version is not re-broadcast to any window', () => {
    const { rig } = makeRig({ extraWindowCount: 1 });
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    for (const win of rig.windows) {
      expect(win.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(1);
    }
    expect(rig.dispatches).toContain('update-downloaded-deduped' as DispatchKind);
  });
});

describe('release-notes cross-window dismiss + late-window delivery', () => {
  test('registers the whats-new-dismiss IPC handler', () => {
    const { rig } = makeRig();
    expect(rig.ipc.handlers.has('ok:update:whats-new-dismiss')).toBe(true);
  });

  test('whats-new-dismiss re-broadcasts ok:update:whats-new-dismissed to every window', () => {
    const { rig } = makeRig({ extraWindowCount: 2 });
    rig.ipc.invoke('ok:update:whats-new-dismiss', { version: '0.3.1' });
    for (const win of rig.windows) {
      const dismissed = win.filter((c) => c.channel === 'ok:update:whats-new-dismissed');
      expect(dismissed).toHaveLength(1);
      expect(dismissed[0]?.payload).toEqual({ version: '0.3.1' });
    }
    expect(rig.dispatches).toContain('whats-new-dismiss-broadcast' as DispatchKind);
  });

  test('getActiveWhatsNew returns the live notice within its window', () => {
    const { handle } = makeRig({ lastSeenVersion: '0.3.0', appVersion: '0.3.1' });
    expect(handle.getActiveWhatsNew()).toMatchObject({ version: '0.3.1' });
  });

  test('getActiveWhatsNew returns null once the live window elapses', () => {
    const { rig, handle } = makeRig({ lastSeenVersion: '0.3.0', appVersion: '0.3.1' });
    expect(handle.getActiveWhatsNew()).not.toBeNull();
    rig.now = new Date(rig.now.getTime() + 60_001);
    expect(handle.getActiveWhatsNew()).toBeNull();
  });

  test('getActiveWhatsNew returns null after the notice is dismissed', () => {
    const { rig, handle } = makeRig({ lastSeenVersion: '0.3.0', appVersion: '0.3.1' });
    expect(handle.getActiveWhatsNew()).not.toBeNull();
    rig.ipc.invoke('ok:update:whats-new-dismiss', { version: '0.3.1' });
    expect(handle.getActiveWhatsNew()).toBeNull();
  });

  test('a stale dismiss for an older version leaves a newer live notice intact', () => {
    const { rig, handle } = makeRig({ lastSeenVersion: '0.3.0', appVersion: '0.3.1' });
    rig.ipc.invoke('ok:update:whats-new-dismiss', { version: '0.3.0' });
    expect(handle.getActiveWhatsNew()).toMatchObject({ version: '0.3.1' });
  });
});

describe('periodic check singleton + jitter (AC10, D10)', () => {
  test('registers exactly one timer after the first launch check resolves', async () => {
    const { rig } = makeRig();
    await rig.updater.checkForUpdates();
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.clock.setTimeout).toHaveBeenCalledTimes(1);
    expect(rig.clock.lastMs).toBe(UPDATE_CHECK_INTERVAL_MS);
  });

  test('scheduled delay = UPDATE_CHECK_INTERVAL_MS + floor(random() * UPDATE_CHECK_JITTER_MS)', async () => {
    const half = makeRig({ random: () => 0.5 });
    await half.rig.updater.checkForUpdates();
    await Promise.resolve();
    await Promise.resolve();
    expect(half.rig.clock.lastMs).toBe(
      UPDATE_CHECK_INTERVAL_MS + Math.floor(0.5 * UPDATE_CHECK_JITTER_MS),
    );
    expect(half.rig.clock.lastMs).toBeGreaterThan(UPDATE_CHECK_INTERVAL_MS);

    const top = makeRig({ random: () => 0.999_999 });
    await top.rig.updater.checkForUpdates();
    await Promise.resolve();
    await Promise.resolve();
    expect(top.rig.clock.lastMs).toBeGreaterThanOrEqual(UPDATE_CHECK_INTERVAL_MS);
    expect(top.rig.clock.lastMs).toBeLessThan(UPDATE_CHECK_INTERVAL_MS + UPDATE_CHECK_JITTER_MS);
  });

  test('jitter is re-drawn on every fire (no fleet lockstep)', async () => {
    const values = [0, 0.25, 0.75, 0.5];
    let i = 0;
    const { rig } = makeRig({ random: () => values[i++ % values.length] ?? 0 });
    await rig.updater.checkForUpdates();
    await Promise.resolve();
    await Promise.resolve();
    const observed: Array<number | null> = [rig.clock.lastMs];
    for (let tick = 0; tick < 3; tick++) {
      rig.clock.lastCallback?.();
      observed.push(rig.clock.lastMs);
    }
    expect(observed).toEqual([
      UPDATE_CHECK_INTERVAL_MS + Math.floor(0 * UPDATE_CHECK_JITTER_MS),
      UPDATE_CHECK_INTERVAL_MS + Math.floor(0.25 * UPDATE_CHECK_JITTER_MS),
      UPDATE_CHECK_INTERVAL_MS + Math.floor(0.75 * UPDATE_CHECK_JITTER_MS),
      UPDATE_CHECK_INTERVAL_MS + Math.floor(0.5 * UPDATE_CHECK_JITTER_MS),
    ]);
    expect(rig.clock.setTimeout).toHaveBeenCalledTimes(4);
  });

  test('timer callback calls checkForUpdates and re-arms', async () => {
    const { rig } = makeRig();
    await rig.updater.checkForUpdates();
    await Promise.resolve();
    await Promise.resolve();
    rig.updater.checkForUpdates.mockClear();
    rig.clock.setTimeout.mockClear();
    rig.clock.lastCallback?.();
    expect(rig.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(rig.clock.setTimeout).toHaveBeenCalledTimes(1);
  });

  test('destroy() clears the pending timer', async () => {
    const { rig, handle } = makeRig();
    await rig.updater.checkForUpdates();
    await Promise.resolve();
    await Promise.resolve();
    handle.destroy();
    expect(rig.clock.clearTimeout).toHaveBeenCalled();
  });

  test('UPDATE_CHECK_INTERVAL_MS is the hourly cadence; jitter is a small fraction of it', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(UPDATE_CHECK_JITTER_MS).toBe(5 * 60 * 1000);
    expect(UPDATE_CHECK_JITTER_MS).toBeLessThan(UPDATE_CHECK_INTERVAL_MS);
  });

  test('first-launch check rejection still registers the periodic timer', async () => {
    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const captured: CapturedSend[] = [];
    let state: AppState = emptyState();
    updater.checkForUpdates = vi.fn(() =>
      Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')),
    );
    const primaryWindow = makeFakeWindow(captured);
    const logger = {
      info: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      debug: vi.fn(() => {}),
    };
    startAutoUpdater({
      updater,
      ipcMain: ipc,
      readState: () => state,
      writeState: (next) => {
        state = next;
      },
      getPrimaryWindow: () => primaryWindow,
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      clock,
      now: () => new Date(),
      random: () => 0,
      logger,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(clock.setTimeout).toHaveBeenCalledTimes(1);
    expect(clock.lastMs).toBe(UPDATE_CHECK_INTERVAL_MS);
    expect(logger.debug).toHaveBeenCalled();
  });
});

describe('ok:update:relaunch-now IPC handler (AC18)', () => {
  test('registers the handler on startup', () => {
    const { rig } = makeRig();
    expect(rig.ipc.handlers.has('ok:update:relaunch-now')).toBe(true);
  });

  test('handler invocation WITH versionPendingInstall calls autoUpdater.quitAndInstall', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(rig.dispatches).toContain('relaunch-now' as DispatchKind);
  });

  test('handler invocation WITHOUT versionPendingInstall is ignored (Finding #5 guard)', () => {
    const { rig } = makeRig({ versionPendingInstall: null });
    rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(rig.dispatches).not.toContain('relaunch-now' as DispatchKind);
    expect(rig.logger.warn).toHaveBeenCalled();
  });

  test('broadcasts ok:update:relaunching to EVERY open window so all swap in lockstep', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', extraWindowCount: 2 });
    expect(rig.windows).toHaveLength(3);
    await rig.ipc.invoke('ok:update:relaunch-now');
    for (const win of rig.windows) {
      const relaunching = win.filter((c) => c.channel === 'ok:update:relaunching');
      expect(relaunching).toHaveLength(1);
      expect(relaunching[0]?.payload).toEqual({ version: '0.3.2' });
    }
    expect(rig.dispatches.filter((d) => d === 'relaunching-broadcast')).toHaveLength(1);
  });

  test('quitAndInstall throw → state restored + every window re-armed via ok:update:downloaded + invoke rejects', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', extraWindowCount: 2 });
    rig.updater.quitAndInstall = vi.fn(() => {
      throw new Error('SQRLInstallerErrorDomain Code=-9');
    });
    await expect(Promise.resolve(rig.ipc.invoke('ok:update:relaunch-now'))).rejects.toThrow(
      'SQRLInstallerErrorDomain Code=-9',
    );
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
    for (const win of rig.windows) {
      expect(win.filter((c) => c.channel === 'ok:update:relaunching')).toHaveLength(1);
      const reArm = win.filter((c) => c.channel === 'ok:update:downloaded');
      expect(reArm).toHaveLength(1);
      expect(reArm[0]?.payload).toEqual({ version: '0.3.2' });
      const failed = win.filter((c) => c.channel === 'ok:update:relaunch-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toEqual({
        version: '0.3.2',
        message: 'SQRLInstallerErrorDomain Code=-9',
      });
    }
    expect(rig.dispatches).toContain('relaunch-failed-rearm' as DispatchKind);
    rig.updater.quitAndInstall = vi.fn(() => {});
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  test('does NOT broadcast ok:update:relaunching when nothing is pending (gated)', () => {
    const { rig } = makeRig({ versionPendingInstall: null, extraWindowCount: 2 });
    rig.ipc.invoke('ok:update:relaunch-now');
    for (const win of rig.windows) {
      expect(win.filter((c) => c.channel === 'ok:update:relaunching')).toHaveLength(0);
    }
    expect(rig.dispatches).not.toContain('relaunching-broadcast' as DispatchKind);
  });

  test('broadcasts ok:update:relaunching BEFORE the prepareForRelaunch teardown runs', async () => {
    const captured: CapturedSend[] = [];
    const ipc = makeFakeIpc();
    let state: AppState = { ...emptyState(), versionPendingInstall: '0.3.2' };
    let relaunchingSeenAtTeardown = -1;
    const win = makeFakeWindow(captured);
    startAutoUpdater({
      updater: new FakeUpdater(),
      ipcMain: ipc,
      readState: () => state,
      writeState: (next) => {
        state = next;
      },
      getPrimaryWindow: () => win,
      getAllWindows: () => [win],
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      prepareForRelaunch: async () => {
        relaunchingSeenAtTeardown = captured.filter(
          (c) => c.channel === 'ok:update:relaunching',
        ).length;
      },
      clock: makeFakeClock(),
      now: () => new Date(),
      logger: {
        info: vi.fn(() => {}),
        warn: vi.fn(() => {}),
        error: vi.fn(() => {}),
        debug: vi.fn(() => {}),
      },
    });
    await ipc.invoke('ok:update:relaunch-now');
    expect(relaunchingSeenAtTeardown).toBe(1);
  });

  test('destroy() removes the IPC handler', () => {
    const { rig, handle } = makeRig();
    handle.destroy();
    expect(rig.ipc.handlers.has('ok:update:relaunch-now')).toBe(false);
  });

  test('teardown and survivor sweep fire before quitAndInstall in that order', async () => {
    const calls: string[] = [];
    const updater = new FakeUpdater();
    updater.quitAndInstall = vi.fn(() => {
      calls.push('quitAndInstall');
    });
    const ipc = makeFakeIpc();
    const captured: CapturedSend[] = [];
    let state: AppState = { ...emptyState(), versionPendingInstall: '0.3.2' };
    startAutoUpdater({
      updater,
      ipcMain: ipc,
      readState: () => state,
      writeState: (next) => {
        state = next;
      },
      getPrimaryWindow: () => makeFakeWindow(captured),
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      prepareForRelaunch: async () => {
        calls.push('prepareForRelaunch');
      },
      sweepUpdateSurvivors: () => {
        calls.push('sweepUpdateSurvivors');
      },
      clock: makeFakeClock(),
      now: () => new Date(),
      logger: {
        info: vi.fn(() => {}),
        warn: vi.fn(() => {}),
        error: vi.fn(() => {}),
        debug: vi.fn(() => {}),
      },
    });
    await ipc.invoke('ok:update:relaunch-now');
    expect(calls).toEqual(['prepareForRelaunch', 'sweepUpdateSurvivors', 'quitAndInstall']);
  });

  test('prepareForRelaunch does NOT fire when versionPendingInstall is null', () => {
    const prepareForRelaunch = vi.fn(() => {});
    const { rig } = makeRig({ versionPendingInstall: null, prepareForRelaunch });
    rig.ipc.invoke('ok:update:relaunch-now');
    expect(prepareForRelaunch).not.toHaveBeenCalled();
    expect(rig.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  test('prepareForRelaunch throw does NOT block quitAndInstall', async () => {
    const prepareForRelaunch = vi.fn(() => {
      throw new Error('teardown bug');
    });
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', prepareForRelaunch });
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(prepareForRelaunch).toHaveBeenCalledTimes(1);
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(rig.logger.warn).toHaveBeenCalled();
  });

  test('survivor sweep throw does NOT block quitAndInstall', async () => {
    const sweepUpdateSurvivors = vi.fn(() => {
      throw new Error('process query failed');
    });
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', sweepUpdateSurvivors });
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(sweepUpdateSurvivors).toHaveBeenCalledTimes(1);
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(rig.logger.warn).toHaveBeenCalled();
  });

  test('incomplete survivor sweep is observable and does NOT block quitAndInstall', async () => {
    const sweepUpdateSurvivors = vi.fn(() => ({
      candidateCount: 2,
      terminatedCount: 0,
      failedCount: 0,
      scanFailed: false,
      revalidationFailed: true,
    }));
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', sweepUpdateSurvivors });

    await rig.ipc.invoke('ok:update:relaunch-now');

    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(rig.logger.warn).toHaveBeenCalledWith(
      'update survivor sweep incomplete — proceeding to quitAndInstall anyway',
      { result: expect.objectContaining({ revalidationFailed: true }) },
    );
  });
});

describe('async relaunch failure — error event + no-quit watchdog', () => {
  test('clean quitAndInstall return arms the watchdog at RELAUNCH_WATCHDOG_MS (packaged)', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.clock.lastMs).toBe(UPDATE_CHECK_INTERVAL_MS);
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.clock.lastMs).toBe(RELAUNCH_WATCHDOG_MS);
    expect(rig.clock.lastCallback).not.toBeNull();
  });

  test('watchdog fire → state restored + every window re-armed + relaunch-failed broadcast', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', extraWindowCount: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.clock.lastMs).toBe(UPDATE_CHECK_INTERVAL_MS);
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.state.versionPendingInstall).toBeNull();
    rig.clock.lastCallback?.();
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
    for (const win of rig.windows) {
      expect(win.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(1);
      const failed = win.filter((c) => c.channel === 'ok:update:relaunch-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toEqual({
        version: '0.3.2',
        message: 'the update timed out',
      });
    }
    expect(rig.dispatches.filter((d) => d === 'relaunch-watchdog-fired')).toHaveLength(1);
  });

  test('updater error while in flight → fast fail with the error detail, watchdog cleared', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', extraWindowCount: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.clock.lastMs).toBe(UPDATE_CHECK_INTERVAL_MS);
    await rig.ipc.invoke('ok:update:relaunch-now');
    rig.updater.emit('error', new Error('ShipIt swap failed'));
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
    for (const win of rig.windows) {
      const failed = win.filter((c) => c.channel === 'ok:update:relaunch-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toEqual({ version: '0.3.2', message: 'ShipIt swap failed' });
    }
    expect(rig.dispatches.filter((d) => d === 'relaunch-error-event')).toHaveLength(1);
    expect(rig.dispatches.filter((d) => d === 'error-unclassified')).toHaveLength(1);
    expect(rig.clock.lastCallback).toBeNull();
    expect(rig.dispatches).not.toContain('relaunch-watchdog-fired' as DispatchKind);
  });

  test('error dispatched SYNCHRONOUSLY inside quitAndInstall (Linux pkexec cancel) fast-fails with the real cause, not the watchdog timeout', async () => {
    const { rig } = makeRig({
      platform: 'linux',
      versionPendingInstall: '0.3.2',
      extraWindowCount: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.clock.lastMs).toBe(UPDATE_CHECK_INTERVAL_MS);
    rig.updater.quitAndInstall = vi.fn(() => {
      rig.updater.emit('error', new Error('pkexec: authorization could not be obtained'));
    });
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
    for (const win of rig.windows) {
      const failed = win.filter((c) => c.channel === 'ok:update:relaunch-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toEqual({
        version: '0.3.2',
        message: 'pkexec: authorization could not be obtained',
      });
    }
    expect(rig.dispatches.filter((d) => d === 'relaunch-error-event')).toHaveLength(1);
    expect(rig.clock.lastCallback).toBeNull();
    expect(rig.dispatches).not.toContain('relaunch-watchdog-fired' as DispatchKind);
  });

  test('CLASSIFIED error while in flight → additive error-classified + relaunch-error-event', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    await Promise.resolve();
    await Promise.resolve();
    await rig.ipc.invoke('ok:update:relaunch-now');
    rig.updater.emit('error', Object.assign(new Error('HTTP 500'), { code: 'HTTP_ERROR_500' }));
    expect(rig.dispatches).toContain('error-classified' as DispatchKind);
    expect(rig.dispatches.filter((d) => d === 'relaunch-error-event')).toHaveLength(1);
    expect(rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(1);
  });

  test('in-flight error with EMPTY message → fallback detail on the failure notice', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    await Promise.resolve();
    await Promise.resolve();
    await rig.ipc.invoke('ok:update:relaunch-now');
    rig.updater.emit('error', new Error(''));
    const failed = rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toEqual({
      version: '0.3.2',
      message: 'update error during relaunch',
    });
  });

  test('updater error AFTER the watchdog already fired → no second relaunch-failed broadcast', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', extraWindowCount: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.clock.lastMs).toBe(UPDATE_CHECK_INTERVAL_MS);
    await rig.ipc.invoke('ok:update:relaunch-now');
    rig.clock.lastCallback?.();
    rig.updater.emit('error', new Error('ShipIt swap failed (late)'));
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
    for (const win of rig.windows) {
      const failed = win.filter((c) => c.channel === 'ok:update:relaunch-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toEqual({
        version: '0.3.2',
        message: 'the update timed out',
      });
      expect(win.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(1);
    }
    expect(rig.dispatches.filter((d) => d === 'relaunch-watchdog-fired')).toHaveLength(1);
    expect(rig.dispatches).not.toContain('relaunch-error-event' as DispatchKind);
  });

  test('restore-persist failure inside failRelaunch → relaunch-failed still broadcasts, re-arm skipped', async () => {
    const captured: CapturedSend[] = [];
    const win = makeFakeWindow(captured);
    const clock = makeFakeClock();
    let state: AppState = { ...emptyState(), versionPendingInstall: '0.3.2' };
    let failWrites = false;
    const ipc = makeFakeIpc();
    startAutoUpdater({
      updater: new FakeUpdater(),
      ipcMain: ipc,
      readState: () => state,
      writeState: (next) => {
        if (failWrites) throw new Error('disk full');
        state = next;
      },
      getPrimaryWindow: () => win,
      getAllWindows: () => [win],
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      clock,
      now: () => new Date(),
      logger: {
        info: vi.fn(() => {}),
        warn: vi.fn(() => {}),
        error: vi.fn(() => {}),
        debug: vi.fn(() => {}),
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    await ipc.invoke('ok:update:relaunch-now');
    failWrites = true;
    clock.lastCallback?.();
    expect(state.versionPendingInstall).toBeNull();
    expect(captured.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(0);
    const failed = captured.filter((c) => c.channel === 'ok:update:relaunch-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toEqual({
      version: '0.3.2',
      message: 'the update timed out',
      dismissPending: true,
    });
  });

  test('updater error with NO relaunch in flight → no relaunch-failed broadcast (normal error path)', () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    rig.updater.emit('error', new Error('routine check failure'));
    expect(rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(0);
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
  });

  test('watchdog NOT armed when isPackaged=false (dev quitAndInstall no-op is not a failure)', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', isPackaged: false });
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.clock.lastCallback).toBeNull();
    rig.updater.emit('error', new Error('dev error'));
    expect(rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(0);
  });

  test('destroy() clears the armed watchdog', async () => {
    const { rig, handle } = makeRig({ versionPendingInstall: '0.3.2' });
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.clock.lastMs).toBe(UPDATE_CHECK_INTERVAL_MS);
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.clock.lastCallback).not.toBeNull();
    handle.destroy();
    expect(rig.clock.lastCallback).toBeNull();
  });
});

describe('ok:update:check-now IPC handler', () => {
  test('registers the handler on startup', () => {
    const { rig } = makeRig();
    expect(rig.ipc.handlers.has('ok:update:check-now')).toBe(true);
  });

  test('handler invocation calls updater.checkForUpdates', () => {
    const { rig } = makeRig();
    rig.updater.checkForUpdates.mockClear();
    rig.ipc.invoke('ok:update:check-now');
    expect(rig.updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test('a second invocation while pending re-acknowledges without starting another check', () => {
    const { rig } = makeRig();
    rig.updater.checkForUpdates = vi.fn(() => new Promise(() => {}));
    rig.updater.checkForUpdates.mockClear();

    rig.ipc.invoke('ok:update:check-now');
    rig.ipc.invoke('ok:update:check-now');

    expect(rig.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(manualCheckPhases(rig)).toEqual(['started', 'started']);
    expect(rig.dispatches.filter((kind) => kind === 'check-now-already-pending')).toEqual([
      'check-now-already-pending',
    ]);
    expect(rig.logger.info).toHaveBeenCalledWith('check-now already pending, re-acknowledged');
  });

  test('handler invocation does NOT gate on versionPendingInstall', () => {
    const { rig } = makeRig({ versionPendingInstall: null });
    rig.updater.checkForUpdates.mockClear();
    rig.ipc.invoke('ok:update:check-now');
    expect(rig.updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test('checkForUpdatesNow handle method calls updater.checkForUpdates', () => {
    const { rig, handle } = makeRig();
    rig.updater.checkForUpdates.mockClear();
    void handle.checkForUpdatesNow();
    expect(rig.updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test('rejection from updater.checkForUpdates is swallowed in IPC path', () => {
    const { rig } = makeRig();
    rig.updater.checkForUpdates = vi.fn(() => Promise.reject(new Error('network down')));
    expect(() => rig.ipc.invoke('ok:update:check-now')).not.toThrow();
  });

  test('destroy() removes the check-now IPC handler', () => {
    const { rig, handle } = makeRig();
    handle.destroy();
    expect(rig.ipc.handlers.has('ok:update:check-now')).toBe(false);
  });
});

describe('check-now → showCheckNowResult feedback dispatch', () => {
  test.each([
    'update-available',
    'update-not-available',
    'error',
    'resolve',
    'reject',
  ] as const)('%s clears the manual watchdog and prevents a later timeout dialog', async (outcome) => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({ showCheckNowResult, isPackaged: false });
    rig.updater.checkForUpdates = vi.fn(() =>
      outcome === 'reject'
        ? Promise.reject(new Error('network unavailable'))
        : Promise.resolve(null),
    );
    rig.ipc.invoke('ok:update:check-now');
    const watchdog = rig.clock.lastCallback;
    const watchdogHandle = rig.clock.lastHandle;
    expect(rig.clock.lastMs).toBe(MANUAL_CHECK_WATCHDOG_MS);
    expect(watchdog).not.toBeNull();

    if (outcome === 'error') rig.updater.emit('error', new Error('network unavailable'));
    else if (outcome !== 'resolve' && outcome !== 'reject') {
      rig.updater.emit(outcome, { version: '0.3.2' });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.clock.clearTimeout).toHaveBeenCalledWith(watchdogHandle);
    expect(manualCheckPhases(rig)).toEqual(['started', 'settled']);
    expect(showCheckNowResult).toHaveBeenCalledTimes(outcome === 'resolve' ? 0 : 1);
    showCheckNowResult.mockClear();
    watchdog?.();
    expect(showCheckNowResult).not.toHaveBeenCalled();
    expect(manualCheckPhases(rig)).toEqual(['started', 'settled']);
  });

  test('destroy clears a pending manual watchdog without showing a dialog', () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig, handle } = makeRig({ showCheckNowResult, isPackaged: false });
    rig.updater.checkForUpdates = vi.fn(() => new Promise(() => {}));
    rig.ipc.invoke('ok:update:check-now');
    const watchdog = rig.clock.lastCallback;
    const watchdogHandle = rig.clock.lastHandle;
    handle.destroy();
    expect(rig.clock.clearTimeout).toHaveBeenCalledWith(watchdogHandle);
    expect(manualCheckPhases(rig)).toEqual(['started', 'settled']);
    watchdog?.();
    expect(showCheckNowResult).not.toHaveBeenCalled();
  });

  test('a throwing result dialog does not escape the verdict event or prevent settlement', () => {
    const dialogError = new Error('native dialog unavailable');
    const { rig } = makeRig({
      isPackaged: false,
      showCheckNowResult: () => {
        throw dialogError;
      },
    });
    rig.ipc.invoke('ok:update:check-now');
    const watchdogHandle = rig.clock.lastHandle;

    expect(() => rig.updater.emit('update-not-available', { version: '0.3.1' })).not.toThrow();
    expect(manualCheckPhases(rig)).toEqual(['started', 'settled']);
    expect(rig.clock.clearTimeout).toHaveBeenCalledWith(watchdogHandle);
    expect(rig.logger.error).toHaveBeenCalledWith(
      'showCheckNowResult threw, check-now result dialog not shown',
      { err: dialogError, result: { kind: 'not-available', currentVersion: '0.3.1' } },
    );
  });

  test('the manual watchdog settles a hung check with an error and does not re-arm on re-click', () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({ showCheckNowResult, isPackaged: false });
    rig.updater.checkForUpdates = vi.fn(() => new Promise(() => {}));

    rig.ipc.invoke('ok:update:check-now');
    expect(rig.clock.lastMs).toBe(MANUAL_CHECK_WATCHDOG_MS);
    const watchdog = rig.clock.lastCallback;
    const watchdogHandle = rig.clock.lastHandle;
    expect(watchdog).not.toBeNull();
    rig.ipc.invoke('ok:update:check-now');
    expect(rig.clock.setTimeout).toHaveBeenCalledTimes(1);
    expect(showCheckNowResult).not.toHaveBeenCalled();

    watchdog?.();
    expect(manualCheckPhases(rig)).toEqual(['started', 'started', 'settled']);
    expect(rig.clock.clearTimeout).toHaveBeenCalledWith(watchdogHandle);
    expect(showCheckNowResult).toHaveBeenCalledExactlyOnceWith({
      kind: 'error',
      message: MANUAL_CHECK_TIMED_OUT_MESSAGE,
    });
    expect(rig.logger.warn).toHaveBeenCalledWith(
      'check-now did not settle within the watchdog window',
      { ms: MANUAL_CHECK_WATCHDOG_MS },
    );
    expect(rig.dispatches).toContain('check-now-watchdog-fired');
    rig.ipc.invoke('ok:update:check-now');
    expect(rig.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(manualCheckPhases(rig)).toEqual(['started', 'started', 'settled', 'started']);
  });

  test('a verdict-less check settles silently and allows another manual check', async () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({ showCheckNowResult });
    rig.updater.checkForUpdates = vi.fn(() => Promise.resolve(null));

    rig.ipc.invoke('ok:update:check-now');
    expect(manualCheckPhases(rig)).toEqual(['started']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manualCheckPhases(rig)).toEqual(['started', 'settled']);
    expect(showCheckNowResult).not.toHaveBeenCalled();

    rig.ipc.invoke('ok:update:check-now');
    expect(rig.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(manualCheckPhases(rig)).toEqual(['started', 'settled', 'started']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manualCheckPhases(rig)).toEqual(['started', 'settled', 'started', 'settled']);
    expect(showCheckNowResult).not.toHaveBeenCalled();
    expect(rig.logger.info).toHaveBeenCalledWith('check-now resolved without a verdict');
  });

  test('update-not-available after menu-check fires not-available result', async () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({ appVersion: '0.4.0-beta.13', showCheckNowResult });
    let phasesAtDialog: Array<'started' | 'settled'> = [];
    showCheckNowResult.mockImplementation(() => {
      phasesAtDialog = manualCheckPhases(rig);
    });
    rig.ipc.invoke('ok:update:check-now');
    expect(manualCheckPhases(rig)).toEqual(['started']);
    rig.updater.emit('update-not-available', { version: '0.4.0-beta.13' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(phasesAtDialog).toEqual(['started', 'settled']);
    expect(showCheckNowResult).toHaveBeenCalledTimes(1);
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'not-available',
      currentVersion: '0.4.0-beta.13',
    });
    expect(manualCheckPhases(rig)).toEqual(['started', 'settled']);
  });

  test('update-available after menu-check fires available result with versions', async () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({
      appVersion: '0.4.0-beta.13',
      showCheckNowResult,
    });
    let phasesAtDialog: Array<'started' | 'settled'> = [];
    showCheckNowResult.mockImplementation(() => {
      phasesAtDialog = manualCheckPhases(rig);
    });
    rig.ipc.invoke('ok:update:check-now');
    expect(manualCheckPhases(rig)).toEqual(['started']);
    rig.updater.emit('update-available', { version: '0.4.0-beta.14' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(phasesAtDialog).toEqual(['started', 'settled']);
    expect(showCheckNowResult).toHaveBeenCalledTimes(1);
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'available',
      currentVersion: '0.4.0-beta.13',
      latestVersion: '0.4.0-beta.14',
    });
    expect(manualCheckPhases(rig)).toEqual(['started', 'settled']);
  });

  test('error after menu-check fires error result with the message', async () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({ showCheckNowResult });
    let phasesAtDialog: Array<'started' | 'settled'> = [];
    showCheckNowResult.mockImplementation(() => {
      phasesAtDialog = manualCheckPhases(rig);
    });
    rig.ipc.invoke('ok:update:check-now');
    expect(manualCheckPhases(rig)).toEqual(['started']);
    rig.updater.emit('error', new Error('network timeout'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(phasesAtDialog).toEqual(['started', 'settled']);
    expect(showCheckNowResult).toHaveBeenCalledTimes(1);
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'error',
      message: 'network timeout',
    });
    expect(manualCheckPhases(rig)).toEqual(['started', 'settled']);
  });

  test('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND routes to not-available (cascade-fallback path)', () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({ appVersion: '0.5.0-beta.21', showCheckNowResult });
    rig.ipc.invoke('ok:update:check-now');
    const err = Object.assign(
      new Error(
        'Cannot find latest-mac.yml in the latest release artifacts (https://github.com/inkeep/open-knowledge/releases/download/v0.5.0-beta.22/latest-mac.yml): HttpError: 404',
      ),
      { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' },
    );
    rig.updater.emit('error', err);
    expect(showCheckNowResult).toHaveBeenCalledTimes(1);
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'not-available',
      currentVersion: '0.5.0-beta.21',
    });
  });

  test('other classified updater errors still surface kind=error (channel-file-not-found is the only narrow case)', () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({ showCheckNowResult });
    rig.ipc.invoke('ok:update:check-now');
    const err = Object.assign(new Error('zip missing'), {
      code: 'ERR_UPDATER_ZIP_FILE_NOT_FOUND',
    });
    rig.updater.emit('error', err);
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'error',
      message: 'zip missing',
    });
  });

  test('periodic check (NO menu-check) does NOT fire showCheckNowResult', () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({ showCheckNowResult });
    rig.updater.emit('update-not-available', { version: '0.4.0-beta.13' });
    expect(showCheckNowResult).not.toHaveBeenCalled();
    expect(manualCheckPhases(rig)).toEqual([]);
  });

  test('subsequent events after dispatch do NOT re-fire (single-shot per check-now)', () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({ showCheckNowResult });
    rig.ipc.invoke('ok:update:check-now');
    rig.updater.emit('update-not-available', { version: '0.4.0-beta.13' });
    rig.updater.emit('update-not-available', { version: '0.4.0-beta.13' });
    rig.updater.emit('error', new Error('next-cycle network error'));
    expect(showCheckNowResult).toHaveBeenCalledTimes(1);
  });

  test('checkForUpdates synchronous reject fires error result', async () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({ showCheckNowResult });
    rig.updater.checkForUpdates = vi.fn(() => Promise.reject(new Error('feed not reachable')));
    let phasesAtDialog: Array<'started' | 'settled'> = [];
    showCheckNowResult.mockImplementation(() => {
      phasesAtDialog = manualCheckPhases(rig);
    });
    rig.ipc.invoke('ok:update:check-now');
    expect(manualCheckPhases(rig)).toEqual(['started']);
    await new Promise((r) => setTimeout(r, 0));
    expect(phasesAtDialog).toEqual(['started', 'settled']);
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'error',
      message: 'feed not reachable',
    });
    expect(manualCheckPhases(rig)).toEqual(['started', 'settled']);
  });

  test('checkForUpdates synchronous reject with ERR_UPDATER_CHANNEL_FILE_NOT_FOUND routes to not-available', async () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({ appVersion: '0.5.0-beta.21', showCheckNowResult });
    const err = Object.assign(new Error('Cannot find latest-mac.yml ...: HttpError: 404'), {
      code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    });
    rig.updater.checkForUpdates = vi.fn(() => Promise.reject(err));
    rig.ipc.invoke('ok:update:check-now');
    await new Promise((r) => setTimeout(r, 0));
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'not-available',
      currentVersion: '0.5.0-beta.21',
    });
  });
});

describe('buildCheckNowResultFromError', () => {
  test('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND maps to not-available with currentVersion', () => {
    const err = Object.assign(new Error('Cannot find …'), {
      code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    });
    const result = buildCheckNowResultFromError(err, '0.5.0-beta.21');
    expect(result).toEqual({ kind: 'not-available', currentVersion: '0.5.0-beta.21' });
  });

  test('other classified codes map to error with the error.message', () => {
    const err = Object.assign(new Error('zip missing'), {
      code: 'ERR_UPDATER_ZIP_FILE_NOT_FOUND',
    });
    const result = buildCheckNowResultFromError(err, '0.5.0-beta.21');
    expect(result).toEqual({ kind: 'error', message: 'zip missing' });
  });

  test('non-classified errors map to error with the error.message', () => {
    const result = buildCheckNowResultFromError(new Error('network timeout'), '0.5.0-beta.21');
    expect(result).toEqual({ kind: 'error', message: 'network timeout' });
  });

  test('empty error.message falls back to "Update check failed"', () => {
    const result = buildCheckNowResultFromError(new Error(''), '0.5.0-beta.21');
    expect(result).toEqual({ kind: 'error', message: 'Update check failed' });
  });

  test('non-Error rejection (string) maps to error with the string', () => {
    const result = buildCheckNowResultFromError('something blew up', '0.5.0-beta.21');
    expect(result).toEqual({ kind: 'error', message: 'something blew up' });
  });

  test('non-Error rejection (empty string) falls back to "Update check failed"', () => {
    const result = buildCheckNowResultFromError('', '0.5.0-beta.21');
    expect(result).toEqual({ kind: 'error', message: 'Update check failed' });
  });

  test('non-Error rejection (other) falls back to the generic message', () => {
    const result = buildCheckNowResultFromError({ weird: true }, '0.5.0-beta.21');
    expect(result).toEqual({ kind: 'error', message: 'Update check failed' });
  });
});

describe('handle.checkForUpdatesNow() routes the menu through runMenuDrivenCheck', () => {
  test('a menu click arms menuCheckPending so the result reaches showCheckNowResult', () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig, handle } = makeRig({ appVersion: '0.4.0-beta.27', showCheckNowResult });
    void handle.checkForUpdatesNow();
    rig.updater.emit('update-not-available', { version: '0.4.0-beta.27' });
    expect(showCheckNowResult).toHaveBeenCalledTimes(1);
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'not-available',
      currentVersion: '0.4.0-beta.27',
    });
  });
});

describe('dev-mode guard (isPackaged=false)', () => {
  test('skips first-launch checkForUpdates when isPackaged=false and forceDevBypass=false', async () => {
    const { rig } = makeRig({ isPackaged: false });
    await Promise.resolve();
    expect(rig.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(rig.dispatches).toContain('skipped-dev-mode' as DispatchKind);
  });

  test('forceDevBypass=true allows the check to run even when isPackaged=false', async () => {
    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const captured: CapturedSend[] = [];
    let state: AppState = emptyState();
    const primaryWindow = makeFakeWindow(captured);
    startAutoUpdater({
      updater,
      ipcMain: ipc,
      readState: () => state,
      writeState: (next) => {
        state = next;
      },
      getPrimaryWindow: () => primaryWindow,
      getAppVersion: () => '0.3.1',
      isPackaged: false,
      forceDevBypass: true,
      clock,
      now: () => new Date(),
      logger: {
        info: vi.fn(() => {}),
        warn: vi.fn(() => {}),
        error: vi.fn(() => {}),
        debug: vi.fn(() => {}),
      },
    });
    await Promise.resolve();
    expect(updater.checkForUpdates).toHaveBeenCalled();
  });

  test('event handlers stay wired in dev-mode so unit tests can drive them', () => {
    const { rig } = makeRig({ isPackaged: false });
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    const toastA = rig.captured.filter((c) => c.channel === 'ok:update:downloaded');
    expect(toastA).toHaveLength(1);
  });

  test('boot-time failed-install notice suppressed when isPackaged=false', () => {
    const { rig } = makeRig({
      isPackaged: false,
      attemptedInstall: '0.5.0',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      appVersion: '0.4.0',
    });
    expect(rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(0);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
  });

  test('boot-time whats-new toast suppressed when isPackaged=false (lastSeenVersion still advances)', () => {
    const { rig } = makeRig({
      isPackaged: false,
      lastSeenVersion: '0.3.0',
      appVersion: '0.3.1',
    });
    expect(rig.captured.filter((c) => c.channel === 'ok:update:whats-new')).toHaveLength(0);
    expect(rig.dispatches).not.toContain('whats-new-toast-b' as DispatchKind);
    expect(rig.state.lastSeenVersion).toBe('0.3.1');
  });

  test('forceDevBypass=true re-enables the boot-time failed-install notice', () => {
    const { rig } = makeRig({
      isPackaged: false,
      forceDevBypass: true,
      attemptedInstall: '0.5.0',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      appVersion: '0.4.0',
    });
    const failed = rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed');
    expect(failed).toHaveLength(1);
    expect(rig.dispatches).toContain('install-failed-on-boot' as DispatchKind);
  });

  test('forceDevBypass=true re-enables the boot-time whats-new toast', () => {
    const { rig } = makeRig({
      isPackaged: false,
      forceDevBypass: true,
      lastSeenVersion: '0.3.0',
      appVersion: '0.3.1',
    });
    expect(rig.captured.filter((c) => c.channel === 'ok:update:whats-new')).toHaveLength(1);
    expect(rig.dispatches).toContain('whats-new-toast-b' as DispatchKind);
  });
});

describe('download-progress (log-only, no UI surface)', () => {
  test('emits debug log without IPC dispatch or state write', () => {
    const { rig } = makeRig();
    const prevState = { ...rig.state };
    rig.updater.emit('download-progress', { percent: 50, bytesPerSecond: 1_000_000 });
    expect(rig.captured).toHaveLength(0);
    expect(rig.state).toEqual(prevState);
    expect(rig.logger.debug).toHaveBeenCalled();
  });
});

describe('destroy() teardown', () => {
  test('detaches all 6 event listeners', () => {
    const { rig, handle } = makeRig();
    handle.destroy();
    expect(rig.updater.listenerCount('checking-for-update')).toBe(0);
    expect(rig.updater.listenerCount('update-available')).toBe(0);
    expect(rig.updater.listenerCount('update-not-available')).toBe(0);
    expect(rig.updater.listenerCount('download-progress')).toBe(0);
    expect(rig.updater.listenerCount('update-downloaded')).toBe(0);
    expect(rig.updater.listenerCount('error')).toBe(0);
  });

  test('after destroy(), emitting an event does NOT fire handler side-effects', () => {
    const { rig, handle } = makeRig();
    handle.destroy();
    rig.updater.emit('update-downloaded', { version: '0.3.3' });
    const toastA = rig.captured.filter((c) => c.channel === 'ok:update:downloaded');
    expect(toastA).toHaveLength(0);
  });
});

describe('single-window dispatch (Finding #1 guard)', () => {
  test('update-downloaded sends to exactly one target even when primary changes between dispatches', () => {
    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const capturedA: CapturedSend[] = [];
    const capturedB: CapturedSend[] = [];
    const windowA = makeFakeWindow(capturedA);
    const windowB = makeFakeWindow(capturedB);
    let primary: SendTarget = windowA;
    let state: AppState = emptyState();
    startAutoUpdater({
      updater,
      ipcMain: ipc,
      readState: () => state,
      writeState: (next) => {
        state = next;
      },
      getPrimaryWindow: () => primary,
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      clock,
      now: () => new Date(),
    });

    updater.emit('update-downloaded', { version: '0.3.3' });
    expect(capturedA.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(1);
    expect(capturedB.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(0);

    primary = windowB;
    updater.emit('update-downloaded', { version: '0.3.4' });
    expect(capturedA.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(1);
    expect(capturedB.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(1);
  });

  test('getPrimaryWindow returning null → broadcast no-ops (no crash)', () => {
    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    let state: AppState = emptyState();
    expect(() => {
      startAutoUpdater({
        updater,
        ipcMain: ipc,
        readState: () => state,
        writeState: (next) => {
          state = next;
        },
        getPrimaryWindow: () => null,
        getAppVersion: () => '0.3.1',
        isPackaged: true,
        clock,
        now: () => new Date(),
      });
      updater.emit('update-downloaded', { version: '0.3.3' });
    }).not.toThrow();
    expect(state.versionPendingInstall).toBe('0.3.3');
  });
});

describe('markCheckSucceeded routes through persistSafely (Critical #1)', () => {
  test('update-available: writeState throws → caught, no rethrow', () => {
    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const captured: CapturedSend[] = [];
    const primaryWindow = makeFakeWindow(captured);
    const state: AppState = emptyState();
    const logger = {
      info: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      debug: vi.fn(() => {}),
    };
    startAutoUpdater({
      updater,
      ipcMain: ipc,
      readState: () => state,
      writeState: () => {
        throw new Error('EACCES');
      },
      getPrimaryWindow: () => primaryWindow,
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      clock,
      now: () => new Date(),
      logger,
    });
    expect(() => updater.emit('update-available', { version: '0.3.2' })).not.toThrow();
    expect(logger.error).toHaveBeenCalled();
    expect(state.lastSuccessfulCheckAt).toBeNull();
  });

  test('update-not-available: writeState throws → caught, no rethrow', () => {
    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const captured: CapturedSend[] = [];
    const primaryWindow = makeFakeWindow(captured);
    const state: AppState = emptyState();
    startAutoUpdater({
      updater,
      ipcMain: ipc,
      readState: () => state,
      writeState: () => {
        throw new Error('disk full');
      },
      getPrimaryWindow: () => primaryWindow,
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      clock,
      now: () => new Date(),
      logger: {
        info: vi.fn(() => {}),
        warn: vi.fn(() => {}),
        error: vi.fn(() => {}),
        debug: vi.fn(() => {}),
      },
    });
    expect(() => updater.emit('update-not-available', { version: '0.3.1' })).not.toThrow();
    expect(state.lastSuccessfulCheckAt).toBeNull();
  });
});

describe('Toast B persist-before-emit + whenRendererReady (Major #1)', () => {
  test('persist failure on lastSeenVersion advance → no Toast B broadcast', () => {
    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const captured: CapturedSend[] = [];
    const primaryWindow = makeFakeWindow(captured);
    const state: AppState = { ...emptyState(), lastSeenVersion: '0.3.0' };
    startAutoUpdater({
      updater,
      ipcMain: ipc,
      readState: () => state,
      writeState: () => {
        throw new Error('EACCES');
      },
      getPrimaryWindow: () => primaryWindow,
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      clock,
      now: () => new Date(),
      logger: {
        info: vi.fn(() => {}),
        warn: vi.fn(() => {}),
        error: vi.fn(() => {}),
        debug: vi.fn(() => {}),
      },
    });
    const whatsNew = captured.filter((c) => c.channel === 'ok:update:whats-new');
    expect(whatsNew).toHaveLength(0);
    expect(state.lastSeenVersion).toBe('0.3.0');
  });

  test('whenRendererReady defers Toast B until scheduler fires', () => {
    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const captured: CapturedSend[] = [];
    const primaryWindow = makeFakeWindow(captured);
    let state: AppState = { ...emptyState(), lastSeenVersion: '0.3.0' };
    let deferredFn: (() => void) | null = null;
    startAutoUpdater({
      updater,
      ipcMain: ipc,
      readState: () => state,
      writeState: (next) => {
        state = next;
      },
      getPrimaryWindow: () => primaryWindow,
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      whenRendererReady: (fn) => {
        deferredFn = fn;
      },
      clock,
      now: () => new Date(),
    });
    expect(state.lastSeenVersion).toBe('0.3.1');
    const beforeFire = captured.filter((c) => c.channel === 'ok:update:whats-new');
    expect(beforeFire).toHaveLength(0);
    expect(deferredFn).not.toBeNull();
    deferredFn?.();
    const afterFire = captured.filter((c) => c.channel === 'ok:update:whats-new');
    expect(afterFire).toHaveLength(1);
  });

  test('no whenRendererReady → immediate fire (pre-fix behavior for tests)', () => {
    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const captured: CapturedSend[] = [];
    const primaryWindow = makeFakeWindow(captured);
    let state: AppState = { ...emptyState(), lastSeenVersion: '0.3.0' };
    startAutoUpdater({
      updater,
      ipcMain: ipc,
      readState: () => state,
      writeState: (next) => {
        state = next;
      },
      getPrimaryWindow: () => primaryWindow,
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      clock,
      now: () => new Date(),
    });
    const whatsNew = captured.filter((c) => c.channel === 'ok:update:whats-new');
    expect(whatsNew).toHaveLength(1);
  });
});

describe('relaunch-now idempotency (Major #2)', () => {
  test('second invocation sees the committed install → no second quitAndInstall', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    const first = rig.ipc.invoke('ok:update:relaunch-now');
    const second = rig.ipc.invoke('ok:update:relaunch-now');
    await Promise.all([first, second]);
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(rig.dispatches).toContain('relaunch-double-invoke-blocked' as DispatchKind);
    expect(rig.state.versionPendingInstall).toBeNull();
  });

  test('persistSafely failure → no quitAndInstall call (better to retry)', async () => {
    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const captured: CapturedSend[] = [];
    const primaryWindow = makeFakeWindow(captured);
    const state: AppState = { ...emptyState(), versionPendingInstall: '0.3.2' };
    startAutoUpdater({
      updater,
      ipcMain: ipc,
      readState: () => state,
      writeState: () => {
        throw new Error('EACCES');
      },
      getPrimaryWindow: () => primaryWindow,
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      clock,
      now: () => new Date(),
      logger: {
        info: vi.fn(() => {}),
        warn: vi.fn(() => {}),
        error: vi.fn(() => {}),
        debug: vi.fn(() => {}),
      },
    });
    await expect(Promise.resolve(ipc.invoke('ok:update:relaunch-now'))).rejects.toThrow();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(state.versionPendingInstall).toBe('0.3.2');
  });
});

describe('bootAutoUpdater catch-path (Major #5)', () => {
  test('dynamic-import failure → returns null + logs error, no throw', async () => {
    const logger = {
      info: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      debug: vi.fn(() => {}),
    };
    const captured: CapturedSend[] = [];
    const primaryWindow = makeFakeWindow(captured);
    const state: AppState = emptyState();
    const handle = await bootAutoUpdater(
      () => Promise.reject(new Error('Cannot find module electron-updater')),
      {
        ipcMain: makeFakeIpc(),
        readState: () => state,
        writeState: () => {},
        getPrimaryWindow: () => primaryWindow,
        getAppVersion: () => '0.3.1',
        isPackaged: true,
        clock: makeFakeClock(),
        now: () => new Date(),
        logger,
      },
    );
    expect(handle).toBeNull();
    expect(logger.error).toHaveBeenCalled();
    const errorCall = logger.error.mock.calls[0];
    expect((errorCall?.[1] as { err?: Error })?.err?.message).toContain('Cannot find module');
  });

  test('successful import → returns a real handle with destroy', async () => {
    const fakeUpdater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const captured: CapturedSend[] = [];
    const primaryWindow = makeFakeWindow(captured);
    let state: AppState = emptyState();
    const handle = await bootAutoUpdater(() => Promise.resolve({ autoUpdater: fakeUpdater }), {
      ipcMain: ipc,
      readState: () => state,
      writeState: (next) => {
        state = next;
      },
      getPrimaryWindow: () => primaryWindow,
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      clock,
      now: () => new Date(),
    });
    expect(handle).not.toBeNull();
    expect(typeof handle?.destroy).toBe('function');
    handle?.destroy();
    expect(clock.clearTimeout).toHaveBeenCalled();
  });

  test('startAutoUpdater synchronous throw during wire-up is caught', async () => {
    const logger = {
      info: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      debug: vi.fn(() => {}),
    };
    const hostileUpdater = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      channel: null,
      allowPrerelease: false,
      allowDowngrade: false,
      on: () => {
        throw new Error('API drift — event contract changed');
      },
      off: () => hostileUpdater as unknown as UpdaterLike,
      checkForUpdates: () => Promise.resolve(undefined),
      quitAndInstall: () => {},
    } as unknown as UpdaterLike;
    const handle = await bootAutoUpdater(() => Promise.resolve({ autoUpdater: hostileUpdater }), {
      ipcMain: makeFakeIpc(),
      readState: () => emptyState(),
      writeState: () => {},
      getPrimaryWindow: () => null,
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      clock: makeFakeClock(),
      now: () => new Date(),
      logger,
    });
    expect(handle).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });

  test('resolveAutoUpdater handles .default.autoUpdater shape (real CJS-from-ESM)', async () => {
    const fakeUpdater = new FakeUpdater();
    const handle = await bootAutoUpdater(
      () => Promise.resolve({ default: { autoUpdater: fakeUpdater } }),
      {
        ipcMain: makeFakeIpc(),
        readState: () => emptyState(),
        writeState: () => {},
        getPrimaryWindow: () => null,
        getAppVersion: () => '0.3.1',
        isPackaged: true,
        platform: 'darwin',
        clock: makeFakeClock(),
        now: () => new Date(),
      },
    );
    expect(handle).not.toBeNull();
    expect(fakeUpdater.autoDownload).toBe(false);
    expect(fakeUpdater.autoInstallOnAppQuit).toBe(true);
    expect(fakeUpdater.channel).toBe('latest');
    handle?.destroy();
  });

  test('resolveAutoUpdater still accepts the flat { autoUpdater } shape (test-mock compat)', async () => {
    const fakeUpdater = new FakeUpdater();
    const handle = await bootAutoUpdater(() => Promise.resolve({ autoUpdater: fakeUpdater }), {
      ipcMain: makeFakeIpc(),
      readState: () => emptyState(),
      writeState: () => {},
      getPrimaryWindow: () => null,
      getAppVersion: () => '0.3.1',
      isPackaged: true,
      clock: makeFakeClock(),
      now: () => new Date(),
    });
    expect(handle).not.toBeNull();
    expect(fakeUpdater.autoDownload).toBe(false);
    handle?.destroy();
  });

  test('module exposes neither top-level nor .default.autoUpdater → logs + returns null', async () => {
    const logger = {
      info: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      debug: vi.fn(() => {}),
    };
    const handle = await bootAutoUpdater(
      () => Promise.resolve({ default: {} }) as unknown as Promise<{ autoUpdater: UpdaterLike }>,
      {
        ipcMain: makeFakeIpc(),
        readState: () => emptyState(),
        writeState: () => {},
        getPrimaryWindow: () => null,
        getAppVersion: () => '0.3.1',
        isPackaged: true,
        clock: makeFakeClock(),
        now: () => new Date(),
        logger,
      },
    );
    expect(handle).toBeNull();
    expect(logger.error).toHaveBeenCalled();
    const errorCall = logger.error.mock.calls[0];
    expect((errorCall?.[1] as { err?: Error })?.err?.message).toContain(
      'electron-updater did not expose',
    );
  });
});

describe('staged-cache reclaim — fires only once every install commitment is settled', () => {
  test('clean boot (nothing pending, nothing attempted) invokes the reclaim hook once', () => {
    const reclaim = vi.fn(() => Promise.resolve());
    const { rig } = makeRig({ reclaimStagedUpdateCache: reclaim });
    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(rig.dispatches.filter((d) => d === 'staged-cache-reclaimed')).toHaveLength(1);
  });

  test('boot after a committed install reclaims once reconciliation clears both gates', () => {
    const reclaim = vi.fn(() => Promise.resolve());
    const { rig } = makeRig({
      appVersion: '0.3.2',
      versionPendingInstall: '0.3.2',
      attemptedInstall: '0.3.2',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      reclaimStagedUpdateCache: reclaim,
    });
    expect(rig.state.versionPendingInstall).toBeNull();
    expect(rig.state.attemptedInstall).toBeNull();
    expect(reclaim).toHaveBeenCalledTimes(1);
  });

  test('a still-staged update (versionPendingInstall armed) blocks the reclaim', () => {
    const reclaim = vi.fn(() => Promise.resolve());
    const { rig } = makeRig({
      versionPendingInstall: '0.9.9',
      reclaimStagedUpdateCache: reclaim,
    });
    expect(rig.state.versionPendingInstall).toBe('0.9.9');
    expect(reclaim).not.toHaveBeenCalled();
    expect(rig.dispatches).not.toContain('staged-cache-reclaimed' as DispatchKind);
  });

  test('a failed install being surfaced (attemptedInstall armed) blocks the reclaim', () => {
    const reclaim = vi.fn(() => Promise.resolve());
    const { rig } = makeRig({
      attemptedInstall: '0.9.9',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      reclaimStagedUpdateCache: reclaim,
    });
    expect(rig.dispatches).toContain('install-failed-on-boot' as DispatchKind);
    expect(reclaim).not.toHaveBeenCalled();
  });

  test('the giveup boot clears both gates but still skips the reclaim', () => {
    const reclaim = vi.fn(() => Promise.resolve());
    const { rig } = makeRig({
      attemptedInstall: '0.9.9',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      attemptedInstallSurfacedCount: INSTALL_FAILURE_MAX_SURFACES,
      reclaimStagedUpdateCache: reclaim,
    });
    expect(rig.dispatches).toContain('install-failed-giveup' as DispatchKind);
    expect(rig.state.attemptedInstall).toBeNull();
    expect(rig.state.versionPendingInstall).toBeNull();
    expect(reclaim).not.toHaveBeenCalled();
  });

  test('a rejecting reclaim hook is logged, never thrown', async () => {
    const reclaim = vi.fn(() => Promise.reject(new Error('EACCES')));
    const { rig } = makeRig({ reclaimStagedUpdateCache: reclaim });
    await Promise.resolve();
    await Promise.resolve();
    expect(
      rig.logger.warn.mock.calls.some((c) => c[0] === 'staged-update cache reclaim failed'),
    ).toBe(true);
  });

  test('no hook wired (dev build) → no dispatch, no throw', () => {
    const { rig } = makeRig();
    expect(rig.dispatches).not.toContain('staged-cache-reclaimed' as DispatchKind);
  });

  test('the launch check waits for the reclaim to settle (no rm/download interleave)', async () => {
    let resolveReclaim: (() => void) | undefined;
    const reclaim = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReclaim = resolve;
        }),
    );
    const { rig } = makeRig({ reclaimStagedUpdateCache: reclaim });
    expect(reclaim).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.updater.checkForUpdates).not.toHaveBeenCalled();
    resolveReclaim?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});

describe('linux manual-install fallback', () => {
  const STAGED_DEB = '/home/u/.cache/ok-updater/pending/ok_0.3.2_arm64.deb';

  function makeLinuxRig(opts: {
    hasGraphicalAuth: boolean;
    downloadedFile?: string | undefined;
    extraWindowCount?: number;
    emitDownloadEvent?: boolean;
    stateStagedInstallerPath?: string;
    stagedInstallerExists?: (path: string) => boolean;
  }) {
    const fallback = vi.fn(() => Promise.resolve());
    const hasAuth = vi.fn(() => opts.hasGraphicalAuth);
    const made = makeRig({
      platform: 'linux',
      versionPendingInstall: '0.3.2',
      ...(opts.stateStagedInstallerPath !== undefined
        ? { stagedInstallerPath: opts.stateStagedInstallerPath }
        : {}),
      extraWindowCount: opts.extraWindowCount ?? 0,
      linuxInstallSupport: {
        hasGraphicalAuth: hasAuth,
        showManualInstallFallback: fallback,
        ...(opts.stagedInstallerExists
          ? { stagedInstallerExists: opts.stagedInstallerExists }
          : {}),
      },
    });
    if (opts.emitDownloadEvent !== false) {
      made.rig.updater.emit('update-downloaded', {
        version: '0.3.2',
        downloadedFile: opts.downloadedFile ?? STAGED_DEB,
      });
    }
    return { ...made, fallback, hasAuth };
  }

  test('no graphical auth → fallback dialog instead of quitAndInstall, staged state preserved', async () => {
    const { rig, fallback } = makeLinuxRig({ hasGraphicalAuth: false, extraWindowCount: 1 });
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
    expect(rig.state.attemptedInstall).toBeNull();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith({
      version: '0.3.2',
      installerPath: STAGED_DEB,
      packageKind: 'deb',
      command: `sudo apt install -- '${STAGED_DEB}'`,
    });
    expect(rig.dispatches).toContain('linux-manual-fallback-no-auth' as DispatchKind);
    expect(rig.dispatches).not.toContain('relaunch-now' as DispatchKind);
    for (const win of rig.windows) {
      expect(win.filter((c) => c.channel === 'ok:update:downloaded').length).toBeGreaterThan(0);
      expect(win.filter((c) => c.channel === 'ok:update:relaunching')).toHaveLength(0);
    }
  });

  test('graphical auth present → normal quitAndInstall path, no fallback', async () => {
    const { rig, fallback, hasAuth } = makeLinuxRig({ hasGraphicalAuth: true });
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(hasAuth).toHaveBeenCalled();
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  test('unrecognized staged format (AppImage) falls through to quitAndInstall even without auth', async () => {
    const { rig, fallback } = makeLinuxRig({
      hasGraphicalAuth: false,
      downloadedFile: '/x/OpenKnowledge.AppImage',
    });
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  test('user cancellation (pkexec 126) → recovery with friendly message, NO fallback dialog', async () => {
    const { rig, fallback } = makeLinuxRig({ hasGraphicalAuth: true, extraWindowCount: 1 });
    await Promise.resolve();
    await Promise.resolve();
    await rig.ipc.invoke('ok:update:relaunch-now');
    rig.updater.emit('error', new Error('Command pkexec exited with code 126'));
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
    for (const win of rig.windows) {
      const failed = win.filter((c) => c.channel === 'ok:update:relaunch-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toEqual({
        version: '0.3.2',
        message: 'authorization was cancelled',
      });
    }
    expect(fallback).not.toHaveBeenCalled();
    expect(rig.dispatches).not.toContain('linux-manual-fallback-after-error' as DispatchKind);
  });

  test('retry after cancellation: the re-armed gate accepts a second relaunch-now', async () => {
    const { rig } = makeLinuxRig({ hasGraphicalAuth: true });
    await rig.ipc.invoke('ok:update:relaunch-now');
    rig.updater.emit('error', new Error('Command pkexec exited with code 126'));
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  test('infrastructure failure (pkexec 127) → recovery AND the fallback dialog', async () => {
    const { rig, fallback } = makeLinuxRig({ hasGraphicalAuth: true, extraWindowCount: 1 });
    await Promise.resolve();
    await Promise.resolve();
    await rig.ipc.invoke('ok:update:relaunch-now');
    rig.updater.emit('error', new Error('Command pkexec exited with code 127'));
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
    for (const win of rig.windows) {
      const failed = win.filter((c) => c.channel === 'ok:update:relaunch-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toEqual({
        version: '0.3.2',
        message: 'Command pkexec exited with code 127',
      });
    }
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith({
      version: '0.3.2',
      installerPath: STAGED_DEB,
      packageKind: 'deb',
      command: `sudo apt install -- '${STAGED_DEB}'`,
    });
    expect(rig.dispatches).toContain('linux-manual-fallback-after-error' as DispatchKind);
  });

  test('sudo-without-tty failure (no graphical wrapper found mid-install) also offers the fallback', async () => {
    const { rig, fallback } = makeLinuxRig({ hasGraphicalAuth: true });
    await rig.ipc.invoke('ok:update:relaunch-now');
    rig.updater.emit('error', new Error('Command sudo exited with code 1'));
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  test('rpm staged file produces the dnf command', async () => {
    const { rig, fallback } = makeLinuxRig({
      hasGraphicalAuth: false,
      downloadedFile: '/home/u/.cache/ok-updater/pending/ok-0.3.2.x86_64.rpm',
    });
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(fallback).toHaveBeenCalledWith(
      expect.objectContaining({
        packageKind: 'rpm',
        command: "sudo dnf install '/home/u/.cache/ok-updater/pending/ok-0.3.2.x86_64.rpm'",
      }),
    );
  });

  test('boot with a staged update: the PERSISTED path powers the fallback before any updater event', async () => {
    const { rig, fallback } = makeLinuxRig({
      hasGraphicalAuth: false,
      emitDownloadEvent: false,
      stateStagedInstallerPath: STAGED_DEB,
    });
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith({
      version: '0.3.2',
      installerPath: STAGED_DEB,
      packageKind: 'deb',
      command: `sudo apt install -- '${STAGED_DEB}'`,
    });
  });

  test('a persisted path whose file is gone falls through to quitAndInstall', async () => {
    const { rig, fallback } = makeLinuxRig({
      hasGraphicalAuth: false,
      emitDownloadEvent: false,
      stateStagedInstallerPath: STAGED_DEB,
      stagedInstallerExists: () => false,
    });
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  test('update-downloaded persists the staged installer path alongside the banner gate', () => {
    const { rig } = makeRig({ platform: 'linux' });
    rig.updater.emit('update-downloaded', { version: '0.9.9', downloadedFile: STAGED_DEB });
    expect(rig.state.versionPendingInstall).toBe('0.9.9');
    expect(rig.state.stagedInstallerPath).toBe(STAGED_DEB);
  });

  test('stale-pending reconciliation clears the persisted staged path with the gate', () => {
    const { rig } = makeRig({
      appVersion: '0.3.2',
      versionPendingInstall: '0.3.2',
      stagedInstallerPath: STAGED_DEB,
    });
    expect(rig.state.versionPendingInstall).toBeNull();
    expect(rig.state.stagedInstallerPath).toBeNull();
  });

  test('non-linux platforms never trigger the fallback even when wired', async () => {
    const fallback = vi.fn(() => Promise.resolve());
    const { rig } = makeRig({
      platform: 'darwin',
      versionPendingInstall: '0.3.2',
      linuxInstallSupport: {
        hasGraphicalAuth: () => false,
        showManualInstallFallback: fallback,
      },
    });
    rig.updater.emit('update-downloaded', { version: '0.3.2', downloadedFile: STAGED_DEB });
    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    rig.updater.emit('error', new Error('Command pkexec exited with code 127'));
    expect(fallback).not.toHaveBeenCalled();
  });
});

function fireTimerFor(clock: FakeClock, ms: number): void {
  const call = [...clock.setTimeout.mock.calls].reverse().find((c) => c[1] === ms);
  if (!call) throw new Error(`no timer registered for ${ms}ms`);
  (call[0] as () => void)();
}

function stageInSession(rig: TestRig, version: string): void {
  rig.updater.emit('update-available', { version });
  rig.updater.emit('update-downloaded', { version });
  rig.updater.downloadUpdate.mockClear();
}

describe('same-version download guard', () => {
  test('a re-offer of the build this session staged does not re-download', () => {
    const { rig } = makeRig({ versionPendingInstall: null });
    stageInSession(rig, '0.3.2');

    rig.updater.emit('update-available', { version: '0.3.2' });

    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.dispatches).toContain('download-skipped-already-staged' as DispatchKind);
  });

  test('the skipped offer still counts as a successful check', () => {
    const { rig } = makeRig({ versionPendingInstall: null });
    stageInSession(rig, '0.3.2');
    rig.dispatches.length = 0;

    rig.updater.emit('update-available', { version: '0.3.2' });

    expect(rig.dispatches).toContain('check-success' as DispatchKind);
  });

  test('the FIRST offer of a session re-downloads even when state says it is staged', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    rig.updater.downloadUpdate.mockClear();

    rig.updater.emit('update-available', { version: '0.3.2' });

    expect(rig.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(rig.dispatches).not.toContain('download-skipped-already-staged' as DispatchKind);

    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    rig.updater.downloadUpdate.mockClear();

    rig.updater.emit('update-available', { version: '0.3.2' });
    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.dispatches).toContain('download-skipped-already-staged' as DispatchKind);

    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  test('a genuinely newer offer still downloads', () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    rig.updater.downloadUpdate.mockClear();

    rig.updater.emit('update-available', { version: '0.3.3' });

    expect(rig.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(rig.dispatches).not.toContain('download-skipped-already-staged' as DispatchKind);
  });

  test('a retry after a failed download is not mistaken for an already-staged build', () => {
    const { rig } = makeRig({ versionPendingInstall: null });
    rig.updater.emit('update-available', { version: '0.3.2' });
    rig.updater.emit('error', new Error('network died'));
    rig.updater.downloadUpdate.mockClear();

    rig.updater.emit('update-available', { version: '0.3.2' });

    expect(rig.updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('cited upstream behaviour stays tied to the pinned dependency', () => {
  test('the electron-updater version in the UPSTREAM marker matches package.json', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const pinned =
      pkg.dependencies?.['electron-updater'] ?? pkg.devDependencies?.['electron-updater'];
    const mainDir = join(here, '../../src/main');
    const cited = readdirSync(mainDir, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts'))
      .flatMap((entry) => [
        ...readFileSync(join(mainDir, entry), 'utf8').matchAll(
          /UPSTREAM\(electron-updater@([^)]+)\)/g,
        ),
      ])
      .map((match) => match[1]);

    expect(cited.length).toBeGreaterThan(0);
    expect([...new Set(cited)]).toEqual([pinned]);
  });
});

describe('single-flight install handoff', () => {
  test('a newer offer does not arm a second request beside the pending one', () => {
    const { rig } = makeRig({ versionPendingInstall: null });
    stageInSession(rig, '0.3.2');

    rig.updater.emit('update-available', { version: '0.3.3' });

    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.dispatches).toContain('download-skipped-install-armed' as DispatchKind);
  });

  test('the declined offer still counts as a successful check', () => {
    const { rig } = makeRig({ versionPendingInstall: null });
    stageInSession(rig, '0.3.2');
    rig.dispatches.length = 0;

    rig.updater.emit('update-available', { version: '0.3.3' });

    expect(rig.dispatches).toContain('download-skipped-install-armed' as DispatchKind);
    expect(rig.dispatches).toContain('check-success' as DispatchKind);
  });

  test('the click-time freshness check installs the armed build rather than a second one', async () => {
    const { rig } = makeRig({ versionPendingInstall: null });
    stageInSession(rig, '0.3.2');
    rig.updater.checkForUpdates.mockImplementation(() => {
      rig.updater.emit('update-available', { version: '0.3.3' });
      return Promise.resolve(undefined);
    });

    await rig.ipc.invoke('ok:update:relaunch-now');

    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(rig.state.attemptedInstall).toBe('0.3.2');
    expect(rig.dispatches).toContain('relaunch-refresh-up-to-date' as DispatchKind);
    expect(rig.dispatches).toContain('download-skipped-install-armed' as DispatchKind);
  });

  test.each(['win32', 'linux'] as const)('on %s a newer offer still downloads', (platform) => {
    const { rig } = makeRig({ versionPendingInstall: null, platform });
    stageInSession(rig, '0.3.2');

    rig.updater.emit('update-available', { version: '0.3.3' });

    expect(rig.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(rig.dispatches).not.toContain('download-skipped-install-armed' as DispatchKind);
  });

  test.each([
    'win32',
    'linux',
  ] as const)('on %s a manual check for a newer offer reports it as downloading', (platform) => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({
      appVersion: '0.3.1',
      versionPendingInstall: null,
      platform,
      showCheckNowResult,
    });
    stageInSession(rig, '0.3.2');
    showCheckNowResult.mockClear();

    rig.ipc.invoke('ok:update:check-now');
    rig.updater.emit('update-available', { version: '0.3.3' });

    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'available',
      currentVersion: '0.3.1',
      latestVersion: '0.3.3',
    });
  });

  test.each([
    'win32',
    'linux',
  ] as const)('on %s the same-version skip still applies', (platform) => {
    const { rig } = makeRig({ versionPendingInstall: null, platform });
    stageInSession(rig, '0.3.2');

    rig.updater.emit('update-available', { version: '0.3.2' });

    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.dispatches).toContain('download-skipped-already-staged' as DispatchKind);
  });

  test('a manual check names the build that will install, not the declined offer', () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({
      appVersion: '0.3.1',
      versionPendingInstall: null,
      showCheckNowResult,
    });
    stageInSession(rig, '0.3.2');
    showCheckNowResult.mockClear();

    rig.ipc.invoke('ok:update:check-now');
    rig.updater.emit('update-available', { version: '0.3.3' });

    expect(showCheckNowResult).toHaveBeenCalledTimes(1);
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'ready-to-install',
      currentVersion: '0.3.1',
      stagedVersion: '0.3.2',
    });
  });

  test('a manual check that turns up the armed build reads as ready, not downloading', () => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({
      appVersion: '0.3.1',
      versionPendingInstall: null,
      showCheckNowResult,
    });
    stageInSession(rig, '0.3.2');
    showCheckNowResult.mockClear();

    rig.ipc.invoke('ok:update:check-now');
    rig.updater.emit('update-available', { version: '0.3.2' });

    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'ready-to-install',
      currentVersion: '0.3.1',
      stagedVersion: '0.3.2',
    });
  });

  test.each([
    'win32',
    'linux',
  ] as const)('on %s a manual check for the armed build still reads as ready', (platform) => {
    const showCheckNowResult = vi.fn(() => {});
    const { rig } = makeRig({
      appVersion: '0.3.1',
      versionPendingInstall: null,
      platform,
      showCheckNowResult,
    });
    stageInSession(rig, '0.3.2');
    showCheckNowResult.mockClear();

    rig.ipc.invoke('ok:update:check-now');
    rig.updater.emit('update-available', { version: '0.3.2' });

    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'ready-to-install',
      currentVersion: '0.3.1',
      stagedVersion: '0.3.2',
    });
  });

  test.each([
    'win32',
    'linux',
  ] as const)('on %s a relaunch that cannot restore its state releases the arm', async (platform) => {
    const { rig } = makeRig({ versionPendingInstall: null, platform });
    stageInSession(rig, '0.3.2');
    rig.updater.quitAndInstall = vi.fn(() => {
      rig.failNextPersist = true;
      throw new Error('installer refused the handoff');
    });

    await expect(Promise.resolve(rig.ipc.invoke('ok:update:relaunch-now'))).rejects.toThrow(
      'installer refused the handoff',
    );
    expect(rig.state.versionPendingInstall).toBeNull();
    rig.failNextPersist = false;
    rig.updater.downloadUpdate.mockClear();

    rig.updater.emit('update-available', { version: '0.3.2' });

    expect(rig.updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  test('on macOS a watchdog fire that cannot restore KEEPS the arm', async () => {
    const { rig } = makeRig({ versionPendingInstall: null });
    stageInSession(rig, '0.3.2');
    await rig.ipc.invoke('ok:update:relaunch-now');
    rig.failNextPersist = true;
    fireTimerFor(rig.clock, RELAUNCH_WATCHDOG_MS);
    rig.failNextPersist = false;
    expect(rig.dispatches).toContain('relaunch-watchdog-fired' as DispatchKind);
    expect(rig.state.versionPendingInstall).toBeNull();
    rig.updater.downloadUpdate.mockClear();

    rig.updater.emit('update-available', { version: '0.3.3' });

    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.dispatches).toContain('download-skipped-install-armed' as DispatchKind);
  });

  test('on macOS a quitAndInstall throw that cannot restore KEEPS the arm', async () => {
    const { rig } = makeRig({ versionPendingInstall: null });
    stageInSession(rig, '0.3.2');
    rig.updater.quitAndInstall = vi.fn(() => {
      rig.failNextPersist = true;
      throw new Error('squirrel refused the handoff');
    });

    await expect(Promise.resolve(rig.ipc.invoke('ok:update:relaunch-now'))).rejects.toThrow(
      'squirrel refused the handoff',
    );
    rig.failNextPersist = false;
    expect(rig.state.versionPendingInstall).toBeNull();
    rig.updater.downloadUpdate.mockClear();

    rig.updater.emit('update-available', { version: '0.3.3' });

    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.dispatches).toContain('download-skipped-install-armed' as DispatchKind);
  });

  test('on macOS an in-flight error that cannot restore KEEPS the arm', async () => {
    const { rig } = makeRig({ versionPendingInstall: null });
    stageInSession(rig, '0.3.2');
    await rig.ipc.invoke('ok:update:relaunch-now');
    rig.failNextPersist = true;
    rig.updater.emit('error', new Error('install failed'));
    rig.failNextPersist = false;
    expect(rig.dispatches).toContain('relaunch-error-event' as DispatchKind);
    expect(rig.state.versionPendingInstall).toBeNull();
    rig.updater.downloadUpdate.mockClear();

    rig.updater.emit('update-available', { version: '0.3.3' });

    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.dispatches).toContain('download-skipped-install-armed' as DispatchKind);
  });

  test('a relaunch that fails but DOES restore its state keeps the arm', async () => {
    const { rig } = makeRig({ versionPendingInstall: null });
    stageInSession(rig, '0.3.2');
    rig.updater.quitAndInstall = vi.fn(() => {
      throw new Error('squirrel refused the handoff');
    });

    await expect(Promise.resolve(rig.ipc.invoke('ok:update:relaunch-now'))).rejects.toThrow(
      'squirrel refused the handoff',
    );
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
    rig.updater.downloadUpdate.mockClear();

    rig.updater.emit('update-available', { version: '0.3.2' });

    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.dispatches).toContain('download-skipped-already-staged' as DispatchKind);
  });

  test('a download that never staged leaves the next offer free to arm', () => {
    const { rig } = makeRig({ versionPendingInstall: null });
    rig.updater.emit('update-available', { version: '0.3.2' });
    rig.updater.emit('error', new Error('network died'));
    rig.updater.downloadUpdate.mockClear();

    rig.updater.emit('update-available', { version: '0.3.3' });

    expect(rig.updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('click-gated freshness check', () => {
  test('nothing newer → installs the staged build', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    await rig.ipc.invoke('ok:update:relaunch-now');

    expect(rig.updater.checkForUpdates).toHaveBeenCalled();
    expect(rig.dispatches).toContain('relaunch-refresh-up-to-date' as DispatchKind);
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  test('every window is told the click is fetching before the wait begins', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', extraWindowCount: 2 });
    await rig.ipc.invoke('ok:update:relaunch-now');

    for (const win of rig.windows) {
      const fetching = win.filter((c) => c.channel === 'ok:update:fetching-latest');
      expect(fetching).toHaveLength(1);
      expect(fetching[0]?.payload).toEqual({ version: '0.3.2' });
    }
  });

  test('a newer build found at click time is installed instead of the staged one', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    rig.updater.checkForUpdates.mockImplementation(() => {
      rig.updater.emit('update-available', { version: '0.3.3' });
      return Promise.resolve(undefined);
    });

    const pending = rig.ipc.invoke('ok:update:relaunch-now');
    await Promise.resolve();
    expect(rig.dispatches).toContain('relaunch-refresh-found-newer' as DispatchKind);
    expect(rig.updater.quitAndInstall).not.toHaveBeenCalled();

    rig.updater.emit('update-downloaded', { version: '0.3.3' });
    await pending;

    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(rig.state.attemptedInstall).toBe('0.3.3');
  });

  test('a click landing mid-stage waits instead of installing over the write', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    rig.updater.emit('update-available', { version: '0.3.3' });

    const pending = rig.ipc.invoke('ok:update:relaunch-now');
    await Promise.resolve();
    expect(rig.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(rig.dispatches).toContain('relaunch-awaited-in-flight-staging' as DispatchKind);

    rig.updater.emit('update-downloaded', { version: '0.3.3' });
    await pending;

    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  test('a stage that errors out releases the click rather than stranding it', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    rig.updater.emit('update-available', { version: '0.3.3' });

    const pending = rig.ipc.invoke('ok:update:relaunch-now');
    await Promise.resolve();
    rig.updater.emit('error', new Error('download died'));
    await pending;

    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  test('a newer build that never finishes downloading falls through on the timeout', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    rig.updater.emit('update-available', { version: '0.3.3' });

    const pending = rig.ipc.invoke('ok:update:relaunch-now');
    await Promise.resolve();
    expect(rig.updater.quitAndInstall).not.toHaveBeenCalled();

    fireTimerFor(rig.clock, RELAUNCH_REFRESH_DOWNLOAD_MS);
    await pending;

    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    const relaunching = rig.captured.filter((c) => c.channel === 'ok:update:relaunching');
    expect(relaunching).toHaveLength(1);
    expect(relaunching[0]?.payload).toEqual({ version: '0.3.2' });
    expect(rig.state.versionPendingInstall).toBeNull();
  });

  test('a staged build that vanishes during the check clears the fetching card', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', extraWindowCount: 2 });
    rig.updater.checkForUpdates.mockImplementation(() => {
      rig.state = { ...rig.state, versionPendingInstall: null };
      return Promise.resolve(undefined);
    });

    await rig.ipc.invoke('ok:update:relaunch-now');

    expect(rig.updater.quitAndInstall).not.toHaveBeenCalled();
    for (const win of rig.windows) {
      const failed = win.filter((c) => c.channel === 'ok:update:relaunch-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toMatchObject({ version: '0.3.2', dismissPending: true });
      expect(win.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(0);
    }
  });

  test('a check that never reports back falls through on the timeout', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    rig.updater.checkForUpdates.mockImplementation(() => new Promise(() => {}));

    const pending = rig.ipc.invoke('ok:update:relaunch-now');
    await Promise.resolve();
    expect(rig.updater.quitAndInstall).not.toHaveBeenCalled();

    fireTimerFor(rig.clock, RELAUNCH_REFRESH_CHECK_MS);
    await pending;

    expect(rig.dispatches).toContain('relaunch-refresh-timed-out' as DispatchKind);
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

describe('the commit flag releases on every path that re-offers the click', () => {
  test('a persist failure leaves the banner clickable again', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    rig.failNextPersist = true;

    await expect(Promise.resolve(rig.ipc.invoke('ok:update:relaunch-now'))).rejects.toThrow(
      'could not save the update state',
    );
    expect(rig.updater.quitAndInstall).not.toHaveBeenCalled();

    rig.failNextPersist = false;
    await rig.ipc.invoke('ok:update:relaunch-now');

    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  test('a relaunch failure that restores cleanly does NOT ask to clear the card', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    await rig.ipc.invoke('ok:update:relaunch-now');
    rig.updater.emit('error', new Error('ShipIt swap failed'));

    const failed = rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed');
    expect(failed).toHaveLength(1);
    expect((failed[0]?.payload as { dismissPending?: boolean }).dismissPending).toBeUndefined();
    expect(rig.captured.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(1);
  });

  test('a persist failure rejects the click rather than resolving it', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    rig.failNextPersist = true;

    await expect(Promise.resolve(rig.ipc.invoke('ok:update:relaunch-now'))).rejects.toThrow();
  });

  test('a persist failure re-arms the banner in EVERY window, not just the clicked one', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', extraWindowCount: 2 });
    rig.failNextPersist = true;

    await expect(Promise.resolve(rig.ipc.invoke('ok:update:relaunch-now'))).rejects.toThrow();

    for (const win of rig.windows) {
      expect(win.filter((c) => c.channel === 'ok:update:fetching-latest')).toHaveLength(1);
      const rearm = win.filter((c) => c.channel === 'ok:update:downloaded');
      expect(rearm).toHaveLength(1);
      expect(rearm[0]?.payload).toEqual({ version: '0.3.2' });
      const failed = win.filter((c) => c.channel === 'ok:update:relaunch-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toEqual({
        version: '0.3.2',
        message: 'could not save the update state',
      });
    }
  });

  test('the linux no-graphical-auth preflight leaves the banner clickable again', async () => {
    const hasGraphicalAuth = vi.fn(() => false);
    const { rig } = makeRig({
      platform: 'linux',
      versionPendingInstall: '0.3.2',
      linuxInstallSupport: {
        hasGraphicalAuth,
        showManualInstallFallback: vi.fn(() => Promise.resolve()),
      },
    });
    rig.updater.emit('update-downloaded', {
      version: '0.3.2',
      downloadedFile: '/home/u/.cache/ok-updater/pending/ok_0.3.2_arm64.deb',
    });

    await rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.updater.quitAndInstall).not.toHaveBeenCalled();

    hasGraphicalAuth.mockReturnValue(true);
    await rig.ipc.invoke('ok:update:relaunch-now');

    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

describe('post-update quiet window', () => {
  test('a banner arriving right after an update is held, not dropped', () => {
    const { rig, handle } = makeRig({ lastSeenVersion: '0.3.0', appVersion: '0.3.1' });
    expect(handle.isWithinPostUpdateQuietWindow()).toBe(true);

    rig.updater.emit('update-downloaded', { version: '0.3.2' });

    expect(rig.captured.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(0);
    expect(rig.dispatches).toContain('toast-a-deferred-post-update-quiet' as DispatchKind);
    expect(rig.state.versionPendingInstall).toBe('0.3.2');

    fireTimerFor(rig.clock, POST_UPDATE_QUIET_MS);

    expect(rig.captured.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(1);
    expect(rig.dispatches).toContain('toast-a-quiet-window-elapsed' as DispatchKind);
    expect(handle.isWithinPostUpdateQuietWindow()).toBe(false);
  });

  test('a fresh install does not arm it', () => {
    const { handle } = makeRig({ lastSeenVersion: null, appVersion: '0.3.1' });
    expect(handle.isWithinPostUpdateQuietWindow()).toBe(false);
  });

  test('a plain relaunch on the same version does not arm it', () => {
    const { handle } = makeRig({ lastSeenVersion: '0.3.1', appVersion: '0.3.1' });
    expect(handle.isWithinPostUpdateQuietWindow()).toBe(false);
  });

  test('linux does not arm it — the banner there is the only install route', () => {
    const { rig, handle } = makeRig({
      platform: 'linux',
      lastSeenVersion: '0.3.0',
      appVersion: '0.3.1',
    });
    expect(handle.isWithinPostUpdateQuietWindow()).toBe(false);

    rig.updater.emit('update-downloaded', { version: '0.3.2' });

    expect(rig.captured.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(1);
    expect(rig.dispatches).not.toContain('toast-a-deferred-post-update-quiet' as DispatchKind);
  });

  test('outside the window the banner fires immediately, as before', () => {
    const { rig, handle } = makeRig({ lastSeenVersion: '0.3.1', appVersion: '0.3.1' });
    expect(handle.isWithinPostUpdateQuietWindow()).toBe(false);

    rig.updater.emit('update-downloaded', { version: '0.3.2' });

    expect(rig.captured.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(1);
    expect(rig.dispatches).toContain('update-downloaded-toast-a' as DispatchKind);
  });
});
