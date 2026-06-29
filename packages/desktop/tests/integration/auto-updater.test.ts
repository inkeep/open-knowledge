
import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { OutgoingHttpHeaders } from 'node:http';
import {
  bootAutoUpdater,
  buildCheckNowResultFromError,
  type DispatchKind,
  type IpcMainLike,
  installReached,
  isClassifiedUpdaterError,
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
  allowPrerelease = true; // deliberately non-default so the lock-down is observable
  allowDowngrade = true;
  forceDevUpdateConfig = false;
  requestHeaders: OutgoingHttpHeaders | null = null;
  setFeedURL = mock(
    (
      _urlOrOptions:
        | string
        | { provider: 'generic'; url: string }
        | { provider: 'github'; owner: string; repo: string },
    ) => {},
  );
  checkForUpdates = mock(() => Promise.resolve(undefined));
  downloadUpdate = mock(() => Promise.resolve([] as unknown[]));
  quitAndInstall = mock(() => {});
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

interface FakeClock {
  setTimeout: ReturnType<typeof mock>;
  clearTimeout: ReturnType<typeof mock>;
  lastCallback: (() => void) | null;
  lastHandle: unknown;
  lastMs: number | null;
}

function makeFakeClock(): FakeClock {
  const clock: FakeClock = {
    setTimeout: mock(() => Symbol('timer-handle')),
    clearTimeout: mock(() => {}),
    lastCallback: null,
    lastHandle: null,
    lastMs: null,
  };
  clock.setTimeout = mock((cb: () => void, ms: number) => {
    clock.lastCallback = cb;
    clock.lastMs = ms;
    const handle = Symbol('timer-handle');
    clock.lastHandle = handle;
    return handle as unknown as ReturnType<typeof setTimeout>;
  });
  clock.clearTimeout = mock((h: unknown) => {
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
  dispatches: DispatchKind[];
  now: Date;
  logger: {
    info: ReturnType<typeof mock>;
    warn: ReturnType<typeof mock>;
    error: ReturnType<typeof mock>;
    debug: ReturnType<typeof mock>;
  };
}

function makeRig(
  overrides?: Partial<AppState> & {
    appVersion?: string;
    isPackaged?: boolean;
    forceDevBypass?: boolean;
    feedUrl?: string;
    proxyFeed?: { base: string; channels: ReadonlySet<'latest' | 'beta'> };
    updaterSetup?: (u: FakeUpdater) => void;
    extraWindowCount?: number;
    prepareForRelaunch?: () => void;
    showCheckNowResult?: Parameters<typeof startAutoUpdater>[0]['showCheckNowResult'];
    random?: () => number;
  },
): {
  rig: TestRig;
  handle: ReturnType<typeof startAutoUpdater>;
} {
  const {
    appVersion = '0.3.1',
    isPackaged = true,
    forceDevBypass,
    feedUrl,
    proxyFeed,
    updaterSetup,
    extraWindowCount = 0,
    prepareForRelaunch,
    showCheckNowResult,
    random = () => 0,
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
    dispatches: [],
    now: new Date('2026-04-21T12:00:00.000Z'),
    logger: {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
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
      rig.state = next;
    },
    getPrimaryWindow: () => primaryWindow,
    getAllWindows: extraWindowCount > 0 ? () => fanOutTargets : undefined,
    getAppVersion: () => appVersion,
    isPackaged,
    forceDevBypass,
    feedUrl,
    proxyFeed,
    prepareForRelaunch,
    showCheckNowResult,
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
  'ERR_CHECKSUM_MISMATCH', // not ERR_UPDATER_-prefixed but should classify under a future extension
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

  test('proxyFeed: default-off — channel not in the set leaves the GitHub default', () => {
    const { rig } = makeRig({
      appVersion: '0.4.0', // stable build
      proxyFeed: { base: PROXY_BASE, channels: new Set(['beta']) }, // only beta enabled
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
        u.checkForUpdates = mock(() => {
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
        u.setFeedURL = mock((arg) => {
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
    const showCheckNowResult = mock(() => {});
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
    handle.destroy(); // detach and re-wire with throwing writeState

    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const captured: CapturedSend[] = [];
    const primaryWindow = makeFakeWindow(captured);
    const state: AppState = emptyState();
    const dispatches: DispatchKind[] = [];
    const logger = {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
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
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
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
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
      },
    });
    expect(state.versionPendingInstall).toBe('0.4.0');
    expect(dispatches).not.toContain('stale-pending-cleared' as DispatchKind);
  });
});


describe('boot-time failed-install detection', () => {
  test('attempted not reached (same-MMP beta) → relaunch-failed w/ downloadUrl, re-arm, stays armed', () => {
    const { rig } = makeRig({
      attemptedInstall: '0.16.0-beta.3',
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
          info: mock(() => {}),
          warn: mock(() => {}),
          error: mock(() => {}),
          debug: mock(() => {}),
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
      appVersion: '0.16.0-beta.3',
    });
    const failed = rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed');
    expect(failed).toHaveLength(0);
    expect(rig.state.attemptedInstall).toBeNull();
    expect(rig.dispatches).toContain('attempted-install-reconciled' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
  });

  test('attempted reached (running past attempted, stable over beta) → silently cleared', () => {
    const { rig } = makeRig({
      attemptedInstall: '0.16.0-beta.3',
      appVersion: '0.16.0',
    });
    expect(rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(0);
    expect(rig.state.attemptedInstall).toBeNull();
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
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
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
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
      },
    });
    expect(state.attemptedInstall).toBe('0.16.0-beta.3');
    expect(dispatches).not.toContain('attempted-install-reconciled' as DispatchKind);
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

  test('UPDATE_CHECK_INTERVAL_MS is the short pre-release cadence; jitter is a small fraction of it', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(UPDATE_CHECK_JITTER_MS).toBeGreaterThanOrEqual(5 * 1000);
    expect(UPDATE_CHECK_JITTER_MS).toBeLessThanOrEqual(60 * 1000);
    expect(UPDATE_CHECK_JITTER_MS).toBeLessThan(UPDATE_CHECK_INTERVAL_MS);
  });

  test('first-launch check rejection still registers the periodic timer', async () => {
    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const captured: CapturedSend[] = [];
    let state: AppState = emptyState();
    updater.checkForUpdates = mock(() =>
      Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')),
    );
    const primaryWindow = makeFakeWindow(captured);
    const logger = {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
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

  test('handler invocation WITH versionPendingInstall calls autoUpdater.quitAndInstall', () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    rig.ipc.invoke('ok:update:relaunch-now');
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

  test('broadcasts ok:update:relaunching to EVERY open window so all swap in lockstep', () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', extraWindowCount: 2 });
    expect(rig.windows).toHaveLength(3);
    rig.ipc.invoke('ok:update:relaunch-now');
    for (const win of rig.windows) {
      const relaunching = win.filter((c) => c.channel === 'ok:update:relaunching');
      expect(relaunching).toHaveLength(1);
      expect(relaunching[0]?.payload).toEqual({ version: '0.3.2' });
    }
    expect(rig.dispatches.filter((d) => d === 'relaunching-broadcast')).toHaveLength(1);
  });

  test('quitAndInstall throw → state restored + every window re-armed via ok:update:downloaded + invoke rejects', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', extraWindowCount: 2 });
    rig.updater.quitAndInstall = mock(() => {
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
    rig.updater.quitAndInstall = mock(() => {});
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
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
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

  test('prepareForRelaunch fires BEFORE quitAndInstall — utility kill ordering', async () => {
    const calls: string[] = [];
    const updater = new FakeUpdater();
    updater.quitAndInstall = mock(() => {
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
      clock: makeFakeClock(),
      now: () => new Date(),
      logger: {
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
      },
    });
    await ipc.invoke('ok:update:relaunch-now');
    expect(calls).toEqual(['prepareForRelaunch', 'quitAndInstall']);
  });

  test('prepareForRelaunch does NOT fire when versionPendingInstall is null', () => {
    const prepareForRelaunch = mock(() => {});
    const { rig } = makeRig({ versionPendingInstall: null, prepareForRelaunch });
    rig.ipc.invoke('ok:update:relaunch-now');
    expect(prepareForRelaunch).not.toHaveBeenCalled();
    expect(rig.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  test('prepareForRelaunch throw does NOT block quitAndInstall', () => {
    const prepareForRelaunch = mock(() => {
      throw new Error('teardown bug');
    });
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', prepareForRelaunch });
    rig.ipc.invoke('ok:update:relaunch-now');
    expect(prepareForRelaunch).toHaveBeenCalledTimes(1);
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(rig.logger.warn).toHaveBeenCalled();
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
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
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
    expect(failed[0]?.payload).toEqual({ version: '0.3.2', message: 'the update timed out' });
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
    rig.updater.checkForUpdates = mock(() => Promise.reject(new Error('network down')));
    expect(() => rig.ipc.invoke('ok:update:check-now')).not.toThrow();
  });

  test('destroy() removes the check-now IPC handler', () => {
    const { rig, handle } = makeRig();
    handle.destroy();
    expect(rig.ipc.handlers.has('ok:update:check-now')).toBe(false);
  });
});

describe('check-now → showCheckNowResult feedback dispatch', () => {
  test('update-not-available after menu-check fires not-available result', () => {
    const showCheckNowResult = mock(() => {});
    const { rig } = makeRig({ appVersion: '0.4.0-beta.13', showCheckNowResult });
    rig.ipc.invoke('ok:update:check-now');
    rig.updater.emit('update-not-available', { version: '0.4.0-beta.13' });
    expect(showCheckNowResult).toHaveBeenCalledTimes(1);
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'not-available',
      currentVersion: '0.4.0-beta.13',
    });
  });

  test('update-available after menu-check fires available result with versions', () => {
    const showCheckNowResult = mock(() => {});
    const { rig } = makeRig({
      appVersion: '0.4.0-beta.13',
      showCheckNowResult,
    });
    rig.ipc.invoke('ok:update:check-now');
    rig.updater.emit('update-available', { version: '0.4.0-beta.14' });
    expect(showCheckNowResult).toHaveBeenCalledTimes(1);
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'available',
      currentVersion: '0.4.0-beta.13',
      latestVersion: '0.4.0-beta.14',
    });
  });

  test('error after menu-check fires error result with the message', () => {
    const showCheckNowResult = mock(() => {});
    const { rig } = makeRig({ showCheckNowResult });
    rig.ipc.invoke('ok:update:check-now');
    rig.updater.emit('error', new Error('network timeout'));
    expect(showCheckNowResult).toHaveBeenCalledTimes(1);
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'error',
      message: 'network timeout',
    });
  });

  test('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND routes to not-available (cascade-fallback path)', () => {
    const showCheckNowResult = mock(() => {});
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
    const showCheckNowResult = mock(() => {});
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
    const showCheckNowResult = mock(() => {});
    const { rig } = makeRig({ showCheckNowResult });
    rig.updater.emit('update-not-available', { version: '0.4.0-beta.13' });
    expect(showCheckNowResult).not.toHaveBeenCalled();
  });

  test('subsequent events after dispatch do NOT re-fire (single-shot per check-now)', () => {
    const showCheckNowResult = mock(() => {});
    const { rig } = makeRig({ showCheckNowResult });
    rig.ipc.invoke('ok:update:check-now');
    rig.updater.emit('update-not-available', { version: '0.4.0-beta.13' });
    rig.updater.emit('update-not-available', { version: '0.4.0-beta.13' });
    rig.updater.emit('error', new Error('next-cycle network error'));
    expect(showCheckNowResult).toHaveBeenCalledTimes(1);
  });

  test('checkForUpdates synchronous reject fires error result', async () => {
    const showCheckNowResult = mock(() => {});
    const { rig } = makeRig({ showCheckNowResult });
    rig.updater.checkForUpdates = mock(() => Promise.reject(new Error('feed not reachable')));
    rig.ipc.invoke('ok:update:check-now');
    await new Promise((r) => setTimeout(r, 0));
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'error',
      message: 'feed not reachable',
    });
  });

  test('checkForUpdates synchronous reject with ERR_UPDATER_CHANNEL_FILE_NOT_FOUND routes to not-available', async () => {
    const showCheckNowResult = mock(() => {});
    const { rig } = makeRig({ appVersion: '0.5.0-beta.21', showCheckNowResult });
    const err = Object.assign(new Error('Cannot find latest-mac.yml ...: HttpError: 404'), {
      code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    });
    rig.updater.checkForUpdates = mock(() => Promise.reject(err));
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
    const showCheckNowResult = mock(() => {});
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
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
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
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
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
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
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
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
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
  test('second invocation sees cleared versionPendingInstall → no second quitAndInstall', () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    rig.ipc.invoke('ok:update:relaunch-now');
    rig.ipc.invoke('ok:update:relaunch-now');
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(rig.state.versionPendingInstall).toBeNull();
  });

  test('persistSafely failure → no quitAndInstall call (better to retry)', () => {
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
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
      },
    });
    ipc.invoke('ok:update:relaunch-now');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(state.versionPendingInstall).toBe('0.3.2');
  });
});


describe('bootAutoUpdater catch-path (Major #5)', () => {
  test('dynamic-import failure → returns null + logs error, no throw', async () => {
    const logger = {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
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
    expect(errorCall?.[1]).toMatchObject({
      message: expect.stringContaining('Cannot find module'),
    });
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
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
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
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
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
    expect(errorCall?.[1]).toMatchObject({
      message: expect.stringContaining('electron-updater did not expose'),
    });
  });
});
