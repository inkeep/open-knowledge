/**
 * Regression tests for inkeep/open-knowledge#617 — the external-link safety net
 * is attached by the WINDOW FACTORY, so every editor window OpenKnowledge
 * creates denies an external `window.open` and delegates it to the OS browser.
 *
 * Before the factory owned this, `attachAssetSafetyNet` was wired per-call-site
 * in `index.ts` at only two window-creation sites, so windows created by any
 * other path — notably the server-restart → recreate window — came up net-less:
 * a WYSIWYG external-link click's `window.open` fell through to Electron's
 * default and a child BrowserWindow rendered the page.
 *
 * Contract pinned here: a window created by the WindowManager factory — via the
 * utility-fork spawn path, the bare attach-to-existing path, the ephemeral
 * single-file path, AND the restart → recreate path — has a
 * `setWindowOpenHandler` registered on its webContents that returns
 * `{ action: 'deny' }` for an external `https:` URL and delegates that URL to
 * `openExternal`.
 *
 * Seam: real `WindowManager` over the established `BrowserWindowLike` /
 * `UtilityProcessLike` structural fakes (no Electron). The window fake's
 * webContents captures the window-open handler so the test invokes it exactly
 * as Electron would on a new-window request. `openExternal` is the one injected
 * boundary (the OS-browser delegate) — asserting the captured handler routes an
 * external URL to it is the real "reaches the OS browser" behavior, not a mock
 * of the factory's own logic.
 */

import { describe, expect, mock, test } from 'bun:test';
import { getLocalDir } from '@inkeep/open-knowledge-server';
import type { AssetOpenResult } from '../../src/main/asset-allowlist.ts';
import type { ShowGateRegistry } from '../../src/main/show-gate.ts';
import {
  type BrowserWindowLike,
  type ServerLockMetadataLike,
  type UtilityProcessLike,
  WindowManager,
  type WindowManagerDeps,
} from '../../src/main/window-manager.ts';

// ---------------------------------------------------------------------------
// Structural fakes — mirror packages/desktop/tests/main/window-manager.test.ts,
// with the addition of a webContents that captures the safety-net handlers.
// ---------------------------------------------------------------------------

interface MockUtility extends UtilityProcessLike {
  fire: (msg: unknown) => void;
  fireExit: (code: number | null) => void;
}

function makeUtility(pid: number): MockUtility {
  let messageHandler: ((m: unknown) => void) | null = null;
  let exitHandler: ((c: number | null) => void) | null = null;
  return {
    pid,
    postMessage: mock(() => {}),
    on: mock((event: 'message' | 'exit', cb: (msg: unknown) => void) => {
      if (event === 'message') messageHandler = cb;
      else if (event === 'exit') exitHandler = cb as (c: number | null) => void;
    }) as UtilityProcessLike['on'],
    once: mock(() => {}),
    removeListener: mock(() => {}),
    kill: mock(() => true),
    fire: (msg) => messageHandler?.(msg),
    fireExit: (code) => exitHandler?.(code),
  };
}

type WindowOpenHandler = (details: { url: string }) => { action: 'allow' | 'deny' };
type WillNavigateHandler = (event: { preventDefault: () => void }, url: string) => void;

type SafetyNetWindow = BrowserWindowLike & {
  fireClose: () => void;
  /** The handler the factory installs via `webContents.setWindowOpenHandler`, or
   *  null when the factory never attached the safety net. */
  windowOpenHandler: WindowOpenHandler | null;
  willNavigateHandler: WillNavigateHandler | null;
};

function makeWindow(): SafetyNetWindow {
  const closeHandlers: Array<() => void> = [];
  let destroyed = false;
  let visible = false;
  const win: SafetyNetWindow = {
    focus: mock(() => {}),
    show: mock(() => {
      visible = true;
    }),
    restore: mock(() => {}),
    isMinimized: mock(() => false),
    moveTop: mock(() => {}),
    isFocused: mock(() => false),
    isDestroyed: mock(() => destroyed),
    isVisible: mock(() => visible),
    on: mock((_event: 'closed', cb: () => void) => {
      closeHandlers.push(cb);
    }) as BrowserWindowLike['on'],
    once: mock((_event: 'ready-to-show', _cb: () => void) => {}) as BrowserWindowLike['once'],
    close: mock(() => {
      destroyed = true;
      for (const h of closeHandlers) h();
    }),
    destroy: mock(() => {
      destroyed = true;
      for (const h of closeHandlers) h();
    }),
    webContents: {
      send: mock(() => {}),
      once: mock(() => {}),
      executeJavaScript: mock(() => Promise.resolve(undefined)),
      setWindowOpenHandler: mock((handler: WindowOpenHandler) => {
        win.windowOpenHandler = handler;
      }),
      on: mock((event: 'will-navigate', handler: WillNavigateHandler) => {
        if (event === 'will-navigate') win.willNavigateHandler = handler;
      }),
    } as unknown as BrowserWindowLike['webContents'],
    loadFile: mock(() => Promise.resolve()),
    loadURL: mock(() => Promise.resolve()),
    fireClose: () => {
      for (const h of closeHandlers) h();
    },
    windowOpenHandler: null,
    willNavigateHandler: null,
  };
  return win;
}

interface TestEnv {
  utilities: MockUtility[];
  windows: SafetyNetWindow[];
  openExternal: ReturnType<typeof mock>;
  openAsset: ReturnType<typeof mock>;
  deps: WindowManagerDeps;
}

function buildEnv(): TestEnv {
  const utilities: MockUtility[] = [];
  const windows: SafetyNetWindow[] = [];
  const showGate: ShowGateRegistry = {
    register: () => () => {},
    fireThemeApplied: () => {},
  };
  let pidCounter = 20000;
  // The two boundary delegates the safety net needs. `openAsset` is 2-arg
  // (`projectPath`, `relPath`) — matching `WindowManagerDeps.safetyNet.openAsset`
  // and the `attachSafetyNet` call `net.openAsset(assetRoot, relPath)`.
  const openExternal = mock(async (_url: string): Promise<void> => {});
  const openAsset = mock(
    async (_projectPath: string, _relPath: string): Promise<AssetOpenResult> => ({ ok: true }),
  );
  const deps: WindowManagerDeps = {
    createWindow: () => {
      const w = makeWindow();
      windows.push(w);
      return w;
    },
    forkUtility: () => {
      const u = makeUtility(++pidCounter);
      utilities.push(u);
      return u;
    },
    utilityEntryPath: '/fake/utility-entry.js',
    rendererEntryPath: '/fake/renderer/index.html',
    appVersion: '9.9.9-test',
    setTimeout: () => null,
    killProbe: mock(() => {}),
    showGate,
    // The ephemeral / detached-spawn deps are wired PER-TEST (createEphemeral
    // and restart only). Leaving them off the base keeps the spawn test on the
    // utility-fork path: `createProjectWindow` picks the detached-spawn path the
    // moment `spawnDetachedServer` is present.
    safetyNet: { openExternal, openAsset },
  };
  return { utilities, windows, openExternal, openAsset, deps };
}

/**
 * Wire the ephemeral single-file (`ok <file>`) deps onto an env so
 * `createEphemeralWindow` reaches its `attachSafetyNet` call without real
 * Electron/spawn: `spawnDetachedServer` publishes a lock, the port poll reads it
 * back via `readServerLock`.
 */
function withEphemeralDeps(env: TestEnv): void {
  const ephemeralLocks = new Map<string, ServerLockMetadataLike>();
  let pid = 42000;
  env.deps.spawnLockPollDeadlineMs = 5_000;
  env.deps.createEphemeralProjectDir = () => '/tmp/ok-ephemeral-net';
  env.deps.removeDir = async () => {};
  env.deps.isProcessAlive = () => true;
  env.deps.readServerLock = (lockDir) => ephemeralLocks.get(lockDir) ?? null;
  env.deps.spawnDetachedServer = async (opts) => {
    const spawnedPid = ++pid;
    if (opts.projectDir !== undefined) {
      ephemeralLocks.set(getLocalDir(opts.projectDir), {
        pid: spawnedPid,
        hostname: 'testhost',
        port: 52999,
        startedAt: '2026-06-05T00:00:00.000Z',
        worktreeRoot: opts.projectDir,
        kind: 'interactive',
        capabilities: ['ws'],
      });
    }
    return { pid: spawnedPid };
  };
}

const EXTERNAL_URL = 'https://example.com/watch';

/**
 * The invariant: `webContents.setWindowOpenHandler` was installed, and the
 * installed handler denies an external new-window request AND delegates it to
 * `openExternal` (the OS browser). Extracted so every factory path asserts it
 * identically.
 */
async function expectExternalSafetyNet(
  window: SafetyNetWindow,
  openExternal: ReturnType<typeof mock>,
): Promise<void> {
  // The factory installed a window-open handler on the created window.
  expect(window.windowOpenHandler).not.toBeNull();
  const handler = window.windowOpenHandler;
  if (!handler) throw new Error('unreachable — asserted non-null above');

  const result = handler({ url: EXTERNAL_URL });
  // An external new-window request must NOT open a child OpenKnowledge window.
  expect(result).toEqual({ action: 'deny' });

  // openExternal fires async inside the handler; let the microtask settle.
  await Promise.resolve();
  await Promise.resolve();
  expect(openExternal).toHaveBeenCalledWith(EXTERNAL_URL);
}

describe('WindowManager factory attaches the external-link safety net', () => {
  test('createProjectWindow (spawn path) installs a deny+delegate window-open handler', async () => {
    const env = buildEnv();
    const wm = new WindowManager(env.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/spawned-proj' });
    env.utilities[0]?.fire({ type: 'ready', port: 51234, apiOrigin: 'http://localhost:51234' });
    await promise;

    expect(env.windows.length).toBe(1);
    const created = env.windows[0];
    if (!created) throw new Error('no window created');
    await expectExternalSafetyNet(created, env.openExternal);
  });

  test('createEphemeralWindow (single-file path) installs a deny+delegate window-open handler', async () => {
    const env = buildEnv();
    withEphemeralDeps(env);
    const wm = new WindowManager(env.deps);
    await wm.createEphemeralWindow({
      canonicalFilePath: '/Users/me/notes/todo.md',
      contentDir: '/Users/me/notes',
      docName: 'todo',
    });

    expect(env.windows.length).toBe(1);
    const created = env.windows[0];
    if (!created) throw new Error('no ephemeral window created');
    await expectExternalSafetyNet(created, env.openExternal);
  });

  test('restartAttachedServer: both the initial attach and the recreated window install the net', async () => {
    // Mirror the production restart path: attach mode → detached spawn (not the
    // dev utility-fork), since drift/restart only occur in attach mode.
    const env = buildEnv();
    env.deps.selfProtocolVersion = 1;
    env.deps.selfRuntimeVersion = '0.8.2';

    const liveLock: ServerLockMetadataLike = {
      pid: 65792,
      hostname: 'my-host',
      port: 59534,
      startedAt: '2026-04-17T20:23:20.713Z',
      worktreeRoot: '/tmp/dragon',
      kind: 'interactive',
      capabilities: ['http', 'ws'],
    };
    let killed = false;
    let spawned = false;
    const oldLock = { ...liveLock, pid: 5555, protocolVersion: 1, runtimeVersion: '0.8.0' };
    const freshLock = {
      ...liveLock,
      pid: 6666,
      port: 60000,
      protocolVersion: 1,
      runtimeVersion: '0.8.2',
    };
    env.deps.readServerLock = () => (spawned ? freshLock : killed ? null : oldLock);
    env.deps.isProcessAlive = (pid) => (pid === 5555 ? !killed : true);
    env.deps.hostname = () => 'my-host';
    env.deps.probeWsUpgrade = () => Promise.resolve(true);
    env.deps.killProbe = mock((_pid: number, signal: number | NodeJS.Signals) => {
      if (signal === 'SIGTERM') killed = true;
    });
    env.deps.spawnDetachedServer = async () => {
      spawned = true;
      return { pid: 6666 };
    };

    const wm = new WindowManager(env.deps);
    const attached = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
    expect(attached.ownsServer).toBe(false);
    expect(env.windows.length).toBe(1);
    // The initial attach (createProjectWindow → attachToExistingServer, the bare
    // attach-to-existing factory path) also installs the net.
    const attachedWindow = env.windows[0];
    if (!attachedWindow) throw new Error('no attach window');
    await expectExternalSafetyNet(attachedWindow, env.openExternal);

    const outcome = await wm.restartAttachedServer('/tmp/dragon');
    expect(outcome).toEqual({ ok: true });
    // A fresh window was recreated for the respawned server — it is the one that
    // must carry the net (the whole point of #617).
    expect(env.windows.length).toBe(2);
    const recreated = env.windows[1];
    if (!recreated) throw new Error('no recreated window');
    await expectExternalSafetyNet(recreated, env.openExternal);
  });
});
