import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { DEFAULT_SERVER_HOST } from '@inkeep/open-knowledge-core';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { breakServerLockHeldBy } from '../../src/main/server-lock-break.ts';
import type { ShowGateRegistry } from '../../src/main/show-gate.ts';
import {
  type BrowserWindowLike,
  type ServerLockMetadataLike,
  type UtilityProcessLike,
  WindowManager,
  type WindowManagerDeps,
} from '../../src/main/window-manager.ts';

/**
 * WindowManager unit tests.
 *
 * No real Electron — uses BrowserWindowLike + UtilityProcessLike subset
 * interfaces with mocked implementations. Asserts:
 *   - createProjectWindow forks utility, sends init, waits for ready, creates window
 *   - re-opening an already-open project focuses the existing window
 *   - utility 'exit' event removes the project from the map + schedules liveness probe
 *   - window close → utility shutdown IPC
 */

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

function makeWindow(opts?: { minimized?: boolean; focused?: boolean }): BrowserWindowLike & {
  fireClose: () => void;
  fireDomReady: () => void;
  fireDidFinishLoad: () => void;
  markDestroyed: () => void;
} {
  // Multiple `'closed'` listeners coexist in real Electron (e.g. the attach
  // factory's cleanup handler + `closeAndAwait`'s resolve hook); model that
  // faithfully so close-then-recreate teardown is exercised, not clobbered.
  const closeHandlers: Array<() => void> = [];
  let domReadyHandler: (() => void) | null = null;
  let didFinishLoadHandler: (() => void) | null = null;
  let minimized = opts?.minimized ?? false;
  let destroyed = false;
  let visible = false;
  const fireClose = () => {
    for (const h of closeHandlers) h();
  };
  return {
    focus: vi.fn(() => {}),
    show: vi.fn(() => {
      visible = true;
    }),
    // Reveals like `show` but never foregrounds the app — the distinction the
    // non-activating raise depends on.
    showInactive: vi.fn(() => {
      visible = true;
    }),
    restore: vi.fn(() => {
      minimized = false;
    }),
    isMinimized: vi.fn(() => minimized),
    moveTop: vi.fn(() => {}),
    isFocused: vi.fn(() => opts?.focused ?? false),
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => visible),
    on: vi.fn((_event: 'closed', cb: () => void) => {
      closeHandlers.push(cb);
    }) as BrowserWindowLike['on'],
    once: vi.fn((_event: 'ready-to-show', _cb: () => void) => {}) as BrowserWindowLike['once'],
    close: vi.fn(() => {
      destroyed = true;
      fireClose();
    }),
    destroy: vi.fn(() => {
      destroyed = true;
      fireClose();
    }),
    webContents: {
      send: vi.fn(() => {}),
      once: vi.fn((event: 'dom-ready' | 'did-finish-load', cb: () => void) => {
        if (event === 'dom-ready') domReadyHandler = cb;
        else if (event === 'did-finish-load') didFinishLoadHandler = cb;
      }),
    },
    loadFile: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
    fireClose,
    markDestroyed: () => {
      destroyed = true;
    },
    fireDomReady: () => domReadyHandler?.(),
    fireDidFinishLoad: () => didFinishLoadHandler?.(),
  };
}

interface ShowGateRegistration {
  window: BrowserWindowLike;
  kind: 'editor' | 'navigator';
  disposed: boolean;
}

interface TestEnv {
  utilities: MockUtility[];
  windows: Array<ReturnType<typeof makeWindow>>;
  /** Opts recorded from each createWindow call, parallel to `windows`. */
  createWindowOpts: Array<{
    additionalArguments: string[];
    title: string;
    projectPath?: string;
  }>;
  forkUtilityArgs: string[][];
  timers: Array<{ cb: () => void; ms: number }>;
  killProbe: ReturnType<typeof vi.fn>;
  activateApp: ReturnType<typeof vi.fn>;
  showGateRegistrations: ShowGateRegistration[];
  deps: WindowManagerDeps;
}

function buildEnv(): TestEnv {
  const utilities: MockUtility[] = [];
  const windows: Array<ReturnType<typeof makeWindow>> = [];
  const createWindowOpts: Array<{
    additionalArguments: string[];
    title: string;
    projectPath?: string;
  }> = [];
  const forkUtilityArgs: string[][] = [];
  const timers: Array<{ cb: () => void; ms: number }> = [];
  const killProbe = vi.fn(() => {});
  const activateApp = vi.fn(() => {});
  const showGateRegistrations: ShowGateRegistration[] = [];
  // Test stub for the show-gate — captures register() calls and immediately
  // signals the dual-signal contract so existing tests that rely on `show()`
  // being callable (e.g. focusWindowForProject) still see expected behavior.
  // Real show-gate dual-signal logic is tested in show-gate.test.ts.
  const showGate: ShowGateRegistry = {
    register: (window, opts) => {
      const reg: ShowGateRegistration = {
        window,
        kind: opts?.kind ?? 'editor',
        disposed: false,
      };
      showGateRegistrations.push(reg);
      return () => {
        reg.disposed = true;
      };
    },
    fireThemeApplied: () => {},
  };
  let pidCounter = 10000;
  return {
    utilities,
    windows,
    createWindowOpts,
    forkUtilityArgs,
    timers,
    killProbe,
    activateApp,
    showGateRegistrations,
    deps: {
      createWindow: (opts) => {
        createWindowOpts.push(opts);
        const w = makeWindow();
        windows.push(w);
        return w;
      },
      forkUtility: (_entry, args) => {
        forkUtilityArgs.push(args);
        const u = makeUtility(++pidCounter);
        utilities.push(u);
        return u;
      },
      utilityEntryPath: '/fake/utility-entry.js',
      rendererEntryPath: '/fake/renderer/index.html',
      appVersion: '9.9.9-test',
      setTimeout: (cb, ms) => {
        timers.push({ cb, ms });
        return null;
      },
      killProbe,
      activateApp,
      showGate,
    },
  };
}

describe('WindowManager', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  test('createProjectWindow sets BrowserWindow title to "<projectName> — OpenKnowledge" (spawn path)', async () => {
    const wm = new WindowManager(env.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/dragon-wiki' });
    env.utilities[0]?.fire({ type: 'ready', port: 52010, apiOrigin: 'http://localhost:52010' });
    await promise;
    expect(env.createWindowOpts[0]?.title).toBe('dragon-wiki — OpenKnowledge');
  });

  test('createProjectWindow threads project identity to the window seam (spawn path)', async () => {
    // The production seam keys per-project window-bounds memory and
    // focus-recency tracking on `projectPath` — it must arrive alongside the
    // window construction opts, and must be the SAME string
    // `getOpenProjectPaths()` returns (= `ctx.projectPath`).
    const wm = new WindowManager(env.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/dragon-wiki' });
    env.utilities[0]?.fire({ type: 'ready', port: 52010, apiOrigin: 'http://localhost:52010' });
    const ctx = await promise;
    expect(env.createWindowOpts[0]?.projectPath).toBe(ctx.projectPath);
  });

  test('createProjectWindow injects --ok-fresh-create=1 only when freshlyCreated is set', async () => {
    // The renderer's onboarding card reads this flag (via preload → bridge
    // config) to stay visible for a first-run create-new project even when a
    // starter pack seeded it with content. Absent → omitted (coerces false).
    const wmFresh = new WindowManager(env.deps);
    const freshPromise = wmFresh.createProjectWindow({
      projectPath: '/tmp/seeded',
      freshlyCreated: true,
    });
    env.utilities[0]?.fire({ type: 'ready', port: 52010, apiOrigin: 'http://localhost:52010' });
    await freshPromise;
    expect(env.createWindowOpts[0]?.additionalArguments).toContain('--ok-fresh-create=1');

    const env2 = buildEnv();
    const wmPlain = new WindowManager(env2.deps);
    const plainPromise = wmPlain.createProjectWindow({ projectPath: '/tmp/opened' });
    env2.utilities[0]?.fire({ type: 'ready', port: 52011, apiOrigin: 'http://localhost:52011' });
    await plainPromise;
    expect(env2.createWindowOpts[0]?.additionalArguments).not.toContain('--ok-fresh-create=1');
  });

  test('createProjectWindow forks utility, sends init, waits for ready, creates window', async () => {
    const wm = new WindowManager(env.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/test-project' });

    // Utility must carry the project lock dir in argv so `ok ps` can discover
    // Electron-hosted servers without changing the utility's effective cwd.
    expect(env.utilities.length).toBe(1);
    const marker = env.forkUtilityArgs[0]?.find((arg) => arg.startsWith('--ok-lock-dir-b64='));
    expect(marker).toBeDefined();
    expect(
      Buffer.from(marker?.slice('--ok-lock-dir-b64='.length) ?? '', 'base64url').toString('utf8'),
    ).toBe('/tmp/test-project/.ok/local');
    const utility = env.utilities[0];
    if (!utility) throw new Error('utility not forked');
    expect(utility.postMessage).toHaveBeenCalledWith({
      type: 'init',
      opts: {
        contentDir: '/tmp/test-project',
        projectDir: '/tmp/test-project',
        port: 0,
        host: '127.0.0.1',
        didEnsureGit: false,
        consentVersion: 1,
        // dirname(rendererEntryPath) — the React-shell dist dir the utility
        // serves over its existing HTTP port.
        reactShellDistDir: '/fake/renderer',
      },
    });

    // Reply with ready
    utility.fire({ type: 'ready', port: 51234, apiOrigin: 'http://localhost:51234' });

    const ctx = await promise;
    expect(ctx.port).toBe(51234);
    expect(ctx.apiOrigin).toBe('http://localhost:51234');
    expect(ctx.projectName).toBe('test-project');

    // Window must have been created with the right additionalArguments
    expect(env.windows.length).toBe(1);
    expect(env.windows[0]?.loadFile).toHaveBeenCalledWith('/fake/renderer/index.html');
  });

  test('createProjectWindow binds the utility server to numeric IPv4 loopback, never a hostname', async () => {
    // macOS resolves `localhost` IPv6-first, so `listen(port, 'localhost')`
    // binds `[::1]` ONLY. Every dialer — the MCP shim, the keepalive WS, and
    // `ok ps` — uses DEFAULT_SERVER_HOST, which is numeric IPv4. Passing a
    // hostname here makes a dev-launched project's server unreachable to its
    // own MCP: the keepalive errors and reconnects forever while the window
    // itself works fine, because the window talks to the utility in-process
    // and never dials. Assert the literal AND the constant so neither side
    // can drift into a name.
    const wm = new WindowManager(env.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/loopback-bind' });

    const utility = env.utilities[0];
    if (!utility) throw new Error('utility not forked');
    const payload = (utility.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      opts: { host: string };
    };
    expect(payload.opts.host).toBe('127.0.0.1');
    expect(payload.opts.host).toBe(DEFAULT_SERVER_HOST);

    utility.fire({ type: 'ready', port: 51999, apiOrigin: 'http://127.0.0.1:51999' });
    await promise;
  });

  test('createProjectWindow forwards localOpCliArgs into the utility init IPC payload', async () => {
    // localOpCliArgs must reach the utility init payload so
    // the API server can spawn the CLI in packaged builds (where open-knowledge
    // is not on PATH). Without this, /api/local-op/auth/login falls back to
    // createApiExtension's default ['open-knowledge'] and fails.
    const wm = new WindowManager(env.deps);
    const expectedCliArgs = ['/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh'];
    const promise = wm.createProjectWindow({
      projectPath: '/tmp/cli-args-plumbed',
      localOpCliArgs: expectedCliArgs,
    });

    const utility = env.utilities[0];
    if (!utility) throw new Error('utility not forked');
    expect(utility.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'init',
        opts: expect.objectContaining({ localOpCliArgs: expectedCliArgs }),
      }),
    );

    // Drain the ready so the createProjectWindow promise resolves and the
    // test harness's after-each cleanup doesn't leak a pending utility.
    utility.fire({ type: 'ready', port: 51235, apiOrigin: 'http://localhost:51235' });
    await promise;
  });

  test('createProjectWindow OMITS reactShellDistDir in dev mode (rendererDevUrl set)', async () => {
    // Dev-mode regression: `rendererEntryPath` resolves to
    // `<out>/renderer/index.html` — a path electron-vite never writes
    // (vite dev server streams the renderer over `rendererDevUrl`).
    // Forwarding `dirname(rendererEntryPath)` to the utility's sirv
    // mount scandir-ENOENTs, rejects `createProjectWindow`, and dumps
    // the user back to Navigator.
    // When `rendererDevUrl` is set, the init payload MUST omit
    // `reactShellDistDir` so the utility skips the sirv mount.
    const devEnv = buildEnv();
    devEnv.deps.rendererDevUrl = 'http://localhost:5173/';
    const wm = new WindowManager(devEnv.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/dev-mode-project' });

    const utility = devEnv.utilities[0];
    if (!utility) throw new Error('utility not forked');

    // Strict-equality on the init payload — `reactShellDistDir` must be
    // absent as a KEY, not just `undefined`. The conditional-spread
    // shape in `window-manager.ts` is what the utility's `Pick<>` type
    // assumes.
    expect(utility.postMessage).toHaveBeenCalledWith({
      type: 'init',
      opts: {
        contentDir: '/tmp/dev-mode-project',
        projectDir: '/tmp/dev-mode-project',
        port: 0,
        host: '127.0.0.1',
        didEnsureGit: false,
        consentVersion: 1,
      },
    });

    // Confirm key absence directly (defensive — `objectContaining` semantics
    // wouldn't catch a `reactShellDistDir: undefined` leak).
    const initCall = utility.postMessage.mock.calls.find(
      (c) => (c[0] as { type?: string }).type === 'init',
    )?.[0] as { opts: Record<string, unknown> };
    expect(initCall.opts).not.toHaveProperty('reactShellDistDir');

    utility.fire({ type: 'ready', port: 51236, apiOrigin: 'http://localhost:51236' });
    await promise;
  });

  test('opening the same project twice focuses the existing window (D44 case a)', async () => {
    const wm = new WindowManager(env.deps);
    const p1 = wm.createProjectWindow({ projectPath: '/tmp/p1' });
    env.utilities[0]?.fire({ type: 'ready', port: 51001, apiOrigin: 'http://localhost:51001' });
    const ctx1 = await p1;

    const p2 = wm.createProjectWindow({ projectPath: '/tmp/p1' });
    const ctx2 = await p2;

    expect(env.utilities.length).toBe(1);
    expect(env.windows.length).toBe(1);
    expect(ctx2).toBe(ctx1);
    expect(ctx1.window.focus).toHaveBeenCalled();
  });

  test('stale destroyed-window entry does NOT throw; spawns fresh', async () => {
    // Repro: a project window's `closed` event fires (BrowserWindow native
    // object destroyed) but the utility's `exit` hasn't run yet, so the
    // `windowsByPath` entry still references the destroyed window. A new
    // open click in this gap previously called `focus()` on the destroyed
    // object and threw "TypeError: Object has been destroyed".
    const wm = new WindowManager(env.deps);
    const p1 = wm.createProjectWindow({ projectPath: '/tmp/destroyable' });
    env.utilities[0]?.fire({ type: 'ready', port: 51100, apiOrigin: 'http://localhost:51100' });
    await p1;

    // Window destroyed; utility exit hasn't fired yet (so windowsByPath
    // still has the entry).
    env.windows[0]?.markDestroyed();

    const p2 = wm.createProjectWindow({ projectPath: '/tmp/destroyable' });
    // Should fall through to spawn-fresh (new utility) instead of throwing.
    expect(env.utilities.length).toBe(2);
    env.utilities[1]?.fire({ type: 'ready', port: 51101, apiOrigin: 'http://localhost:51101' });
    const ctx2 = await p2;
    expect(env.windows.length).toBe(2);
    expect(ctx2.port).toBe(51101);
    // The destroyed window's focus must NOT have been called on this path.
    expect(env.windows[0]?.focus).not.toHaveBeenCalled();
  });

  test('utility error message rejects createProjectWindow', async () => {
    const wm = new WindowManager(env.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/err' });
    env.utilities[0]?.fire({ type: 'error', message: 'boot failed' });
    await expect(promise).rejects.toThrow('boot failed');
  });

  test('utility exits before ready → createProjectWindow rejects (no hang)', async () => {
    const wm = new WindowManager(env.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/early-exit' });
    // Utility crashes before posting 'ready' or 'error'. The original
    // implementation would hang here forever because the exit listener was
    // only registered AFTER `await ready`. The fix registers the exit
    // listener alongside the message listener inside the ready promise.
    env.utilities[0]?.fireExit(1);
    await expect(promise).rejects.toThrow(/utility exited before ready.*code=1/);
  });

  test('utility stays silent → init times out with actionable error', async () => {
    // Install a setTimeout mock that fires synchronously so we don't need
    // real timer waits. The default env.deps.setTimeout pushes to
    // env.timers without firing — we override here just for this test.
    const fireList: Array<() => void> = [];
    env.deps.setTimeout = (cb, ms) => {
      fireList.push(cb);
      env.timers.push({ cb, ms });
      return null;
    };
    // Tight budget so the test error message is predictable.
    env.deps.utilityInitTimeoutMs = 500;

    const wm = new WindowManager(env.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/stuck' });
    // Simulate the timer firing without any other message / exit arriving.
    expect(fireList.length).toBeGreaterThan(0);
    fireList[0]?.();
    await expect(promise).rejects.toThrow(/utility init timed out after 500ms/);
  });

  test('timeout timer is harmless if ready landed first (no double-settle)', async () => {
    const fireList: Array<() => void> = [];
    env.deps.setTimeout = (cb, ms) => {
      fireList.push(cb);
      env.timers.push({ cb, ms });
      return null;
    };

    const wm = new WindowManager(env.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/fast-ready' });
    env.utilities[0]?.fire({ type: 'ready', port: 51010, apiOrigin: 'http://localhost:51010' });
    await promise;

    // Fire the timeout AFTER ready settled. Must not reject, must not throw.
    expect(() => fireList[0]?.()).not.toThrow();
  });

  test('window close → utility shutdown IPC', async () => {
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/close-test' });
    env.utilities[0]?.fire({ type: 'ready', port: 51002, apiOrigin: 'http://localhost:51002' });
    await p;

    env.windows[0]?.fireClose();
    expect(env.utilities[0]?.postMessage).toHaveBeenCalledWith({ type: 'shutdown' });
  });

  test('utility exit removes project from map AND schedules liveness probe (D39)', async () => {
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/exit-test' });
    env.utilities[0]?.fire({ type: 'ready', port: 51003, apiOrigin: 'http://localhost:51003' });
    await p;

    expect(wm.windowCount()).toBe(1);
    env.utilities[0]?.fireExit(0);
    expect(wm.windowCount()).toBe(0);

    // env.timers now contains the init-timeout timer (15_000ms, registered during
    // the ready promise and harmless after ready settled) AND the post-exit
    // liveness probe (1000ms). Find the liveness probe by its cadence.
    const livenessProbe = env.timers.find((t) => t.ms === 1000);
    expect(livenessProbe).toBeDefined();
  });

  test('getOpenProjectPaths is empty with no project windows open', () => {
    const wm = new WindowManager(env.deps);
    expect(wm.getOpenProjectPaths()).toEqual([]);
  });

  test('getOpenProjectPaths returns the path of every live project window', async () => {
    const wm = new WindowManager(env.deps);
    const p1 = wm.createProjectWindow({ projectPath: '/tmp/alpha' });
    env.utilities[0]?.fire({ type: 'ready', port: 52100, apiOrigin: 'http://localhost:52100' });
    await p1;
    const p2 = wm.createProjectWindow({ projectPath: '/tmp/beta' });
    env.utilities[1]?.fire({ type: 'ready', port: 52101, apiOrigin: 'http://localhost:52101' });
    await p2;

    expect(wm.getOpenProjectPaths().sort()).toEqual(['/tmp/alpha', '/tmp/beta']);
  });

  test('getOpenProjectPaths skips a window destroyed before its utility exit fires', async () => {
    // The `closed` event destroys the native window but the `windowsByPath`
    // entry lingers until the utility's `exit` listener clears it — the
    // pre-relaunch snapshot must not carry that dead window.
    const wm = new WindowManager(env.deps);
    const p1 = wm.createProjectWindow({ projectPath: '/tmp/gamma' });
    env.utilities[0]?.fire({ type: 'ready', port: 52200, apiOrigin: 'http://localhost:52200' });
    await p1;
    const p2 = wm.createProjectWindow({ projectPath: '/tmp/delta' });
    env.utilities[1]?.fire({ type: 'ready', port: 52201, apiOrigin: 'http://localhost:52201' });
    await p2;

    env.windows[0]?.markDestroyed();
    expect(wm.getOpenProjectPaths()).toEqual(['/tmp/delta']);
  });

  test('liveness probe sends SIGTERM if pid still alive 1s after exit', async () => {
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/zombie-test' });
    env.utilities[0]?.fire({ type: 'ready', port: 51004, apiOrigin: 'http://localhost:51004' });
    await p;
    const utilityPid = env.utilities[0]?.pid;

    env.utilities[0]?.fireExit(0);
    const livenessProbe = env.timers.find((t) => t.ms === 1000);
    expect(livenessProbe).toBeDefined();

    // Simulate "pid still alive" — killProbe doesn't throw
    livenessProbe?.cb();
    expect(env.killProbe).toHaveBeenCalledWith(utilityPid, 0);
    expect(env.killProbe).toHaveBeenCalledWith(utilityPid, 'SIGTERM');
  });

  test('liveness probe is silent if pid is truly gone (probe throws)', async () => {
    env.killProbe = vi.fn(() => {
      throw new Error('No such process');
    });
    env.deps.killProbe = env.killProbe;
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/clean-exit' });
    env.utilities[0]?.fire({ type: 'ready', port: 51005, apiOrigin: 'http://localhost:51005' });
    await p;

    env.utilities[0]?.fireExit(0);
    const livenessProbe = env.timers.find((t) => t.ms === 1000);
    expect(livenessProbe).toBeDefined();
    // Should NOT throw — probe throws are caught
    expect(() => livenessProbe?.cb()).not.toThrow();
    // Only the initial probe (pid, 0) was called; no SIGTERM follow-up
    expect(env.killProbe).toHaveBeenCalledTimes(1);
  });

  test('runClean (when provided) is called before forking utility', async () => {
    const runClean = vi.fn(() => Promise.resolve());
    env.deps.runClean = runClean;
    const wm = new WindowManager(env.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/clean-run' });
    expect(env.utilities.length).toBe(0); // not forked yet
    // Wait a microtask so runClean's promise resolves
    await wait(5);
    expect(runClean).toHaveBeenCalledWith({ lockDir: '/tmp/clean-run/.ok/local' });
    env.utilities[0]?.fire({ type: 'ready', port: 51006, apiOrigin: 'http://localhost:51006' });
    await promise;
  });

  test('closeProjectWindow sends shutdown IPC + returns true', async () => {
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/close-via-api' });
    env.utilities[0]?.fire({ type: 'ready', port: 51007, apiOrigin: 'http://localhost:51007' });
    await p;
    expect(wm.closeProjectWindow('/tmp/close-via-api')).toBe(true);
    expect(env.utilities[0]?.postMessage).toHaveBeenCalledWith({ type: 'shutdown' });
  });

  test('closeProjectWindow on unknown project returns false', () => {
    const wm = new WindowManager(env.deps);
    expect(wm.closeProjectWindow('/tmp/never-opened')).toBe(false);
  });

  test('closeProjectWindow swallows postMessage errors (utility already exited)', async () => {
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/detached-port' });
    env.utilities[0]?.fire({ type: 'ready', port: 51099, apiOrigin: 'http://localhost:51099' });
    await p;

    // Simulate the utility having already exited — postMessage throws
    // (ERR_IPC_CHANNEL_CLOSED in production).
    const utility = env.utilities[0];
    if (!utility) throw new Error('utility missing');
    utility.postMessage = vi.fn(() => {
      throw new Error('ERR_IPC_CHANNEL_CLOSED');
    });

    // Must not throw — the handler swallows the error + logs.
    expect(() => wm.closeProjectWindow('/tmp/detached-port')).not.toThrow();
  });

  test('getContextForBrowserWindow resolves the project for a given window', async () => {
    const wm = new WindowManager(env.deps);
    const p1 = wm.createProjectWindow({ projectPath: '/tmp/ctx-a' });
    env.utilities[0]?.fire({ type: 'ready', port: 52001, apiOrigin: 'http://localhost:52001' });
    const ctxA = await p1;
    const p2 = wm.createProjectWindow({ projectPath: '/tmp/ctx-b' });
    env.utilities[1]?.fire({ type: 'ready', port: 52002, apiOrigin: 'http://localhost:52002' });
    const ctxB = await p2;

    expect(wm.getContextForBrowserWindow(ctxA.window)).toBe(ctxA);
    expect(wm.getContextForBrowserWindow(ctxB.window)).toBe(ctxB);
  });

  test('getContextForBrowserWindow returns undefined for unknown window', () => {
    const wm = new WindowManager(env.deps);
    const stranger = makeWindow();
    expect(wm.getContextForBrowserWindow(stranger)).toBeUndefined();
  });

  test('getContextForBrowserWindow resolves a window whose renderer is still loading', async () => {
    // The window exists — and its application menu is live — from the moment
    // `createWindow` returns, but the `windowsByPath` entry lands only once
    // `loadFile` resolves. Anything that asks "which project owns this window"
    // inside that gap used to be told "none", so Terminal -> New Terminal Window
    // opened a HOME-cwd window with an empty collab URL instead of inheriting the
    // project. Hold `loadFile` open and ask mid-load.
    let releaseLoad: (() => void) | undefined;
    env.deps.createWindow = (opts) => {
      env.createWindowOpts.push(opts);
      const w = makeWindow();
      w.loadFile = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseLoad = resolve;
          }),
      ) as typeof w.loadFile;
      env.windows.push(w);
      return w;
    };

    const wm = new WindowManager(env.deps);
    const pending = wm.createProjectWindow({ projectPath: '/tmp/ctx-mid-load' });
    env.utilities[0]?.fire({ type: 'ready', port: 52101, apiOrigin: 'http://localhost:52101' });
    // Let the spawn path run up to (and park on) `await loadFile`.
    await vi.waitFor(() => {
      expect(releaseLoad).toBeDefined();
    });

    const loading = env.windows[0];
    if (!loading) throw new Error('window was never created');
    const midLoad = wm.getContextForBrowserWindow(loading);
    expect(midLoad?.projectPath).toBe('/tmp/ctx-mid-load');
    expect(midLoad?.apiOrigin).toBe('http://localhost:52101');

    releaseLoad?.();
    const settled = await pending;
    // The same object once the load resolves, not a copy that could drift from
    // the authoritative entry.
    expect(wm.getContextForBrowserWindow(loading)).toBe(settled);
  });

  test('a window whose renderer load rejects stops resolving to a project', async () => {
    // The mid-load answer must not outlive a failed load: a window that never
    // came up owns nothing, and a stale entry would hand New Terminal Window a
    // project whose window is already gone.
    let rejectLoad: ((err: Error) => void) | undefined;
    env.deps.createWindow = (opts) => {
      env.createWindowOpts.push(opts);
      const w = makeWindow();
      w.loadFile = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectLoad = reject;
          }),
      ) as typeof w.loadFile;
      env.windows.push(w);
      return w;
    };

    const wm = new WindowManager(env.deps);
    const pending = wm.createProjectWindow({ projectPath: '/tmp/ctx-load-fails' });
    env.utilities[0]?.fire({ type: 'ready', port: 52102, apiOrigin: 'http://localhost:52102' });
    await vi.waitFor(() => {
      expect(rejectLoad).toBeDefined();
    });

    const loading = env.windows[0];
    if (!loading) throw new Error('window was never created');
    expect(wm.getContextForBrowserWindow(loading)?.projectPath).toBe('/tmp/ctx-load-fails');

    rejectLoad?.(new Error('ERR_FILE_NOT_FOUND'));
    await expect(pending).rejects.toThrow('ERR_FILE_NOT_FOUND');
    expect(wm.getContextForBrowserWindow(loading)).toBeUndefined();
  });

  test('onUtilityMessage (when wired) receives post-init utility messages', async () => {
    const observed: unknown[] = [];
    env.deps.onUtilityMessage = (msg) => observed.push(msg);
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/post-init-listener' });
    env.utilities[0]?.fire({ type: 'ready', port: 52100, apiOrigin: 'http://localhost:52100' });
    await p;

    // Post-init message routes to the wired listener.
    env.utilities[0]?.fire({
      type: 'debug-keyring-smoke-result',
      correlationId: 'cid-42',
      result: { ok: true, backend: 'keyring', durationMs: 9, timestamp: '2026-04-21T00:00:00Z' },
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      type: 'debug-keyring-smoke-result',
      correlationId: 'cid-42',
    });
  });

  test('onUtilityMessage is not attached when not provided (no-op for back-compat)', async () => {
    delete env.deps.onUtilityMessage;
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/no-listener' });
    env.utilities[0]?.fire({ type: 'ready', port: 52101, apiOrigin: 'http://localhost:52101' });
    await p;
    // Firing a debug result should not throw even without a listener wired.
    expect(() =>
      env.utilities[0]?.fire({
        type: 'debug-keyring-smoke-result',
        correlationId: 'x',
        result: {},
      }),
    ).not.toThrow();
  });

  test('onUtilityExit (when wired) is invoked on utility exit with the utility ref', async () => {
    const observed: unknown[] = [];
    env.deps.onUtilityExit = (utility) => observed.push(utility);
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/exit-hook' });
    env.utilities[0]?.fire({ type: 'ready', port: 52200, apiOrigin: 'http://localhost:52200' });
    await p;

    const utilityRef = env.utilities[0];
    env.utilities[0]?.fireExit(0);

    expect(observed).toHaveLength(1);
    // Identity match: consumer (debug-ipc) will use this to select pending
    // entries for cleanup via ===.
    expect(observed[0]).toBe(utilityRef);
  });

  test('onUtilityExit is not attached when not provided (no-op for back-compat)', async () => {
    delete env.deps.onUtilityExit;
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/no-exit-hook' });
    env.utilities[0]?.fire({ type: 'ready', port: 52201, apiOrigin: 'http://localhost:52201' });
    await p;
    // Firing exit should not throw even without a listener wired.
    expect(() => env.utilities[0]?.fireExit(1)).not.toThrow();
  });

  // Attach-mode tests — when a live same-host server
  // already holds the lock (a running `ok start` CLI, another Electron
  // instance, etc.), reuse it instead of fighting over the lock.

  describe('attach mode', () => {
    const liveLock: ServerLockMetadataLike = {
      pid: 65792,
      hostname: 'my-host',
      port: 59534,
      startedAt: '2026-04-17T20:23:20.713Z',
      worktreeRoot: '/tmp/dragon',
      // New contract — same-version interactive server with full collab.
      kind: 'interactive',
      capabilities: ['http', 'ws'],
    };

    /**
     * Wire attach-mode deps on top of the base env so a single probe path is
     * active. Individual tests override `readServerLock` / `isProcessAlive`
     * to exercise the fall-through criteria. The WS probe defaults to
     * "always succeed" so happy-path tests don't have to wire it manually;
     * the rejection-branch tests override per case.
     */
    function enableAttachProbe(overrides?: {
      readServerLock?: WindowManagerDeps['readServerLock'];
      isProcessAlive?: WindowManagerDeps['isProcessAlive'];
      hostname?: WindowManagerDeps['hostname'];
      probeWsUpgrade?: WindowManagerDeps['probeWsUpgrade'];
    }) {
      env.deps.readServerLock = overrides?.readServerLock ?? (() => liveLock);
      env.deps.isProcessAlive = overrides?.isProcessAlive ?? (() => true);
      env.deps.hostname = overrides?.hostname ?? (() => 'my-host');
      env.deps.probeWsUpgrade = overrides?.probeWsUpgrade ?? (() => Promise.resolve(true));
    }

    test('attaches to live same-host lock — no utility forked', async () => {
      enableAttachProbe();
      const runClean = vi.fn(() => Promise.resolve());
      env.deps.runClean = runClean;

      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });

      expect(env.utilities.length).toBe(0);
      expect(runClean).not.toHaveBeenCalled();
      expect(ctx.ownsServer).toBe(false);
      expect(ctx.utility).toBeNull();
      expect(ctx.port).toBe(59534);
      expect(ctx.apiOrigin).toBe('http://localhost:59534');
      expect(env.windows.length).toBe(1);
      // Title is set from projectName in the attach path too.
      expect(env.createWindowOpts[0]?.title).toBe('dragon — OpenKnowledge');
      // Project identity for bounds/focus memory rides the attach path too —
      // it's the production path, so omitting it here would silently disable
      // window-position restore in packaged builds.
      expect(env.createWindowOpts[0]?.projectPath).toBe(ctx.projectPath);
    });

    test('an attach-mode window resolves to its project while its renderer loads', async () => {
      // Same gap as the spawn path: the attach path also registers in
      // `windowsByPath` only once the renderer load resolves, and an
      // attach-mode window is an ordinary editor window as far as
      // Terminal -> New Terminal Window is concerned.
      enableAttachProbe();
      let releaseLoad: (() => void) | undefined;
      env.deps.createWindow = (opts) => {
        env.createWindowOpts.push(opts);
        const w = makeWindow();
        w.loadFile = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseLoad = resolve;
            }),
        ) as typeof w.loadFile;
        env.windows.push(w);
        return w;
      };

      const wm = new WindowManager(env.deps);
      const pending = wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      await vi.waitFor(() => {
        expect(releaseLoad).toBeDefined();
      });

      const loading = env.windows[0];
      if (!loading) throw new Error('window was never created');
      expect(wm.getContextForBrowserWindow(loading)?.projectPath).toBe('/tmp/dragon');

      releaseLoad?.();
      expect(wm.getContextForBrowserWindow(loading)).toBe(await pending);
    });

    test('a throw between the load and the registry does not strand the loading entry', async () => {
      // `createKeepalive` runs after the renderer load and before
      // `windowsByPath.set`. If that span is not bracketed, a throw there leaves
      // the context — and its strong BrowserWindow reference — in
      // `loadingContextByWindow` for the life of the process, and a destroyed
      // window keeps resolving to a project.
      enableAttachProbe();
      env.deps.createKeepalive = vi.fn(() => {
        throw new Error('keepalive boom');
      }) as unknown as WindowManagerDeps['createKeepalive'];

      const wm = new WindowManager(env.deps);
      await expect(wm.createProjectWindow({ projectPath: '/tmp/dragon' })).rejects.toThrow(
        'keepalive boom',
      );

      const stranded = env.windows[0];
      if (!stranded) throw new Error('window was never created');
      expect(wm.getContextForBrowserWindow(stranded)).toBeUndefined();
    });

    test('attach path injects --ok-fresh-create=1 when freshlyCreated is set (production path)', async () => {
      // Attach mode — both the direct-attach and detached-spawn callers delegate
      // here — is the PRODUCTION window path (packaged builds wire
      // spawnDetachedServer). The onboarding-card flag MUST be injected here too,
      // not only in the dev/test utility-fork branch, or the starter-pack fix
      // silently fails for every packaged user.
      enableAttachProbe();
      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({
        projectPath: '/tmp/dragon',
        freshlyCreated: true,
      });
      // No utility forked → we genuinely took the attach path, not utility-fork.
      expect(env.utilities.length).toBe(0);
      expect(ctx.ownsServer).toBe(false);
      expect(env.createWindowOpts[0]?.additionalArguments).toContain('--ok-fresh-create=1');
    });

    test('attach path omits --ok-fresh-create=1 when freshlyCreated is not set', async () => {
      enableAttachProbe();
      const wm = new WindowManager(env.deps);
      await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(env.createWindowOpts[0]?.additionalArguments).not.toContain('--ok-fresh-create=1');
    });

    // The canonical attach contract (server.lock v2): a shell-serving server
    // advertises ONE record — `url` plus `capabilities` containing "ui" — and
    // everything the desktop dials must derive from that record. These pins
    // are what make it provably safe to retire the `ok ui` sibling + `ui.lock`:
    // the desktop's attach surface consumes only server.lock.

    test('attach consumes the v2 advertisement end-to-end — probe + renderer args derive from url', async () => {
      // A ui-capable holder bound to a non-default loopback (::1). If any
      // dial falls back to a hardcoded localhost:<port>, the attach succeeds
      // but every subsequent connection misses the server.
      const probed: string[] = [];
      enableAttachProbe({
        readServerLock: () => ({
          ...liveLock,
          url: 'http://[::1]:59534',
          capabilities: ['http', 'ws', 'ui'],
        }),
        probeWsUpgrade: (url) => {
          probed.push(url);
          return Promise.resolve(true);
        },
      });
      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });

      expect(ctx.ownsServer).toBe(false);
      expect(ctx.apiOrigin).toBe('http://[::1]:59534');
      // The WS-upgrade health probe dials the advertised origin.
      expect(probed).toEqual(['ws://[::1]:59534/collab/__attach_probe__']);
      // The renderer's injected args — the preload/React bundle's only view of
      // the server — carry the same one-URL derivation.
      const args = env.createWindowOpts[0]?.additionalArguments ?? [];
      expect(args).toContain('--ok-api-origin=http://[::1]:59534');
      expect(args).toContain('--ok-collab-url=ws://[::1]:59534/collab');
    });

    test('pre-v2 lock (no url) attaches with the localhost:<port> fallback end-to-end', async () => {
      // Version-skew window: an older server's lock has no `url`. The desktop
      // must keep attaching via the port so a stable-channel straggler server
      // still gets a window.
      const probed: string[] = [];
      enableAttachProbe({
        probeWsUpgrade: (url) => {
          probed.push(url);
          return Promise.resolve(true);
        },
      });
      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });

      expect(ctx.apiOrigin).toBe('http://localhost:59534');
      expect(probed).toEqual(['ws://localhost:59534/collab/__attach_probe__']);
      const args = env.createWindowOpts[0]?.additionalArguments ?? [];
      expect(args).toContain('--ok-api-origin=http://localhost:59534');
      expect(args).toContain('--ok-collab-url=ws://localhost:59534/collab');
    });

    test('a non-loopback lock url is refused by validation — dials fall back to the port', async () => {
      // The url comes off disk; only http(s) + loopback hosts are honored, so
      // a tampered advertisement cannot point the renderer off-machine.
      enableAttachProbe({
        readServerLock: () => ({ ...liveLock, url: 'http://evil.example:80' }),
      });
      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(ctx.apiOrigin).toBe('http://localhost:59534');
    });

    function driftSends(w: ReturnType<typeof makeWindow>): unknown[] {
      return (w.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'ok:server-version-drift',
      );
    }

    test('attach to an older server emits ok:server-version-drift on dom-ready', async () => {
      env.deps.selfProtocolVersion = 1;
      env.deps.selfRuntimeVersion = '0.8.2';
      enableAttachProbe({
        readServerLock: () => ({ ...liveLock, protocolVersion: 1, runtimeVersion: '0.8.0' }),
      });
      const wm = new WindowManager(env.deps);
      await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      const w = env.windows[0];
      if (!w) throw new Error('no window created');
      // Registered before loadURL, but only delivered on dom-ready.
      expect(driftSends(w).length).toBe(0);
      w.fireDomReady();
      const sends = driftSends(w);
      expect(sends.length).toBe(1);
      expect((sends[0] as unknown[])[1]).toEqual({
        relation: 'older',
        dimension: 'runtime',
        serverRuntime: '0.8.0',
        appRuntime: '0.8.2',
      });
    });

    test('attach to a newer server emits a newer drift', async () => {
      env.deps.selfProtocolVersion = 1;
      env.deps.selfRuntimeVersion = '0.8.2';
      enableAttachProbe({
        readServerLock: () => ({ ...liveLock, protocolVersion: 1, runtimeVersion: '0.9.0' }),
      });
      const wm = new WindowManager(env.deps);
      await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      const w = env.windows[0];
      if (!w) throw new Error('no window created');
      w.fireDomReady();
      const sends = driftSends(w);
      expect(sends.length).toBe(1);
      expect((sends[0] as unknown[])[1]).toMatchObject({ relation: 'newer' });
    });

    test('attach to a same-version server emits no drift', async () => {
      env.deps.selfProtocolVersion = 1;
      env.deps.selfRuntimeVersion = '0.8.2';
      enableAttachProbe({
        readServerLock: () => ({ ...liveLock, protocolVersion: 1, runtimeVersion: '0.8.2' }),
      });
      const wm = new WindowManager(env.deps);
      await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      const w = env.windows[0];
      if (!w) throw new Error('no window created');
      w.fireDomReady();
      expect(driftSends(w).length).toBe(0);
    });

    test('attach to a legacy lock (no version fields) emits no drift', async () => {
      env.deps.selfProtocolVersion = 1;
      env.deps.selfRuntimeVersion = '0.8.2';
      enableAttachProbe(); // liveLock carries no version fields → indeterminate
      const wm = new WindowManager(env.deps);
      await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      const w = env.windows[0];
      if (!w) throw new Error('no window created');
      w.fireDomReady();
      expect(driftSends(w).length).toBe(0);
    });

    test('restartAttachedServer terminates the server and recreates against a fresh spawn', async () => {
      // Mirror the production path: detached spawn → attach (not the dev
      // utility-fork branch), since drift/restart only occur in attach mode.
      env.deps.selfProtocolVersion = 1;
      env.deps.selfRuntimeVersion = '0.8.2';
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
      const killProbe = vi.fn((_pid: number, signal: string) => {
        if (signal === 'SIGTERM') killed = true;
      });
      enableAttachProbe({
        readServerLock: () => (spawned ? freshLock : killed ? null : oldLock),
        // The terminate poll watches PID death (not lock release) — the old
        // server "exits" as soon as SIGTERM lands.
        isProcessAlive: (pid) => (pid === 5555 ? !killed : true),
      });
      env.deps.killProbe = killProbe;
      env.deps.spawnDetachedServer = async () => {
        spawned = true;
        return { pid: 6666 };
      };

      // Note windows live outside windowsByPath, so the recreate below does not
      // reach them, and their attach argv is frozen at creation — a pop-out left
      // behind would hold a URL for the terminated server forever. The hook has
      // to carry the FRESH origin, not the old one.
      const restarted: Array<{ projectPath: string; apiOrigin: string }> = [];
      env.deps.onProjectServerRestarted = (args) => restarted.push({ ...args });

      const wm = new WindowManager(env.deps);
      const attached = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(attached.ownsServer).toBe(false);
      expect(attached.port).toBe(59534);
      expect(env.windows.length).toBe(1);

      const outcome = await wm.restartAttachedServer('/tmp/dragon');
      expect(outcome).toEqual({ ok: true });
      expect(killProbe).toHaveBeenCalledWith(5555, 'SIGTERM');
      // A fresh window attached to the respawned (matching-version) server.
      expect(env.windows.length).toBe(2);
      const ctx = wm.getContextForBrowserWindow(env.windows[1] as BrowserWindowLike);
      expect(ctx?.port).toBe(60000);

      // The note-window recreate hook fired once, carrying the NEW origin.
      expect(restarted).toHaveLength(1);
      expect(restarted[0]?.projectPath).toBe('/tmp/dragon');
      expect(restarted[0]?.apiOrigin).toContain('60000');

      // Same-version respawn → no drift notification on the new window.
      const newWindow = env.windows[1];
      if (!newWindow) throw new Error('no recreated window');
      newWindow.fireDomReady();
      expect(driftSends(newWindow).length).toBe(0);
      // The recreated window confirms the restart on did-finish-load.
      newWindow.fireDidFinishLoad();
      const restartedSends = (
        newWindow.webContents.send as ReturnType<typeof vi.fn>
      ).mock.calls.filter((c: unknown[]) => c[0] === 'ok:server-restarted');
      expect(restartedSends.length).toBe(1);
      expect((restartedSends[0] as unknown[])[1]).toEqual({ appRuntime: '0.8.2' });
    });

    test('a note-window recreate hook that throws does not fail the restart or strand the old window', async () => {
      // The recreate hook is a SECONDARY concern (note windows live outside
      // windowsByPath). A throw in it — a `BrowserWindow` constructor failure
      // under memory pressure, say — must not propagate out of the restart and
      // skip the `closeAndAwait` teardown, which would leave the old window as a
      // zombie pointing at the terminated server.
      env.deps.selfProtocolVersion = 1;
      env.deps.selfRuntimeVersion = '0.8.2';
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
      enableAttachProbe({
        readServerLock: () => (spawned ? freshLock : killed ? null : oldLock),
        isProcessAlive: (pid) => (pid === 5555 ? !killed : true),
      });
      env.deps.killProbe = vi.fn((_pid: number, signal: string) => {
        if (signal === 'SIGTERM') killed = true;
      });
      env.deps.spawnDetachedServer = async () => {
        spawned = true;
        return { pid: 6666 };
      };
      env.deps.onProjectServerRestarted = () => {
        throw new Error('recreate boom');
      };

      const wm = new WindowManager(env.deps);
      await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      const originating = env.windows[0];
      if (!originating) throw new Error('no originating window');

      const outcome = await wm.restartAttachedServer('/tmp/dragon');
      // Isolated: the restart still succeeds and the fresh window came up…
      expect(outcome).toEqual({ ok: true });
      expect(env.windows.length).toBe(2);
      // …and the old window was still torn down despite the hook throwing.
      expect(originating.isDestroyed?.()).toBe(true);
    });

    test('restartAttachedServer returns eperm without recreating when the kill is blocked', async () => {
      const lockWithPid = { ...liveLock, pid: 7777, protocolVersion: 1, runtimeVersion: '0.8.0' };
      env.deps.readServerLock = () => lockWithPid;
      env.deps.killProbe = vi.fn(() => {
        const err = new Error('operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      });
      const wm = new WindowManager(env.deps);
      const outcome = await wm.restartAttachedServer('/tmp/dragon');
      expect(outcome).toEqual({ ok: false, reason: 'eperm' });
      // No window recreated on failure.
      expect(env.windows.length).toBe(0);
      expect(env.utilities.length).toBe(0);
    });

    // "Cannot be signalled" and "is not serving" are separate facts, and the
    // restart path stops at the first one: `terminateServerByPid` reports
    // `{ ok: false, reason: 'eperm' }` when `killProbe` throws EPERM, and
    // `restartAttachedServer` returns that verbatim with no fallback. A lock
    // naming a holder this app cannot signal therefore makes the project
    // unopenable from inside the app even when the port behind that holder
    // answers nothing — and the dialog's Stop Server & Retry runs the same
    // ladder, so there is no user-reachable way out.
    test('restartAttachedServer breaks a stale lock whose unkillable holder serves nothing', async () => {
      // The base env's setTimeout only RECORDS timers, which would deadlock the
      // post-spawn lock poll a successful recreate has to run through.
      env.deps.setTimeout = (cb: () => void, _ms: number) => {
        cb();
        return null;
      };
      const STALE_PID = 870;
      const FRESH_PID = 22018;
      const staleLock = { ...liveLock, pid: STALE_PID, port: 42117 };
      const freshLock = { ...liveLock, pid: FRESH_PID, port: 60222 };
      let spawned = false;
      // The stale lock survives until our own respawn replaces it — the
      // unkillable holder is never going to release it for us.
      env.deps.readServerLock = () => (spawned ? freshLock : staleLock);
      // EPERM reads as alive (`isPidAlive`), so liveness cannot break the tie.
      env.deps.isProcessAlive = () => true;
      env.deps.hostname = () => 'my-host';
      // 42117 answers nothing; the freshly spawned server does.
      env.deps.probeWsUpgrade = (url) => Promise.resolve(!url.includes('42117'));
      env.deps.killProbe = vi.fn(() => {
        throw Object.assign(new Error('eperm'), { code: 'EPERM' });
      });
      const removeServerLock = vi.fn(() => true);
      env.deps.removeServerLock = removeServerLock;
      env.deps.spawnDetachedServer = () => {
        spawned = true;
        return Promise.resolve({ pid: FRESH_PID });
      };

      const wm = new WindowManager(env.deps);
      const outcome = await wm.restartAttachedServer('/tmp/dragon');

      // Dead-ending on EPERM is the defect: the holder cannot be signalled AND
      // is not serving, so nothing is lost by breaking its lock.
      expect(outcome).not.toEqual({ ok: false, reason: 'eperm' });
      // …and the recreate proceeds onto the freshly spawned server.
      expect(outcome).toEqual({ ok: true });
      expect(env.windows.length).toBe(1);
      const ctx = wm.getContextForBrowserWindow(env.windows[0] as BrowserWindowLike);
      expect(ctx?.port).toBe(60222);
      // The break itself, not just its consequence. `readServerLock` is stubbed
      // to stop returning the stale record once we respawn, so the recreate
      // would succeed here even if the lock were left on disk — in production it
      // would not, because the fresh server's own acquire re-reads that file and
      // its stale detection reads an EPERM pid as alive. Asserting the call
      // keeps that step from being silently dropped.
      expect(removeServerLock).toHaveBeenCalledTimes(1);
      // The LOCK DIR, not the project root. `removeServerLock` unlinks
      // `<arg>/server.lock` and swallows ENOENT, so handing it the project root
      // silently turns this entire recovery into a no-op — and an assertion
      // that merely contains the project path accepts both.
      expect(removeServerLock.mock.calls[0]?.[0]).toMatch(/[/\\]\.ok[/\\]local$/);
      expect(removeServerLock.mock.calls[0]?.[0]).toContain('/tmp/dragon');
      // The identity guard. A health probe stands between the verdict and this
      // call, which is long enough for the judged holder to exit and a fresh
      // server to take the lock; the implementation re-reads and unlinks only
      // if it still names this pid, so the pid has to travel with the request.
      expect(removeServerLock.mock.calls[0]?.[1]).toEqual({ pid: STALE_PID });
    });

    // The break can fail for reasons that have nothing to do with the holder:
    // a read-only `.ok` directory, a file held by something else. This runs on
    // the path whose whole purpose is to un-wedge a project, so it must degrade
    // to "could not break it" — replacing a stuck project with a crashed app is
    // strictly worse. Nothing pinned this, so deleting the try/catch was
    // invisible to the suite while letting the throw escape an IPC handler.
    test('restartAttachedServer survives a removeServerLock that throws', async () => {
      // The graced probe on the break path retries through `deps.setTimeout`,
      // which the base env only records; drive it so the loop resolves.
      env.deps.setTimeout = (cb: () => void, _ms: number) => {
        cb();
        return null;
      };
      env.deps.removeServerLock = vi.fn(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      });
      env.deps.readServerLock = () => ({ ...liveLock, pid: 5151, port: 42117 });
      env.deps.isProcessAlive = () => true;
      env.deps.hostname = () => 'my-host';
      env.deps.probeWsUpgrade = () => Promise.resolve(false);
      const spawn = vi.fn(() => Promise.resolve({ pid: 22018 }));
      env.deps.spawnDetachedServer = spawn;
      env.deps.killProbe = vi.fn(() => {
        throw Object.assign(new Error('eperm'), { code: 'EPERM' });
      });

      const wm = new WindowManager(env.deps);
      const outcome = await wm.restartAttachedServer('/tmp/dragon');

      expect(outcome).toEqual({ ok: false, reason: 'eperm' });
      expect(spawn).not.toHaveBeenCalled();
      expect(env.windows.length).toBe(0);
    });

    // A declined break is not a success. The identity guard can refuse when the
    // lock no longer names the holder we judged, and treating that as "broken"
    // would send the recreate at a lock that is still there.
    test('restartAttachedServer does not proceed when the break is declined', async () => {
      // The graced probe on the break path retries through `deps.setTimeout`,
      // which the base env only records; drive it so the loop resolves.
      env.deps.setTimeout = (cb: () => void, _ms: number) => {
        cb();
        return null;
      };
      const removeServerLock = vi.fn(() => false);
      env.deps.removeServerLock = removeServerLock;
      env.deps.readServerLock = () => ({ ...liveLock, pid: 5152, port: 42117 });
      env.deps.isProcessAlive = () => true;
      env.deps.hostname = () => 'my-host';
      env.deps.probeWsUpgrade = () => Promise.resolve(false);
      const spawn = vi.fn(() => Promise.resolve({ pid: 22018 }));
      env.deps.spawnDetachedServer = spawn;
      env.deps.killProbe = vi.fn(() => {
        throw Object.assign(new Error('eperm'), { code: 'EPERM' });
      });

      const wm = new WindowManager(env.deps);
      const outcome = await wm.restartAttachedServer('/tmp/dragon');

      expect(removeServerLock).toHaveBeenCalledTimes(1);
      expect(outcome).toEqual({ ok: false, reason: 'eperm' });
      expect(spawn).not.toHaveBeenCalled();
    });

    // The grace on the DESTRUCTIVE path. A transient refusal here deletes a
    // live server's claim, which is why this path retries rather than acting on
    // one answer — but every other recovery test stubs a constant probe, so a
    // reversion to single-shot would be invisible exactly where it costs most.
    test('the break path retries the probe and stands down when a later attempt answers', async () => {
      env.deps.setTimeout = (cb: () => void, _ms: number) => {
        cb();
        return null;
      };
      const removeServerLock = vi.fn(() => true);
      env.deps.removeServerLock = removeServerLock;
      env.deps.readServerLock = () => ({ ...liveLock, pid: 5153, port: 42117 });
      env.deps.isProcessAlive = () => true;
      env.deps.hostname = () => 'my-host';
      let probes = 0;
      // Silent twice, then answers — a holder that was merely slow.
      env.deps.probeWsUpgrade = () => {
        probes++;
        return Promise.resolve(probes >= 3);
      };
      env.deps.killProbe = vi.fn(() => {
        throw Object.assign(new Error('eperm'), { code: 'EPERM' });
      });

      const wm = new WindowManager(env.deps);
      const outcome = await wm.restartAttachedServer('/tmp/dragon');

      expect(probes).toBe(3);
      // It answered, so it is a live server we merely cannot kill: refuse, and
      // above all do not break its lock.
      expect(outcome).toEqual({ ok: false, reason: 'eperm' });
      expect(removeServerLock).not.toHaveBeenCalled();
    });

    // The guard belongs to the RULE, so both entry states inherit it. Port 0 is
    // the acquired-but-not-yet-bound sentinel: the probe cannot succeed against
    // it, and a probe that cannot succeed would read as "not serving" and break
    // the lock of a server that is merely still coming up.
    test('restartAttachedServer leaves the lock alone when the holder has not bound a port', async () => {
      env.deps.setTimeout = (cb: () => void, _ms: number) => {
        cb();
        return null;
      };
      const removeServerLock = vi.fn(() => true);
      env.deps.removeServerLock = removeServerLock;
      // port 0 — acquired, still booting.
      env.deps.readServerLock = () => ({ ...liveLock, pid: 5154, port: 0 });
      env.deps.isProcessAlive = () => true;
      env.deps.hostname = () => 'my-host';
      const probe = vi.fn(() => Promise.resolve(false));
      env.deps.probeWsUpgrade = probe;
      env.deps.killProbe = vi.fn(() => {
        throw Object.assign(new Error('eperm'), { code: 'EPERM' });
      });

      const wm = new WindowManager(env.deps);
      const outcome = await wm.restartAttachedServer('/tmp/dragon');

      expect(outcome).toEqual({ ok: false, reason: 'eperm' });
      expect(removeServerLock).not.toHaveBeenCalled();
      // Not even probed: there is nothing at port 0 to ask.
      expect(probe).not.toHaveBeenCalled();
    });

    // `port` is typed `number` but never validated at runtime — `readProcessLock`
    // checks only `pid` and casts the rest — so these all arrive in production,
    // and every one survives a `port <= 0` test (`undefined <= 0` is a NaN
    // comparison, hence false).
    //
    // None of them can denote a listening server, so there is nothing to strand
    // by breaking the claim — and refusing would wedge the project forever.
    // `runClean` is not a route out for any of them: its classifier reads only
    // the pid and the file's parseability, never `port`, so a lock advertising
    // `Infinity` is `alive` to it and survives every sweep.
    test.each([
      ['absent', undefined],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['out of range', 70000],
      ['non-integer', 1.5],
      ['a non-numeric string', 'not-a-port'],
    ])('restartAttachedServer breaks a lock whose port is %s', async (_label, port) => {
      env.deps.setTimeout = (cb: () => void, _ms: number) => {
        cb();
        return null;
      };
      const removeServerLock = vi.fn(() => true);
      env.deps.removeServerLock = removeServerLock;
      let spawned = false;
      env.deps.readServerLock = () =>
        (spawned
          ? { ...liveLock, pid: 22018, port: 60222 }
          : { ...liveLock, pid: 5155, port }) as unknown as ServerLockMetadataLike;
      env.deps.isProcessAlive = () => true;
      env.deps.hostname = () => 'my-host';
      env.deps.probeWsUpgrade = () => Promise.resolve(true);
      env.deps.spawnDetachedServer = () => {
        spawned = true;
        return Promise.resolve({ pid: 22018 });
      };
      env.deps.killProbe = vi.fn(() => {
        throw Object.assign(new Error('eperm'), { code: 'EPERM' });
      });

      const wm = new WindowManager(env.deps);
      const outcome = await wm.restartAttachedServer('/tmp/dragon');

      expect(outcome).toEqual({ ok: true });
      expect(removeServerLock).toHaveBeenCalledTimes(1);
    });

    // `lockApiOrigin` resolves `url` BEFORE `port`, so an undialable port field
    // on a lock carrying a usable url is not evidence that nothing is behind
    // it. Breaking without asking would destroy a live server's claim on the
    // strength of a field we never dial.
    test('a garbage port does not authorise a break when the lock carries a usable url', async () => {
      env.deps.setTimeout = (cb: () => void, _ms: number) => {
        cb();
        return null;
      };
      const removeServerLock = vi.fn(() => true);
      env.deps.removeServerLock = removeServerLock;
      env.deps.readServerLock = () =>
        ({
          ...liveLock,
          pid: 5156,
          port: Number.POSITIVE_INFINITY,
          url: 'http://127.0.0.1:42117',
        }) as unknown as ServerLockMetadataLike;
      env.deps.isProcessAlive = () => true;
      env.deps.hostname = () => 'my-host';
      // The url answers: this is a live server we simply cannot kill.
      const probe = vi.fn(() => Promise.resolve(true));
      env.deps.probeWsUpgrade = probe;
      env.deps.killProbe = vi.fn(() => {
        throw Object.assign(new Error('eperm'), { code: 'EPERM' });
      });

      const wm = new WindowManager(env.deps);
      const outcome = await wm.restartAttachedServer('/tmp/dragon');

      expect(outcome).toEqual({ ok: false, reason: 'eperm' });
      expect(removeServerLock).not.toHaveBeenCalled();
      // Asked, rather than assumed, and asked at the url.
      expect(probe).toHaveBeenCalled();
      expect(probe.mock.calls[0]?.[0]).toContain('42117');
    });

    // The two questions are not the same question. A numeric string cannot be
    // ATTACHED to — the keepalive is typed on a numeric port — but it renders
    // into `http://localhost:42117`, which is a live address, so a server can be
    // behind it. Breaking without asking would destroy a claim we could dial.
    test('a numeric string port is probed rather than broken, since a server can be behind it', async () => {
      env.deps.setTimeout = (cb: () => void, _ms: number) => {
        cb();
        return null;
      };
      const removeServerLock = vi.fn(() => true);
      env.deps.removeServerLock = removeServerLock;
      env.deps.readServerLock = () =>
        ({ ...liveLock, pid: 5158, port: '42117' }) as unknown as ServerLockMetadataLike;
      env.deps.isProcessAlive = () => true;
      env.deps.hostname = () => 'my-host';
      // It answers: a live server we simply cannot kill.
      const probe = vi.fn(() => Promise.resolve(true));
      env.deps.probeWsUpgrade = probe;
      env.deps.killProbe = vi.fn(() => {
        throw Object.assign(new Error('eperm'), { code: 'EPERM' });
      });

      const wm = new WindowManager(env.deps);
      const outcome = await wm.restartAttachedServer('/tmp/dragon');

      expect(outcome).toEqual({ ok: false, reason: 'eperm' });
      expect(removeServerLock).not.toHaveBeenCalled();
      expect(probe.mock.calls[0]?.[0]).toContain('42117');
    });

    // The scoping guard. EPERM is the one termination failure that carries
    // information about the holder: it exists and is not ours to signal. An
    // `other` failure carries none, so a dead port alongside it is not evidence
    // the lock is safe to break. Without this, dropping the `term.reason ===
    // 'eperm'` conjunct widens lock-breaking to ANY termination failure and
    // every other test stays green.
    test('restartAttachedServer does not break a lock when termination failed for a non-EPERM reason', async () => {
      const removeServerLock = vi.fn(() => true);
      env.deps.removeServerLock = removeServerLock;
      env.deps.readServerLock = () => ({ ...liveLock, pid: 5150, port: 42117 });
      env.deps.isProcessAlive = () => true;
      env.deps.hostname = () => 'my-host';
      // The port answers nothing — the OTHER half of the rule is satisfied, so
      // only the reason scoping can hold the line here.
      env.deps.probeWsUpgrade = () => Promise.resolve(false);
      const spawn = vi.fn(() => Promise.resolve({ pid: 22018 }));
      env.deps.spawnDetachedServer = spawn;
      env.deps.killProbe = vi.fn(() => {
        throw Object.assign(new Error('kaboom'), { code: 'EIO' });
      });

      const wm = new WindowManager(env.deps);
      const outcome = await wm.restartAttachedServer('/tmp/dragon');

      expect(outcome).toEqual({ ok: false, reason: 'other' });
      expect(removeServerLock).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(env.windows.length).toBe(0);
    });

    // The guard on the fix above: EPERM is not license to break a lock. When
    // the unkillable holder is genuinely serving, the eperm refusal is the only
    // correct answer — the renderer surfaces the "running under a different
    // account" remedy — because breaking that lock would strand a live server
    // and the windows connected to it behind a second one on the same project.
    test('restartAttachedServer still refuses eperm when the unkillable holder IS serving', async () => {
      const liveHolderLock = {
        ...liveLock,
        pid: 7777,
        protocolVersion: 1,
        runtimeVersion: '0.8.0',
      };
      const spawn = vi.fn(() => Promise.resolve({ pid: 22018 }));
      env.deps.readServerLock = () => liveHolderLock;
      env.deps.isProcessAlive = () => true;
      env.deps.hostname = () => 'my-host';
      // The port answers: this server is real, just not ours to kill.
      env.deps.probeWsUpgrade = () => Promise.resolve(true);
      env.deps.killProbe = vi.fn(() => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      });
      env.deps.spawnDetachedServer = spawn;

      const wm = new WindowManager(env.deps);
      const outcome = await wm.restartAttachedServer('/tmp/dragon');

      expect(outcome).toEqual({ ok: false, reason: 'eperm' });
      // Nothing respawned, no second window opened behind the live server.
      expect(spawn).not.toHaveBeenCalled();
      expect(env.windows.length).toBe(0);
      expect(env.utilities.length).toBe(0);
    });

    test('restartAttachedServer keeps the originating window alive when the respawn fails', async () => {
      // Kill succeeds, but the fresh spawn never comes up — the originating
      // window must survive so its invoke resolves with the failure and the
      // renderer can surface the remedy on a window that still exists.
      env.deps.selfProtocolVersion = 1;
      env.deps.selfRuntimeVersion = '0.8.2';
      let killed = false;
      const oldLock = { ...liveLock, pid: 5555, protocolVersion: 1, runtimeVersion: '0.8.0' };
      enableAttachProbe({
        readServerLock: () => (killed ? null : oldLock),
        isProcessAlive: (pid) => (pid === 5555 ? !killed : true),
      });
      env.deps.killProbe = vi.fn((_pid: number, signal: string) => {
        if (signal === 'SIGTERM') killed = true;
      });
      env.deps.spawnDetachedServer = async () => {
        throw new Error('spawn failed to bind');
      };

      const wm = new WindowManager(env.deps);
      await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(env.windows.length).toBe(1);
      const originating = env.windows[0];
      if (!originating) throw new Error('no originating window');

      const outcome = await wm.restartAttachedServer('/tmp/dragon');
      expect(outcome).toEqual({ ok: false, reason: 'other' });
      // The originating window was not closed and remains the project's window.
      expect((originating.close as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
      expect(originating.isDestroyed?.()).toBe(false);
      expect(wm.getContextForBrowserWindow(originating as BrowserWindowLike)?.projectPath).toBe(
        '/tmp/dragon',
      );
      // No second window was created (the spawn threw before window creation).
      expect(env.windows.length).toBe(1);
    });

    /**
     * Wire an attach-mode restart whose respawn parks until `release` (or
     * `fail`) is called, so a test can observe the window manager while the
     * originating window is detached from `windowsByPath` and its replacement
     * does not exist yet. The respawned server publishes a lock on port 60000.
     */
    function parkedRestart(): {
      release: () => void;
      fail: (err: Error) => void;
      awaitParked: () => Promise<void>;
    } {
      env.deps.selfProtocolVersion = 1;
      env.deps.selfRuntimeVersion = '0.8.2';
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
      enableAttachProbe({
        readServerLock: () => (spawned ? freshLock : killed ? null : oldLock),
        isProcessAlive: (pid) => (pid === 5555 ? !killed : true),
      });
      env.deps.killProbe = vi.fn((_pid: number, signal: string) => {
        if (signal === 'SIGTERM') killed = true;
      });
      let resolveSpawn: (() => void) | undefined;
      let rejectSpawn: ((err: Error) => void) | undefined;
      env.deps.spawnDetachedServer = async () => {
        await new Promise<void>((resolve, reject) => {
          resolveSpawn = resolve;
          rejectSpawn = reject;
        });
        spawned = true;
        return { pid: 6666 };
      };
      return {
        release: () => resolveSpawn?.(),
        fail: (err) => rejectSpawn?.(err),
        awaitParked: async () => {
          await vi.waitFor(() => {
            expect(resolveSpawn).toBeDefined();
          });
        },
      };
    }

    test('a window mid-server-restart still resolves to its project', async () => {
      // The restart detaches the originating window from `windowsByPath` so the
      // recreate spawns a new window instead of focusing the old one, and only
      // restores or closes it once `createProjectWindow` settles. Across that
      // span — terminate poll, detached spawn, lock poll, renderer load — the
      // originating window is on screen and focusable, so the application menu
      // acts on it while nothing would admit which project it belongs to.
      // Terminal -> New Terminal Window resolved no project and opened a
      // HOME-cwd, project-less window.
      const parked = parkedRestart();
      const wm = new WindowManager(env.deps);
      const attached = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      const originating = env.windows[0];
      if (!originating) throw new Error('no originating window');

      const restart = wm.restartAttachedServer('/tmp/dragon');
      await parked.awaitParked();

      // The same object the authoritative entry held — including the port of the
      // server this restart just terminated. `getContextForBrowserWindow`
      // documents why that is the right answer for this span.
      expect(wm.getContextForBrowserWindow(originating as BrowserWindowLike)).toBe(attached);

      parked.release();
      await expect(restart).resolves.toEqual({ ok: true });
    });

    test('a completed restart leaves no entry behind for the window it closed', async () => {
      // Release pin. `windowsByPath` holds the RECREATED window under this
      // project's key, so the only thing that could still answer for the closed
      // originating window is an unreleased publish — a permanent Map entry
      // pinning a destroyed BrowserWindow.
      const parked = parkedRestart();
      const wm = new WindowManager(env.deps);
      await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      const originating = env.windows[0];
      if (!originating) throw new Error('no originating window');

      // Sample the answer for the dying window from inside the close. That is
      // the only point where the two orderings differ: once `closeAndAwait`
      // resolves, the end state is identical whether the release ran before the
      // close or in the trailing bracket. A `'closed'` listener also covers the
      // force-`destroy()` route, which stubbing `close` would miss.
      let closeTimeAnswer: unknown = 'unsampled';
      originating.on('closed', () => {
        closeTimeAnswer = wm.getContextForBrowserWindow(originating as BrowserWindowLike);
      });

      const restart = wm.restartAttachedServer('/tmp/dragon');
      await parked.awaitParked();
      parked.release();
      await expect(restart).resolves.toEqual({ ok: true });

      expect(originating.isDestroyed?.()).toBe(true);
      expect(wm.getContextForBrowserWindow(originating as BrowserWindowLike)).toBeUndefined();
      // The release lands BEFORE the close, not in the trailing `finally`: the
      // replacement already owns the authoritative entry by then, and
      // `closeAndAwait` grants a grace the old renderer stays interactive for.
      // Sampled from the close itself, the only observation point inside it.
      expect(closeTimeAnswer).toBeUndefined();
      // The replacement still resolves — releasing must not take the
      // authoritative entry with it.
      const recreated = env.windows[1];
      if (!recreated) throw new Error('no recreated window');
      expect(wm.getContextForBrowserWindow(recreated as BrowserWindowLike)?.port).toBe(60000);
    });

    test('a failed restart whose window survives releases on the later close', async () => {
      // The third exit branch, and the one the other two pins cannot reach: a
      // recreate failure with the originating window still alive restores it to
      // `windowsByPath`, and since `getContextForBrowserWindow` reads that map
      // first, the restore MASKS whether the publish was released. Step one
      // past the restart — the window's own close drops the authoritative entry
      // through its ownership guard, leaving an unreleased publish as the only
      // thing that could still answer.
      const parked = parkedRestart();
      const wm = new WindowManager(env.deps);
      await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      const originating = env.windows[0];
      if (!originating) throw new Error('no originating window');

      const restart = wm.restartAttachedServer('/tmp/dragon');
      await parked.awaitParked();
      parked.fail(new Error('spawn failed to bind'));
      await expect(restart).resolves.toEqual({ ok: false, reason: 'other' });

      // Masked: the restore alone satisfies this, released or not.
      expect(wm.getContextForBrowserWindow(originating as BrowserWindowLike)?.projectPath).toBe(
        '/tmp/dragon',
      );

      originating.fireClose();
      expect(wm.getContextForBrowserWindow(originating as BrowserWindowLike)).toBeUndefined();
    });

    test('a failed restart whose window died meanwhile leaves no entry behind', async () => {
      // The other release pin. A recreate failure restores the originating
      // window to `windowsByPath` only while it is alive; when it is not, that
      // restore is skipped, so an unreleased publish would be the sole surviving
      // reference to a destroyed window.
      const parked = parkedRestart();
      const wm = new WindowManager(env.deps);
      await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      const originating = env.windows[0];
      if (!originating) throw new Error('no originating window');

      const restart = wm.restartAttachedServer('/tmp/dragon');
      await parked.awaitParked();
      originating.markDestroyed();
      parked.fail(new Error('spawn failed to bind'));
      await expect(restart).resolves.toEqual({ ok: false, reason: 'other' });

      expect(wm.getContextForBrowserWindow(originating as BrowserWindowLike)).toBeUndefined();
    });

    test('reclaimForeignServerInDev terminates a foreign server and spawns fresh via utility-fork, SILENTLY (no notice)', async () => {
      env.deps.reclaimForeignServerInDev = true;
      let killed = false;
      const killProbe = vi.fn((_pid: number, signal: string) => {
        if (signal === 'SIGTERM') killed = true;
      });
      env.deps.killProbe = killProbe;
      // Foreign lock at attach-decision time; the holder pid dies right after
      // SIGTERM so the terminate poll (pid-death, not lock release) returns on
      // its first check (the env setTimeout never fires, so a poll that had
      // to sleep would hang the test).
      enableAttachProbe({
        readServerLock: () => (killed ? null : liveLock),
        isProcessAlive: () => !killed,
      });

      const wm = new WindowManager(env.deps);
      const promise = wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      // Reclaim awaits termination before forking, so the utility appears a few
      // microtasks in — flush until it does, then complete the spawn handshake.
      for (let i = 0; i < 50 && env.utilities.length === 0; i++) await wait(0);
      expect(killProbe).toHaveBeenCalledWith(65792, 'SIGTERM');
      expect(env.utilities.length).toBe(1);
      env.utilities[0]?.fire({ type: 'ready', port: 52777, apiOrigin: 'http://localhost:52777' });
      const ctx = await promise;

      // Fresh own-build spawn (dev utility-fork → ownsServer true), not an attach.
      expect(ctx.ownsServer).toBe(true);
      expect(ctx.port).toBe(52777);

      const w = env.windows[0];
      if (!w) throw new Error('no window created');
      // The dev reclaim is a routine per-rebuild event — it must NOT pop a
      // toast. Fire both lifecycle edges and assert no restart confirmation
      // reaches the renderer (the "started a fresh server" notice is gone).
      w.fireDomReady();
      w.fireDidFinishLoad();
      const lifecycleSends = (w.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'ok:server-restarted',
      );
      expect(lifecycleSends.length).toBe(0);
    });

    test('without reclaimForeignServerInDev (production default), a foreign server is attached — no termination, no notice', async () => {
      const killProbe = vi.fn(() => {});
      env.deps.killProbe = killProbe;
      enableAttachProbe();
      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(ctx.ownsServer).toBe(false);
      expect(ctx.port).toBe(59534);
      expect(env.utilities.length).toBe(0);
      expect(killProbe).not.toHaveBeenCalled();
      const w = env.windows[0];
      if (!w) throw new Error('no window created');
      w.fireDidFinishLoad();
      const lifecycleSends = (w.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'ok:server-restarted',
      );
      expect(lifecycleSends.length).toBe(0);
    });

    test('first launch after upgrade auto-terminates a drifted survivor and respawns SILENTLY (no toast, no prompt)', async () => {
      // Packaged path: detached spawn → attach. The attach path finds a lock
      // from a build that outlived the update teardown; because this is the
      // first launch after the version changed, terminate it and spawn our
      // own version instead of attaching + prompting. No toast — the whats-new
      // "Updated to Version X" notice already covers the upgrade.
      env.deps.selfProtocolVersion = 1;
      env.deps.selfRuntimeVersion = '0.8.2';
      env.deps.isFirstLaunchAfterUpgrade = () => true;
      let killed = false;
      let spawned = false;
      const survivorLock = { ...liveLock, pid: 5555, protocolVersion: 1, runtimeVersion: '0.8.0' };
      const freshLock = {
        ...liveLock,
        pid: 6666,
        port: 60000,
        protocolVersion: 1,
        runtimeVersion: '0.8.2',
      };
      const killProbe = vi.fn((_pid: number, signal: string) => {
        if (signal === 'SIGTERM') killed = true;
      });
      enableAttachProbe({
        readServerLock: () => (spawned ? freshLock : killed ? null : survivorLock),
        isProcessAlive: (pid) => (pid === 5555 ? !killed : true),
      });
      env.deps.killProbe = killProbe;
      env.deps.spawnDetachedServer = async () => {
        spawned = true;
        return { pid: 6666 };
      };

      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });

      // Terminated the survivor and respawned our own version — not an attach.
      expect(killProbe).toHaveBeenCalledWith(5555, 'SIGTERM');
      expect(ctx.port).toBe(60000);
      expect(env.windows.length).toBe(1);

      const w = env.windows[0];
      if (!w) throw new Error('no window created');
      // Reconciled → neither the manual version-drift prompt nor a restart
      // toast fires (the reconcile is silent).
      w.fireDomReady();
      expect(driftSends(w).length).toBe(0);
      w.fireDidFinishLoad();
      const restartedSends = (w.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'ok:server-restarted',
      );
      expect(restartedSends.length).toBe(0);
    });

    test('upgrade reconcile also fires for a NEWER survivor (any drift direction qualifies)', async () => {
      // Trigger is "we just upgraded", not the version ordering — a survivor
      // newer than the app (e.g. a rollback scenario) is reconciled too.
      env.deps.selfProtocolVersion = 1;
      env.deps.selfRuntimeVersion = '0.8.2';
      env.deps.isFirstLaunchAfterUpgrade = () => true;
      let killed = false;
      let spawned = false;
      const survivorLock = { ...liveLock, pid: 5555, protocolVersion: 1, runtimeVersion: '0.9.0' };
      const freshLock = {
        ...liveLock,
        pid: 6666,
        port: 60000,
        protocolVersion: 1,
        runtimeVersion: '0.8.2',
      };
      const killProbe = vi.fn((_pid: number, signal: string) => {
        if (signal === 'SIGTERM') killed = true;
      });
      enableAttachProbe({
        readServerLock: () => (spawned ? freshLock : killed ? null : survivorLock),
        isProcessAlive: (pid) => (pid === 5555 ? !killed : true),
      });
      env.deps.killProbe = killProbe;
      env.deps.spawnDetachedServer = async () => {
        spawned = true;
        return { pid: 6666 };
      };
      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(killProbe).toHaveBeenCalledWith(5555, 'SIGTERM');
      expect(ctx.port).toBe(60000);
    });

    test('upgrade reconcile leaves a SAME-version server untouched (never needlessly bounced)', async () => {
      // A same-version server we would share is left attached even on the first
      // launch after an upgrade — the reconcile only fires on a real drift.
      env.deps.selfProtocolVersion = 1;
      env.deps.selfRuntimeVersion = '0.8.2';
      env.deps.isFirstLaunchAfterUpgrade = () => true;
      const killProbe = vi.fn(() => {});
      env.deps.killProbe = killProbe;
      enableAttachProbe({
        readServerLock: () => ({ ...liveLock, protocolVersion: 1, runtimeVersion: '0.8.2' }),
      });
      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(ctx.ownsServer).toBe(false); // attached, not respawned
      expect(ctx.port).toBe(59534);
      expect(killProbe).not.toHaveBeenCalled();
      expect(env.utilities.length).toBe(0);
      const w = env.windows[0];
      if (!w) throw new Error('no window created');
      w.fireDomReady();
      // Same version → no drift prompt either.
      expect(driftSends(w).length).toBe(0);
    });

    test('a drifted server is left attached (manual prompt) when NOT the first launch after upgrade', async () => {
      // Same drift as the reconcile test, but no upgrade this launch → attach +
      // fire the manual version-drift prompt, never auto-terminate.
      env.deps.selfProtocolVersion = 1;
      env.deps.selfRuntimeVersion = '0.8.2';
      // isFirstLaunchAfterUpgrade left unset (undefined).
      const killProbe = vi.fn(() => {});
      env.deps.killProbe = killProbe;
      enableAttachProbe({
        readServerLock: () => ({ ...liveLock, protocolVersion: 1, runtimeVersion: '0.8.0' }),
      });
      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(ctx.ownsServer).toBe(false);
      expect(env.utilities.length).toBe(0);
      expect(killProbe).not.toHaveBeenCalled();
      const w = env.windows[0];
      if (!w) throw new Error('no window created');
      w.fireDomReady();
      // The manual version-drift prompt fires; no auto-restart confirmation.
      expect(driftSends(w).length).toBe(1);
      w.fireDidFinishLoad();
      const restartedSends = (w.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'ok:server-restarted',
      );
      expect(restartedSends.length).toBe(0);
    });

    test('upgrade reconcile falls back to attaching (with the manual prompt) when terminating the survivor fails', async () => {
      // First launch after upgrade, but the survivor can't be killed (EPERM —
      // another account owns it). Rather than leave the project window-less, we
      // attach to the stale build; the manual version-drift prompt still offers
      // a restart, exactly as before this feature.
      env.deps.selfProtocolVersion = 1;
      env.deps.selfRuntimeVersion = '0.8.2';
      env.deps.isFirstLaunchAfterUpgrade = () => true;
      env.deps.killProbe = vi.fn(() => {
        const err = new Error('operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      });
      enableAttachProbe({
        readServerLock: () => ({ ...liveLock, protocolVersion: 1, runtimeVersion: '0.8.0' }),
      });
      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      // Fell back to attaching the survivor, not a fresh spawn.
      expect(ctx.ownsServer).toBe(false);
      expect(ctx.port).toBe(59534);
      expect(env.utilities.length).toBe(0);
      const w = env.windows[0];
      if (!w) throw new Error('no window created');
      w.fireDomReady();
      // The manual version-drift prompt is the fallback remedy.
      expect(driftSends(w).length).toBe(1);
      w.fireDidFinishLoad();
      const restartedSends = (w.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'ok:server-restarted',
      );
      expect(restartedSends.length).toBe(0);
    });

    test('reclaim does NOT terminate a server THIS session spawned (own-pid guard)', async () => {
      // A combination production never uses (dev never wires detached spawn),
      // but the pid guard must hold if a future build does: a same-session
      // reopen that attaches to OUR OWN detached server must not be reclaimed.
      env.deps.reclaimForeignServerInDev = true;
      const killProbe = vi.fn(() => {});
      env.deps.killProbe = killProbe;
      const ownLock = { ...liveLock, pid: 6666, port: 60000 };
      let spawned = false;
      env.deps.spawnDetachedServer = async () => {
        spawned = true;
        return { pid: 6666 };
      };
      env.deps.spawnLockPollDeadlineMs = 1000;
      enableAttachProbe({ readServerLock: () => (spawned ? ownLock : null) });

      const wm = new WindowManager(env.deps);
      const ctx1 = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(ctx1.port).toBe(60000);
      expect(env.windows.length).toBe(1);

      // Close the window — the detached server (tracked in spawnedDetachedPids)
      // outlives it, so its lock is still present on reopen.
      env.windows[0]?.fireClose();

      const ctx2 = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(killProbe).not.toHaveBeenCalled();
      expect(ctx2.ownsServer).toBe(false); // attached to our own server
      expect(ctx2.port).toBe(60000);
      expect(env.utilities.length).toBe(0); // attached, did not reclaim-and-respawn
    });

    test('reclaim falls back to attaching when terminating the foreign server fails (eperm)', async () => {
      env.deps.reclaimForeignServerInDev = true;
      env.deps.killProbe = vi.fn(() => {
        const err = new Error('operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      });
      enableAttachProbe();
      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      // Fell back to attaching the foreign server rather than leaving it window-less.
      expect(ctx.ownsServer).toBe(false);
      expect(ctx.port).toBe(59534);
      expect(env.utilities.length).toBe(0);
      const w = env.windows[0];
      if (!w) throw new Error('no window created');
      w.fireDidFinishLoad();
      const restartedSends = (w.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'ok:server-restarted',
      );
      expect(restartedSends.length).toBe(0);
    });

    test('stale lock (pid dead) falls through to spawn mode', async () => {
      enableAttachProbe({ isProcessAlive: () => false });
      const runClean = vi.fn(() => Promise.resolve());
      env.deps.runClean = runClean;

      const wm = new WindowManager(env.deps);
      const p = wm.createProjectWindow({ projectPath: '/tmp/dragon' });

      // runClean is async — let its microtask drain before the utility forks.
      await wait(5);
      expect(runClean).toHaveBeenCalled();
      expect(env.utilities.length).toBe(1);
      env.utilities[0]?.fire({ type: 'ready', port: 40001, apiOrigin: 'http://localhost:40001' });
      const ctx = await p;
      expect(ctx.ownsServer).toBe(true);
    });

    test('port=0 (holder still starting) falls through to spawn mode', async () => {
      enableAttachProbe({
        readServerLock: () => ({ ...liveLock, port: 0 }),
      });

      const wm = new WindowManager(env.deps);
      const p = wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      // tryAttachExistingServer is async — drain microtasks before asserting.
      await new Promise((r) => setTimeout(r, 5));
      expect(env.utilities.length).toBe(1);
      env.utilities[0]?.fire({ type: 'ready', port: 40002, apiOrigin: 'http://localhost:40002' });
      await p;
    });

    test('draining lock (teardown in progress) falls through to spawn mode', async () => {
      enableAttachProbe({
        readServerLock: () => ({ ...liveLock, draining: true }),
      });

      const wm = new WindowManager(env.deps);
      const p = wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      await new Promise((r) => setTimeout(r, 5));
      expect(env.utilities.length).toBe(1);
      env.utilities[0]?.fire({ type: 'ready', port: 40005, apiOrigin: 'http://localhost:40005' });
      await p;
    });

    test('machineId-carrying lock with a drifted hostname still attaches', async () => {
      // readServerLock (production) already machine-checked a lock that
      // carries machineId; the window-manager's own hostname gate must not
      // re-refuse it after a macOS hostname rename.
      enableAttachProbe({
        readServerLock: () => ({ ...liveLock, machineId: 'stable-machine-id' }),
        hostname: () => 'renamed-since-lock-was-written',
      });

      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(env.utilities.length).toBe(0);
      expect(ctx.ownsServer).toBe(false);
      expect(ctx.port).toBe(59534);
    });

    test('foreign-host lock falls through (D44 case c)', async () => {
      enableAttachProbe({ hostname: () => 'different-host' });

      const wm = new WindowManager(env.deps);
      const p = wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      await new Promise((r) => setTimeout(r, 5));
      expect(env.utilities.length).toBe(1);
      env.utilities[0]?.fire({ type: 'ready', port: 40003, apiOrigin: 'http://localhost:40003' });
      await p;
    });

    test('no lock file falls through to spawn mode', async () => {
      enableAttachProbe({ readServerLock: () => null });

      const wm = new WindowManager(env.deps);
      const p = wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      await new Promise((r) => setTimeout(r, 5));
      expect(env.utilities.length).toBe(1);
      env.utilities[0]?.fire({ type: 'ready', port: 40004, apiOrigin: 'http://localhost:40004' });
      await p;
    });

    test('window close on attached context does NOT send shutdown IPC', async () => {
      enableAttachProbe();
      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(ctx.utility).toBeNull();

      env.windows[0]?.fireClose();
      // Nothing to assert on the utility (there isn't one). The test
      // guarantee is just that close doesn't throw and removes from the map.
      expect(wm.getWindowFor('/tmp/dragon')).toBeUndefined();
    });

    test('closeProjectWindow on attached context returns true, sends no shutdown IPC', async () => {
      enableAttachProbe();
      const wm = new WindowManager(env.deps);
      await wm.createProjectWindow({ projectPath: '/tmp/dragon' });

      // No utility exists — just asserting this path returns cleanly.
      expect(wm.closeProjectWindow('/tmp/dragon')).toBe(true);
      expect(env.utilities.length).toBe(0);
    });

    test('re-opening an already-attached project focuses the existing window (case a still applies)', async () => {
      enableAttachProbe();
      const wm = new WindowManager(env.deps);
      const ctx1 = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      const ctx2 = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });

      expect(ctx2).toBe(ctx1);
      expect(env.windows.length).toBe(1);
      expect(ctx1.window.focus).toHaveBeenCalled();
    });

    test('attach-mode deps missing (back-compat) → tests without injection still spawn', async () => {
      // Explicitly: not calling enableAttachProbe. No readServerLock in deps.
      const wm = new WindowManager(env.deps);
      const p = wm.createProjectWindow({ projectPath: '/tmp/no-probe' });
      await new Promise((r) => setTimeout(r, 5));
      expect(env.utilities.length).toBe(1);
      env.utilities[0]?.fire({ type: 'ready', port: 40005, apiOrigin: 'http://localhost:40005' });
      await p;
    });

    test('mcp-spawned lock attaches in attach mode (no spawn, no SIGTERM)', async () => {
      // Lock kind is provenance-only — both `interactive` and `mcp-spawned`
      // expose the same HTTP+WS surface, so the desktop attaches rather than
      // refusing or replacing the holder. This keeps an agent's MCP session
      // alive when the user opens the desktop on a project the agent owns.
      enableAttachProbe({
        readServerLock: () => ({ ...liveLock, kind: 'mcp-spawned' }),
      });
      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(env.utilities.length).toBe(0);
      expect(ctx.ownsServer).toBe(false);
    });

    // The detached-spawn-mode tests below sit inside the attach-mode
    // describe deliberately — every detached-mode happy path delegates to
    // `attachToExistingServer` after spawn → poll → attach, so the same
    // ProjectContext shape (`ownsServer: false`, `utility: null`) and the
    // same attach window-close behavior apply. Nesting keeps the closure-
    // scoped `enableAttachProbe` + `liveLock` available, and makes the
    // "detached is a flavor of attach" architecture explicit at the test
    // level.
    describe('detached-spawn submode (production path)', () => {
      const spawnedLock: ServerLockMetadataLike = {
        pid: 88001,
        hostname: 'my-host',
        port: 60111,
        startedAt: '2026-05-21T00:00:00.000Z',
        worktreeRoot: '/tmp/spawned-project',
        kind: 'interactive',
        capabilities: ['http', 'ws'],
      };

      // The lock-poll loop awaits `deps.setTimeout` between iterations. The
      // base env's setTimeout RECORDS timers without firing them — fine for
      // the existing post-exit liveness-probe tests, but it deadlocks our
      // polling loop. Override per-test to fire timers immediately so the
      // poll iterates as fast as real wall-clock allows. The poll loop's
      // termination remains gated by `Date.now() < deadline`, so a short
      // `spawnLockPollDeadlineMs` still produces a timely timeout.
      function enableSyncTimers() {
        env.deps.setTimeout = (cb: () => void, _ms: number) => {
          cb();
          return null;
        };
      }

      test('spawn → poll lock → delegate to attach mode (no utilityProcess.fork)', async () => {
        enableSyncTimers();
        // No existing lock initially; spawn fires; lock appears immediately on
        // the first poll iteration. Reader returns `null` once (no lock yet),
        // then the lock metadata.
        let readCount = 0;
        env.deps.readServerLock = () => {
          readCount++;
          return readCount === 1 ? null : spawnedLock;
        };
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);

        const spawn = vi.fn(() => Promise.resolve({ pid: 88001 }));
        env.deps.spawnDetachedServer = spawn;

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' });

        // Detached-spawn called with the expected payload.
        expect(spawn).toHaveBeenCalledTimes(1);
        const call = spawn.mock.calls[0]?.[0] as
          | { contentDir: string; reactShellDistDir: string }
          | undefined;
        expect(call?.contentDir).toBe('/tmp/spawned-project');
        expect(call?.reactShellDistDir).toBe('/fake/renderer');

        // utilityProcess.fork must NOT be called on this path.
        expect(env.utilities.length).toBe(0);

        // Window opened in attach-mode shape against the spawned server.
        expect(ctx.ownsServer).toBe(false);
        expect(ctx.utility).toBeNull();
        expect(ctx.port).toBe(60111);
        expect(ctx.apiOrigin).toBe('http://localhost:60111');
        expect(env.windows.length).toBe(1);
        expect(env.createWindowOpts[0]?.title).toBe('spawned-project — OpenKnowledge');
      });

      test('spawned pid is tracked for stopAllOwnedServers (US-008)', async () => {
        enableSyncTimers();
        // First read (the synchronous attach gate) sees no lock → falls through
        // to the spawn branch; subsequent reads (the post-spawn poll) see the
        // lock the freshly-spawned server wrote.
        let readCount = 0;
        env.deps.readServerLock = () => {
          readCount++;
          return readCount === 1 ? null : spawnedLock;
        };
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });

        const wm = new WindowManager(env.deps);
        await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' });

        // Use the internal map via a discriminated read — the test
        // intentionally peeks at the private surface to pin the contract that
        // `stopAllOwnedServers` will consume.
        const pids = (wm as unknown as { spawnedDetachedPids: Map<string, number> })
          .spawnedDetachedPids;
        expect(pids.size).toBe(1);
        expect([...pids.values()]).toEqual([88001]);
      });

      test('lock-poll timeout surfaces spawn-lock-timeout error', async () => {
        enableSyncTimers();
        // Reader never returns a valid lock — spawn appears to succeed but the
        // detached process never binds a port. The window manager must surface
        // a structured error after the deadline elapses.
        env.deps.readServerLock = () => null;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });
        // Very short deadline so the test fires fast; setTimeout is the
        // env mock that records but does not actually sleep, so the poll
        // loop iterates as fast as possible until the wall-clock deadline.
        env.deps.spawnLockPollDeadlineMs = 1;

        const wm = new WindowManager(env.deps);
        await expect(
          wm.createProjectWindow({ projectPath: '/tmp/never-binds' }),
        ).rejects.toMatchObject({
          kind: 'spawn-lock-timeout',
          pid: 88001,
        });

        // No window created when spawn fails to produce a lock.
        expect(env.windows.length).toBe(0);
        // pid is also evicted from the tracking map so a retry doesn't think
        // the (defunct) prior spawn is still ours.
        const pids = (wm as unknown as { spawnedDetachedPids: Map<string, number> })
          .spawnedDetachedPids;
        expect(pids.size).toBe(0);
      });

      // The defect this guards: a server whose boot legitimately outruns the
      // startup deadline was SIGTERM'd while mid-boot, so every large project
      // became permanently unopenable and every retry reproduced it. Being
      // slow is not being hung — a child observed alive at the deadline has to
      // keep its wait.
      test('a live child that binds after the startup deadline still opens the window', async () => {
        enableSyncTimers();
        // Gated on elapsed WALL-CLOCK, not poll count: the deadline is
        // wall-clock and the injected timers fire synchronously, so a
        // count-based gate would let the lock appear inside the startup
        // deadline and never exercise the extension at all.
        const spawnedAt = Date.now();
        const BINDS_AFTER_MS = 40;
        env.deps.readServerLock = () =>
          Date.now() - spawnedAt >= BINDS_AFTER_MS ? spawnedLock : null;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });
        const killed: number[] = [];
        env.deps.killProbe = (pid: number) => {
          killed.push(pid);
        };
        // Startup deadline lands well before the bind; the extension is what
        // has to carry the wait the rest of the way.
        env.deps.spawnLockPollDeadlineMs = 5;
        env.deps.spawnLockProgressDeadlineMs = 30_000;

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' });

        expect(ctx.port).toBe(60111);
        expect(env.windows.length).toBe(1);
        // The whole point: no SIGTERM went to the healthy child.
        expect(killed).toEqual([]);
      });

      // The shipped path: no `OK_SPAWN_BIND_TIMEOUT_MS`, so the cap comes from
      // the multiplier. Other tests that reach the graduation branch either
      // pin `spawnLockProgressDeadlineMs` explicitly (so the `??`
      // short-circuits and the multiplier is never evaluated) or never
      // produce a bindable lock (so the cap's value is irrelevant — they fail
      // regardless). This is the only one where a derived cap has to carry a
      // bind to success, making it the only place a regression in that
      // expression (dropped factor, swapped operand) shows up rather than
      // shipping green.
      test('with no progress override the cap is derived from the startup deadline', async () => {
        enableSyncTimers();
        const spawnedAt = Date.now();
        // Between the 20ms startup deadline and the 20 * 8 = 160ms derived cap.
        // The RATIO is what pins mutation sensitivity (drop the factor and the
        // cap collapses to 20ms, well short of the bind); the absolute numbers
        // are scaled up so a stalled spin loop does not flip a pass into a
        // timeout on a loaded runner.
        const BINDS_AFTER_MS = 60;
        env.deps.readServerLock = () =>
          Date.now() - spawnedAt >= BINDS_AFTER_MS ? spawnedLock : null;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });
        const killed: number[] = [];
        env.deps.killProbe = (pid: number) => {
          killed.push(pid);
        };
        env.deps.spawnLockPollDeadlineMs = 20;
        env.deps.spawnLockProgressDeadlineMs = undefined;

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' });

        expect(ctx.port).toBe(60111);
        expect(killed).toEqual([]);
      });

      test('the extended wait is bounded — a live child that never binds still fails', async () => {
        enableSyncTimers();
        env.deps.readServerLock = () => null;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });
        env.deps.spawnLockPollDeadlineMs = 1;
        env.deps.spawnLockProgressDeadlineMs = 25;

        const wm = new WindowManager(env.deps);
        const err = await wm.createProjectWindow({ projectPath: '/tmp/never-binds' }).then(
          () => null,
          (e: unknown) => e as Error & { kind?: string },
        );

        expect(err?.kind).toBe('spawn-lock-timeout');
        // The reported deadline is the wait actually served, not the startup
        // deadline it graduated from — otherwise the message understates the
        // wait by the extension factor.
        expect(err?.message).toMatch(/within 25ms/);
      });

      // The lock is keyed by PROJECT, not by process: when a concurrent starter
      // wins the acquire our child exits by design and the WINNER is the one
      // mid-boot. Tying the extension to our own child's liveness would cut
      // that winner off at the startup deadline — the same slow-boot failure,
      // one branch over.
      test('a live lock-holder earns the extension even though our child lost the race', async () => {
        enableSyncTimers();
        const spawnedAt = Date.now();
        const BINDS_AFTER_MS = 40;
        const winnerPid = 77002;
        env.deps.readServerLock = () =>
          Date.now() - spawnedAt >= BINDS_AFTER_MS
            ? { ...spawnedLock, pid: winnerPid }
            : // Winner holds the lock but has not bound yet: the documented
              // `port: 0`-but-not-yet-listening window.
              { ...spawnedLock, pid: winnerPid, port: 0 };
        // Our child is dead (it lost the acquire); the winner is alive.
        env.deps.isProcessAlive = (pid: number) => pid === winnerPid;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });
        env.deps.spawnLockPollDeadlineMs = 5;
        env.deps.spawnLockProgressDeadlineMs = 30_000;

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' });

        expect(ctx.port).toBe(60111);
        expect(env.windows.length).toBe(1);
      });

      // A dead child must NOT earn the extension: waiting on a corpse turns a
      // fast crash into a long stall and reframes it as a slow start.
      test('a child that dies past the startup deadline is not granted the extension', async () => {
        enableSyncTimers();
        env.deps.readServerLock = () => null;
        env.deps.isProcessAlive = () => false;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });
        env.deps.spawnLockPollDeadlineMs = 1;
        env.deps.spawnLockProgressDeadlineMs = 60_000;

        const wm = new WindowManager(env.deps);
        const err = await wm.createProjectWindow({ projectPath: '/tmp/dead-child' }).then(
          () => null,
          (e: unknown) => e as Error & { kind?: string },
        );

        expect(err?.kind).toBe('spawn-lock-timeout');
        expect(err?.message).toMatch(/exited before binding/);
      });

      // The captured stderr is whatever the server printed on the way up, and
      // on a healthy boot that is routinely a config advisory. Presenting it
      // under a bare "stderr" header next to a failure sends the reader off to
      // fix a warning that had nothing to do with it.
      function projectWithSpawnErrorLog(contents: string): string {
        const root = mkdtempSync(join(tmpdir(), 'ok-spawn-stderr-'));
        mkdirSync(join(root, '.ok', 'local'), { recursive: true });
        writeFileSync(join(root, '.ok', 'local', 'last-spawn-error.log'), contents);
        return root;
      }

      test('a still-running child frames its output as probably not the cause', async () => {
        enableSyncTimers();
        const advisory = '[ok] Removed key at .ok/config.yml:5:19: appearance.sidebar.showAllFiles';
        const projectPath = projectWithSpawnErrorLog(advisory);
        env.deps.readServerLock = () => null;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });
        env.deps.spawnLockPollDeadlineMs = 1;
        env.deps.spawnLockProgressDeadlineMs = 5;

        const wm = new WindowManager(env.deps);
        const err = await wm.createProjectWindow({ projectPath }).then(
          () => null,
          (e: unknown) => e as Error,
        );

        expect(err?.message).toContain(advisory);
        expect(err?.message).toMatch(/probably not the cause/);
        expect(err?.message).not.toMatch(/^--- stderr ---$/m);
      });

      test('an exited child keeps its stderr labelled as stderr', async () => {
        enableSyncTimers();
        const projectPath = projectWithSpawnErrorLog('Error: EACCES on .ok/local\n');
        env.deps.readServerLock = () => null;
        env.deps.isProcessAlive = () => false;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () =>
          Promise.resolve({ pid: 88001, readExit: () => ({ code: 1, signal: null }) });
        env.deps.spawnLockPollDeadlineMs = 1;

        const wm = new WindowManager(env.deps);
        const err = await wm.createProjectWindow({ projectPath }).then(
          () => null,
          (e: unknown) => e as Error,
        );

        expect(err?.message).toMatch(/exited before binding/);
        expect(err?.message).toMatch(/^--- stderr ---$/m);
        expect(err?.message).not.toMatch(/probably not the cause/);
      });

      // A hung start and a crash otherwise render as the same bare deadline.
      // Naming the surviving process is what lets the reader tell them apart.
      test('a deadline reached with the child alive says the process was still running', async () => {
        enableSyncTimers();
        env.deps.readServerLock = () => null;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });
        env.deps.spawnLockPollDeadlineMs = 1;

        const wm = new WindowManager(env.deps);
        const err = await wm.createProjectWindow({ projectPath: '/tmp/slow-child' }).then(
          () => null,
          (e: unknown) => e as Error,
        );

        expect(err?.message).toMatch(/did not bind a port/);
        expect(err?.message).toMatch(/still running/);
      });

      // Never claim liveness that was not observed: with no probe wired, the
      // message must stay agnostic rather than assert a state we cannot see.
      test('with no liveness probe wired the message claims nothing about the process', async () => {
        enableSyncTimers();
        env.deps.readServerLock = () => null;
        env.deps.isProcessAlive = undefined;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });
        env.deps.spawnLockPollDeadlineMs = 1;

        const wm = new WindowManager(env.deps);
        const err = await wm.createProjectWindow({ projectPath: '/tmp/unprobed' }).then(
          () => null,
          (e: unknown) => e as Error,
        );

        expect(err?.message).toMatch(/did not bind a port/);
        expect(err?.message).not.toMatch(/still running/);
        expect(err?.message).not.toMatch(/exited before binding/);
      });

      // The sibling case to the test above: there, the child is ALIVE and
      // simply never binds, so waiting out the deadline is the correct
      // behavior. Here the child is DEAD. Waiting is then pure dead time, and
      // the deadline framing ("did not bind a port within 15000ms") actively
      // misdescribes a fast crash as a slow start.
      test('a dead child ends the lock poll immediately instead of waiting out the deadline', async () => {
        enableSyncTimers();
        let readCount = 0;
        env.deps.readServerLock = () => {
          readCount++;
          return null;
        };
        // Child exited between spawn and the first poll tick.
        env.deps.isProcessAlive = () => false;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });
        // A realistic deadline. The poll must NOT consume it: liveness, not
        // wall-clock, is what ends the wait once the child is gone.
        env.deps.spawnLockPollDeadlineMs = 500;

        const wm = new WindowManager(env.deps);
        const err = await wm.createProjectWindow({ projectPath: '/tmp/dead-child' }).then(
          () => null,
          (e: unknown) => e as Error,
        );

        expect(err).toMatchObject({ pid: 88001 });
        // Framed as a death, not as a deadline — reporting "did not bind within
        // 500ms" for a child that died immediately is the original defect.
        expect(err?.message).toMatch(/exited before binding a port/);
        expect(err?.message).not.toMatch(/did not bind a port/);

        // Bounded, not exhaustive. Spinning the full 500ms window produces
        // reads in the thousands; noticing the death costs a handful.
        expect(readCount).toBeLessThanOrEqual(3);
      });

      // The lock is keyed by project, not by process. A concurrent starter that
      // wins the acquire makes OUR child exit by design, while the winner is
      // still mid-bind (lock present, port still 0). Treating our child's death
      // as "no lock is coming" would report a failure another process is about
      // to resolve — the project would fail to open where it previously did.
      test('a losing child does not abort the wait while a live winner is still binding', async () => {
        enableSyncTimers();
        const WINNER_PID = 77001;
        const winnerLock = (port: number): ServerLockMetadataLike => ({
          pid: WINNER_PID,
          hostname: 'my-host',
          port,
          startedAt: '2026-08-05T00:00:00.000Z',
          worktreeRoot: '/tmp/contended',
          kind: 'interactive',
          capabilities: ['ws'],
        });

        // Winner holds the lock at port 0 (acquired, not yet bound), then binds.
        let reads = 0;
        env.deps.readServerLock = () => {
          reads++;
          if (reads === 1) return null; // pre-spawn attach gate: nothing usable yet
          if (reads < 4) return winnerLock(0); // winner acquired, still binding
          return winnerLock(52999); // winner bound
        };
        // Our spawned child lost the acquire and exited; the winner is alive.
        env.deps.isProcessAlive = (pid) => pid === WINNER_PID;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });
        env.deps.spawnLockPollDeadlineMs = 500;

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/contended' });

        // Attached to the winner rather than erroring on our child's death.
        expect(ctx.port).toBe(52999);
        expect(env.windows.length).toBe(1);
      });

      // A stale lock is a different failure from a missing one. The file can
      // name a pid that is alive-or-unkillable while the port it advertises
      // serves nothing: an MCP-spawned server takes the lock, the desktop's own
      // server is later stopped by an auto-update relaunch, and the survivor's
      // lock outlives the port behind it. Every metadata gate still passes, so
      // only a health probe can tell that lock from a good one — and the attach
      // path already does exactly that. The spawn path does not, which is how
      // one field log records both verdicts on the same port 2 ms apart:
      // `desktop-attach-refused reason=ws-upgrade-failed lockPid=870`, then
      // `desktop-server-spawned-detached pid=22018 port=42117` /
      // "detached server ready". The window opens onto a port that answers
      // nothing, and every retry reproduces it.
      test('a stale lock our child never replaced is NOT declared ready (dead port)', async () => {
        enableSyncTimers();
        const STALE_PID = 870;
        const OUR_CHILD_PID = 22018;
        const staleLock: ServerLockMetadataLike = {
          ...spawnedLock,
          pid: STALE_PID,
          port: 42117,
        };
        // The holder never releases and our child never publishes its own lock,
        // so every read — the attach gate's and the spawn poll's — returns the
        // same record, and `pollServerLock` accepts it on the first iteration.
        const probed: string[] = [];
        env.deps.readServerLock = () => staleLock;
        // Alive-or-unkillable: `isPidAlive` reports EPERM as alive, so liveness
        // cannot distinguish this holder from a healthy one.
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = (url) => {
          probed.push(url);
          return Promise.resolve(false);
        };
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: OUR_CHILD_PID });
        const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
        env.deps.killProbe = (pid, signal) => {
          killCalls.push({ pid, signal });
        };
        // Both tiers kept short: a correct refusal spends the rest of the
        // window re-polling for a lock that is never going to change.
        env.deps.spawnLockPollDeadlineMs = 50;
        env.deps.spawnLockProgressDeadlineMs = 50;

        const wm = new WindowManager(env.deps);
        // Discriminated rather than a bare rejects/resolves assertion so a
        // failure names the port we wrongly attached to.
        const outcome = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' }).then(
          (ctx) => ({ kind: 'attached' as const, port: ctx.port }),
          (err) => ({
            kind: 'refused' as const,
            message: (err as Error).message,
            errKind: (err as Error & { kind?: string }).kind,
            reason: (err as Error & { reason?: string }).reason,
            holderPid: (err as Error & { holderPid?: number }).holderPid,
          }),
        );

        // Precondition, not the point: the attach gate really did probe this
        // lock, so a pass here cannot come from the lock never being examined.
        expect(probed.some((u) => u.includes('42117'))).toBe(true);
        // The point: the spawn branch must not adopt the lock the attach branch
        // just refused. Failing the spawn is an acceptable outcome — the user
        // gets the "Unable to open project" dialog and its Stop Server & Retry
        // remedy instead of a window wired to a port that answers nothing.
        expect(outcome).toMatchObject({ kind: 'refused' });
        expect(env.windows.length).toBe(0);
        // The refusal has to be diagnosable AS a stale holder, not as a
        // deadline. `buildSpawnFailureError`'s narrative would blame a timeout
        // that never elapsed on our own child's pid, and — load-bearing — the
        // failed-open dialog gates its Stop Server & Retry remedy on this kind,
        // so a refusal that does not say what it is silently loses the only way
        // out a user has while the project has no window.
        expect(outcome).toMatchObject({ errKind: 'stale-lock-holder', holderPid: STALE_PID });
        // The other half of the discriminator, and the half that carries THIS
        // scenario — a holder alive but answering nothing. Without it, collapsing
        // the ternary shows the unusable-lock copy ("it may still be running")
        // for a holder this code just proved is not serving, and the suite stays
        // green.
        expect(outcome).toMatchObject({ reason: 'holder-not-serving' });
        if (outcome.kind === 'refused') {
          expect(outcome.message).toContain('not serving on port 42117');
        }
        // The orphan reap. Our child is `.unref()`ed with no parent to collect
        // it, so refusing the holder without SIGTERMing it leaks a server
        // process for the session's lifetime.
        expect(killCalls).toContainEqual({ pid: OUR_CHILD_PID, signal: 'SIGTERM' });
      });

      // Two doors lead into `attachToExistingServer`, and the direct gate is
      // only one of them. A numeric-string port is refused there, but the
      // spawn branch then re-derives the same lock through `pollServerLock`,
      // whose readiness test is `lock.port > 0` — a RELATIONAL compare, so
      // `'42117' > 0` coerces true. The probe on that lock SUCCEEDS, because a
      // numeric string renders into a live address, so the health check that
      // catches the dead-port case cannot catch this one. Without a gate on
      // this door the session is built on a port typed as a string, and the
      // keepalive that keeps the server from reaping the project is typed on a
      // number.
      test('a numeric-string port is refused at the spawn door too, not just the attach gate', async () => {
        enableSyncTimers();
        const FOREIGN_PID = 870;
        const OUR_CHILD_PID = 22018;
        const stringPortLock = {
          ...spawnedLock,
          pid: FOREIGN_PID,
          port: '42117',
        } as unknown as ServerLockMetadataLike;
        env.deps.readServerLock = () => stringPortLock;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        // Load-bearing: the holder ANSWERS. This is what separates this case
        // from the dead-port test above — health cannot be the discriminator,
        // so only the shape check can refuse it.
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: OUR_CHILD_PID });
        const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
        env.deps.killProbe = (pid, signal) => {
          killCalls.push({ pid, signal });
        };
        env.deps.spawnLockPollDeadlineMs = 50;
        env.deps.spawnLockProgressDeadlineMs = 50;

        const wm = new WindowManager(env.deps);
        const outcome = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' }).then(
          (ctx) => ({ kind: 'attached' as const, port: ctx.port }),
          (err) => ({
            kind: 'refused' as const,
            errKind: (err as Error & { kind?: string }).kind,
            reason: (err as Error & { reason?: string }).reason,
            holderIsOwnChild: (err as Error & { holderIsOwnChild?: boolean }).holderIsOwnChild,
            message: (err as Error).message,
          }),
        );

        expect(outcome).toMatchObject({
          kind: 'refused',
          errKind: 'stale-lock-holder',
          reason: 'lock-not-attachable',
        });
        // The FOREIGN direction of both discriminators, and the one carrying the
        // consequence: `holderIsOwnChild` is the second conjunct of the dialog's
        // may-still-be-running hedge AND of its safe keyboard default, so a
        // mutant pinning it true reverts both for every stranger's lock.
        // Asserting only the own-child direction leaves that green.
        expect(outcome).toMatchObject({ holderIsOwnChild: false });
        if (outcome.kind === 'refused') {
          expect(outcome.message).toContain(`Another process (pid ${FOREIGN_PID})`);
        }
        // `||` short-circuits, so the holder was never dialed on this arm. The
        // failed-open dialog quotes this message verbatim, and a user asked to
        // stop a process on the claim it is already inert would be consenting
        // under a premise nothing here established.
        expect(outcome).toMatchObject({ kind: 'refused' });
        if (outcome.kind === 'refused') {
          expect(outcome.message).not.toContain('not serving');
        }
        expect(env.windows.length).toBe(0);
        expect(killCalls).toContainEqual({ pid: OUR_CHILD_PID, signal: 'SIGTERM' });
      });

      // A url arm here would defeat the whole point of the predicate:
      // `resolveKeepaliveWsOrigin` returns `undefined`
      // unless `port` is a positive NUMBER whatever the url says, so a session
      // built on this lock loses its keepalive and idle-shutdown reaps the
      // server under an open window. A good advertisement does not make a lock
      // we can HOLD.
      test('a good loopback url does not rescue a non-numeric port at the attach gate', async () => {
        enableSyncTimers();
        const urlLock = {
          ...spawnedLock,
          pid: 870,
          url: 'http://127.0.0.1:59534',
          port: '59534',
        } as unknown as ServerLockMetadataLike;
        env.deps.readServerLock = () => urlLock;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        // The advertised address answers. Only the shape can refuse this.
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 22018 });
        env.deps.spawnLockPollDeadlineMs = 50;
        env.deps.spawnLockProgressDeadlineMs = 50;

        const wm = new WindowManager(env.deps);
        const outcome = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' }).then(
          (ctx) => ({ kind: 'attached' as const, port: ctx.port }),
          (err) => ({
            kind: 'refused' as const,
            reason: (err as Error & { reason?: string }).reason,
          }),
        );

        expect(outcome).toMatchObject({ kind: 'refused', reason: 'lock-not-attachable' });
        expect(env.windows.length).toBe(0);
      });

      // The one shape that reaches the own-child arm of the holder framing.
      // `unusableLock` is deliberately not exempted for our own spawn the way
      // the probe is, so a lock our child wrote with a port we cannot hold a
      // connection on refuses ITS OWN child — which this method has already
      // SIGTERMed by the time the message is built. Nothing else in the suite
      // gets here (every other test of this throw is cross-pid), so without
      // this the framing reverts to "another process" unnoticed.
      test('refusing our own child names it as ours, not as another process', async () => {
        enableSyncTimers();
        const OUR_CHILD_PID = 22018;
        const ownLock = {
          ...spawnedLock,
          pid: OUR_CHILD_PID,
          port: '42117',
        } as unknown as ServerLockMetadataLike;
        env.deps.readServerLock = () => ownLock;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: OUR_CHILD_PID });
        const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
        env.deps.killProbe = (pid, signal) => {
          killCalls.push({ pid, signal });
        };
        env.deps.spawnLockPollDeadlineMs = 50;
        env.deps.spawnLockProgressDeadlineMs = 50;

        const wm = new WindowManager(env.deps);
        const outcome = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' }).then(
          () => ({ kind: 'attached' as const }),
          (err) => ({
            kind: 'refused' as const,
            message: (err as Error).message,
            holderIsOwnChild: (err as Error & { holderIsOwnChild?: boolean }).holderIsOwnChild,
          }),
        );

        expect(outcome).toMatchObject({ kind: 'refused', holderIsOwnChild: true });
        if (outcome.kind === 'refused') {
          expect(outcome.message).not.toContain('Another process');
        }
        // The same reap its same-branch siblings assert: our child is
        // `.unref()`ed with no parent to collect it, and here the holder IS
        // that child.
        expect(killCalls).toContainEqual({ pid: OUR_CHILD_PID, signal: 'SIGTERM' });
      });

      // The differential partner of the dead-port test above: the same cross-pid shape
      // with exactly one variable flipped. `pollServerLock` deliberately
      // accepts a non-draining lock held by a DIFFERENT live pid, because a
      // concurrent starter that won the acquire is a real server we should
      // share (see the losing-child test above). Any fix for the stale-lock
      // case must discriminate on the HEALTH of the advertised port, never on
      // pid identity — give that test a probe that passes and the attach returns.
      test('a healthy cross-pid lock-race winner is still attached (probe passes)', async () => {
        enableSyncTimers();
        const WINNER_PID = 870;
        const OUR_CHILD_PID = 22018;
        const winnerLock: ServerLockMetadataLike = {
          ...spawnedLock,
          pid: WINNER_PID,
          port: 42117,
        };
        // Nothing usable at the attach gate; the winner's lock lands on the
        // first poll read, by which point our child is already gone.
        let reads = 0;
        env.deps.readServerLock = () => {
          reads++;
          return reads === 1 ? null : winnerLock;
        };
        // Our child lost the acquire and exited by design; the winner is alive.
        env.deps.isProcessAlive = (pid) => pid === WINNER_PID;
        env.deps.hostname = () => 'my-host';
        // The winner is genuinely serving — the whole difference from above.
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        const spawn = vi.fn(() => Promise.resolve({ pid: OUR_CHILD_PID }));
        env.deps.spawnDetachedServer = spawn;
        env.deps.spawnLockPollDeadlineMs = 500;

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' });

        // Not vacuous: we went through the spawn branch's poll, not the direct
        // attach gate (which saw no lock on its single read).
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(ctx.port).toBe(42117);
        expect(ctx.ownsServer).toBe(false);
        expect(env.windows.length).toBe(1);
      });

      // The STRICT differential for the stale-lock test: byte-identical setup
      // with exactly one value changed, the probe's answer. The cross-pid
      // winner test above is a useful scenario but a loose differential — it
      // also varies child liveness and the lock-read sequence, so a gate gating
      // on child liveness rather than port health passes both of them and only
      // trips over an unrelated pre-existing test. Here liveness is `() => true`
      // for everyone and the lock never changes, so the probe is the only thing
      // that can decide, and any implementation reading a different signal
      // fails one of the pair.
      test('the same stale-lock shape attaches when the probe answers (only the probe differs)', async () => {
        enableSyncTimers();
        const HOLDER_PID = 870;
        const OUR_CHILD_PID = 22018;
        const holderLock: ServerLockMetadataLike = {
          ...spawnedLock,
          pid: HOLDER_PID,
          port: 42117,
        };
        env.deps.readServerLock = () => holderLock;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: OUR_CHILD_PID });
        env.deps.spawnLockPollDeadlineMs = 50;
        env.deps.spawnLockProgressDeadlineMs = 50;

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' });

        expect(ctx.port).toBe(42117);
        expect(env.windows.length).toBe(1);
      });

      // The grace exists for a holder that is up but not yet answering, which is
      // the whole reason this path retries where the attach gate does not. With
      // a single shot this attaches to nothing and the open fails; the loop is
      // otherwise only ever exercised with a constant answer, so nothing would
      // notice it collapsing back to one attempt.
      test('a foreign holder that answers only on a later attempt is still attached', async () => {
        enableSyncTimers();
        const HOLDER_PID = 870;
        const OUR_CHILD_PID = 22018;
        const holderLock: ServerLockMetadataLike = {
          ...spawnedLock,
          pid: HOLDER_PID,
          port: 42117,
        };
        env.deps.readServerLock = () => holderLock;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        let probes = 0;
        // Refuses the first two, then comes up — a server past `listen()` whose
        // `/collab` is still wiring.
        env.deps.probeWsUpgrade = () => {
          probes++;
          return Promise.resolve(probes >= 3);
        };
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: OUR_CHILD_PID });
        env.deps.spawnLockPollDeadlineMs = 50;
        env.deps.spawnLockProgressDeadlineMs = 50;

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' });

        expect(ctx.port).toBe(42117);
        expect(probes).toBe(3);
        expect(env.windows.length).toBe(1);
      });

      // The own-child exemption is a deliberate cost decision, not an accident:
      // probing a server we just watched come up buys no signal and would put
      // the probe timeout on every cold project open. Nothing else pins it, so
      // deleting the exemption is invisible to the suite.
      test('our own child’s lock is adopted without paying for a probe', async () => {
        enableSyncTimers();
        const OUR_CHILD_PID = 44001;
        let reads = 0;
        env.deps.readServerLock = () => {
          reads++;
          return reads === 1 ? null : { ...spawnedLock, pid: OUR_CHILD_PID, port: 51234 };
        };
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        const probed: string[] = [];
        env.deps.probeWsUpgrade = (url) => {
          probed.push(url);
          return Promise.resolve(true);
        };
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: OUR_CHILD_PID });
        env.deps.spawnLockPollDeadlineMs = 500;

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' });

        expect(ctx.port).toBe(51234);
        expect(probed).toHaveLength(0);
      });

      test('a child that exits before binding surfaces its exit code and signal', async () => {
        enableSyncTimers();
        env.deps.readServerLock = () => null;
        env.deps.isProcessAlive = () => false;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        // The spawn handle reports how the child died. `readExit` returns null
        // while it is still running and the exit record once it has exited —
        // the parent's only channel for a reason, since stdout/stderr may be
        // empty (the reported failure had an empty capture log).
        env.deps.spawnDetachedServer = () =>
          Promise.resolve({
            pid: 88001,
            readExit: () => ({ code: 1, signal: null }),
          });
        env.deps.spawnLockPollDeadlineMs = 500;

        const wm = new WindowManager(env.deps);
        await expect(
          wm.createProjectWindow({ projectPath: '/tmp/exited-child' }),
        ).rejects.toMatchObject({ pid: 88001, exitCode: 1, exitSignal: null });
      });

      test('a signal-killed child surfaces the signal in its error message', async () => {
        enableSyncTimers();
        env.deps.readServerLock = () => null;
        env.deps.isProcessAlive = () => false;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () =>
          Promise.resolve({
            pid: 88001,
            readExit: () => ({ code: null, signal: 'SIGKILL' }),
          });
        env.deps.spawnLockPollDeadlineMs = 500;

        const wm = new WindowManager(env.deps);
        const err = await wm.createProjectWindow({ projectPath: '/tmp/killed-child' }).then(
          () => null,
          (e: unknown) => e as Error,
        );

        // The reason belongs in the message, not only in a structured field —
        // this string is what reaches the user in the "Unable to open project"
        // dialog, and a bare deadline there is the reported complaint.
        expect(err?.message).toMatch(/SIGKILL/);
      });

      // Degradation guard: a handle with no exit record (child still running,
      // or a caller that predates `readExit`) must still produce the ordinary
      // timeout rather than throwing on an absent accessor.
      test('an unavailable exit record still yields the ordinary timeout error', async () => {
        enableSyncTimers();
        env.deps.readServerLock = () => null;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001, readExit: () => null });
        env.deps.spawnLockPollDeadlineMs = 1;

        const wm = new WindowManager(env.deps);
        await expect(
          wm.createProjectWindow({ projectPath: '/tmp/still-running' }),
        ).rejects.toMatchObject({ kind: 'spawn-lock-timeout', pid: 88001 });
      });

      test('detached-mode window close: no shutdown IPC, no spawn pid removal', async () => {
        enableSyncTimers();
        // Same attach-then-spawn split as the previous test: first read no
        // lock so the spawn branch fires; subsequent reads see the lock the
        // freshly-spawned server wrote.
        let readCount = 0;
        env.deps.readServerLock = () => {
          readCount++;
          return readCount === 1 ? null : spawnedLock;
        };
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' });

        // The ctx is in attach-mode shape — no utility to send IPC to.
        expect(ctx.utility).toBeNull();
        expect(ctx.ownsServer).toBe(false);

        // Fire the window-close event. There MUST be no IPC posted to any
        // utility because there's no utility — the server is detached and
        // lives on. The pid stays in the tracking map.
        env.windows[0]?.fireClose();
        const pids = (wm as unknown as { spawnedDetachedPids: Map<string, number> })
          .spawnedDetachedPids;
        expect(pids.size).toBe(1);
        expect(env.utilities.length).toBe(0);
      });

      test('spawn-poll skips a draining predecessor lock and connects to the fresh spawn', async () => {
        enableSyncTimers();
        // Restart window: the dying predecessor still holds its lock (marked
        // draining — the file survives until its process exits). The attach
        // gate must refuse it, and the spawn-readiness poll must NOT mistake
        // it for the fresh spawn's lock — only the successor's non-draining
        // lock is the readiness signal.
        const drainingPredecessor: ServerLockMetadataLike = {
          ...spawnedLock,
          pid: 77001,
          port: 55555,
          draining: true,
        };
        let readCount = 0;
        env.deps.readServerLock = () => {
          readCount++;
          // Attach gate + first poll reads see the draining predecessor;
          // then the fresh spawn's lock lands.
          return readCount <= 3 ? drainingPredecessor : spawnedLock;
        };
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        const spawn = vi.fn(() => Promise.resolve({ pid: 91001 }));
        env.deps.spawnDetachedServer = spawn;

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' });

        expect(spawn).toHaveBeenCalledTimes(1);
        // Connected to the successor's port — never the draining predecessor's.
        expect(ctx.port).toBe(spawnedLock.port);
        expect(ctx.ownsServer).toBe(false);
      });

      test('attach-eligible lock pre-empts detached spawn (does NOT spawn a duplicate)', async () => {
        enableSyncTimers();
        // An attachable lock is already present — the desktop attaches rather
        // than spawning its own detached server. spawnDetachedServer must NOT
        // be called.
        env.deps.readServerLock = () => spawnedLock;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        const spawn = vi.fn(() => Promise.resolve({ pid: 99 }));
        env.deps.spawnDetachedServer = spawn;

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' });

        expect(spawn).not.toHaveBeenCalled();
        expect(ctx.port).toBe(60111);
      });
    });

    describe('forceStopConflictingServer (dialog "Stop Server & Retry")', () => {
      function seedRawLock(pid: number, overrides?: { port?: number }): string {
        const projectPath = mkdtempSync(join(tmpdir(), 'ok-force-stop-'));
        const lockDir = join(projectPath, '.ok', 'local');
        mkdirSync(lockDir, { recursive: true });
        // Tampered/foreign identity on purpose — the method must bypass the
        // machine-identity filter and act on the raw pid.
        writeFileSync(
          join(lockDir, 'server.lock'),
          JSON.stringify({
            pid,
            hostname: 'some-old-hostname',
            machineId: 'not-this-machine',
            port: overrides?.port ?? 61000,
            startedAt: '2026-07-07T00:00:00.000Z',
            worktreeRoot: projectPath,
            kind: 'interactive',
          }),
          'utf-8',
        );
        return projectPath;
      }

      test('SIGTERMs the raw lock pid even when its identity looks foreign', async () => {
        const killedPids = new Set<number>();
        const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
        env.deps.killProbe = (pid, signal) => {
          killCalls.push({ pid, signal });
          if (signal === 'SIGTERM') killedPids.add(pid);
        };
        env.deps.isProcessAlive = (pid) => !killedPids.has(pid);
        const projectPath = seedRawLock(64321);

        const wm = new WindowManager(env.deps);
        const outcome = await wm.forceStopConflictingServer(projectPath);

        expect(outcome).toEqual({ ok: true });
        expect(killCalls).toContainEqual({ pid: 64321, signal: 'SIGTERM' });
      });

      test('no lock file → ok without signalling anything', async () => {
        const killCalls: number[] = [];
        env.deps.killProbe = (pid) => {
          killCalls.push(pid);
        };
        const projectPath = mkdtempSync(join(tmpdir(), 'ok-force-stop-empty-'));

        const wm = new WindowManager(env.deps);
        const outcome = await wm.forceStopConflictingServer(projectPath);

        expect(outcome).toEqual({ ok: true });
        expect(killCalls).toHaveLength(0);
      });

      test('EPERM (other user account) surfaces as a failure', async () => {
        env.deps.killProbe = () => {
          const err = new Error('operation not permitted') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        };
        const projectPath = seedRawLock(64322);

        const wm = new WindowManager(env.deps);
        const outcome = await wm.forceStopConflictingServer(projectPath);

        expect(outcome).toEqual({ ok: false, reason: 'eperm' });
      });

      // This dialog is the ONLY remedy while the project has no window, so an
      // EPERM dead-end here is terminal in a way the restart path's is not: the
      // restart affordance lives on a window that, for a wedged project, never
      // opens. Both entry states have to clear an unkillable-and-not-serving
      // holder or the fix only helps projects that were already open.
      test('EPERM holder that serves nothing has its lock broken so the retry proceeds', async () => {
        // The graced probe on the break path retries through `deps.setTimeout`,
        // which the base env only records; drive it so the loop resolves.
        env.deps.setTimeout = (cb: () => void, _ms: number) => {
          cb();
          return null;
        };
        const projectPath = seedRawLock(64323);
        const removeServerLock = vi.fn(() => true);
        env.deps.removeServerLock = removeServerLock;
        env.deps.readServerLock = () => ({ ...liveLock, pid: 64323, port: 61000 });
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        // 61000 answers nothing.
        env.deps.probeWsUpgrade = () => Promise.resolve(false);
        env.deps.killProbe = () => {
          throw Object.assign(new Error('eperm'), { code: 'EPERM' });
        };

        const wm = new WindowManager(env.deps);
        const outcome = await wm.forceStopConflictingServer(projectPath);

        expect(outcome).toEqual({ ok: true });
        expect(removeServerLock).toHaveBeenCalledTimes(1);
        // Same trap as the restart path: the lock dir, not the project root.
        expect(removeServerLock.mock.calls[0]?.[0]).toBe(join(projectPath, '.ok', 'local'));
        expect(removeServerLock.mock.calls[0]?.[1]).toEqual({ pid: 64323 });
      });

      // The production `removeServerLock` wiring, exercised against a real lock
      // file rather than a spy. The window between deciding and unlinking is a
      // whole health probe wide, so a successor that acquired the lock in it
      // must keep it — an unguarded unlink would delete a valid claim on the
      // strength of a verdict about its predecessor.
      test('the guarded unlink breaks only the holder it was told about', () => {
        const projectPath = seedRawLock(70001);
        const lockDir = join(projectPath, '.ok', 'local');
        const lockPath = join(lockDir, 'server.lock');

        // A successor took the lock while we were probing the predecessor.
        expect(breakServerLockHeldBy(lockDir, { pid: 69999 })).toBe(false);
        expect(existsSync(lockPath)).toBe(true);

        // The holder we actually judged.
        expect(breakServerLockHeldBy(lockDir, { pid: 70001 })).toBe(true);
        expect(existsSync(lockPath)).toBe(false);

        // Already gone is the end state we wanted, but not a removal WE did,
        // and never an error — this runs on the path that un-wedges a project.
        expect(breakServerLockHeldBy(lockDir, { pid: 70001 })).toBe(false);

        // A corrupt lock is left for `runClean`, not broken on a guess.
        writeFileSync(lockPath, 'not json', 'utf-8');
        expect(breakServerLockHeldBy(lockDir, { pid: 70001 })).toBe(false);
        expect(existsSync(lockPath)).toBe(true);
      });

      // `seedRawLock` deliberately writes a
      // foreign hostname and machineId, because the defining feature of this
      // state is that identity checks refused the holder — that is why this
      // method reads the lock raw. Sourcing the probe target from
      // `readServerLock` instead re-imposes that filter and returns null,
      // silently making the one no-window remedy inert for exactly the cohort
      // EPERM implies: a holder under another account or a flapped hostname.
      test('EPERM recovery works on a lock whose identity fields look foreign', async () => {
        // The graced probe on the break path retries through `deps.setTimeout`,
        // which the base env only records; drive it so the loop resolves.
        env.deps.setTimeout = (cb: () => void, _ms: number) => {
          cb();
          return null;
        };
        const projectPath = seedRawLock(64325);
        const removeServerLock = vi.fn(() => true);
        env.deps.removeServerLock = removeServerLock;
        // The identity-filtered reader refuses this lock, as it does in the field.
        env.deps.readServerLock = () => null;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(false);
        env.deps.killProbe = () => {
          throw Object.assign(new Error('eperm'), { code: 'EPERM' });
        };

        const wm = new WindowManager(env.deps);
        const outcome = await wm.forceStopConflictingServer(projectPath);

        expect(outcome).toEqual({ ok: true });
        expect(removeServerLock).toHaveBeenCalledTimes(1);
        expect(removeServerLock.mock.calls[0]?.[1]).toEqual({ pid: 64325 });
      });

      // Same degrade-don't-crash contract as the restart path, on the entry
      // state that has no window to fall back to.
      test('EPERM recovery survives a removeServerLock that throws', async () => {
        // The graced probe on the break path retries through `deps.setTimeout`,
        // which the base env only records; drive it so the loop resolves.
        env.deps.setTimeout = (cb: () => void, _ms: number) => {
          cb();
          return null;
        };
        const projectPath = seedRawLock(64326);
        env.deps.removeServerLock = vi.fn(() => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        });
        env.deps.readServerLock = () => null;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(false);
        env.deps.killProbe = () => {
          throw Object.assign(new Error('eperm'), { code: 'EPERM' });
        };

        const wm = new WindowManager(env.deps);
        const outcome = await wm.forceStopConflictingServer(projectPath);

        expect(outcome).toEqual({ ok: false, reason: 'eperm' });
      });

      // Symmetry with the restart path: a declined break is not a success here
      // either, and this is the entry state with no window to fall back to.
      test('EPERM recovery does not report success when the break is declined', async () => {
        const projectPath = seedRawLock(64327);
        env.deps.setTimeout = (cb: () => void, _ms: number) => {
          cb();
          return null;
        };
        const removeServerLock = vi.fn(() => false);
        env.deps.removeServerLock = removeServerLock;
        env.deps.readServerLock = () => null;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(false);
        env.deps.killProbe = () => {
          throw Object.assign(new Error('eperm'), { code: 'EPERM' });
        };

        const wm = new WindowManager(env.deps);
        const outcome = await wm.forceStopConflictingServer(projectPath);

        expect(removeServerLock).toHaveBeenCalledTimes(1);
        expect(outcome).toEqual({ ok: false, reason: 'eperm' });
      });

      // The other half of the port-0 guard. Pinning it from the restart path
      // alone proves the rule holds it, not that this caller reaches the rule.
      test('EPERM recovery leaves the lock alone when the holder has not bound a port', async () => {
        const projectPath = seedRawLock(64328, { port: 0 });
        env.deps.setTimeout = (cb: () => void, _ms: number) => {
          cb();
          return null;
        };
        const removeServerLock = vi.fn(() => true);
        env.deps.removeServerLock = removeServerLock;
        env.deps.readServerLock = () => null;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        const probe = vi.fn(() => Promise.resolve(false));
        env.deps.probeWsUpgrade = probe;
        env.deps.killProbe = () => {
          throw Object.assign(new Error('eperm'), { code: 'EPERM' });
        };

        const wm = new WindowManager(env.deps);
        const outcome = await wm.forceStopConflictingServer(projectPath);

        expect(outcome).toEqual({ ok: false, reason: 'eperm' });
        expect(removeServerLock).not.toHaveBeenCalled();
        expect(probe).not.toHaveBeenCalled();
      });

      // The guard on the test above, and the reason the rule asks two questions
      // rather than one: breaking a serving holder's lock would strand it and
      // put a second server on the same project.
      test('EPERM holder that IS serving keeps its lock and still fails', async () => {
        const projectPath = seedRawLock(64324);
        const removeServerLock = vi.fn(() => true);
        env.deps.removeServerLock = removeServerLock;
        env.deps.readServerLock = () => ({ ...liveLock, pid: 64324, port: 61000 });
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.killProbe = () => {
          throw Object.assign(new Error('eperm'), { code: 'EPERM' });
        };

        const wm = new WindowManager(env.deps);
        const outcome = await wm.forceStopConflictingServer(projectPath);

        expect(outcome).toEqual({ ok: false, reason: 'eperm' });
        expect(removeServerLock).not.toHaveBeenCalled();
      });

      test('never signals a hostile lock pid (0/1/self)', async () => {
        const killCalls: number[] = [];
        env.deps.killProbe = (pid) => {
          killCalls.push(pid);
        };
        for (const badPid of [0, 1, process.pid]) {
          const projectPath = seedRawLock(badPid);
          const wm = new WindowManager(env.deps);
          const outcome = await wm.forceStopConflictingServer(projectPath);
          expect(outcome).toEqual({ ok: true });
        }
        expect(killCalls).toHaveLength(0);
      });
    });

    describe('keepalive lifecycle (FR4)', () => {
      function makeKeepaliveMock() {
        const calls: Array<{ lockDir: string }> = [];
        const handles: Array<{ closed: boolean }> = [];
        const create = vi.fn((opts: { lockDir: string }) => {
          calls.push(opts);
          const handle = { closed: false };
          handles.push(handle);
          return {
            close: () => {
              handle.closed = true;
            },
            isConnected: () => !handle.closed,
          };
        });
        return { create, calls, handles };
      }

      test('opens keepalive when a project window attaches', async () => {
        enableAttachProbe();
        const ka = makeKeepaliveMock();
        env.deps.createKeepalive = ka.create;

        const wm = new WindowManager(env.deps);
        await wm.createProjectWindow({ projectPath: '/tmp/dragon' });

        expect(ka.calls).toHaveLength(1);
        expect(ka.calls[0]?.lockDir).toBe('/tmp/dragon/.ok/local');
        expect(ka.handles[0]?.closed).toBe(false);
      });

      test('closes keepalive when the project window closes', async () => {
        enableAttachProbe();
        const ka = makeKeepaliveMock();
        env.deps.createKeepalive = ka.create;

        const wm = new WindowManager(env.deps);
        await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
        expect(ka.handles[0]?.closed).toBe(false);

        env.windows[0]?.fireClose();
        expect(ka.handles[0]?.closed).toBe(true);
      });

      test('a fresh window open re-creates the keepalive (post-close)', async () => {
        enableAttachProbe();
        const ka = makeKeepaliveMock();
        env.deps.createKeepalive = ka.create;

        const wm = new WindowManager(env.deps);
        await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
        env.windows[0]?.fireClose();

        await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
        expect(ka.calls).toHaveLength(2);
        expect(ka.handles[0]?.closed).toBe(true);
        expect(ka.handles[1]?.closed).toBe(false);
      });

      test('no createKeepalive dep → no keepalive opened (back-compat)', async () => {
        enableAttachProbe();
        const wm = new WindowManager(env.deps);
        await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
        expect(env.windows).toHaveLength(1);
      });
    });

    describe('stopAllOwnedServers (US-008 — auto-update teardown)', () => {
      const spawnedLock: ServerLockMetadataLike = {
        pid: 91001,
        hostname: 'my-host',
        port: 60777,
        startedAt: '2026-05-21T00:00:00.000Z',
        worktreeRoot: '/tmp/stop-test',
        kind: 'interactive',
        capabilities: ['http', 'ws'],
      };

      function enableSyncTimers() {
        env.deps.setTimeout = (cb: () => void, _ms: number) => {
          cb();
          return null;
        };
      }

      test('SIGTERMs every spawned detached pid; clears the tracking map', async () => {
        enableSyncTimers();
        // Spawn two detached servers (one per project) so we can assert
        // both pids are SIGTERMed.
        const lockByCwd = new Map<string, ServerLockMetadataLike>();
        lockByCwd.set('/tmp/proj-a/.ok/local', { ...spawnedLock, pid: 91001 });
        lockByCwd.set('/tmp/proj-b/.ok/local', { ...spawnedLock, pid: 91002 });
        let readCounts = new Map<string, number>();
        env.deps.readServerLock = (lockDir) => {
          const n = (readCounts.get(lockDir) ?? 0) + 1;
          readCounts.set(lockDir, n);
          // First read (the attach gate) sees no lock → spawn fires.
          // Subsequent reads return the spawned lock; stopAllOwnedServers
          // also reads (and we want it to find the lock initially, then
          // disappear after SIGTERM — simulated by toggling to null on the
          // post-stop reads via the kill mock).
          return n === 1 ? null : (lockByCwd.get(lockDir) ?? null);
        };
        // Liveness follows the kill mock below: a SIGTERMed pid counts as
        // exited (the stop poll watches pid death, not lock release).
        const killedPids = new Set<number>();
        env.deps.isProcessAlive = (pid) => !killedPids.has(pid);
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        let nextSpawnPid = 91001;
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: nextSpawnPid++ });

        // Inject killProbe so we record signals + simulate the server exiting.
        // The dep is already wired in WindowManagerDeps (used by the
        // post-exit liveness probe + now also by stopAllOwnedServers
        // and the spawn-lock-timeout orphan cleanup) — cleaner than
        // monkey-patching node:process.kill.
        const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
        env.deps.killProbe = (pid: number, signal: NodeJS.Signals | 0) => {
          killCalls.push({ pid, signal });
          // Simulate the server reacting to SIGTERM by exiting (pid dies,
          // and its lock file goes with it via the exit-time unlink).
          if (signal === 'SIGTERM') {
            killedPids.add(pid);
            for (const [dir, lock] of lockByCwd.entries()) {
              if (lock.pid === pid) {
                lockByCwd.delete(dir);
              }
            }
          }
        };

        const wm = new WindowManager(env.deps);
        await wm.createProjectWindow({ projectPath: '/tmp/proj-a' });
        // Reset readCounts so /tmp/proj-b's first read also returns null
        // (otherwise readCounts inherits from /tmp/proj-a's reads).
        readCounts = new Map<string, number>();
        await wm.createProjectWindow({ projectPath: '/tmp/proj-b' });

        // Pre-call: both pids tracked.
        const pidsBefore = (wm as unknown as { spawnedDetachedPids: Map<string, number> })
          .spawnedDetachedPids;
        expect(pidsBefore.size).toBe(2);

        await wm.stopAllOwnedServers();

        // SIGTERM sent to each tracked pid; no SIGKILL needed (lock
        // released within the grace window).
        expect(
          killCalls
            .filter((c) => c.signal === 'SIGTERM')
            .map((c) => c.pid)
            .sort(),
        ).toEqual([91001, 91002]);
        expect(killCalls.filter((c) => c.signal === 'SIGKILL')).toHaveLength(0);

        // Map cleared.
        expect(pidsBefore.size).toBe(0);
      });

      test('escalates to SIGKILL when SIGTERM grace expires (lock still held)', async () => {
        enableSyncTimers();
        let readCount = 0;
        env.deps.readServerLock = () => {
          readCount++;
          return readCount === 1 ? null : { ...spawnedLock, pid: 91001 };
        };
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 91001 });
        // Short grace so the test exits fast — wedged-server case otherwise
        // waits 10 s of real wall-clock.
        env.deps.sigtermGraceMs = 5;

        const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
        env.deps.killProbe = (pid: number, signal: NodeJS.Signals | 0) => {
          killCalls.push({ pid, signal });
          // Do NOT release the lock on SIGTERM — simulate a wedged server.
        };

        const wm = new WindowManager(env.deps);
        await wm.createProjectWindow({ projectPath: '/tmp/wedged-project' });

        await wm.stopAllOwnedServers();

        // SIGTERM first, then SIGKILL after the grace window elapsed.
        const signals = killCalls.filter((c) => c.pid === 91001).map((c) => c.signal);
        expect(signals).toContain('SIGTERM');
        expect(signals).toContain('SIGKILL');
        // SIGTERM must precede SIGKILL.
        expect(signals.indexOf('SIGTERM')).toBeLessThan(signals.indexOf('SIGKILL'));
      });

      test('attached-only windows (no spawned pid) are not signaled', async () => {
        enableAttachProbe();
        const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
        env.deps.killProbe = (pid: number, signal: NodeJS.Signals | 0) => {
          killCalls.push({ pid, signal });
        };
        const wm = new WindowManager(env.deps);
        // Pure attach mode — no spawn, no tracking.
        await wm.createProjectWindow({ projectPath: '/tmp/attached-only' });
        await wm.stopAllOwnedServers();
        expect(killCalls).toHaveLength(0);
      });

      test('already-dead pid (ESRCH) is skipped without throwing', async () => {
        enableSyncTimers();
        let readCount = 0;
        env.deps.readServerLock = () => {
          readCount++;
          return readCount === 1 ? null : { ...spawnedLock, pid: 91001 };
        };
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 91001 });

        env.deps.killProbe = () => {
          const err = new Error('No such process') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        };

        const wm = new WindowManager(env.deps);
        await wm.createProjectWindow({ projectPath: '/tmp/dead-pid' });
        // Must not throw — ESRCH means the server already exited.
        await expect(wm.stopAllOwnedServers()).resolves.toBeUndefined();
      });

      test('utility-fork (dev path, ownsServer=true) is SIGKILLed by stopAllOwnedServers', async () => {
        // The detached-spawn path is gated on `spawnDetachedServer` being
        // wired in deps. With that dep absent (the dev wiring and most
        // tests), the WindowManager falls back to `forkUtility` and the
        // resulting ProjectContext has `ownsServer === true` + a `utility`
        // handle. `stopAllOwnedServers` must SIGKILL that utility before
        // auto-update relaunch so ShipIt's pre-swap `pgrep` check sees a
        // clean process tree — even though the utility would die anyway
        // on `quitAndInstall`, ShipIt polls BEFORE swapping the binary.
        delete env.deps.spawnDetachedServer;
        const wm = new WindowManager(env.deps);
        const p = wm.createProjectWindow({ projectPath: '/tmp/utility-mode' });
        // Wait for the fork; then fire `ready` so attach completes.
        await new Promise<void>((r) => setTimeout(r, 5));
        const utility = env.utilities[0];
        expect(utility).toBeDefined();
        utility?.fire({ type: 'ready', port: 60500, apiOrigin: 'http://localhost:60500' });
        await p;

        await wm.stopAllOwnedServers();

        // Utility received exactly one SIGKILL.
        const killMock = utility?.kill as unknown as { mock: { calls: unknown[][] } } | undefined;
        const killCalls = killMock?.mock.calls ?? [];
        expect(killCalls).toHaveLength(1);
        expect(killCalls[0]?.[0]).toBe('SIGKILL');
      });
    });

    test('legacy lock (kind undefined) is conservatively refused', async () => {
      enableAttachProbe({
        readServerLock: () => {
          const { kind: _kind, ...rest } = liveLock;
          return rest;
        },
      });
      const wm = new WindowManager(env.deps);
      const p = wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      await new Promise((r) => setTimeout(r, 5));
      expect(env.utilities.length).toBe(1);
      env.utilities[0]?.fire({ type: 'ready', port: 40011, apiOrigin: 'http://localhost:40011' });
      await p;
    });

    test('lock with capabilities missing "ws" falls through', async () => {
      enableAttachProbe({
        readServerLock: () => ({ ...liveLock, capabilities: ['http'] }),
      });
      const wm = new WindowManager(env.deps);
      const p = wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      await new Promise((r) => setTimeout(r, 5));
      expect(env.utilities.length).toBe(1);
      env.utilities[0]?.fire({ type: 'ready', port: 40012, apiOrigin: 'http://localhost:40012' });
      await p;
    });

    test('WS-upgrade probe failure falls through to spawn mode', async () => {
      const probe = vi.fn(() => Promise.resolve(false));
      enableAttachProbe({ probeWsUpgrade: probe });
      const wm = new WindowManager(env.deps);
      const p = wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      // The probe runs before utility fork; let microtasks drain.
      await new Promise((r) => setTimeout(r, 5));
      expect(probe).toHaveBeenCalled();
      expect(env.utilities.length).toBe(1);
      env.utilities[0]?.fire({ type: 'ready', port: 40014, apiOrigin: 'http://localhost:40014' });
      await p;
    });

    test('WS-upgrade probe rejection (thrown error) falls through to spawn mode', async () => {
      const probe = vi.fn(() => Promise.reject(new Error('socket refused')));
      enableAttachProbe({ probeWsUpgrade: probe });
      const wm = new WindowManager(env.deps);
      const p = wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      await new Promise((r) => setTimeout(r, 5));
      expect(env.utilities.length).toBe(1);
      env.utilities[0]?.fire({ type: 'ready', port: 40015, apiOrigin: 'http://localhost:40015' });
      await p;
    });

    test('WS probe undefined → final gate skipped (back-compat for tests)', async () => {
      // Explicitly do NOT wire probeWsUpgrade — same liveLock, alive pid.
      env.deps.readServerLock = () => liveLock;
      env.deps.isProcessAlive = () => true;
      env.deps.hostname = () => 'my-host';
      // probeWsUpgrade intentionally absent.
      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(env.utilities.length).toBe(0);
      expect(ctx.ownsServer).toBe(false);
    });
  });
});

describe('WindowManager.focusWindowForProject (M4 URL-scheme warm-start)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  test('returns null when no window is open for the project', () => {
    const wm = new WindowManager(env.deps);
    expect(wm.focusWindowForProject('/tmp/never-opened')).toBeNull();
  });

  test('returns the window when a project is open + calls focus+show', async () => {
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/warm-proj' });
    env.utilities[0]?.fire({ type: 'ready', port: 51200, apiOrigin: 'http://localhost:51200' });
    const ctx = await p;

    const win = wm.focusWindowForProject('/tmp/warm-proj');
    expect(win).toBe(ctx.window);
    expect(ctx.window.focus).toHaveBeenCalled();
    expect(ctx.window.show).toHaveBeenCalled();
  });

  test('restores a minimized window before focusing', async () => {
    // Replace createWindow with one that returns a pre-minimized mock so
    // `isMinimized()` returns true. The first (+ only) createProjectWindow
    // call will receive this pre-minimized window.
    const w = makeWindow({ minimized: true });
    env.deps.createWindow = () => {
      env.createWindowOpts.push({ additionalArguments: [], title: '' });
      env.windows.push(w);
      return w;
    };
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/min-proj' });
    env.utilities[0]?.fire({ type: 'ready', port: 51201, apiOrigin: 'http://localhost:51201' });
    await p;

    const result = wm.focusWindowForProject('/tmp/min-proj');
    expect(result).toBe(w);
    expect(w.isMinimized).toHaveBeenCalled();
    expect(w.restore).toHaveBeenCalled();
    expect(w.focus).toHaveBeenCalled();
  });

  test('brings a backgrounded window to the front: show + moveTop + focus + app steal', async () => {
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/bg-proj' });
    env.utilities[0]?.fire({ type: 'ready', port: 51210, apiOrigin: 'http://localhost:51210' });
    const ctx = await p;

    wm.focusWindowForProject('/tmp/bg-proj');
    // The full macOS recipe: window-level surface + app-level activation,
    // because focus() alone won't foreground a backgrounded app.
    expect(ctx.window.show).toHaveBeenCalled();
    expect(ctx.window.moveTop).toHaveBeenCalled();
    expect(ctx.window.focus).toHaveBeenCalled();
    expect(env.activateApp).toHaveBeenCalled();
  });

  test('reports a destroyed window as no window rather than calling into it', async () => {
    // A map entry outlives its native window between `closed` and the utility
    // `exit` that clears it. Surfacing that entry would throw; reporting "no
    // window" instead sends a deep link down its cold path, which is correct
    // for a window that is gone.
    const w = makeWindow();
    env.deps.createWindow = () => {
      env.createWindowOpts.push({ additionalArguments: [], title: '' });
      env.windows.push(w);
      return w;
    };
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/gone-proj' });
    env.utilities[0]?.fire({ type: 'ready', port: 51223, apiOrigin: 'http://localhost:51223' });
    await p;
    w.markDestroyed();
    w.focus.mockClear();
    w.show.mockClear();

    expect(wm.focusWindowForProject('/tmp/gone-proj')).toBeNull();
    expect(w.focus).not.toHaveBeenCalled();
    expect(w.show).not.toHaveBeenCalled();
    expect(env.activateApp).not.toHaveBeenCalled();
  });

  test('activate:false raises without foregrounding the app', async () => {
    // The post-restore raise when the user walked away mid-restore: order the
    // window correctly inside OpenKnowledge, but leave whatever app they are
    // actually using in front. `show()` would activate the app on macOS, so the
    // reveal must go through `showInactive()` and the app-level steal must not
    // fire at all.
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/quiet-proj' });
    env.utilities[0]?.fire({ type: 'ready', port: 51220, apiOrigin: 'http://localhost:51220' });
    const ctx = await p;
    const win = ctx.window as unknown as ReturnType<typeof makeWindow>;
    win.show.mockClear();
    win.showInactive.mockClear();

    wm.focusWindowForProject('/tmp/quiet-proj', { activate: false });

    expect(env.activateApp).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    // Asserted, not just described: the reveal is the whole point of the
    // branch, so a regression that dropped it must fail here.
    expect(win.showInactive).toHaveBeenCalledTimes(1);
    // Still ordered + made key within the app, so returning to OpenKnowledge
    // lands on this window rather than an arbitrary sibling.
    expect(win.moveTop).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });

  test('activate:false leaves an already-visible window alone rather than re-revealing', async () => {
    // Every restored window has already revealed by the time the raise runs, so
    // the common case must not call a reveal primitive at all.
    const w = makeWindow();
    env.deps.createWindow = () => {
      env.createWindowOpts.push({ additionalArguments: [], title: '' });
      env.windows.push(w);
      return w;
    };
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/visible-proj' });
    env.utilities[0]?.fire({ type: 'ready', port: 51221, apiOrigin: 'http://localhost:51221' });
    await p;
    w.show();
    w.show.mockClear();
    w.showInactive.mockClear();

    wm.focusWindowForProject('/tmp/visible-proj', { activate: false });

    expect(w.show).not.toHaveBeenCalled();
    expect(w.showInactive).not.toHaveBeenCalled();
    expect(env.activateApp).not.toHaveBeenCalled();
  });

  test('activate:false reveals a still-hidden window via showInactive', async () => {
    const w = makeWindow();
    env.deps.createWindow = () => {
      env.createWindowOpts.push({ additionalArguments: [], title: '' });
      env.windows.push(w);
      return w;
    };
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/hidden-proj' });
    env.utilities[0]?.fire({ type: 'ready', port: 51222, apiOrigin: 'http://localhost:51222' });
    await p;
    w.show.mockClear();
    w.showInactive.mockClear();

    wm.focusWindowForProject('/tmp/hidden-proj', { activate: false });

    expect(w.showInactive).toHaveBeenCalled();
    expect(w.show).not.toHaveBeenCalled();
    expect(env.activateApp).not.toHaveBeenCalled();
  });

  test('skips the app-level focus steal when the window is already frontmost', async () => {
    // A window that reports isFocused() === true models the OK Desktop
    // built-in terminal focusing a doc in its own already-active window —
    // surfacing the route must not steal OS focus that the app already holds.
    const w = makeWindow({ focused: true });
    env.deps.createWindow = () => {
      env.createWindowOpts.push({ additionalArguments: [], title: '' });
      env.windows.push(w);
      return w;
    };
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/frontmost-proj' });
    env.utilities[0]?.fire({ type: 'ready', port: 51211, apiOrigin: 'http://localhost:51211' });
    await p;

    wm.focusWindowForProject('/tmp/frontmost-proj');
    expect(w.focus).toHaveBeenCalled();
    expect(env.activateApp).not.toHaveBeenCalled();
  });

  test('canonicalizes project path before lookup (resolve equivalence)', async () => {
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/canon' });
    env.utilities[0]?.fire({ type: 'ready', port: 51202, apiOrigin: 'http://localhost:51202' });
    await p;

    // A variant path that `path.resolve` would canonicalize to the same
    // storage key must match. `/tmp/canon/.` resolves to `/tmp/canon`.
    expect(wm.focusWindowForProject('/tmp/canon/.')).not.toBeNull();
  });

  test('realpath canonicalization: open via symlink, focus via realpath matches', async () => {
    // Simulated symlink: `/Users/me/workspaces/dragon` → `/Users/me/projects/dragon`.
    // User opens via the symlink path; MCP's preview-url.ts emits the URL with
    // `realpathSync(contentDir)` = the realpath. Without realpath canonicalization
    // on the window-manager side, focusWindowForProject(realpath) would miss and
    // spawn a duplicate window. This test drives the injected realpathSync stub.
    const realpathMap = new Map([
      ['/Users/me/workspaces/dragon', '/Users/me/projects/dragon'],
      ['/Users/me/projects/dragon', '/Users/me/projects/dragon'],
    ]);
    env.deps.realpathSync = (p: string) => {
      const mapped = realpathMap.get(p);
      if (mapped) return mapped;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const wm = new WindowManager(env.deps);
    const pending = wm.createProjectWindow({ projectPath: '/Users/me/workspaces/dragon' });
    env.utilities[0]?.fire({ type: 'ready', port: 51210, apiOrigin: 'http://localhost:51210' });
    const ctx = await pending;

    // Lookup via the realpath (what preview-url.ts emits) — must hit.
    const found = wm.focusWindowForProject('/Users/me/projects/dragon');
    expect(found).toBe(ctx.window);
    expect(ctx.window.focus).toHaveBeenCalled();
    // Symmetric: getWindowFor also hits.
    expect(wm.getWindowFor('/Users/me/projects/dragon')).toBe(ctx);
    // canonicalKey is stored so cleanup handlers use the same key.
    expect(ctx.canonicalKey).toBe('/Users/me/projects/dragon');
    // User-facing projectPath retains the symlink path for UI / recents.
    expect(ctx.projectPath).toBe('/Users/me/workspaces/dragon');
  });

  test('realpathSync throws (ENOENT) → falls back to resolve(projectPath)', async () => {
    // Unreadable path — realpath throws. The canonicalizeKey helper falls back
    // to resolve(path) so the old behavior is preserved for nonexistent paths.
    env.deps.realpathSync = () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/ghost-path' });
    env.utilities[0]?.fire({ type: 'ready', port: 51211, apiOrigin: 'http://localhost:51211' });
    const ctx = await p;
    // Same fallback path on lookup → match.
    expect(wm.focusWindowForProject('/tmp/ghost-path')).toBe(ctx.window);
    expect(ctx.canonicalKey).toBe('/tmp/ghost-path');
  });
});

describe('WindowManager — pendingDeepLinkTarget dom-ready gate (M4 US-007 / Finding 2)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  test('spawn path: pendingDeepLinkTarget registers dom-ready listener BEFORE loadURL resolves', async () => {
    // Regression: the send must be registered BEFORE `await loadURL` so the
    // one-shot `ok:deep-link` event lands after the renderer's subscriber
    // mounts but not after did-finish-load (which misses dom-ready entirely).
    let onceCalledBeforeLoadResolved = false;
    let domReadyRegistrations = 0;
    env.deps.createWindow = () => {
      const w = makeWindow();
      const baseOnce = w.webContents.once as (event: 'dom-ready', cb: () => void) => void;
      w.webContents.once = ((event: 'dom-ready', cb: () => void) => {
        domReadyRegistrations++;
        baseOnce(event, cb);
      }) as typeof w.webContents.once;
      const baseLoadFile = w.loadFile as () => Promise<void>;
      w.loadFile = vi.fn(async () => {
        onceCalledBeforeLoadResolved = domReadyRegistrations > 0;
        return baseLoadFile();
      }) as typeof w.loadFile;
      env.windows.push(w);
      env.createWindowOpts.push({ additionalArguments: [], title: '' });
      return w;
    };

    const wm = new WindowManager(env.deps);
    const pending = wm.createProjectWindow({
      projectPath: '/tmp/deep-link-proj',
      pendingDeepLinkTarget: { kind: 'doc', path: 'notes/meeting' },
    });
    env.utilities[0]?.fire({ type: 'ready', port: 51220, apiOrigin: 'http://localhost:51220' });
    await pending;

    expect(onceCalledBeforeLoadResolved).toBe(true);
    const window = env.windows[0];
    if (!window) throw new Error('expected window to be created');

    // dom-ready callback sends the deep-link event.
    expect((window.webContents.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    window.fireDomReady();
    const sendCalls = (window.webContents.send as ReturnType<typeof vi.fn>).mock.calls;
    const deepLinkCall = sendCalls.find((c) => c[0] === 'ok:deep-link');
    expect(deepLinkCall).toBeDefined();
    expect(deepLinkCall?.[1]).toEqual({
      doc: 'notes/meeting',
      kind: 'doc',
      branch: null,
      multiCandidate: false,
    });
  });

  test('spawn path: no pendingDeepLinkTarget → no ok:deep-link event fires on dom-ready', async () => {
    const wm = new WindowManager(env.deps);
    const pending = wm.createProjectWindow({ projectPath: '/tmp/no-deep-link' });
    env.utilities[0]?.fire({ type: 'ready', port: 51221, apiOrigin: 'http://localhost:51221' });
    await pending;

    const window = env.windows[0];
    if (!window) throw new Error('expected window to be created');
    window.fireDomReady();
    const sendCalls = (window.webContents.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(sendCalls.find((c) => c[0] === 'ok:deep-link')).toBeUndefined();
  });

  test('attach path: pendingDeepLinkTarget also fires on dom-ready', async () => {
    // Attach mode skips utility fork but still mounts a renderer, so the
    // dom-ready gate applies symmetrically.
    const liveLock: ServerLockMetadataLike = {
      pid: 65793,
      hostname: 'my-host',
      port: 59600,
      startedAt: '2026-04-21T10:00:00.000Z',
      worktreeRoot: '/tmp/attach-deep-link',
      kind: 'interactive',
      capabilities: ['http', 'ws'],
    };
    env.deps.readServerLock = () => liveLock;
    env.deps.isProcessAlive = () => true;
    env.deps.hostname = () => 'my-host';
    env.deps.probeWsUpgrade = () => Promise.resolve(true);

    const wm = new WindowManager(env.deps);
    const ctx = await wm.createProjectWindow({
      projectPath: '/tmp/attach-deep-link',
      pendingDeepLinkTarget: { kind: 'doc', path: 'attached/note' },
    });
    expect(ctx.ownsServer).toBe(false);

    const window = env.windows[0];
    if (!window) throw new Error('expected window to be created');
    window.fireDomReady();
    const sendCalls = (window.webContents.send as ReturnType<typeof vi.fn>).mock.calls;
    const deepLinkCall = sendCalls.find((c) => c[0] === 'ok:deep-link');
    expect(deepLinkCall).toBeDefined();
    expect(deepLinkCall?.[1]).toEqual({
      doc: 'attached/note',
      kind: 'doc',
      branch: null,
      multiCandidate: false,
    });
  });

  test('spawn path: pendingBranch threads into the deep-link payload alongside the doc', async () => {
    // Regression: branch from the share URL rides on the same
    // `ok:deep-link` event so the renderer can detect mismatches. Includes
    // a slashed branch (`feat/foo`) to lock the encoding contract.
    const wm = new WindowManager(env.deps);
    const pending = wm.createProjectWindow({
      projectPath: '/tmp/branch-aware-spawn',
      pendingDeepLinkTarget: { kind: 'doc', path: 'docs/page.md' },
      pendingBranch: 'feat/foo',
    });
    env.utilities[0]?.fire({ type: 'ready', port: 51222, apiOrigin: 'http://localhost:51222' });
    await pending;

    const window = env.windows[0];
    if (!window) throw new Error('expected window to be created');
    window.fireDomReady();
    const sendCalls = (window.webContents.send as ReturnType<typeof vi.fn>).mock.calls;
    const deepLinkCall = sendCalls.find((c) => c[0] === 'ok:deep-link');
    expect(deepLinkCall?.[1]).toEqual({
      doc: 'docs/page.md',
      kind: 'doc',
      branch: 'feat/foo',
      multiCandidate: false,
    });
  });

  test('attach path: pendingBranch threads through to the deep-link payload', async () => {
    const liveLock: ServerLockMetadataLike = {
      pid: 65794,
      hostname: 'my-host',
      port: 59601,
      startedAt: '2026-04-21T10:00:00.000Z',
      worktreeRoot: '/tmp/attach-branch',
      kind: 'interactive',
      capabilities: ['http', 'ws'],
    };
    env.deps.readServerLock = () => liveLock;
    env.deps.isProcessAlive = () => true;
    env.deps.hostname = () => 'my-host';
    env.deps.probeWsUpgrade = () => Promise.resolve(true);

    const wm = new WindowManager(env.deps);
    await wm.createProjectWindow({
      projectPath: '/tmp/attach-branch',
      pendingDeepLinkTarget: { kind: 'doc', path: 'attached/note' },
      pendingBranch: 'release/v2',
    });

    const window = env.windows[0];
    if (!window) throw new Error('expected window to be created');
    window.fireDomReady();
    const sendCalls = (window.webContents.send as ReturnType<typeof vi.fn>).mock.calls;
    const deepLinkCall = sendCalls.find((c) => c[0] === 'ok:deep-link');
    expect(deepLinkCall?.[1]).toEqual({
      doc: 'attached/note',
      kind: 'doc',
      branch: 'release/v2',
      multiCandidate: false,
    });
  });

  test('spawn path: pendingDeepLinkTarget threads the folder kind into the deep-link payload', async () => {
    // Folder-share receivers carry `kind: 'folder'`; the path string rides on
    // `doc` for both kinds today (the renderer hash-setter is made kind-aware
    // in a sibling story).
    const wm = new WindowManager(env.deps);
    const pending = wm.createProjectWindow({
      projectPath: '/tmp/folder-share-spawn',
      pendingDeepLinkTarget: { kind: 'folder', path: 'docs' },
    });
    env.utilities[0]?.fire({ type: 'ready', port: 51223, apiOrigin: 'http://localhost:51223' });
    await pending;

    const window = env.windows[0];
    if (!window) throw new Error('expected window to be created');
    window.fireDomReady();
    const sendCalls = (window.webContents.send as ReturnType<typeof vi.fn>).mock.calls;
    const deepLinkCall = sendCalls.find((c) => c[0] === 'ok:deep-link');
    expect(deepLinkCall?.[1]).toEqual({
      doc: 'docs',
      kind: 'folder',
      branch: null,
      multiCandidate: false,
    });
  });
});

describe('WindowManager — pendingShareBranchSwitch dom-ready gate (US-004)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  test('spawn path: pendingShareBranchSwitch registers dom-ready listener BEFORE loadURL resolves', async () => {
    // Cold-start regression: the share-receive listener installs at renderer
    // module-init, so the send must be registered BEFORE `await loadURL`
    // (which resolves on did-finish-load — past dom-ready). Registering
    // after the await silently drops on a fast load.
    let onceCalledBeforeLoadResolved = false;
    let domReadyRegistrations = 0;
    env.deps.createWindow = () => {
      const w = makeWindow();
      const baseOnce = w.webContents.once as (
        event: 'dom-ready' | 'did-finish-load',
        cb: () => void,
      ) => void;
      w.webContents.once = ((event: 'dom-ready' | 'did-finish-load', cb: () => void) => {
        if (event === 'dom-ready') domReadyRegistrations++;
        baseOnce(event, cb);
      }) as typeof w.webContents.once;
      const baseLoadFile = w.loadFile as () => Promise<void>;
      w.loadFile = vi.fn(async () => {
        onceCalledBeforeLoadResolved = domReadyRegistrations > 0;
        return baseLoadFile();
      }) as typeof w.loadFile;
      env.windows.push(w);
      env.createWindowOpts.push({ additionalArguments: [], title: '' });
      return w;
    };

    const wm = new WindowManager(env.deps);
    const pending = wm.createProjectWindow({
      projectPath: '/tmp/share-branch-switch-spawn',
      pendingShareBranchSwitch: {
        share: {
          owner: 'inkeep',
          repo: 'playbooks',
          branch: 'feature/x',
          path: 'docs/getting-started.md',
          blobUrl: 'https://github.com/inkeep/playbooks/blob/feature/x/docs/getting-started.md',
        },
        projectPath: '/tmp/share-branch-switch-spawn',
        currentBranch: 'main',
      },
    });
    env.utilities[0]?.fire({ type: 'ready', port: 51800, apiOrigin: 'http://localhost:51800' });
    await pending;

    expect(onceCalledBeforeLoadResolved).toBe(true);
    const window = env.windows[0];
    if (!window) throw new Error('expected window to be created');

    // No send fires until dom-ready signal arrives.
    expect(
      (window.webContents.send as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === 'ok:share:received',
      ),
    ).toBeUndefined();

    window.fireDomReady();
    const shareCall = (window.webContents.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'ok:share:received',
    );
    expect(shareCall).toBeDefined();
    expect(shareCall?.[1]).toEqual({
      kind: 'project-branch-switch',
      share: {
        owner: 'inkeep',
        repo: 'playbooks',
        branch: 'feature/x',
        path: 'docs/getting-started.md',
        blobUrl: 'https://github.com/inkeep/playbooks/blob/feature/x/docs/getting-started.md',
      },
      projectPath: '/tmp/share-branch-switch-spawn',
      currentBranch: 'main',
    });
  });

  test('spawn path: no pendingShareBranchSwitch → no ok:share:received event fires on dom-ready', async () => {
    const wm = new WindowManager(env.deps);
    const pending = wm.createProjectWindow({ projectPath: '/tmp/no-share-branch-switch' });
    env.utilities[0]?.fire({ type: 'ready', port: 51801, apiOrigin: 'http://localhost:51801' });
    await pending;

    const window = env.windows[0];
    if (!window) throw new Error('expected window to be created');
    window.fireDomReady();
    const sendCalls = (window.webContents.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(sendCalls.find((c) => c[0] === 'ok:share:received')).toBeUndefined();
  });

  test('attach path: pendingShareBranchSwitch also fires on dom-ready', async () => {
    // Attach mode skips utility fork but still mounts a renderer, so the
    // share-receive gate applies symmetrically — same regression class as
    // the spawn path. A user who already has the project open via `ok start`
    // shares to a branch-mismatched project: branch-switch payload must
    // still land on the editor renderer. The `onceCalledBeforeLoadResolved`
    // tracking mirrors the spawn-path test so a refactor moving the
    // dom-ready registration to after `await loadURL` fails this test on
    // a fast load instead of silently dropping the payload.
    let onceCalledBeforeLoadResolved = false;
    let domReadyRegistrations = 0;
    env.deps.createWindow = () => {
      const w = makeWindow();
      const baseOnce = w.webContents.once as (
        event: 'dom-ready' | 'did-finish-load',
        cb: () => void,
      ) => void;
      w.webContents.once = ((event: 'dom-ready' | 'did-finish-load', cb: () => void) => {
        if (event === 'dom-ready') domReadyRegistrations++;
        baseOnce(event, cb);
      }) as typeof w.webContents.once;
      const baseLoadFile = w.loadFile as () => Promise<void>;
      w.loadFile = vi.fn(async () => {
        onceCalledBeforeLoadResolved = domReadyRegistrations > 0;
        return baseLoadFile();
      }) as typeof w.loadFile;
      env.windows.push(w);
      env.createWindowOpts.push({ additionalArguments: [], title: '' });
      return w;
    };
    const liveLock: ServerLockMetadataLike = {
      pid: 65802,
      hostname: 'my-host',
      port: 59700,
      startedAt: '2026-06-01T10:00:00.000Z',
      worktreeRoot: '/tmp/attach-share-branch-switch',
      kind: 'interactive',
      capabilities: ['http', 'ws'],
    };
    env.deps.readServerLock = () => liveLock;
    env.deps.isProcessAlive = () => true;
    env.deps.hostname = () => 'my-host';
    env.deps.probeWsUpgrade = () => Promise.resolve(true);

    const wm = new WindowManager(env.deps);
    const ctx = await wm.createProjectWindow({
      projectPath: '/tmp/attach-share-branch-switch',
      pendingShareBranchSwitch: {
        share: {
          owner: 'inkeep',
          repo: 'attached-repo',
          branch: 'feat/x',
          path: 'notes.md',
          blobUrl: 'https://github.com/inkeep/attached-repo/blob/feat/x/notes.md',
        },
        projectPath: '/tmp/attach-share-branch-switch',
        currentBranch: 'main',
      },
    });
    expect(ctx.ownsServer).toBe(false);
    expect(onceCalledBeforeLoadResolved).toBe(true);

    const window = env.windows[0];
    if (!window) throw new Error('expected window to be created');
    window.fireDomReady();
    const shareCall = (window.webContents.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'ok:share:received',
    );
    expect(shareCall).toBeDefined();
    expect(shareCall?.[1]).toEqual({
      kind: 'project-branch-switch',
      share: {
        owner: 'inkeep',
        repo: 'attached-repo',
        branch: 'feat/x',
        path: 'notes.md',
        blobUrl: 'https://github.com/inkeep/attached-repo/blob/feat/x/notes.md',
      },
      projectPath: '/tmp/attach-share-branch-switch',
      currentBranch: 'main',
    });
  });
});

describe('WindowManager.getWindowFor — canonicalization symmetry with focusWindowForProject', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  test('returns the window when caller passes a non-canonical path', async () => {
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/canon-get' });
    env.utilities[0]?.fire({ type: 'ready', port: 51300, apiOrigin: 'http://localhost:51300' });
    const ctx = await p;

    // Without canonicalization, `/tmp/canon-get/.` would not match the key
    // `/tmp/canon-get` stored at spawn time — introducing an asymmetry with
    // `focusWindowForProject` that already resolves its input.
    expect(wm.getWindowFor('/tmp/canon-get/.')).toBe(ctx);
  });
});

describe('WindowManager — show-gate integration', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  test('spawn-path createProjectWindow registers the new window with showGate (kind=editor)', async () => {
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/show-gate-spawn' });
    env.utilities[0]?.fire({ type: 'ready', port: 51400, apiOrigin: 'http://localhost:51400' });
    const ctx = await p;

    expect(env.showGateRegistrations).toHaveLength(1);
    const reg = env.showGateRegistrations[0];
    expect(reg?.window).toBe(ctx.window);
    expect(reg?.kind).toBe('editor');
    expect(reg?.disposed).toBe(false);
  });

  test('attach-path createProjectWindow registers the new window with showGate (kind=editor)', async () => {
    env.deps.readServerLock = () => ({
      pid: 9001,
      hostname: 'test-host',
      port: 51500,
      startedAt: '2026-05-07T00:00:00Z',
      worktreeRoot: '/tmp/attach-gate',
      kind: 'interactive',
      capabilities: ['http', 'ws'],
    });
    env.deps.isProcessAlive = () => true;
    env.deps.hostname = () => 'test-host';
    env.deps.probeWsUpgrade = () => Promise.resolve(true);

    const wm = new WindowManager(env.deps);
    const ctx = await wm.createProjectWindow({ projectPath: '/tmp/attach-gate' });

    // Attach path: no utility forked (sibling owns the server).
    expect(env.utilities).toHaveLength(0);
    expect(env.showGateRegistrations).toHaveLength(1);
    const reg = env.showGateRegistrations[0];
    expect(reg?.window).toBe(ctx.window);
    expect(reg?.kind).toBe('editor');
  });

  test('show-gate registration is disposed when the window closes (spawn path)', async () => {
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/dispose-spawn' });
    env.utilities[0]?.fire({ type: 'ready', port: 51410, apiOrigin: 'http://localhost:51410' });
    await p;

    const win = env.windows[0];
    if (!win) throw new Error('window not created');
    expect(env.showGateRegistrations[0]?.disposed).toBe(false);
    win.fireClose();
    expect(env.showGateRegistrations[0]?.disposed).toBe(true);
  });

  test('show-gate registration is disposed when the window closes (attach path)', async () => {
    env.deps.readServerLock = () => ({
      pid: 9002,
      hostname: 'test-host',
      port: 51510,
      startedAt: '2026-05-07T00:00:00Z',
      worktreeRoot: '/tmp/dispose-attach',
      kind: 'interactive',
      capabilities: ['http', 'ws'],
    });
    env.deps.isProcessAlive = () => true;
    env.deps.hostname = () => 'test-host';
    env.deps.probeWsUpgrade = () => Promise.resolve(true);

    const wm = new WindowManager(env.deps);
    await wm.createProjectWindow({ projectPath: '/tmp/dispose-attach' });

    const win = env.windows[0];
    if (!win) throw new Error('window not created');
    expect(env.showGateRegistrations[0]?.disposed).toBe(false);
    win.fireClose();
    expect(env.showGateRegistrations[0]?.disposed).toBe(true);
  });

  test('window-manager no longer schedules its own ready-to-show 5_000ms timer (gate owns timeout)', async () => {
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/no-direct-timer' });
    env.utilities[0]?.fire({ type: 'ready', port: 51420, apiOrigin: 'http://localhost:51420' });
    await p;

    // The show-gate now owns the ready-to-show 5_000ms timeout — so no
    // 5_000ms timer should appear in env.timers from window-manager itself.
    // Other timers (post-exit liveness probe at 1_000ms, etc.) may still
    // appear but are unrelated.
    const fiveSecondTimers = env.timers.filter((t) => t.ms === 5_000);
    expect(fiveSecondTimers).toHaveLength(0);
  });
});
