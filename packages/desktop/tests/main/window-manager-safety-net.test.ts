import { getLocalDir } from '@inkeep/open-knowledge-server';
import { describe, expect, test, vi } from 'vitest';
import type { AssetOpenResult } from '../../src/main/asset-allowlist.ts';
import type { ShowGateRegistry } from '../../src/main/show-gate.ts';
import {
  type BrowserWindowLike,
  type ServerLockMetadataLike,
  type UtilityProcessLike,
  WindowManager,
  type WindowManagerDeps,
} from '../../src/main/window-manager.ts';

interface MockUtility extends UtilityProcessLike {
  fire: (msg: unknown) => void;
  fireExit: (code: number | null) => void;
}

function makeUtility(pid: number): MockUtility {
  let messageHandler: ((m: unknown) => void) | null = null;
  let exitHandler: ((c: number | null) => void) | null = null;
  return {
    pid,
    postMessage: vi.fn(() => {}),
    on: vi.fn((event: 'message' | 'exit', cb: (msg: unknown) => void) => {
      if (event === 'message') messageHandler = cb;
      else if (event === 'exit') exitHandler = cb as (c: number | null) => void;
    }) as UtilityProcessLike['on'],
    once: vi.fn(() => {}),
    removeListener: vi.fn(() => {}),
    kill: vi.fn(() => true),
    fire: (msg) => messageHandler?.(msg),
    fireExit: (code) => exitHandler?.(code),
  };
}

type WindowOpenHandler = (details: { url: string }) => { action: 'allow' | 'deny' };
type WillNavigateHandler = (event: { preventDefault: () => void }, url: string) => void;

type SafetyNetWindow = BrowserWindowLike & {
  fireClose: () => void;
  windowOpenHandler: WindowOpenHandler | null;
  willNavigateHandler: WillNavigateHandler | null;
};

function makeWindow(): SafetyNetWindow {
  const closeHandlers: Array<() => void> = [];
  let destroyed = false;
  let visible = false;
  const win: SafetyNetWindow = {
    focus: vi.fn(() => {}),
    show: vi.fn(() => {
      visible = true;
    }),
    restore: vi.fn(() => {}),
    isMinimized: vi.fn(() => false),
    moveTop: vi.fn(() => {}),
    isFocused: vi.fn(() => false),
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => visible),
    on: vi.fn((_event: 'closed', cb: () => void) => {
      closeHandlers.push(cb);
    }) as BrowserWindowLike['on'],
    once: vi.fn((_event: 'ready-to-show', _cb: () => void) => {}) as BrowserWindowLike['once'],
    close: vi.fn(() => {
      destroyed = true;
      for (const h of closeHandlers) h();
    }),
    destroy: vi.fn(() => {
      destroyed = true;
      for (const h of closeHandlers) h();
    }),
    webContents: {
      send: vi.fn(() => {}),
      once: vi.fn(() => {}),
      executeJavaScript: vi.fn(() => Promise.resolve(undefined)),
      setWindowOpenHandler: vi.fn((handler: WindowOpenHandler) => {
        win.windowOpenHandler = handler;
      }),
      on: vi.fn((event: 'will-navigate', handler: WillNavigateHandler) => {
        if (event === 'will-navigate') win.willNavigateHandler = handler;
      }),
    } as unknown as BrowserWindowLike['webContents'],
    loadFile: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
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
  openExternal: ReturnType<typeof vi.fn>;
  openAsset: ReturnType<typeof vi.fn>;
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
  const openExternal = vi.fn(async (_url: string): Promise<void> => {});
  const openAsset = vi.fn(
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
    killProbe: vi.fn(() => {}),
    showGate,
    safetyNet: { openExternal, openAsset },
  };
  return { utilities, windows, openExternal, openAsset, deps };
}

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

async function expectExternalSafetyNet(
  window: SafetyNetWindow,
  openExternal: ReturnType<typeof vi.fn>,
): Promise<void> {
  expect(window.windowOpenHandler).not.toBeNull();
  const handler = window.windowOpenHandler;
  if (!handler) throw new Error('unreachable — asserted non-null above');

  const result = handler({ url: EXTERNAL_URL });
  expect(result).toEqual({ action: 'deny' });

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
    env.deps.killProbe = vi.fn((_pid: number, signal: number | NodeJS.Signals) => {
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
    const attachedWindow = env.windows[0];
    if (!attachedWindow) throw new Error('no attach window');
    await expectExternalSafetyNet(attachedWindow, env.openExternal);

    const outcome = await wm.restartAttachedServer('/tmp/dragon');
    expect(outcome).toEqual({ ok: true });
    expect(env.windows.length).toBe(2);
    const recreated = env.windows[1];
    if (!recreated) throw new Error('no recreated window');
    await expectExternalSafetyNet(recreated, env.openExternal);
  });
});
