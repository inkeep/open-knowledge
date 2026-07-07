import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
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
    focus: mock(() => {}),
    show: mock(() => {
      visible = true;
    }),
    restore: mock(() => {
      minimized = false;
    }),
    isMinimized: mock(() => minimized),
    moveTop: mock(() => {}),
    isFocused: mock(() => opts?.focused ?? false),
    isDestroyed: mock(() => destroyed),
    isVisible: mock(() => visible),
    on: mock((_event: 'closed', cb: () => void) => {
      closeHandlers.push(cb);
    }) as BrowserWindowLike['on'],
    once: mock((_event: 'ready-to-show', _cb: () => void) => {}) as BrowserWindowLike['once'],
    close: mock(() => {
      destroyed = true;
      fireClose();
    }),
    destroy: mock(() => {
      destroyed = true;
      fireClose();
    }),
    webContents: {
      send: mock(() => {}),
      once: mock((event: 'dom-ready' | 'did-finish-load', cb: () => void) => {
        if (event === 'dom-ready') domReadyHandler = cb;
        else if (event === 'did-finish-load') didFinishLoadHandler = cb;
      }),
    },
    loadFile: mock(() => Promise.resolve()),
    loadURL: mock(() => Promise.resolve()),
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
  createWindowOpts: Array<{ additionalArguments: string[]; title: string }>;
  forkUtilityArgs: string[][];
  timers: Array<{ cb: () => void; ms: number }>;
  killProbe: ReturnType<typeof mock>;
  activateApp: ReturnType<typeof mock>;
  showGateRegistrations: ShowGateRegistration[];
  deps: WindowManagerDeps;
}

function buildEnv(): TestEnv {
  const utilities: MockUtility[] = [];
  const windows: Array<ReturnType<typeof makeWindow>> = [];
  const createWindowOpts: Array<{ additionalArguments: string[]; title: string }> = [];
  const forkUtilityArgs: string[][] = [];
  const timers: Array<{ cb: () => void; ms: number }> = [];
  const killProbe = mock(() => {});
  const activateApp = mock(() => {});
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
        host: 'localhost',
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
        host: 'localhost',
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
    env.killProbe = mock(() => {
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
    const runClean = mock(() => Promise.resolve());
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
    utility.postMessage = mock(() => {
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
      const runClean = mock(() => Promise.resolve());
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
    });

    function driftSends(w: ReturnType<typeof makeWindow>): unknown[] {
      return (w.webContents.send as ReturnType<typeof mock>).mock.calls.filter(
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
      const killProbe = mock((_pid: number, signal: string) => {
        if (signal === 'SIGTERM') killed = true;
      });
      enableAttachProbe({
        readServerLock: () => (spawned ? freshLock : killed ? null : oldLock),
      });
      env.deps.killProbe = killProbe;
      env.deps.spawnDetachedServer = async () => {
        spawned = true;
        return { pid: 6666 };
      };

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

      // Same-version respawn → no drift notification on the new window.
      const newWindow = env.windows[1];
      if (!newWindow) throw new Error('no recreated window');
      newWindow.fireDomReady();
      expect(driftSends(newWindow).length).toBe(0);
      // The recreated window confirms the restart on did-finish-load.
      newWindow.fireDidFinishLoad();
      const restartedSends = (
        newWindow.webContents.send as ReturnType<typeof mock>
      ).mock.calls.filter((c: unknown[]) => c[0] === 'ok:server-restarted');
      expect(restartedSends.length).toBe(1);
      expect((restartedSends[0] as unknown[])[1]).toEqual({ appRuntime: '0.8.2' });
    });

    test('restartAttachedServer returns eperm without recreating when the kill is blocked', async () => {
      const lockWithPid = { ...liveLock, pid: 7777, protocolVersion: 1, runtimeVersion: '0.8.0' };
      env.deps.readServerLock = () => lockWithPid;
      env.deps.killProbe = mock(() => {
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

    test('restartAttachedServer keeps the originating window alive when the respawn fails', async () => {
      // Kill succeeds, but the fresh spawn never comes up — the originating
      // window must survive so its invoke resolves with the failure and the
      // renderer can surface the remedy on a window that still exists.
      env.deps.selfProtocolVersion = 1;
      env.deps.selfRuntimeVersion = '0.8.2';
      let killed = false;
      const oldLock = { ...liveLock, pid: 5555, protocolVersion: 1, runtimeVersion: '0.8.0' };
      enableAttachProbe({ readServerLock: () => (killed ? null : oldLock) });
      env.deps.killProbe = mock((_pid: number, signal: string) => {
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
      expect((originating.close as ReturnType<typeof mock>).mock.calls.length).toBe(0);
      expect(originating.isDestroyed?.()).toBe(false);
      expect(wm.getContextForBrowserWindow(originating as BrowserWindowLike)?.projectPath).toBe(
        '/tmp/dragon',
      );
      // No second window was created (the spawn threw before window creation).
      expect(env.windows.length).toBe(1);
    });

    test('reclaimForeignServerInDev terminates a foreign server and spawns fresh via utility-fork, firing ok:server-reclaimed on did-finish-load', async () => {
      env.deps.reclaimForeignServerInDev = true;
      let killed = false;
      const killProbe = mock((_pid: number, signal: string) => {
        if (signal === 'SIGTERM') killed = true;
      });
      env.deps.killProbe = killProbe;
      // Foreign lock at attach-decision time; gone right after SIGTERM so the
      // terminate poll returns on its first check (the env setTimeout never
      // fires, so a poll that had to sleep would hang the test).
      enableAttachProbe({ readServerLock: () => (killed ? null : liveLock) });

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
      const reclaimSends = () =>
        (w.webContents.send as ReturnType<typeof mock>).mock.calls.filter(
          (c: unknown[]) => c[0] === 'ok:server-reclaimed',
        );
      // Must arrive on did-finish-load (sonner mounted), NOT dom-ready — a
      // regression dropping `{ event: 'did-finish-load' }` would deliver before
      // the toast subscriber mounts and silently lose the notice. Mirror the
      // drift-test ordering: dom-ready → still 0, did-finish-load → 1.
      expect(reclaimSends().length).toBe(0);
      w.fireDomReady();
      expect(reclaimSends().length).toBe(0);
      w.fireDidFinishLoad();
      expect(reclaimSends().length).toBe(1);
      expect((reclaimSends()[0] as unknown[])[1]).toEqual({ appRuntime: '9.9.9-test' });
    });

    test('without reclaimForeignServerInDev (production default), a foreign server is attached — no termination, no reclaim notice', async () => {
      const killProbe = mock(() => {});
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
      const reclaimSends = (w.webContents.send as ReturnType<typeof mock>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'ok:server-reclaimed',
      );
      expect(reclaimSends.length).toBe(0);
    });

    test('reclaim does NOT terminate a server THIS session spawned (own-pid guard)', async () => {
      // A combination production never uses (dev never wires detached spawn),
      // but the pid guard must hold if a future build does: a same-session
      // reopen that attaches to OUR OWN detached server must not be reclaimed.
      env.deps.reclaimForeignServerInDev = true;
      const killProbe = mock(() => {});
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
      env.deps.killProbe = mock(() => {
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
      const reclaimSends = (w.webContents.send as ReturnType<typeof mock>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'ok:server-reclaimed',
      );
      expect(reclaimSends.length).toBe(0);
    });

    test('stale lock (pid dead) falls through to spawn mode', async () => {
      enableAttachProbe({ isProcessAlive: () => false });
      const runClean = mock(() => Promise.resolve());
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

        const spawn = mock(() => Promise.resolve({ pid: 88001 }));
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

      test('attach-eligible lock pre-empts detached spawn (does NOT spawn a duplicate)', async () => {
        enableSyncTimers();
        // An attachable lock is already present — the desktop attaches rather
        // than spawning its own detached server. spawnDetachedServer must NOT
        // be called.
        env.deps.readServerLock = () => spawnedLock;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        const spawn = mock(() => Promise.resolve({ pid: 99 }));
        env.deps.spawnDetachedServer = spawn;

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' });

        expect(spawn).not.toHaveBeenCalled();
        expect(ctx.port).toBe(60111);
      });
    });

    describe('keepalive lifecycle (FR4)', () => {
      function makeKeepaliveMock() {
        const calls: Array<{ lockDir: string }> = [];
        const handles: Array<{ closed: boolean }> = [];
        const create = mock((opts: { lockDir: string }) => {
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
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        let nextSpawnPid = 91001;
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: nextSpawnPid++ });

        // Inject killProbe so we record signals + simulate lock release.
        // The dep is already wired in WindowManagerDeps (used by the
        // post-exit liveness probe + now also by stopAllOwnedServers
        // and the spawn-lock-timeout orphan cleanup) — cleaner than
        // monkey-patching node:process.kill.
        const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
        env.deps.killProbe = (pid: number, signal: NodeJS.Signals | 0) => {
          killCalls.push({ pid, signal });
          // Simulate the server reacting to SIGTERM by releasing its lock.
          if (signal === 'SIGTERM') {
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
      const probe = mock(() => Promise.resolve(false));
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
      const probe = mock(() => Promise.reject(new Error('socket refused')));
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
      w.loadFile = mock(async () => {
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
    expect((window.webContents.send as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    window.fireDomReady();
    const sendCalls = (window.webContents.send as ReturnType<typeof mock>).mock.calls;
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
    const sendCalls = (window.webContents.send as ReturnType<typeof mock>).mock.calls;
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
    const sendCalls = (window.webContents.send as ReturnType<typeof mock>).mock.calls;
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
    const sendCalls = (window.webContents.send as ReturnType<typeof mock>).mock.calls;
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
    const sendCalls = (window.webContents.send as ReturnType<typeof mock>).mock.calls;
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
    const sendCalls = (window.webContents.send as ReturnType<typeof mock>).mock.calls;
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
      w.loadFile = mock(async () => {
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
      (window.webContents.send as ReturnType<typeof mock>).mock.calls.find(
        (c) => c[0] === 'ok:share:received',
      ),
    ).toBeUndefined();

    window.fireDomReady();
    const shareCall = (window.webContents.send as ReturnType<typeof mock>).mock.calls.find(
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
    const sendCalls = (window.webContents.send as ReturnType<typeof mock>).mock.calls;
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
      w.loadFile = mock(async () => {
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
    const shareCall = (window.webContents.send as ReturnType<typeof mock>).mock.calls.find(
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
