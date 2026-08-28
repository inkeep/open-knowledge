/**
 * auto-updater unit + integration tests.
 *
 * Drives the full `startAutoUpdater(...)` event flow via a fake
 * `UpdaterLike` (event-stub pattern) + fake `ipcMain` + fake `WebContents` sink + injected
 * clock. No Electron runtime needed — tests run under `bun test`.
 *
 * Coverage map:
 *   - 6 events wired + dispatch shape (channel names, payloads)
 *   - 13 ERR_UPDATER_* / HTTP_ERROR_* codes route to classified log
 *   - Bare Error (no .code) routes to unclassified log
 *   - Successful check updates lastSuccessfulCheckAt + resets stuckHintShown
 *   - Stuck-hint fires once per installation; resets on success; re-arms
 *   - First-launch post-update (Toast B) once per version transition
 *   - Periodic check singleton via injectable clock
 *   - Relaunch-now IPC calls quitAndInstall
 *   - Dev-mode guard skips first-launch check but keeps handlers wired
 *   - Staged-cache reclaim fires only with no install commitment armed
 *   - Linux manual-install fallback (no-auth preflight, 126 vs 127 routing)
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { OutgoingHttpHeaders } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import {
  bootAutoUpdater,
  buildCheckNowResultFromError,
  type DispatchKind,
  INSTALL_FAILURE_MAX_SURFACES,
  type IpcMainLike,
  installReached,
  isClassifiedUpdaterError,
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

/** Narrow window-like shape used in tests — mirrors the production `getPrimaryWindow` return type. */
interface SendTarget {
  webContents: SendableWebContents;
}

// ————————————————————————————————————————————————————————
// Fakes
// ————————————————————————————————————————————————————————

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  channel: string | null = null;
  allowPrerelease = true; // deliberately non-default so the lock-down is observable
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
      // Mirror Electron's real ipcMain semantics — a double registration
      // throws. Silent overwrite would let a re-registration bug pass the
      // whole suite and crash only in production.
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

interface FakeClock {
  setTimeout: ReturnType<typeof vi.fn>;
  clearTimeout: ReturnType<typeof vi.fn>;
  /** Most recently registered timer callback — fire it to simulate a tick. */
  lastCallback: (() => void) | null;
  /** Most recently returned timer handle. */
  lastHandle: unknown;
  /** ms the last setTimeout call was configured for (base interval + jitter). */
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
  /**
   * Per-window broadcast captures used to assert multi-window state-sync.
   * `windows[0]` is always the primary window (same buffer as `captured`, so
   * existing tests asserting on `captured` remain unaffected). Additional
   * entries hold extra windows registered via `extraWindowCount`.
   */
  windows: CapturedSend[][];
  state: AppState;
  /** Set true to make the next (and every) `writeState` throw. */
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
    /**
     * Injected platform. Defaults to 'darwin' — NOT the host's — so the
     * suite asserts one deterministic platform's behavior on every CI
     * runner (this file runs on ubuntu, where inheriting `process.platform`
     * would silently flip the Linux install-on-quit carve-out on).
     */
    platform?: NodeJS.Platform;
    forceDevBypass?: boolean;
    feedUrl?: string;
    proxyFeed?: { base: string; channels: ReadonlySet<'latest' | 'beta'> };
    /** Configure the FakeUpdater before startAutoUpdater runs (e.g. a rejecting first check). */
    updaterSetup?: (u: FakeUpdater) => void;
    /**
     * Number of EXTRA windows beyond the primary that the relaunch-banner
     * (Toast A) fan-out should observe. Defaults to 0 — when 0, the fixture
     * omits `getAllWindows` entirely so Toast A falls back to the single
     * primary window.
     */
    extraWindowCount?: number;
    /**
     * Pre-relaunch teardown hook — fires synchronously from the
     * `relaunch-now` IPC handler immediately before
     * `autoUpdater.quitAndInstall()`. Production wires this to a hard
     * SIGKILL of project-window utilities so no server outlives the bundle
     * swap. Not about Squirrel.Mac's "App Still Running" abort, which keys on
     * another process claiming the app's bundle URL and so cannot see these.
     */
    prepareForRelaunch?: () => void;
    /**
     * Menu-driven check-result dispatcher — production renders a
     * `dialog.showMessageBox`. Tests pass a spy to assert the
     * discriminated-union shape that lands per outcome.
     */
    showCheckNowResult?: Parameters<typeof startAutoUpdater>[0]['showCheckNowResult'];
    /**
     * Staged-cache reclaim hook — production wires
     * `reclaimPendingUpdateCache` in packaged builds. Tests pass a spy to
     * pin the boot-reconciliation gating (never while an install commitment
     * is armed).
     */
    reclaimStagedUpdateCache?: Parameters<typeof startAutoUpdater>[0]['reclaimStagedUpdateCache'];
    /**
     * Linux manual-install fallback surface — production wires the
     * pkexec-preflight + Copy-command dialog. Tests pass spies to pin the
     * trigger conditions (no graphical auth / infrastructure-classified
     * install failure) and the preserved staged state.
     */
    linuxInstallSupport?: Parameters<typeof startAutoUpdater>[0]['linuxInstallSupport'];
    /**
     * RNG for the periodic-check jitter. Defaults to `() => 0` so the
     * scheduled delay is exactly `UPDATE_CHECK_INTERVAL_MS` in tests that
     * don't care about jitter; pass a custom stub to exercise the jitter
     * window (`() => 0.5` → floor + half) or per-fire re-randomization
     * (a stub returning a fresh value each call).
     */
    random?: () => number;
    /**
     * Wall clock the boot itself observes. `rig.now` is mutable, but
     * `startAutoUpdater` runs inside this factory, so a test that needs the
     * BOOT-time reconciliation to see a specific instant has to supply it
     * here. Defaults to the fixture's fixed timestamp.
     */
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
    // Most updater tests exercise event-specific dispatch after boot. Seed
    // lastSeenVersion to the fixture appVersion so the new first-launch
    // version notice only appears in tests that opt into that branch.
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
      // Flippable mid-test so a persist failure and the retry that follows it
      // can be exercised against one live updater, the way the user meets them
      // (full disk, click, free some space, click again).
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

// ————————————————————————————————————————————————————————
// Constants used across tests
// ————————————————————————————————————————————————————————

/**
 * A handoff stamped far outside the in-flight grace, for fixtures that mean "an
 * install was really committed and really failed".
 *
 * `attemptedInstall` alone no longer says that. It is armed at DOWNLOAD time on
 * non-Linux, so on its own it means only "an artifact is staged" — and a boot
 * that finds it armed with NO handoff stamp now reads that as "no commit point
 * ever ran", re-offers the update, and never reaches a failure verdict. Fixtures
 * predating the handoff stamp were written when the two facts were one, so they
 * need this to keep exercising the branch their assertions describe.
 */
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
  'ERR_CHECKSUM_MISMATCH', // not ERR_UPDATER_-prefixed but should classify under a future extension
  'HTTP_ERROR_404',
  'HTTP_ERROR_429',
  'HTTP_ERROR_500',
];

// ————————————————————————————————————————————————————————
// Invariant: configuration is locked at startup
// ————————————————————————————————————————————————————————

describe('startAutoUpdater — initial configuration (parent §8.10 LOCKED)', () => {
  test('sets autoDownload=false, autoInstallOnAppQuit=true, channel=latest', () => {
    // autoDownload is `false` so the cross-channel veto in `onUpdateAvailable`
    // can run BEFORE electron-updater downloads. We trigger `downloadUpdate()`
    // explicitly once the channel-match check passes.
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
    // electron-updater's quit handler fires after every window is gone, and
    // the Linux installers run a BLOCKING pkexec install right there — a
    // staged update would pop a windowless polkit password prompt on an
    // ordinary quit. Linux keeps only the explicit "Relaunch now" path.
    const { rig } = makeRig({ platform: 'linux' });
    expect(rig.updater.autoInstallOnAppQuit).toBe(false);
    // The rest of the configuration lock-down is platform-independent.
    expect(rig.updater.autoDownload).toBe(false);
  });

  test('win32 keeps install-on-quit (NSIS installs silently, like Squirrel.Mac)', () => {
    const { rig } = makeRig({ platform: 'win32' });
    expect(rig.updater.autoInstallOnAppQuit).toBe(true);
  });

  test('linux: update-downloaded arms the banner but NOT attemptedInstall (no install commit on plain quit)', () => {
    // With install-on-quit off, downloading is not an install attempt — a
    // user who downloads and simply quits must not get a false "Update
    // didn't install" notice on the next boot.
    const { rig } = makeRig({ platform: 'linux' });
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
    expect(rig.state.attemptedInstall).toBeNull();
  });

  test('linux: relaunch-now is the install-commit point — it arms attemptedInstall', async () => {
    // The click is Linux's commitment; arming here keeps the boot-time
    // silent-failure detection working for the path the user actually took.
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

  // smoke plumbing regression. Added when manual `bun run dev` revealed that
  // `OK_UPDATER_FEED_URL` was documented in the PR body but never actually
  // wired into main — feedUrl would be set but setFeedURL was never called,
  // and `forceDevUpdateConfig` was never flipped so the check gate blocked
  // network access anyway. These tests lock in the full contract so
  // a future refactor can't silently break the manual smoke.

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
    // The channel is derived from `app.getVersion()`. A plain `X.Y.Z` is
    // stable. `allowDowngrade` is `false` on both branches under the
    // install-time-sticky model — cross-channel moves are user-initiated
    // reinstalls, not auto-update events.
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
    // The legacy sticky `updateChannel` preference has been removed. A stable
    // build always configures `channel=latest`; a beta build always
    // configures `channel=beta`. To switch channels the user uninstalls and
    // reinstalls the other DMG.
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
    // Windows/Linux installers have version-less names and stable resolves
    // them through GitHub's `latest` alias, so this header is the proxy's only
    // way to know which version an update landed on. It must be set before
    // downloadUpdate runs — electron-updater reads requestHeaders there.
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
    // No download happens, so tagging one would attribute a version to an
    // update that was never fetched.
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
    // The GitHub fallback nulls these headers; growing a custom one here would
    // send OpenKnowledge telemetry to github.com.
    const { rig } = makeRig({ appVersion: '0.4.0' });
    rig.updater.emit('update-available', { version: '0.5.0' });
    expect(rig.updater.downloadUpdate).toHaveBeenCalled();
    expect(rig.updater.requestHeaders).toBeNull();
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
        u.checkForUpdates = vi.fn(() => {
          if (firstCall) {
            firstCall = false;
            return Promise.reject(new Error('proxy 503'));
          }
          return Promise.resolve(undefined);
        });
      },
    });
    // Let the boot check's rejection + the revert microtasks flush.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'inkeep',
      repo: 'open-knowledge',
    });
    expect(rig.updater.requestHeaders).toBeNull();
    // The boot .catch() that reverts the feed must still arm the periodic
    // timer — a proxy failure can't leave the session without update checks.
    expect(rig.clock.setTimeout).toHaveBeenCalledTimes(1);
  });

  test('proxyFeed: an error EVENT (not a rejection) reverts to the GitHub provider', async () => {
    const { rig } = makeRig({
      appVersion: '0.4.0-beta.7',
      proxyFeed: { base: PROXY_BASE, channels: new Set(['beta']) },
    });
    // Proxy feed is the active source: setFeedURL chose the generic provider
    // (not GitHub) and the version/channel headers are set.
    expect(rig.updater.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: `${PROXY_BASE}/beta`,
    });
    expect(rig.updater.requestHeaders).not.toBeNull();

    // electron-updater delivers feed/manifest failures primarily through the
    // `error` event, not a checkForUpdates() rejection. That common path must
    // still trip the GitHub-direct fallback.
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
    // boot generic feed + the one-shot GitHub fallback = 2 setFeedURL calls.
    const callsAfterFallback = rig.updater.setFeedURL.mock.calls.length;
    expect(callsAfterFallback).toBe(2);

    // The guard (`!usingProxyFeed || proxyFallbackTried`) makes every later
    // error event inert — no second setFeedURL, no re-check storm.
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
    // The throw is caught and logged; the load-bearing `return` prevents a
    // re-check against the mis-configured updater.
    expect(rig.updater.checkForUpdates.mock.calls.length).toBe(checksBeforeError);
    expect(rig.logger.error).toHaveBeenCalled();
  });
});

// ————————————————————————————————————————————————————————
// Staging age
// ————————————————————————————————————————————————————————
//
// ShipIt performs the swap after the app exits, so when an install silently
// fails no live process saw it and the bundle carries no ShipIt-side reason.
// How long the update had been staged when the install was requested is the
// one correlate the app CAN record, and it only becomes comparable across
// reports if every install request emits it.

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
    // A couple of seconds: the reported shape is a click landing moments after
    // a newer build re-staged underneath an already-open notification.
    rig.now = new Date('2026-04-21T12:00:02.060Z');
    await rig.ipc.invoke('ok:update:relaunch-now');

    expect(rig.state.attemptedInstallStagingAgeMs).toBe(2060);
    expect(rig.logger.info).toHaveBeenCalledWith(
      'relaunch-now invoked — calling autoUpdater.quitAndInstall',
      expect.objectContaining({ stagingAgeMs: 2060 }),
    );
    // The click clears the banner gate but must leave the staged-at stamp
    // alone: the artifact is still staged, so a Retry after a failed install
    // measures from the original staging rather than restarting the clock.
    expect(rig.state.versionPendingInstall).toBeNull();
    expect(rig.state.versionPendingInstallStagedAt).toBe(Date.parse('2026-04-21T12:00:00.000Z'));
  });

  // `Date.now()` is wall-clock, not monotonic. An NTP correction between
  // staging and the click makes the delta negative, and there is no age to
  // report — same "unknown" the no-click path yields, not an instant install.
  test('reports null rather than zero when the clock moved backwards while staged', async () => {
    const { rig } = makeRig({ platform: 'darwin' });
    rig.now = new Date('2026-04-21T12:00:00.000Z');
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    rig.now = new Date('2026-04-21T11:59:57.000Z');
    await rig.ipc.invoke('ok:update:relaunch-now');

    expect(rig.state.attemptedInstallStagingAgeMs).toBeNull();
  });

  // The failed-install detector runs on the NEXT boot, in a different process
  // than the install it reports. Without the persisted age the one number that
  // could corroborate a timing hypothesis dies with the process that had it.
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

  // Install-on-quit commits without a click, so there is no request moment to
  // measure to. Null says "unknown"; a zero would read as "installed instantly
  // after staging" and corroborate exactly the hypothesis it cannot speak to.
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

  // An age belongs to the version whose install it was recorded for. Arming a
  // NEW version starts a fresh measurement, so a leftover age from an earlier
  // click must not travel with it — a stale non-null number reads as real
  // signal to a triager and is worse than the age simply being absent.
  test('a newly armed version does not inherit an earlier version staging age', async () => {
    const { rig: session, handle } = makeRig({ platform: 'darwin' });
    session.now = new Date('2026-04-21T12:00:00.000Z');
    session.updater.emit('update-downloaded', { version: '0.3.2' });
    session.now = new Date('2026-04-21T12:00:02.060Z');
    await session.ipc.invoke('ok:update:relaunch-now');
    expect(session.state.attemptedInstallStagingAgeMs).toBe(2060);

    // A newer build lands and is committed by a plain quit — no click, so the
    // install of 0.3.3 has no request moment of its own. The quit itself is
    // what commits it, and stamping the handoff is what makes the next boot
    // judge the attempt rather than read it as one that never started.
    session.now = new Date('2026-04-21T13:00:00.000Z');
    session.updater.emit('update-downloaded', { version: '0.3.3' });
    handle.recordInstallHandoffOnQuit();
    expect(session.state.attemptedInstall).toBe('0.3.3');

    // 0.3.3 never took: the next boot is still on the old version.
    const { rig: nextBoot } = makeRig({ ...session.state });
    expect(nextBoot.logger.warn).toHaveBeenCalledWith(
      'attempted install did not take — surfacing failure notice',
      expect.objectContaining({ attempted: '0.3.3', stagingAgeMs: null }),
    );
  });

  // Once the install is reconciled as successful the age describes nothing —
  // leaving it set makes `state.json` self-contradictory for the triage read
  // the whole record exists to serve.
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

// ————————————————————————————————————————————————————————
// Cross-channel veto on update-available
// ————————————————————————————————————————————————————————
//
// electron-updater's GitHubProvider can deliver a stable manifest to a beta
// client when `beta-mac.yml` 404s on the latest release (the
// `beta-mac.yml`→`latest-mac.yml` cascade).
// Channels are install-time-sticky: a beta DMG only auto-updates to a newer
// beta DMG, a stable DMG only to a newer stable DMG. We enforce that at the
// app layer by setting `autoDownload = false` and gating `downloadUpdate()`
// on a channel-match check inside `onUpdateAvailable`.

describe('cross-channel veto on update-available', () => {
  test('beta build offered a stable version → veto records the check as successful (mirrors update-not-available)', () => {
    // The bug scenario: a stable v0.5.0 cut while a v0.5.0-beta.5 client is
    // running. electron-updater cascades and offers the stable version; our
    // gate vetoes the install.
    //
    // The check pipeline itself succeeded (manifest fetched + parsed); only
    // the install is gated by channel policy. Mirror `onUpdateNotAvailable`
    // and advance `lastSuccessfulCheckAt` so the 7-day stuck-hint gate
    // doesn't fire on a beta cohort during a long stable-only window. Seed
    // a prior ISO so the assertion pins ADVANCE-semantics (timestamp moved
    // forward to rig.now), not just the no-op default.
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
    // Regression for the false-stuck-hint scenario: a beta cohort during a
    // long stable-only release window receives only cross-channel offers.
    // The veto must advance `lastSuccessfulCheckAt` (per
    // `markCheckSucceeded`), so the 7-day stuck-hint gate stays disarmed
    // when a transient error lands. Without the advance, Toast C would
    // fire incorrectly: the updater is healthy, there's just nothing for
    // beta channel.
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
    // The download gate lives in `onUpdateAvailable` and is independent of
    // the menu-check feedback path; pin both behaviors so a future regression
    // that suppresses the veto when a menu check is in flight can't pass.
    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
  });

  test('empty version is treated as a veto (no download, check still recorded as successful)', () => {
    // Empty / non-string `info.version` from electron-updater is a malformed-
    // emitter case; classified by `classifyOffer` as `'empty-version'` which
    // hits the same veto branch as `'channel-mismatch'`. The check pipeline
    // still succeeded (we received the event), so `markCheckSucceeded` fires.
    const priorCheckAt = '2026-05-01T00:00:00.000Z';
    const { rig } = makeRig({ appVersion: '0.3.1', lastSuccessfulCheckAt: priorCheckAt });
    rig.updater.emit('update-available', {});
    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.dispatches).toContain('cross-channel-blocked' as DispatchKind);
    expect(rig.state.lastSuccessfulCheckAt).toBe(rig.now.toISOString());
  });
});

// ————————————————————————————————————————————————————————
// schemaVersion boot-incompatibility check. The pure
// helper is exhaustively unit-tested in tests/unit/state-store-channel-fields,
// but the AC asks the integration suite to also pin the contract that
// the auto-updater feature relies on so a regression in either side
// (helper drift, MAX bump without callsite update) surfaces here.
// ————————————————————————————————————————————————————————

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

// persist-before-emit ordering
// ————————————————————————————————————————————————————————

describe('persist-before-emit ordering (Finding #2)', () => {
  test('update-downloaded: writeState failure → NO Toast A dispatch', () => {
    const { rig, handle } = makeRig();
    handle.destroy(); // detach and re-wire with throwing writeState

    // Wire a fresh instance with writeState that always throws.
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
    // Gate did not arm → no toast dispatched
    expect(captured.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(0);
    expect(dispatches).not.toContain('update-downloaded-toast-a' as DispatchKind);
    expect(state.versionPendingInstall).toBeNull();
    expect(logger.error).toHaveBeenCalled();
    // A re-fire must get another shot (state still unarmed).
    expect(state.versionPendingInstall).toBeNull();
    // rig unused here — pin compile-time reference so TS doesn't complain about unused binding.
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

// ————————————————————————————————————————————————————————
// 6 events subscribed, 3 events NOT subscribed
// ————————————————————————————————————————————————————————

describe('event subscription surface (AC2)', () => {
  test('registers listeners for the six AC2 events', () => {
    const { rig } = makeRig();
    expect(rig.updater.listenerCount('checking-for-update')).toBe(1);
    // Two listeners on update-available: the primary handler (log +
    // markCheckSucceeded), and a separate menu-check feedback listener that
    // surfaces a result dialog when `ok:update:check-now` was the trigger.
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

// ————————————————————————————————————————————————————————
// Toast A dispatch + once-per-pending-version gate
// ————————————————————————————————————————————————————————

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
    // empty-version branch emits its own
    // DispatchKind so tests can observe the malformed-payload path.
    expect(rig.dispatches).toContain('update-downloaded-empty-version' as DispatchKind);
  });
});

// ————————————————————————————————————————————————————————
// error classification — silent log, no dispatch
// ————————————————————————————————————————————————————————

describe('error routing (AC3, D5)', () => {
  test.each(CLASSIFIED_CODES)('classified err.code %s → bracket log, no IPC dispatch', (code) => {
    const { rig } = makeRig();
    const err = Object.assign(new Error(`failure ${code}`), { code });
    rig.updater.emit('error', err);
    expect(rig.captured.some((c) => c.channel.startsWith('ok:update:error'))).toBe(false);
    // ERR_CHECKSUM_MISMATCH in the table doesn't start with ERR_UPDATER_ or
    // HTTP_ERROR_ — treats it as classified via an observed code
    // prefix but the module's `isClassifiedUpdaterError` is strict. Accept
    // the pragmatic outcome: strict prefix → unclassified, otherwise → classified.
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

// ————————————————————————————————————————————————————————
// stuck-hint gate
// ————————————————————————————————————————————————————————

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

    // First error — fires stuck-hint.
    rig.updater.emit('error', new Error('network'));
    const hint = rig.captured.filter((c) => c.channel === 'ok:update:stuck-hint');
    expect(hint).toHaveLength(1);
    expect(hint[0]?.payload).toEqual({ downloadUrl: STUCK_HINT_DOWNLOAD_URL });
    expect(rig.state.stuckHintShown).toBe(true);
    expect(rig.dispatches).toContain('stuck-hint-toast-c' as DispatchKind);

    // Second error — must NOT fire a second stuck-hint.
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

    // Simulate another 8-day silent window → error fires again.
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

// ————————————————————————————————————————————————————————
// first-launch version notice detection (Toast B)
// ————————————————————————————————————————————————————————

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

// ————————————————————————————————————————————————————————
// Boot-time stale-pending reconciliation: clear versionPendingInstall when the
// running version has caught up. Covers the install-on-quit cycle where
// autoInstallOnAppQuit applies the update without going through the relaunch-
// now IPC that clears the gate.
// ————————————————————————————————————————————————————————

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
    // Mirror the pattern — direct startAutoUpdater wiring with a
    // throwing writeState. The reconcile attempt MUST NOT fire onDispatch when
    // the write fails, because the on-disk state still contains the stale
    // value and the next boot needs another chance to clear it.
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

// ————————————————————————————————————————————————————————
// Boot-time failed-install detection. `attemptedInstall` records the
// version the app committed to install; at boot, if the running version did not
// reach it, the install silently failed (e.g. Squirrel.Mac's post-quit ShipIt
// never ran) and we surface the richer "Retry / Download manually" notice via
// the relaunch-failed channel with a downloadUrl. This is the ONLY detector for
// a clean-quit failure: the sync-throw path and the no-quit watchdog both need
// the process to still be alive.
// ————————————————————————————————————————————————————————

describe('boot-time failed-install detection', () => {
  // A handoff on record, far enough past the grace that nothing can still be
  // installing, so the detector speaks. The two complementary cases live in
  // their own describe block below: an attempt whose handoff is recent enough
  // that the install may still be in flight, and an attempt with NO handoff on
  // record at all — which no longer reaches this detector, because a stamp that
  // was never written means no install was ever started, and the boot re-offers
  // the staged update instead of judging it.
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
    // versionPendingInstall re-armed so the notice's Retry can re-trigger the
    // still-staged update through relaunch-now. attemptedInstall STAYS armed:
    // relaunch-now does not re-set it, so clearing here would make a second
    // (post-Retry) failure silent. It persists until the install actually takes.
    expect(rig.state.attemptedInstall).toBe('0.16.0-beta.3');
    expect(rig.state.versionPendingInstall).toBe('0.16.0-beta.3');
    expect(rig.dispatches).toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.dispatches).not.toContain('attempted-install-reconciled' as DispatchKind);
  });

  test('persistent failure across reboots keeps re-surfacing (attemptedInstall not consumed)', () => {
    // Simulate two boots on the old version with the same staged-but-failing
    // update: the failure notice must fire BOTH times (a broken ShipIt does not
    // self-heal). Shared mutable state mirrors a real state.json across boots.
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
    // Success reconcile also resets the surface counter for the next attempt.
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

  // Cross-channel residue: stable and beta builds share one state.json (same
  // appId/productName → same Electron userData dir), so a version armed by one
  // channel poisons the other channel's boot check — the running channel can
  // never reach it (cross-channel veto), so without this guard the card re-fires
  // every boot forever.
  test('cross-channel residue (stable attempted, beta running) → silently cleared, no notice', () => {
    // Higher-MMP stable attempted so the MMP-only stale-pending reconciliation
    // does NOT pre-clear versionPendingInstall; this exercises the cross-channel
    // branch's own clear of the stale pending marker.
    const { rig } = makeRig({
      attemptedInstall: '0.24.0',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      versionPendingInstall: '0.24.0',
      // Seeded so the clearing assertion below has teeth — a branch that
      // stops nulling it would leave a stale path for the Linux fallback.
      stagedInstallerPath: '/tmp/staged-cross-channel.deb',
      appVersion: '0.23.0-beta.1',
    });
    expect(rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(0);
    expect(rig.state.attemptedInstall).toBeNull();
    // The stale cross-channel pending marker is dropped too — no phantom
    // "ready to install" banner survives on the beta build.
    expect(rig.state.versionPendingInstall).toBeNull();
    expect(rig.state.stagedInstallerPath).toBeNull();
    expect(rig.dispatches).toContain('attempted-install-cross-channel' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.dispatches).not.toContain('attempted-install-reconciled' as DispatchKind);
  });

  test('cross-channel residue (beta attempted, older stable running) → silently cleared', () => {
    // Stable 0.22.0 has NOT reached beta 0.23.0-beta.5, so this is not a success
    // reconcile; the channels differ, so it is cross-channel residue, not a
    // same-channel failure notice.
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
    // Higher-MMP attempted than running (the phantom-banner case): the
    // MMP-only stale-pending reconciliation cannot clear versionPendingInstall,
    // so the giveup branch must clear it itself.
    const { rig } = makeRig({
      attemptedInstall: '0.17.0-beta.1',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      versionPendingInstall: '0.17.0-beta.1',
      // Seeded so the clearing assertion below has teeth.
      stagedInstallerPath: '/tmp/staged-giveup.deb',
      appVersion: '0.16.0-beta.1',
      attemptedInstallSurfacedCount: INSTALL_FAILURE_MAX_SURFACES,
    });
    expect(rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(0);
    expect(rig.state.attemptedInstall).toBeNull();
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
    // No phantom "ready to install" banner left behind after giving up.
    expect(rig.state.versionPendingInstall).toBeNull();
    expect(rig.state.stagedInstallerPath).toBeNull();
    expect(rig.dispatches).toContain('install-failed-giveup' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
  });

  test('surfaces exactly INSTALL_FAILURE_MAX_SURFACES times across reboots, then gives up', () => {
    // Shared mutable state mirrors a real state.json across boots (same as the
    // "persistent failure" test above, but carried to the cap).
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
    // Budget spent: give up, clear the record, no more cards.
    const giveup = boot();
    expect(giveup.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(
      0,
    );
    expect(giveup.dispatches).toContain('install-failed-giveup' as DispatchKind);
    expect(state.attemptedInstall).toBeNull();
    // Record cleared → the next boot is a no-op.
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
    // Boot surfaced the failure once more (1 → 2), record still armed.
    expect(rig.state.attemptedInstallSurfacedCount).toBe(2);
    // A newer beta downloads: a fresh attempt gets a fresh budget.
    rig.updater.emit('update-downloaded', { version: '0.16.0-beta.5' });
    expect(rig.state.attemptedInstall).toBe('0.16.0-beta.5');
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
  });

  test('update-downloaded of the SAME version preserves the surface counter', () => {
    // Models a re-download of the still-attempted version after relaunch-now
    // cleared versionPendingInstall. isPackaged:false skips the boot surface
    // branch (which would otherwise re-arm versionPendingInstall and trigger the
    // dedup path), isolating the arming preserve logic. Re-arming the SAME
    // version must NOT reset the budget, or a stuck install could nag forever.
    const { rig } = makeRig({
      isPackaged: false,
      attemptedInstall: '0.16.0-beta.3',
      attemptedInstallHandoffAt: COMMITTED_LONG_AGO,
      appVersion: '0.16.0-beta.1',
      attemptedInstallSurfacedCount: 2,
    });
    rig.updater.emit('update-downloaded', { version: '0.16.0-beta.3' });
    // versionPendingInstall becoming the version proves the arm ran (not a dev
    // no-op); the counter staying at 2 proves the same-version preserve.
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
    // Same guard the sibling branches carry: if a refactor ever moved
    // `state = next` outside the `persistSafely` gate, a failed disk write would
    // leave memory claiming the re-offer while `state.json` still holds the old
    // record — and the next boot would read back the very
    // record-claims-an-install-that-never-happened inconsistency this branch
    // exists to resolve.
    const captured: CapturedSend[] = [];
    const state: AppState = {
      ...emptyState(),
      lastSeenVersion: '0.16.0-beta.1',
      attemptedInstall: '0.16.0-beta.3',
      // The shape of the branch under test: armed, with no handoff ever stamped.
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
    // No toast either: a user offered a relaunch the state cannot back would
    // click into a gate that was never armed.
    expect(captured.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(0);
    // The record survives, so the next boot re-decides rather than losing it.
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
    // Symmetric with the failure-branch test: a write failure on the success
    // path must NOT clear attemptedInstall in memory, so the next boot
    // reconciles again. Guards against a refactor that moves `state = next`
    // outside the persistSafely gate.
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
    // The moment and the spent hold both date exactly one armed attempt. Every
    // branch that retires the attempt has to retire them alongside it, or the
    // record outlives the thing it describes: whatever reads it next is dating
    // an attempt that no longer exists, and the next attempt inherits a hold it
    // never spent. Seeded far enough in the past that the in-flight tolerance
    // cannot swallow the boot before it reaches the give-up branch.
    const STALE_HANDOFF = new Date('2026-04-20T12:00:00.000Z').getTime();

    // Reconciled as a success: the running version caught up to the attempt.
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

    // Cross-channel residue: this build can never reach the attempt at all.
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

    // Retry budget exhausted: the notice has said its piece and the record goes.
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

// ————————————————————————————————————————————————————————
// Boot-time failed-install detection vs. an install that may STILL BE RUNNING.
//
// On macOS the swap happens after the app exits, inside a separate ShipIt
// process, and it is not instantaneous — successful installs have been observed
// taking anywhere from ~1s to ~4.5 minutes. Reopening the app inside that window
// boots the OLD version, which is the EXPECTED state mid-install, not evidence
// of failure. It is also self-fulfilling: the reopen is what trips ShipIt's
// final "the target app is not running" check, and an aborted request re-stages,
// so the update being declared dead would have installed on the next quit.
//
// So the verdict has to separate "not reached, and no install for this attempt
// can still be running" from "not reached, install may still be in flight".
// These tests drive the commit through the production write paths
// (`update-downloaded`, then either the `relaunch-now` IPC handler or
// install-on-quit) and then boot, so they pin the OUTCOME rather than whichever
// record the handoff happens to leave behind.
// ————————————————————————————————————————————————————————

describe('boot-time failed-install detection — install still in flight', () => {
  const RUNNING = '0.53.0-beta.0';
  const ATTEMPTED = '0.54.0-beta.0';
  /** Download completes: the artifact is staged and the install is requestable. */
  const STAGED_AT = new Date('2026-08-12T00:24:18.000Z');
  /**
   * The handoff: ~16 min after staging the session ends and the install is
   * committed — by clicking "Relaunch now", or by quitting with install-on-quit
   * armed. Both paths reach it the same way, so the fixtures below share it.
   */
  const HANDED_OFF_AT = new Date('2026-08-12T00:40:04.000Z');
  const SECOND = 1_000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;

  /**
   * The pre-update session: stage the update, then end the session the way that
   * commits the install — the "Relaunch now" click, or a plain quit that
   * install-on-quit commits on. `'unobserved-quit'` ends the session without
   * either, which is the session that commits NOTHING: a Windows shutdown (the
   * dominant shape — it terminates the process without `will-quit`, so
   * install-on-quit never fires), a force-quit, or a power loss. It also stands
   * in for the two benign ways a real commit arrives unstamped: a `state.json`
   * from a build predating the quit stamp, and a quit whose stamp write failed.
   * Returns the `state.json` that boot reads.
   *
   * `overrides` moves the version pair and the commit moment off the defaults —
   * the two dimensions that change which route through boot the fixture takes.
   */
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

  /** The reopen: a fresh boot on the pre-update version at a given wall clock. */
  function reopenAt(state: AppState, at: Date, running: string = RUNNING): TestRig {
    const { rig } = makeRig({ ...state, appVersion: running, platform: 'darwin', nowAt: at });
    return rig;
  }

  const failureCards = (rig: TestRig): CapturedSend[] =>
    rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed');

  /** The ordinary ready-to-install offer — Toast A's channel. */
  const reofferCards = (rig: TestRig): CapturedSend[] =>
    rig.captured.filter((c) => c.channel === 'ok:update:downloaded');

  /**
   * A reopen the user does not stay in: boot, let the launch check re-fire
   * electron-updater's cached `update-downloaded`, then quit — which commits
   * the same staged artifact all over again. `reopenAt` models the boots that
   * only need a verdict; this models the cycle someone waiting on an install
   * actually produces, where the re-fire and the quit between two boots rewrite
   * the timing a verdict would otherwise reason from.
   */
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
    // The canonical shape the deferral exists for: a reopen a minute after the
    // click, well inside the tolerance, while the swap is still running.
    const rig = reopenAt(
      await stageAndCommit('relaunch-click'),
      new Date(HANDED_OFF_AT.getTime() + 62 * SECOND),
    );

    expect(failureCards(rig)).toHaveLength(0);
    // The deferral branch specifically, not merely the absence of a verdict:
    // an accidental no-op that reached neither branch would satisfy every
    // assertion below.
    expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    // Nothing about the attempt is consumed: the banner gate stays clear (the
    // click cleared it, and there is no failure to offer a Retry for yet) and
    // the surfacing budget is untouched.
    expect(rig.state.versionPendingInstall).toBeNull();
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
    // The record stays armed — the verdict is deferred, not decided. A later
    // boot still reconciles it, as success or as failure.
    expect(rig.state.attemptedInstall).toBe(ATTEMPTED);
  });

  test('reopened deep in the observed install-duration range → still no failure verdict', async () => {
    // Field installs have run to ~4.5 minutes, and the slow tail is exactly the
    // population with time to get impatient and reopen, so the deferral has to
    // cover the tail rather than the median.
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
    // The detector's whole purpose, preserved. A day on, nothing is installing,
    // so a still-old running version is a genuinely failed install.
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
    // Install-on-quit commits without a click, so the quit itself is the
    // handoff — the last moment a live process can record before the swap moves
    // into a process no later boot can see.
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
    // The dominant commit path: an update downloads quietly in the background,
    // the user works on for hours, then quits and reopens a minute later.
    // Reasoning from the staging moment would have spent the whole tolerance on
    // the working session and condemned an install that was one minute old.
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
    // Both commit points persist the handoff stamp BEFORE handing anything to
    // an installer: `relaunch-now` writes it and returns early if that write
    // fails, and `recordInstallHandoffOnQuit` runs from `before-quit`, ahead of
    // the swap. So a null stamp is not "we lost track of when the install
    // began" — it is "no install ever began", which deserves a different answer
    // than a failure verdict.
    //
    // But it is asked SECOND, after the in-flight grace, and the ordering is
    // load-bearing: electron-updater re-arming `update-downloaded` from its
    // on-disk cache clears the stamp, so a null one can coexist with an install
    // genuinely in flight. Re-offering into that would hand the user a relaunch
    // that aborts the swap already running. Once the grace is spent nothing can
    // still be installing, and what the state describes is simply an update
    // sitting staged — so the honest response is the ordinary offer, not a
    // failure notice. The sibling test below pins the deferral that guards this.
    const rig = reopenAt(
      await stageAndCommit('unobserved-quit'),
      new Date(STAGED_AT.getTime() + 2 * HOUR),
    );

    expect(rig.dispatches).toContain('install-never-committed-reoffered' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-in-flight-deferred' as DispatchKind);
    expect(failureCards(rig)).toHaveLength(0);
    // The user-visible half: the staged artifact goes back on offer through the
    // ordinary consented path, which means the same toast the download would
    // have raised.
    expect(reofferCards(rig)).toHaveLength(1);
    expect(reofferCards(rig)[0]?.payload).toEqual({ version: ATTEMPTED });
    expect(rig.state.versionPendingInstall).toBe(ATTEMPTED);
    // `attemptedInstall` stays ARMED. On non-Linux the click does not arm it —
    // only the Linux spread does — so this is the record the post-click failure
    // path reads. Withdrawing it would disarm failed-install detection for the
    // very click this branch exists to offer.
    expect(rig.state.attemptedInstall).toBe(ATTEMPTED);
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
  });

  test('a never-committed attempt inside the grace defers rather than re-offering', async () => {
    // The ordering guard. `update-downloaded` re-arming from electron-updater's
    // on-disk cache clears the handoff stamp, so a null stamp can coexist with
    // an install that is genuinely mid-flight. Asking "was one ever handed off"
    // BEFORE "could one still be running" would re-offer into that install, and
    // the relaunch the user then clicked would abort the swap already underway.
    //
    // Nothing else in the suite fails if the two arms are swapped back: the
    // deferral tests still see their dispatch, because the re-offer arm would
    // simply never be reached in their fixtures.
    const rig = reopenAt(
      await stageAndCommit('unobserved-quit'),
      new Date(STAGED_AT.getTime() + 45 * SECOND),
    );

    expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-never-committed-reoffered' as DispatchKind);
    // The decisive one: no relaunch is offered while a swap may be running.
    expect(reofferCards(rig)).toHaveLength(0);
    expect(failureCards(rig)).toHaveLength(0);
  });

  test('a session that recorded no handoff never becomes a failure verdict, however long ago', async () => {
    // The win32 shape this exists for: Windows ends the session with
    // `WM_ENDSESSION` and terminates without running `will-quit`, so
    // install-on-quit never fires and nothing is handed off. A user who shuts
    // the machine down rather than quitting the app hits this every time, and
    // age is not what distinguishes it — a day-old never-started install is
    // exactly as un-started as a minute-old one.
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
    // The stranding mechanism, pinned. Charging a never-started install against
    // `INSTALL_FAILURE_MAX_SURFACES` means that after three OS shutdowns the
    // record is dropped and the user is told nothing at all — while the update
    // is still sitting on disk. Whatever the offer is, it has to survive more
    // boots than the failure budget allows.
    let state = await stageAndCommit('unobserved-quit');
    for (let boot = 1; boot <= 4; boot += 1) {
      const rig = reopenAt(state, new Date(STAGED_AT.getTime() + boot * 24 * HOUR));
      expect(failureCards(rig)).toHaveLength(0);
      expect(rig.dispatches).not.toContain('install-failed-giveup' as DispatchKind);
      expect(reofferCards(rig)).toHaveLength(1);
      expect(rig.state.versionPendingInstall).toBe(ATTEMPTED);
      // No re-arming between boots: each one ends the same way the last did, so
      // the state this boot leaves behind IS the next boot's starting state.
      // That the loop needs no help is the point — the offer repeats on its own.
      state = rig.state;
    }
  });

  test('a re-offer taken and then failing still produces a failure verdict on the next boot', async () => {
    // The hazard in keeping the two records separate: the click is the only
    // thing that turns a re-offer into a real attempt, and on non-Linux it does
    // not arm `attemptedInstall` itself. If the boot that re-offers had
    // withdrawn that record, this sequence would end in silence — no notice, no
    // manual-download URL — and the staged-cache reclaim would delete the
    // artifact the user is still waiting on.
    const reoffered = reopenAt(
      await stageAndCommit('unobserved-quit'),
      new Date(STAGED_AT.getTime() + 24 * HOUR),
    );
    expect(reoffered.dispatches).toContain('install-never-committed-reoffered' as DispatchKind);

    // The user takes the offer. This is the moment the attempt becomes real: the
    // click stamps the handoff, so the next boot judges it rather than
    // re-offering.
    reoffered.now = new Date(STAGED_AT.getTime() + 24 * HOUR + MINUTE);
    await reoffered.ipc.invoke('ok:update:relaunch-now');
    expect(reoffered.state.attemptedInstallHandoffAt).not.toBeNull();

    // ...and the install does not land. A day on, nothing is installing.
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
    // The artifact survives: an install commitment is still armed, so the
    // reclaim must not delete what the Retry needs.
    expect(reclaim).not.toHaveBeenCalled();
  });

  test('the re-arm is what restores an offer the stale-pending reconciliation cleared', async () => {
    // Same-MMP beta: the boot's stale-pending reconciliation nulls
    // `versionPendingInstall` before the attempt is judged, so here the re-arm
    // is doing real work rather than restating what `...state` already carried.
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
    // Guard against the fix over-reaching. The discriminator is whether a
    // handoff was recorded, NOT how old it is: a real commit inside the grace
    // still defers, and the same commit a day later still fails.
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
    // The uninstall path turns install-on-quit off so Squirrel cannot swap the
    // bundle out from under the helper trying to trash it. That quit installs
    // nothing, so it must not record a handoff — and a boot that then reads the
    // record would defer a verdict for an install that was never handed off.
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
    // The tolerance has to terminate, or a broken installer plus a user who
    // reopens promptly after every quit would defer forever and the notice
    // would never arrive. The moment is stamped once per staging, so the second
    // quit measures from the first handoff — and by then the first attempt has
    // demonstrably not landed, which is what the notice says.
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
    // Two impatient reopens during the install window, then a boot long after.
    // If a deferral spent budget the real failure would arrive part-spent, and
    // at the cap it would never arrive at all — the notice would be silenced by
    // the very impatience that triggered the abort.
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
    // Elapsed time alone cannot end the hold, because nothing about the timing
    // ages across a reopen: electron-updater re-fires the cached
    // `update-downloaded` on every launch check, the re-arm clears the recorded
    // handoff, and the next quit stamps a new one. So a broken install plus a
    // user who reopens within the tolerance every time is deferred on the
    // timing forever, and the notice the whole detector exists to deliver never
    // arrives. Something has to count the holds and stop them.
    //
    // Driven on a same-major.minor.patch beta bump — the dominant shape an OK
    // update takes, and the one where the re-fire re-arms on EVERY boot: the
    // stale-pending reconciliation compares major.minor.patch only, so each
    // boot strips the pending gate the dedupe would otherwise catch on.
    const RUNNING_BETA = '0.54.0-beta.0';
    const ATTEMPTED_BETA = '0.54.0-beta.1';
    const versions = { running: RUNNING_BETA, attempted: ATTEMPTED_BETA };

    let state = await stageAndCommit('relaunch-click', versions);
    let reopenedAt = new Date(HANDED_OFF_AT.getTime() + 45 * SECOND);
    // Three reopens, each one inside the tolerance and each one leaving behind
    // a handoff moment seconds old. On the timing they are indistinguishable
    // from the healthy mid-install reopens above.
    for (let cycle = 1; cycle <= 3; cycle++) {
      const rig = reopenAndQuit(state, reopenedAt, versions);
      expect(failureCards(rig)).toHaveLength(0);
      expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
      expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
      // The premise the bound exists for. If a future change makes the re-fire
      // dedupe here, the handoff would age by itself and these cycles would
      // stop exercising the hazard.
      expect(rig.dispatches).not.toContain('update-downloaded-deduped' as DispatchKind);
      expect(rig.state.attemptedInstallHandoffAt).toBe(reopenedAt.getTime() + 20 * SECOND);
      state = rig.state;
      reopenedAt = new Date(reopenedAt.getTime() + 1 * MINUTE);
    }

    // The next reopen is timed exactly like the three before it, and it is the
    // one that finally tells the user.
    const reported = reopenAt(state, reopenedAt, RUNNING_BETA);
    expect(failureCards(reported)).toHaveLength(1);
    expect(failureCards(reported)[0]?.payload).toEqual({
      version: ATTEMPTED_BETA,
      downloadUrl: STUCK_HINT_DOWNLOAD_URL,
    });
    expect(reported.dispatches).toContain('install-failed-on-boot' as DispatchKind);
    expect(reported.dispatches).not.toContain('install-in-flight-deferred' as DispatchKind);
    expect(reported.state.attemptedInstallSurfacedCount).toBe(1);
    // And it fired for the right reason: the handoff on record was 40 seconds
    // old, deep inside the window every earlier boot deferred on. The verdict
    // came from the exhausted hold, not from a clock that finally ran out.
    expect(reported.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('did not take'),
      expect.objectContaining({ handoffAgeMs: 40 * SECOND }),
    );
  });

  test('a boot that cannot record the hold still holds', async () => {
    // The deferral is the only branch here that persists without deciding
    // anything, so a failed write has to leave the boot where it started rather
    // than promote it to a verdict: an install that may be seconds from landing
    // must not be condemned because the disk was full. The cost is that the
    // bound does not advance on this boot, which the deferral log carries.
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
    // The hold is spent per attempt. A re-arm of the version already being
    // attempted is the same install being committed again, so it inherits what
    // its predecessors spent — that inheritance IS the bound, since the re-arm
    // is what wipes the handoff moment. A genuinely new version is a different
    // install, and starts from a full hold: charging it for the last one's
    // failures would condemn a healthy install mid-swap.
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
    // The hold is spent: another reopen on this attempt would report it.
    expect(failureCards(reopenAt(state, reopenedAt, RUNNING_BETA))).toHaveLength(1);

    // A newer version arrives and is committed by the quit that follows.
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

    // Reopened mid-swap, exactly like the impatient reopens the deferral was
    // built for — and it is deferred, because this attempt has its own hold.
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
    // `Date.now()` is wall-clock, not monotonic: an NTP correction or a VM
    // resume between the handoff and the boot can leave the recorded moment in
    // the future. A negative elapsed time is unknown timing rather than a fresh
    // install, and unknown must not silence the detector — the same coercion
    // the staging age already makes on the write side.
    const rig = reopenAt(
      await stageAndCommit('relaunch-click'),
      new Date(HANDED_OFF_AT.getTime() - 1 * HOUR),
    );

    expect(failureCards(rig)).toHaveLength(1);
    expect(rig.dispatches).toContain('install-failed-on-boot' as DispatchKind);
  });

  test('same-MMP beta bump committed by a plain quit → no failure verdict', async () => {
    // A beta-to-beta bump inside one major.minor.patch is the dominant shape an
    // OK update takes, and it reaches the verdict by a different route than the
    // fixtures above. The boot's stale-pending reconciliation compares
    // major.minor.patch only, so a running 0.54.0-beta.0 reads as having caught
    // up to a pending 0.54.0-beta.1 and the staging stamp is cleared — while the
    // prerelease-aware verdict immediately after still sees an install that
    // never landed. Whatever the verdict reasons from has to survive that clear,
    // or this path goes on condemning healthy installs after every other path
    // is fixed.
    const RUNNING_BETA = '0.54.0-beta.0';
    const ATTEMPTED_BETA = '0.54.0-beta.1';
    const rig = reopenAt(
      await stageAndCommit('plain-quit', { running: RUNNING_BETA, attempted: ATTEMPTED_BETA }),
      new Date(HANDED_OFF_AT.getTime() + 45 * SECOND),
      RUNNING_BETA,
    );

    // The premise: this boot really does take the clearing path. If a future
    // change stops it firing here, the fixture has drifted off the hazard and
    // the assertions below would pass for the wrong reason.
    expect(rig.dispatches).toContain('stale-pending-cleared' as DispatchKind);

    expect(failureCards(rig)).toHaveLength(0);
    expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
    expect(rig.state.attemptedInstall).toBe(ATTEMPTED_BETA);
  });

  test('an unobserved commit on a same-MMP beta bump still defers', async () => {
    // The intersection the two fixtures above each leave open, and the only
    // state where the pre-clear staging snapshot is load-bearing. The
    // stale-pending reconciliation nulls `versionPendingInstallStagedAt` on an
    // MMP-only compare, and an unobserved quit means nothing ever stamped
    // `attemptedInstallHandoffAt` — so the moment the artifact was staged
    // survives ONLY in the snapshot taken before that clear. A verdict that
    // reads the field off the reconciled state instead has no bound left at all
    // and condemns an install that is still running.
    //
    // Neither sibling fixture reaches here: the staging-fallback one uses the
    // default version pair, so the clear never fires; the same-MMP one commits
    // by a plain quit, so the handoff is stamped and the fallback is never
    // consulted.
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

    // Both premises, asserted so the test cannot drift off the hazard and start
    // passing for the wrong reason.
    expect(rig.dispatches).toContain('stale-pending-cleared' as DispatchKind);
    expect(rig.state.attemptedInstallHandoffAt).toBeNull();

    expect(failureCards(rig)).toHaveLength(0);
    expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(rig.dispatches).not.toContain('install-failed-on-boot' as DispatchKind);
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
    // WHICH moment the hold leaned on, not merely that it held. Without this the
    // fixture would pass on a verdict that deferred off some other bound, which
    // is exactly the failure it exists to catch.
    expect(rig.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('defer'),
      expect.objectContaining({ recordedHandoff: false, handoffAt: STAGED_AT.getTime() }),
    );
  });

  // The unobserved-quit counterpart of the second-reopen fixture below. Boot 1's
  // stale-pending clear nulls the staging stamp on disk, and an unobserved quit
  // stamps no handoff, so boot 2 reads both witnesses as null and condemns an
  // install that may still be running. Left as a todo rather than a skip: the
  // fixture cannot be written honestly until the staging instant lives in a
  // field no reconciliation clears, which needs a parseAppState schema addition.
  test.todo(
    'an unobserved commit on a same-MMP beta bump survives a SECOND reopen (needs PRD-8291)',
  );

  test('a same-MMP beta bump survives a SECOND reopen inside the window', async () => {
    // The same-MMP shape reaches the verdict having just lost a field: the
    // stale-pending reconciliation fires on an MMP-only compare and persists the
    // staging stamp as null, so every boot after the first one reads a state
    // the first boot already stripped. Impatience is repetitive — the user who
    // reopens once mid-install reopens again — so a tolerance that only holds
    // for one boot condemns the same healthy install on the next.
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
    // The artifact sits staged for however long the user leaves the notice
    // alone — three hours here, unbounded in general. Reasoning from the staging
    // moment makes the tolerance a function of the user's patience rather than
    // of how long an install takes: a click that landed sixty seconds ago gets
    // condemned because the download happened this morning.
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
    // A deferred boot is silent to the user by design, so this line is the only
    // place an operator reading a "my update never installed" report can see
    // that the boot considered the attempt and how long ago the handoff was —
    // the number that separates a verdict held too eagerly from one held
    // correctly. The derived age alone cannot be audited: the moment it was
    // measured from has to travel with it.
    //
    // The line no longer says WHICH moment, because there is only one it can be:
    // a boot with no handoff on record never reaches the deferral at all.
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
    // The tolerance has to clear the observed install tail with real margin
    // rather than just cover the median: measured installs have run to about
    // four and a half minutes on one machine, and the slow tail — a large bundle
    // competing for I/O, or being scanned on first launch — is exactly the
    // population that both runs long and gets reopened impatiently.
    const rig = reopenAt(
      await stageAndCommit('relaunch-click'),
      new Date(HANDED_OFF_AT.getTime() + 10 * MINUTE),
    );

    expect(failureCards(rig)).toHaveLength(0);
    expect(rig.dispatches).toContain('install-in-flight-deferred' as DispatchKind);
    expect(rig.state.attemptedInstallSurfacedCount).toBe(0);
  });

  test('a boot two hours after the handoff fires the notice', async () => {
    // The other side of the same calibration. Nothing is still installing two
    // hours on, and a tolerance wide enough to swallow a working session would
    // defeat the detector for the people it exists for: someone who quits to
    // install in the morning and reopens through the day would be told nothing
    // all day. Brackets the tolerance from above without pinning its value, so
    // it can be recalibrated from field reports within the bracket.
    const rig = reopenAt(
      await stageAndCommit('relaunch-click'),
      new Date(HANDED_OFF_AT.getTime() + 2 * HOUR),
    );

    expect(failureCards(rig)).toHaveLength(1);
    expect(rig.dispatches).toContain('install-failed-on-boot' as DispatchKind);
  });

  test('a re-armed artifact records its own handoff instead of inheriting the last one', async () => {
    // A handoff moment dates one artifact's install. When a second artifact
    // arrives, the moment recorded for the first has to go with the staging it
    // belonged to: left in place, the once-per-attempt guard reads it as "this
    // attempt already handed off", so the quit that actually commits the new
    // install never stamps anything and the new install is dated to whenever the
    // OLD one was committed — by then old enough to be condemned on reopen.
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

    // Which is what leaves the quit that commits the new artifact free to stamp
    // its own moment.
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

// ————————————————————————————————————————————————————————
// Pure-helper unit tests for versionAtLeast — the MMP compare used by the
// boot-time reconciliation. Covers parse-shape correctness and the malformed-
// returns-false contract that keeps a parse failure from dropping a genuinely
// staged update.
// ————————————————————————————————————————————————————————

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

// ————————————————————————————————————————————————————————
// Multi-window delivery: the relaunch banner (Toast A) fans out to EVERY
// open window; the "updated to version" notice (Toast B) stays single-window
// ————————————————————————————————————————————————————————

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
    // Fan-out is delivery-only: one state write, one dispatch — not N.
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
    // Every window gets the notice — the cross-window dismiss makes fanning it
    // out safe (dismissing in one clears all).
    for (const win of rig.windows) {
      const whatsNew = win.filter((c) => c.channel === 'ok:update:whats-new');
      expect(whatsNew).toHaveLength(1);
      expect(whatsNew[0]?.payload).toMatchObject({ version: '0.3.1' });
    }
    // Fan-out is delivery-only: one dispatch, not N.
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

// ————————————————————————————————————————————————————————
// Release-notes cross-window dismiss + late-window delivery
// ————————————————————————————————————————————————————————

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

// ————————————————————————————————————————————————————————
// periodic check singleton + jitter
// ————————————————————————————————————————————————————————

describe('periodic check singleton + jitter (AC10, D10)', () => {
  test('registers exactly one timer after the first launch check resolves', async () => {
    const { rig } = makeRig();
    // The module awaits checkForUpdates().then(startPeriodicChecks).
    // Yield the event loop so that the then-callback fires.
    await rig.updater.checkForUpdates();
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.clock.setTimeout).toHaveBeenCalledTimes(1);
    // makeRig's default RNG is `() => 0`, so the scheduled delay is the
    // exact base-interval floor with no jitter.
    expect(rig.clock.lastMs).toBe(UPDATE_CHECK_INTERVAL_MS);
  });

  test('scheduled delay = UPDATE_CHECK_INTERVAL_MS + floor(random() * UPDATE_CHECK_JITTER_MS)', async () => {
    // Half the jitter window — exact, deterministic.
    const half = makeRig({ random: () => 0.5 });
    await half.rig.updater.checkForUpdates();
    await Promise.resolve();
    await Promise.resolve();
    expect(half.rig.clock.lastMs).toBe(
      UPDATE_CHECK_INTERVAL_MS + Math.floor(0.5 * UPDATE_CHECK_JITTER_MS),
    );
    expect(half.rig.clock.lastMs).toBeGreaterThan(UPDATE_CHECK_INTERVAL_MS);

    // Top of the jitter window — still strictly below interval + jitter
    // (jitter is `[0, JITTER)`, never the full JITTER).
    const top = makeRig({ random: () => 0.999_999 });
    await top.rig.updater.checkForUpdates();
    await Promise.resolve();
    await Promise.resolve();
    expect(top.rig.clock.lastMs).toBeGreaterThanOrEqual(UPDATE_CHECK_INTERVAL_MS);
    expect(top.rig.clock.lastMs).toBeLessThan(UPDATE_CHECK_INTERVAL_MS + UPDATE_CHECK_JITTER_MS);
  });

  test('jitter is re-drawn on every fire (no fleet lockstep)', async () => {
    // RNG returns a fresh value each call → each reschedule gets a new delay.
    const values = [0, 0.25, 0.75, 0.5];
    let i = 0;
    const { rig } = makeRig({ random: () => values[i++ % values.length] ?? 0 });
    await rig.updater.checkForUpdates();
    await Promise.resolve();
    await Promise.resolve();
    const observed: Array<number | null> = [rig.clock.lastMs];
    // Fire the timer a few times; each tick re-schedules with a fresh jitter.
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
    // Still a single timer at any instant — re-scheduling replaces, it does
    // not accumulate. setTimeout was called once per (re)schedule: initial + 3.
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
    // The tick re-schedules itself so the cadence continues.
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
    // Hourly: the beta manifest poll resolves through a proxy that calls
    // GitHub's unauthenticated List Releases API on a shared IP budget, so
    // poll frequency is rate-limit-sensitive. See the constant's JSDoc.
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000);
    // Jitter: 5 min, pinned as the steady-state target. Still a small fraction
    // of the base interval so "hourly" roughly holds, wide enough to break
    // fleet lockstep.
    expect(UPDATE_CHECK_JITTER_MS).toBe(5 * 60 * 1000);
    expect(UPDATE_CHECK_JITTER_MS).toBeLessThan(UPDATE_CHECK_INTERVAL_MS);
  });

  /**
   * Regression.
   *
   * `startAutoUpdater` kicks off with `updater.checkForUpdates()` and in its
   * .catch() still calls `startPeriodicChecks()` so a transient first-launch
   * failure (network down at boot, 404 on the manifest) doesn't leave the
   * user stuck without auto-update for the entire session. Without this
   * test, a refactor that early-returns on the catch path — or deletes the
   * .catch entirely and falls through to the default rejection handler —
   * would silently break the recovery guarantee and only be caught by real
   * users on flaky networks.
   */
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
    // Let both the rejected promise + the chained .catch() run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(clock.setTimeout).toHaveBeenCalledTimes(1);
    expect(clock.lastMs).toBe(UPDATE_CHECK_INTERVAL_MS);
    expect(logger.debug).toHaveBeenCalled();
  });
});

// ————————————————————————————————————————————————————————
// ok:update:relaunch-now IPC handler
// ————————————————————————————————————————————————————————

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
    // The screenshot bug: clicking Relaunch in one window left the others
    // showing a stale "…ready to install [Relaunch]" banner. The commit fans a
    // relaunching signal to every window so they all swap to the in-progress
    // card. Delivery-only fan-out: one dispatch, not N.
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
    // Failure recovery for the cross-window swap: after the relaunching
    // broadcast, every window shows a button-less, non-dismissible
    // "Relaunching…" card. Only the clicked window has a rejection handler,
    // so main must re-arm the others — restore versionPendingInstall and
    // re-broadcast the downloaded banner (same notice id replaces the stuck
    // card in place), then rethrow for the clicked window's error notice.
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
    // The restored gate makes a retry click work end-to-end.
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
    // Windows must swap to "Relaunching…" at the START of the relaunch, not
    // after the up-to-10s server teardown — otherwise the stale banner lingers
    // for those seconds (the exact symptom). Assert the broadcast is already
    // captured by the time the teardown hook is invoked.
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

  test('prepareForRelaunch fires BEFORE quitAndInstall — utility kill ordering', async () => {
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
      // prepareForRelaunch is now awaited by the handler so a two-phase
      // shutdown (SIGTERM → poll → SIGKILL via `stopAllOwnedServers`) can
      // complete before `quitAndInstall`. Returning a resolved Promise keeps
      // this test exercising the async path.
      prepareForRelaunch: async () => {
        calls.push('prepareForRelaunch');
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
    expect(calls).toEqual(['prepareForRelaunch', 'quitAndInstall']);
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
});

// ————————————————————————————————————————————————————————
// Async relaunch-failure surfacing: error-event fast path + no-quit watchdog
// ————————————————————————————————————————————————————————

describe('async relaunch failure — error event + no-quit watchdog', () => {
  test('clean quitAndInstall return arms the watchdog at RELAUNCH_WATCHDOG_MS (packaged)', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    // Drain the boot microtask (checkForUpdates().then(startPeriodicChecks))
    // FIRST so the single-slot fake clock's last-timer tracking points at the
    // watchdog armed below, not the periodic-check timer.
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.clock.lastMs).toBe(UPDATE_CHECK_INTERVAL_MS);
    await rig.ipc.invoke('ok:update:relaunch-now');
    // The single-slot fake clock now tracks the watchdog (armed after the
    // boot-time periodic check was scheduled).
    expect(rig.clock.lastMs).toBe(RELAUNCH_WATCHDOG_MS);
    expect(rig.clock.lastCallback).not.toBeNull();
  });

  test('watchdog fire → state restored + every window re-armed + relaunch-failed broadcast', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', extraWindowCount: 1 });
    // Drain the boot microtask (checkForUpdates().then(startPeriodicChecks))
    // FIRST so the single-slot fake clock's last-timer tracking points at the
    // watchdog armed below, not the periodic-check timer.
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
    // Drain the boot microtask (checkForUpdates().then(startPeriodicChecks))
    // FIRST so the single-slot fake clock's last-timer tracking points at the
    // watchdog armed below, not the periodic-check timer.
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
    // Dispatch is intentionally additive: the same error also takes the
    // generic error path (operator log) — 'relaunch-error-event' reports the
    // recovery, not a replacement.
    expect(rig.dispatches.filter((d) => d === 'error-unclassified')).toHaveLength(1);
    // failRelaunch cleared the watchdog — the single-slot fake clock nulls
    // its tracked callback on a matching clearTimeout, so no later "fire"
    // can double-report the same failure.
    expect(rig.clock.lastCallback).toBeNull();
    expect(rig.dispatches).not.toContain('relaunch-watchdog-fired' as DispatchKind);
  });

  test('error dispatched SYNCHRONOUSLY inside quitAndInstall (Linux pkexec cancel) fast-fails with the real cause, not the watchdog timeout', async () => {
    // electron-updater's DebUpdater/RpmUpdater spawnSync the package manager
    // inside quitAndInstall and dispatch failures through the `error` event
    // BEFORE it returns (no throw). The in-flight gate must already be armed
    // at that point — armed-after would leave this path unreachable and the
    // user waiting out the watchdog for a misleading "the update timed out".
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
    // failRelaunch cleared the just-armed watchdog — no later fire can
    // double-report the same failure as a timeout.
    expect(rig.clock.lastCallback).toBeNull();
    expect(rig.dispatches).not.toContain('relaunch-watchdog-fired' as DispatchKind);
  });

  test('CLASSIFIED error while in flight → additive error-classified + relaunch-error-event', async () => {
    // Pins the additive invariant on the classified branch too: a future
    // refactor that calls failRelaunch only from the unclassified else-arm
    // would silently drop recovery for ERR_UPDATER_* / HTTP_ERROR_* failures.
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
    // The realistic Squirrel sequence for a slow failure: the no-quit
    // watchdog declares the relaunch failed at 15s, then ShipIt's error
    // event trickles in later. The watchdog's failRelaunch disarmed the
    // in-flight gate, so onError must treat the late error as an ordinary
    // updater error — exactly one relaunch-failed notice per attempt, and
    // the surviving notice keeps the watchdog's message.
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
    // The split is deliberate: the downloaded re-arm follows
    // persist-before-emit (skipped when the restore write fails), but the
    // failure notice is unconditional — the user must learn the relaunch
    // failed even on a failing disk. Pin it so a refactor can't fold the
    // failure broadcast into the persist-gated block.
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
    // With no re-arm to replace it, every window is still on the shared
    // in-progress card, which has no action and no dismiss — so the failure
    // has to carry the instruction to clear it.
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
    // Dev boot never schedules the periodic check either, so the single-slot
    // clock saw no setTimeout at all.
    expect(rig.clock.lastCallback).toBeNull();
    // And a later updater error is NOT misattributed to a relaunch.
    rig.updater.emit('error', new Error('dev error'));
    expect(rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed')).toHaveLength(0);
  });

  test('destroy() clears the armed watchdog', async () => {
    const { rig, handle } = makeRig({ versionPendingInstall: '0.3.2' });
    // Drain the boot microtask (checkForUpdates().then(startPeriodicChecks))
    // FIRST so the single-slot fake clock's last-timer tracking points at the
    // watchdog armed below, not the periodic-check timer.
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
  test('update-not-available after menu-check fires not-available result', () => {
    const showCheckNowResult = vi.fn(() => {});
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
    const showCheckNowResult = vi.fn(() => {});
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
    const showCheckNowResult = vi.fn(() => {});
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
    // electron-updater's GitHubProvider raises this code when the channel
    // manifest 404s on the latest matching release. Residual triggers
    // (the steady-state release-cut race is closed by the --draft +
    // promote-after-upload workflow flow):
    //   - ~60s .atom-feed propagation delay after draft→published flip
    //   - Real-world transient errors (5xx, network, asset-CDN latency)
    //   - Manual rollbacks or out-of-band release edits
    // The provider's allowPrerelease fallback also tries `latest-mac.yml`,
    // so the final 404 names `latest-mac.yml` even on the beta channel.
    // Functionally: there is no installable update right now → surface the
    // friendly "up to date" dialog instead of a scary HTTP-404 dump.
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
    // Lock the narrow scope: only ERR_UPDATER_CHANNEL_FILE_NOT_FOUND gets
    // remapped. Other classified codes (HTTP_ERROR_500, ZIP_FILE_NOT_FOUND,
    // CHECKSUM_MISMATCH, …) still surface as error dialogs — they describe
    // real failures, not a transient empty-release state.
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
    rig.ipc.invoke('ok:update:check-now');
    // Wait for the .catch handler in runMenuDrivenCheck to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(showCheckNowResult).toHaveBeenCalledWith({
      kind: 'error',
      message: 'feed not reachable',
    });
  });

  test('checkForUpdates synchronous reject with ERR_UPDATER_CHANNEL_FILE_NOT_FOUND routes to not-available', async () => {
    // Defends against a future electron-updater that delivers
    // ERR_UPDATER_CHANNEL_FILE_NOT_FOUND via promise rejection instead of the
    // `error` event. The shared `buildCheckNowResultFromError` helper keeps
    // both paths aligned. Today this path is rare (the error normally lands
    // on the event bus), but the unit test pins the contract so a refactor
    // that drops the helper's special-case fails loud.
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

// `buildCheckNowResultFromError` is the shared helper used by BOTH the
// `error` event handler (`onError`) and the synchronous-reject `.catch` in
// `runMenuDrivenCheck`. Unit-test the helper directly so the contract is
// pinned independently of either call-site's wiring — keeping the remap
// centralized prevents the two paths from drifting in a future change.
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

// The application-menu "Check for Updates…" entry goes through
// `handle.checkForUpdatesNow()` (NOT the IPC), and must surface the same
// result dialog as the IPC path. Both delegate to `runMenuDrivenCheck`, so the
// per-outcome behavior (available / not-available / error / sync-reject) is
// already covered by the `ok:update:check-now` IPC tests above — the one
// invariant unique to the menu seam is "it routes through that same path".
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

// ————————————————————————————————————————————————————————
// dev-mode guard
// ————————————————————————————————————————————————————————

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
    // Emit update-downloaded — handler must still fire the Toast A dispatch.
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    const toastA = rig.captured.filter((c) => c.channel === 'ok:update:downloaded');
    expect(toastA).toHaveLength(1);
  });

  // Boot-time update notices ("Update to X didn't install" + the what's-new
  // toast) are a production-only surface — in an unpackaged dev build with no
  // OK_UPDATER_FORCE_DEV they must not fire, even when stale persisted state
  // would otherwise trigger them. `forceDevBypass` re-enables them so the manual
  // update smoke can still observe a toast in a dev build.
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
    // Silent advance is load-bearing: it keeps the toast suppressed on the next
    // boot rather than re-evaluating the same version as "new" every launch.
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

// ————————————————————————————————————————————————————————
// download-progress: log only, no UI
// ————————————————————————————————————————————————————————

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

// ————————————————————————————————————————————————————————
// destroy() teardown
// ————————————————————————————————————————————————————————

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

// ————————————————————————————————————————————————————————
// Single-window dispatch (regression guard — multi-window fix)
//
// Under the multi-window model ("every project pick spawns a new editor
// window"), fanning out
// update events to `BrowserWindow.getAllWindows()` produced N visible
// toasts with N independent "Relaunch now" buttons. The module now targets
// a single primary window via `getPrimaryWindow()`. These tests lock the
// new contract and catch any regression back to fan-out semantics.
// ————————————————————————————————————————————————————————

describe('single-window dispatch (Finding #1 guard)', () => {
  test('update-downloaded sends to exactly one target even when primary changes between dispatches', () => {
    const updater = new FakeUpdater();
    const ipc = makeFakeIpc();
    const clock = makeFakeClock();
    const capturedA: CapturedSend[] = [];
    const capturedB: CapturedSend[] = [];
    const windowA = makeFakeWindow(capturedA);
    const windowB = makeFakeWindow(capturedB);
    // Simulate "user focuses window B between two downloaded events"
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
    // windowA still has the first toast only; windowB receives the second.
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
    // Even though no window received the toast, the state gate must still
    // arm so the event doesn't re-fire repeatedly once a window opens.
    expect(state.versionPendingInstall).toBe('0.3.3');
  });
});

// ————————————————————————————————————————————————————————
// markCheckSucceeded routes through persistSafely
//
// The peer sites all gate on persistSafely; this site used to bypass it and
// `writeState` throws on disk-save failure (see main/index.ts's rollback
// pattern — the throw is how persistSafely's catch registers the failure).
// An uncaught throw inside `update-available` / `update-not-available`
// propagates out of electron-updater's `emit()` and breaks the check
// pipeline before `autoDownload` can trigger.
// ————————————————————————————————————————————————————————

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
    // Emitting update-available MUST NOT propagate the writeState throw
    // out to the caller. electron-updater's emit is synchronous — a
    // throwing listener breaks the check pipeline.
    expect(() => updater.emit('update-available', { version: '0.3.2' })).not.toThrow();
    // persistSafely logged the failure at error level.
    expect(logger.error).toHaveBeenCalled();
    // lastSuccessfulCheckAt stays null — the write failed.
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

// ————————————————————————————————————————————————————————
// Toast B persist-before-emit + renderer-mount race
// ————————————————————————————————————————————————————————

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
    // Persist failed → no Toast B.
    const whatsNew = captured.filter((c) => c.channel === 'ok:update:whats-new');
    expect(whatsNew).toHaveLength(0);
    // lastSeenVersion stays stale since the writeState rollback pattern
    // (on the production main/index.ts side) reverts on failure.
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
    // State advances immediately (persist-before-emit), but broadcast is queued.
    expect(state.lastSeenVersion).toBe('0.3.1');
    const beforeFire = captured.filter((c) => c.channel === 'ok:update:whats-new');
    expect(beforeFire).toHaveLength(0);
    expect(deferredFn).not.toBeNull();
    // Simulate did-finish-load firing.
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

// ————————————————————————————————————————————————————————
// relaunch-now idempotent under double-invoke
// ————————————————————————————————————————————————————————

describe('relaunch-now idempotency (Major #2)', () => {
  test('second invocation sees the committed install → no second quitAndInstall', async () => {
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    // Rapid double-click: BOTH invocations are fired before either resolves,
    // which is the shape the freshness check made possible. The state gate
    // alone no longer covers it — `versionPendingInstall` is not cleared until
    // after the pre-install check awaits, so the second click would otherwise
    // find the state still armed and fire a second, non-idempotent
    // `quitAndInstall()`. The in-memory commit flag is what blocks it.
    const first = rig.ipc.invoke('ok:update:relaunch-now');
    const second = rig.ipc.invoke('ok:update:relaunch-now');
    await Promise.all([first, second]);
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(rig.dispatches).toContain('relaunch-double-invoke-blocked' as DispatchKind);
    // State is cleared by the invocation that committed.
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
    // Rejects so the clicked window runs its failure arm rather than its
    // success one, which would dismiss the banner the bail just re-armed.
    await expect(Promise.resolve(ipc.invoke('ok:update:relaunch-now'))).rejects.toThrow();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    // State stays pending since persist failed — user can click again.
    expect(state.versionPendingInstall).toBe('0.3.2');
  });
});

// ————————————————————————————————————————————————————————
// bootAutoUpdater catch-path coverage
// ————————————————————————————————————————————————————————

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
    // Simulate the node_modules/electron-updater corruption path.
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
    // Error log includes the failure message for triage.
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
    // Clean teardown — no throw.
    expect(clock.clearTimeout).toHaveBeenCalled();
  });

  test('startAutoUpdater synchronous throw during wire-up is caught', async () => {
    const logger = {
      info: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      debug: vi.fn(() => {}),
    };
    // A fake updater whose `.on(...)` throws simulates an API-shape drift
    // inside startAutoUpdater's wire-up (future electron-updater major
    // version bumps that rename event contracts).
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

  // Regression: electron-updater's `autoUpdater` export is installed via
  // `Object.defineProperty(exports, 'autoUpdater', { get: ... })` — a dynamic
  // getter that Node's CJS → ESM interop exposes under `.default`, NOT on the
  // module namespace root. The original bootAutoUpdater destructured
  // `{ autoUpdater }` off the top level, got `undefined`, and the subsequent
  // `updater.autoDownload = true` threw "Cannot set properties of undefined".
  // In dev this looked like a caught error; in packaged builds it meant zero
  // auto-updates ever. Fix: `resolveAutoUpdater` checks `.default.autoUpdater`
  // first and falls back to the top-level for flat test mocks.

  test('resolveAutoUpdater handles .default.autoUpdater shape (real CJS-from-ESM)', async () => {
    const fakeUpdater = new FakeUpdater();
    const handle = await bootAutoUpdater(
      // Mirror the real electron-updater ESM namespace: autoUpdater is only
      // reachable via `.default`, NOT on the top-level module namespace.
      () => Promise.resolve({ default: { autoUpdater: fakeUpdater } }),
      {
        ipcMain: makeFakeIpc(),
        readState: () => emptyState(),
        writeState: () => {},
        getPrimaryWindow: () => null,
        getAppVersion: () => '0.3.1',
        isPackaged: true,
        // Pinned so the install-on-quit assertion below is deterministic on
        // every runner — this test's subject is module-shape resolution;
        // without the pin, ubuntu CI inherits linux and the Linux carve-out
        // flips autoInstallOnAppQuit off.
        platform: 'darwin',
        clock: makeFakeClock(),
        now: () => new Date(),
      },
    );
    expect(handle).not.toBeNull();
    // The fake received the configuration lock-down — proves the boot path
    // actually called `startAutoUpdater` rather than catching silently.
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
      // A degenerate module that has neither shape — simulates a future
      // major-version rename of `autoUpdater` without anyone updating our code.
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

// ————————————————————————————————————————————————————————
// Staged-cache reclaim gating (boot reconciliation)
// ————————————————————————————————————————————————————————

describe('staged-cache reclaim — fires only once every install commitment is settled', () => {
  test('clean boot (nothing pending, nothing attempted) invokes the reclaim hook once', () => {
    const reclaim = vi.fn(() => Promise.resolve());
    const { rig } = makeRig({ reclaimStagedUpdateCache: reclaim });
    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(rig.dispatches.filter((d) => d === 'staged-cache-reclaimed')).toHaveLength(1);
  });

  test('boot after a committed install reclaims once reconciliation clears both gates', () => {
    // Running 0.3.2 with versionPendingInstall + attemptedInstall still
    // recording 0.3.2 — the install-on-quit success shape. Reconciliation
    // clears both, then (and only then) the reclaim may fire.
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
    // The Linux download-then-quit shape: the staged installer is the very
    // file "Relaunch now" / the manual-install command will consume.
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
    // Boot detects the silent install failure, re-arms the banner for Retry —
    // the staged installer must stay for that Retry to have anything to run.
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

// ————————————————————————————————————————————————————————
// Linux manual-install fallback triggers
// ————————————————————————————————————————————————————————

describe('linux manual-install fallback', () => {
  const STAGED_DEB = '/home/u/.cache/ok-updater/pending/ok_0.3.2_arm64.deb';

  function makeLinuxRig(opts: {
    hasGraphicalAuth: boolean;
    downloadedFile?: string | undefined;
    extraWindowCount?: number;
    /**
     * When false, no `update-downloaded` event fires — the boot-with-staged
     * shape where the fallback must run entirely off the PERSISTED path.
     * Combine with `stateStagedInstallerPath`.
     */
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
    // Stage the installer path the way production learns it — from the
    // update-downloaded payload. The seeded versionPendingInstall makes this
    // a dedupe re-fire; the staged path must be captured regardless.
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
    // The staged update survives: the gate stays armed for the next boot /
    // a later retry, exactly what "premature relaunch" relies on.
    expect(rig.state.versionPendingInstall).toBe('0.3.2');
    // The early return fires BEFORE the install-commitment persist — no
    // attempt ever ran, so the next boot must not see a spurious
    // "install failed" record.
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
    // Every window's banner is restored (the clicked one swapped locally);
    // no relaunching broadcast ever goes out.
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
    // failRelaunch recovery landed first: gate restored, windows re-armed.
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
    // The standard Linux flow — download, quit, boot, click Relaunch. The
    // banner (restored from versionPendingInstall) is clickable long before
    // the launch check re-validates the ~250 MB cache and re-emits
    // update-downloaded, so the fallback must work from state alone.
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

// ————————————————————————————————————————————————————————
// Update freshness at the moment the user asks to install
// ————————————————————————————————————————————————————————

/**
 * Fire the timer registered for exactly `ms`, newest first.
 *
 * `clock.lastCallback` is not usable here: the fixture remembers only the most
 * recent timer, and the periodic-check timer re-arms itself from a microtask
 * that lands in the middle of these tests, so `lastCallback` routinely points
 * at the periodic check rather than the timer under test.
 */
function fireTimerFor(clock: FakeClock, ms: number): void {
  const call = [...clock.setTimeout.mock.calls].reverse().find((c) => c[1] === ms);
  if (!call) throw new Error(`no timer registered for ${ms}ms`);
  (call[0] as () => void)();
}

/** Take a rig through a real in-session stage of `version`. */
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
    // The pipeline reached a parsed manifest; only the download was declined.
    // Treating it as a failure would march the 7-day stuck-hint toward firing
    // on a healthy updater that simply has nothing new to fetch.
    const { rig } = makeRig({ versionPendingInstall: null });
    stageInSession(rig, '0.3.2');
    rig.dispatches.length = 0;

    rig.updater.emit('update-available', { version: '0.3.2' });

    expect(rig.dispatches).toContain('check-success' as DispatchKind);
  });

  test('the FIRST offer of a session re-downloads even when state says it is staged', async () => {
    // A staged build that never installed (crash, force-quit, failed swap, or
    // any Linux session the user did not click through) carries
    // `versionPendingInstall` into the next session, but electron-updater
    // keeps nothing across processes: no download means no installer path and
    // no quit handler, so skipping here would leave the update uninstallable
    // until a newer one shipped.
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    rig.updater.downloadUpdate.mockClear();

    rig.updater.emit('update-available', { version: '0.3.2' });

    expect(rig.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(rig.dispatches).not.toContain('download-skipped-already-staged' as DispatchKind);

    // And the install route is live again once that download completes.
    rig.updater.emit('update-downloaded', { version: '0.3.2' });
    rig.updater.downloadUpdate.mockClear();

    // Having staged it for real, the skip re-engages — the inherited-state
    // re-download is a one-time correction, not a permanent opt-out.
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
    // A download that never completed left `versionPendingInstall` unset, so
    // the guard must not latch on the version alone.
    const { rig } = makeRig({ versionPendingInstall: null });
    rig.updater.emit('update-available', { version: '0.3.2' });
    rig.updater.emit('error', new Error('network died'));
    rig.updater.downloadUpdate.mockClear();

    rig.updater.emit('update-available', { version: '0.3.2' });

    expect(rig.updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('cited upstream behaviour stays tied to the pinned dependency', () => {
  test('the electron-updater version in the guard comment matches package.json', () => {
    // The comment citing `BaseUpdater#addQuitHandler` is what authorizes NOT
    // guarding Windows and Linux, and the suite cannot check it: these tests
    // run against a stub, so they pin our gating rather than electron-updater's
    // behaviour. A version bump is the one event that should force a re-read of
    // that citation, and without this it would pass silently.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const pinned =
      pkg.dependencies?.['electron-updater'] ?? pkg.devDependencies?.['electron-updater'];
    const source = readFileSync(join(here, '../../src/main/auto-updater.ts'), 'utf8');
    // Every occurrence, not the first: the file carries more than one citation
    // and a guard that checks one of them would pass while another rots.
    const cited = [...source.matchAll(/`electron-updater@([^`]+)`/g)].map((m) => m[1]);

    expect(cited.length).toBeGreaterThan(0);
    expect([...new Set(cited)]).toEqual([pinned]);
  });
});

/**
 * A second macOS download arms a second ShipIt beside the pending one, and both
 * race the same bundle swap at quit. The mechanism, and why declining is the
 * only available lever, is stated once at the guard itself — see the comment
 * above the `declinedForStagedVersion` call in `onUpdateAvailable`.
 */
describe('single-flight install handoff', () => {
  test('a newer offer does not arm a second request beside the pending one', () => {
    // The periodic-cadence shape. The staged build still installs at quit; the
    // newer one is picked up in the session after that. The cost is that every
    // further offer this macOS process sees is declined too — nothing clears
    // `stagedThisSession` here — which is the whole price of not racing the
    // swap.
    const { rig } = makeRig({ versionPendingInstall: null });
    stageInSession(rig, '0.3.2');

    rig.updater.emit('update-available', { version: '0.3.3' });

    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.dispatches).toContain('download-skipped-install-armed' as DispatchKind);
  });

  test('the declined offer still counts as a successful check', () => {
    // Same reasoning as the same-version skip: the manifest was fetched and
    // parsed, so marching the stuck-hint toward firing would be wrong.
    const { rig } = makeRig({ versionPendingInstall: null });
    stageInSession(rig, '0.3.2');
    rig.dispatches.length = 0;

    rig.updater.emit('update-available', { version: '0.3.3' });

    expect(rig.dispatches).toContain('download-skipped-install-armed' as DispatchKind);
    expect(rig.dispatches).toContain('check-success' as DispatchKind);
  });

  test('the click-time freshness check installs the armed build rather than a second one', async () => {
    // The worst instance of the race, because both ShipIts are woken seconds
    // later by this very click. The refresh is documented to fall through to
    // "install whatever is currently staged" on every failure; an already-armed
    // request is one more reason to take that path, not a new failure mode.
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
    // The pair `refreshBeforeInstall` documents as what keeps a decline
    // separable from a genuinely up-to-date check: the outcome kind says the
    // refresh did not change what installs, and the decline kind beside it says
    // why. Telemetry that only saw the former would read this as "nothing
    // newer existed".
    expect(rig.dispatches).toContain('relaunch-refresh-up-to-date' as DispatchKind);
    expect(rig.dispatches).toContain('download-skipped-install-armed' as DispatchKind);
  });

  // Per-platform cases rather than a loop inside one test: a loop reports the
  // first failure as the whole test and never runs the platform after it.
  test.each(['win32', 'linux'] as const)('on %s a newer offer still downloads', (platform) => {
    // Only Squirrel.Mac holds the pending install in a separate armed process.
    // On Windows a download writes an installer to the cache and the single
    // idempotent quit handler runs whichever was downloaded LAST, so a newer
    // build replaces the pending one instead of racing it; on Linux
    // `autoInstallOnAppQuit` is false, so nothing is pending at all. Declining
    // there would pin a long session to the first build it happened to stage
    // and buy nothing for it.
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
    // The reporting gate must ask the same darwin-scoped predicate as the
    // fetch gate, or Windows and Linux report a stale staged version while a
    // newer download is in flight. Pins the direction the fetch test cannot
    // see: there, the correct outcome is that the download happens.
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
    // Its rationale — not reopening a re-stage window over bytes already
    // held — has nothing to do with Squirrel, so the platform scoping must
    // not leak into it.
    const { rig } = makeRig({ versionPendingInstall: null, platform });
    stageInSession(rig, '0.3.2');

    rig.updater.emit('update-available', { version: '0.3.2' });

    expect(rig.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(rig.dispatches).toContain('download-skipped-already-staged' as DispatchKind);
  });

  test('a manual check names the build that will install, not the declined offer', () => {
    // `onUpdateAvailableForMenuCheck` fires for the same event and cannot see
    // that the offer was declined. Left alone it says "0.3.3 is available, it's
    // downloading in the background" — both halves false — and the user
    // relaunches onto 0.3.2 and repeats the check forever.
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
    // The same-version re-offer, which is the COMMON shape: electron-updater
    // re-offers a staged build on every poll for as long as it is newer than
    // the running one, so this fires hourly while the version-change shape
    // needs a release to land mid-session. It is declined too — no
    // `downloadUpdate()` runs — so reporting "downloading in the background"
    // described a download that was not happening on every platform.
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
    // Off macOS the version-change term is false, so this is the only place
    // the same-version half of the predicate is load-bearing — on darwin that
    // term reports `ready-to-install` on its own and would mask its removal.
    // It is also the shape that fires hourly.
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
    // Losing both the persist and the arm leaves the session with no banner
    // to retry from and a guard that declines the re-offer of this very
    // version forever. Only `stagedThisSession` gates that decline, so
    // nothing else would release it. Safe here because neither platform has
    // an armed installer a re-download could duplicate.
    const { rig } = makeRig({ versionPendingInstall: null, platform });
    stageInSession(rig, '0.3.2');
    rig.updater.quitAndInstall = vi.fn(() => {
      // Flip only now: an earlier failure would abort the handler before it
      // reaches the restore path this test is about.
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

  /**
   * macOS keeps the arm on every `failRelaunch` trigger, because none of them
   * establishes that Squirrel's request is spent — the watchdog fires on an app
   * that may still quit, a throw means it is not quitting at all, and an error
   * event may arrive while ShipIt is still pending. One case per trigger, so a
   * refactor of any single dispatch site cannot break the invariant silently.
   */
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
    // The trigger where the arm may genuinely be spent — this is Squirrel's
    // swap-failure channel, reported after a clean `quitAndInstall()` return.
    // The arm is kept anyway because `onError` cannot tell that case from an
    // unrelated error arriving while ShipIt is still pending, and only one of
    // those two readings is safe to act on.
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
    // The ordinary failure path, and the direction a "simplification" that
    // hoists the release above the if/else would silently break: the banner is
    // back, so the retry affordance exists and the arm must survive to keep the
    // single-flight guarantee.
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
    // Nothing was handed to Squirrel, so there is no pending request to
    // collide with — the guard must key on a completed stage, not on having
    // attempted one, or a single failed download would end updates for the
    // rest of the session.
    //
    // The same setup as `a retry after a failed download…` above, re-offering a
    // DIFFERENT version rather than the same one, so it lands on the
    // newer-offer branch (`declinedForStagedVersion` returning non-null via the
    // darwin term). Both fail if the not-armed short circuit stops
    // short-circuiting; only this one covers the newer-offer path through it.
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
    // The check the click fires turns up a newer build. The download it starts
    // is left in flight so the wait is the one under test; the test completes
    // it below.
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
    // The handoff record names the build actually installed, not the one the
    // banner happened to be showing when it was clicked.
    expect(rig.state.attemptedInstall).toBe('0.3.3');
  });

  test('a click landing mid-stage waits instead of installing over the write', async () => {
    // The install-failure shape this guards: electron-updater keeps its
    // "already staged" flag set from the previous stage, so quitAndInstall
    // during a re-stage fires at a half-written bundle.
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

    // The newer build never staged, so the one still on disk is installed.
    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  test('a newer build that never finishes downloading falls through on the timeout', async () => {
    // Falling through is safe: an unfinished re-download has not disturbed the
    // previously-staged bundle, so the user still gets an install rather than
    // a click that did nothing.
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    rig.updater.emit('update-available', { version: '0.3.3' });

    const pending = rig.ipc.invoke('ok:update:relaunch-now');
    await Promise.resolve();
    expect(rig.updater.quitAndInstall).not.toHaveBeenCalled();

    fireTimerFor(rig.clock, RELAUNCH_REFRESH_DOWNLOAD_MS);
    await pending;

    expect(rig.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    // The install went ahead against the build that was already staged, not
    // the one whose download never finished.
    const relaunching = rig.captured.filter((c) => c.channel === 'ok:update:relaunching');
    expect(relaunching).toHaveLength(1);
    expect(relaunching[0]?.payload).toEqual({ version: '0.3.2' });
    expect(rig.state.versionPendingInstall).toBeNull();
  });

  test('a staged build that vanishes during the check clears the fetching card', async () => {
    // Every window is showing the button-less, non-dismissible fetching card
    // by this point, and there is nothing staged left to re-arm the banner
    // with — so the failure notice has to carry the flag that clears that
    // card, or it just layers on top of one the user can never remove.
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
      // No banner re-arm on this path — there is nothing staged to offer.
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
  // The flag exists to stop a rapid double-click firing a non-idempotent
  // install twice. Every path that declines to install has to hand it back, or
  // the banner it re-arms would be dead to the next click for the rest of the
  // session.
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
    // The re-armed banner replaces the in-progress card by id, so clearing as
    // well would take the retry affordance away again.
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    await rig.ipc.invoke('ok:update:relaunch-now');
    rig.updater.emit('error', new Error('ShipIt swap failed'));

    const failed = rig.captured.filter((c) => c.channel === 'ok:update:relaunch-failed');
    expect(failed).toHaveLength(1);
    expect((failed[0]?.payload as { dismissPending?: boolean }).dismissPending).toBeUndefined();
    expect(rig.captured.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(1);
  });

  test('a persist failure rejects the click rather than resolving it', async () => {
    // Resolving would run the clicked window's success continuation, which
    // dismisses the shared notice id and removes the banner the broadcast just
    // re-armed — and whether it wins is a race, since the broadcast and the
    // invoke reply travel different IPC pipes. Rejecting routes that window to
    // its failure arm, which re-arms the banner itself and says the click did
    // not take.
    const { rig } = makeRig({ versionPendingInstall: '0.3.2' });
    rig.failNextPersist = true;

    await expect(Promise.resolve(rig.ipc.invoke('ok:update:relaunch-now'))).rejects.toThrow();
  });

  test('a persist failure re-arms the banner in EVERY window, not just the clicked one', async () => {
    // The click already repainted every window with the button-less,
    // non-dismissible fetching card. Only the clicked window has a failure arm
    // of its own, so without a broadcast the others are stranded on it.
    const { rig } = makeRig({ versionPendingInstall: '0.3.2', extraWindowCount: 2 });
    rig.failNextPersist = true;

    await expect(Promise.resolve(rig.ipc.invoke('ok:update:relaunch-now'))).rejects.toThrow();

    for (const win of rig.windows) {
      expect(win.filter((c) => c.channel === 'ok:update:fetching-latest')).toHaveLength(1);
      const rearm = win.filter((c) => c.channel === 'ok:update:downloaded');
      expect(rearm).toHaveLength(1);
      expect(rearm[0]?.payload).toEqual({ version: '0.3.2' });
      // Paired with the reason, so a window that did not click still learns a
      // relaunch was attempted rather than watching the banner reappear on its
      // own. No `dismissPending` here: the re-arm above already replaced the
      // in-progress card by id, and clearing as well would take the retry
      // affordance away again.
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

    // The user installs a polkit agent and clicks the re-armed banner again.
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
    // Held, not lost: the update is fully staged and still installs on quit.
    expect(rig.state.versionPendingInstall).toBe('0.3.2');

    fireTimerFor(rig.clock, POST_UPDATE_QUIET_MS);

    expect(rig.captured.filter((c) => c.channel === 'ok:update:downloaded')).toHaveLength(1);
    expect(rig.dispatches).toContain('toast-a-quiet-window-elapsed' as DispatchKind);
    expect(handle.isWithinPostUpdateQuietWindow()).toBe(false);
  });

  test('a fresh install does not arm it', () => {
    // Nobody sat through an update, and the installer is often already a
    // release or two behind, so suppressing here would only delay a wanted
    // update.
    const { handle } = makeRig({ lastSeenVersion: null, appVersion: '0.3.1' });
    expect(handle.isWithinPostUpdateQuietWindow()).toBe(false);
  });

  test('a plain relaunch on the same version does not arm it', () => {
    const { handle } = makeRig({ lastSeenVersion: '0.3.1', appVersion: '0.3.1' });
    expect(handle.isWithinPostUpdateQuietWindow()).toBe(false);
  });

  test('linux does not arm it — the banner there is the only install route', () => {
    // Install-on-quit is off on Linux, so the banner is not a notification the
    // user can ignore, it is the sole affordance for applying the update.
    // Holding it back would withhold the install entirely and leave the build
    // staged and uninstalled.
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
