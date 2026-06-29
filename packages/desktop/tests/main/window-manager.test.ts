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

function makeWindow(opts?: { minimized?: boolean }): BrowserWindowLike & {
  fireClose: () => void;
  fireDomReady: () => void;
  fireDidFinishLoad: () => void;
  markDestroyed: () => void;
} {
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
  createWindowOpts: Array<{ additionalArguments: string[]; title: string }>;
  forkUtilityArgs: string[][];
  timers: Array<{ cb: () => void; ms: number }>;
  killProbe: ReturnType<typeof mock>;
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
  const showGateRegistrations: ShowGateRegistration[] = [];
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
        reactShellDistDir: '/fake/renderer',
      },
    });

    utility.fire({ type: 'ready', port: 51234, apiOrigin: 'http://localhost:51234' });

    const ctx = await promise;
    expect(ctx.port).toBe(51234);
    expect(ctx.apiOrigin).toBe('http://localhost:51234');
    expect(ctx.projectName).toBe('test-project');

    expect(env.windows.length).toBe(1);
    expect(env.windows[0]?.loadFile).toHaveBeenCalledWith('/fake/renderer/index.html');
  });

  test('createProjectWindow forwards localOpCliArgs into the utility init IPC payload', async () => {
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

    utility.fire({ type: 'ready', port: 51235, apiOrigin: 'http://localhost:51235' });
    await promise;
  });

  test('createProjectWindow OMITS reactShellDistDir in dev mode (rendererDevUrl set)', async () => {
    const devEnv = buildEnv();
    devEnv.deps.rendererDevUrl = 'http://localhost:5173/';
    const wm = new WindowManager(devEnv.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/dev-mode-project' });

    const utility = devEnv.utilities[0];
    if (!utility) throw new Error('utility not forked');

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
    const wm = new WindowManager(env.deps);
    const p1 = wm.createProjectWindow({ projectPath: '/tmp/destroyable' });
    env.utilities[0]?.fire({ type: 'ready', port: 51100, apiOrigin: 'http://localhost:51100' });
    await p1;

    env.windows[0]?.markDestroyed();

    const p2 = wm.createProjectWindow({ projectPath: '/tmp/destroyable' });
    expect(env.utilities.length).toBe(2);
    env.utilities[1]?.fire({ type: 'ready', port: 51101, apiOrigin: 'http://localhost:51101' });
    const ctx2 = await p2;
    expect(env.windows.length).toBe(2);
    expect(ctx2.port).toBe(51101);
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
    env.utilities[0]?.fireExit(1);
    await expect(promise).rejects.toThrow(/utility exited before ready.*code=1/);
  });

  test('utility stays silent → init times out with actionable error', async () => {
    const fireList: Array<() => void> = [];
    env.deps.setTimeout = (cb, ms) => {
      fireList.push(cb);
      env.timers.push({ cb, ms });
      return null;
    };
    env.deps.utilityInitTimeoutMs = 500;

    const wm = new WindowManager(env.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/stuck' });
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
    expect(() => livenessProbe?.cb()).not.toThrow();
    expect(env.killProbe).toHaveBeenCalledTimes(1);
  });

  test('runClean (when provided) is called before forking utility', async () => {
    const runClean = mock(() => Promise.resolve());
    env.deps.runClean = runClean;
    const wm = new WindowManager(env.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/clean-run' });
    expect(env.utilities.length).toBe(0); // not forked yet
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

    const utility = env.utilities[0];
    if (!utility) throw new Error('utility missing');
    utility.postMessage = mock(() => {
      throw new Error('ERR_IPC_CHANNEL_CLOSED');
    });

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
    expect(observed[0]).toBe(utilityRef);
  });

  test('onUtilityExit is not attached when not provided (no-op for back-compat)', async () => {
    delete env.deps.onUtilityExit;
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/no-exit-hook' });
    env.utilities[0]?.fire({ type: 'ready', port: 52201, apiOrigin: 'http://localhost:52201' });
    await p;
    expect(() => env.utilities[0]?.fireExit(1)).not.toThrow();
  });

  describe('attach mode', () => {
    const liveLock: ServerLockMetadataLike = {
      pid: 65792,
      hostname: 'my-host',
      port: 59534,
      startedAt: '2026-04-17T20:23:20.713Z',
      worktreeRoot: '/tmp/dragon',
      kind: 'interactive',
      capabilities: ['http', 'ws'],
    };

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
      expect(env.windows.length).toBe(2);
      const ctx = wm.getContextForBrowserWindow(env.windows[1] as BrowserWindowLike);
      expect(ctx?.port).toBe(60000);

      const newWindow = env.windows[1];
      if (!newWindow) throw new Error('no recreated window');
      newWindow.fireDomReady();
      expect(driftSends(newWindow).length).toBe(0);
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
      expect(env.windows.length).toBe(0);
      expect(env.utilities.length).toBe(0);
    });

    test('restartAttachedServer keeps the originating window alive when the respawn fails', async () => {
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
      expect((originating.close as ReturnType<typeof mock>).mock.calls.length).toBe(0);
      expect(originating.isDestroyed?.()).toBe(false);
      expect(wm.getContextForBrowserWindow(originating as BrowserWindowLike)?.projectPath).toBe(
        '/tmp/dragon',
      );
      expect(env.windows.length).toBe(1);
    });

    test('reclaimForeignServerInDev terminates a foreign server and spawns fresh via utility-fork, firing ok:server-reclaimed on did-finish-load', async () => {
      env.deps.reclaimForeignServerInDev = true;
      let killed = false;
      const killProbe = mock((_pid: number, signal: string) => {
        if (signal === 'SIGTERM') killed = true;
      });
      env.deps.killProbe = killProbe;
      enableAttachProbe({ readServerLock: () => (killed ? null : liveLock) });

      const wm = new WindowManager(env.deps);
      const promise = wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      for (let i = 0; i < 50 && env.utilities.length === 0; i++) await wait(0);
      expect(killProbe).toHaveBeenCalledWith(65792, 'SIGTERM');
      expect(env.utilities.length).toBe(1);
      env.utilities[0]?.fire({ type: 'ready', port: 52777, apiOrigin: 'http://localhost:52777' });
      const ctx = await promise;

      expect(ctx.ownsServer).toBe(true);
      expect(ctx.port).toBe(52777);

      const w = env.windows[0];
      if (!w) throw new Error('no window created');
      const reclaimSends = () =>
        (w.webContents.send as ReturnType<typeof mock>).mock.calls.filter(
          (c: unknown[]) => c[0] === 'ok:server-reclaimed',
        );
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
      expect(wm.getWindowFor('/tmp/dragon')).toBeUndefined();
    });

    test('closeProjectWindow on attached context returns true, sends no shutdown IPC', async () => {
      enableAttachProbe();
      const wm = new WindowManager(env.deps);
      await wm.createProjectWindow({ projectPath: '/tmp/dragon' });

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
      const wm = new WindowManager(env.deps);
      const p = wm.createProjectWindow({ projectPath: '/tmp/no-probe' });
      await new Promise((r) => setTimeout(r, 5));
      expect(env.utilities.length).toBe(1);
      env.utilities[0]?.fire({ type: 'ready', port: 40005, apiOrigin: 'http://localhost:40005' });
      await p;
    });

    test('mcp-spawned lock attaches in attach mode (no spawn, no SIGTERM)', async () => {
      enableAttachProbe({
        readServerLock: () => ({ ...liveLock, kind: 'mcp-spawned' }),
      });
      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(env.utilities.length).toBe(0);
      expect(ctx.ownsServer).toBe(false);
    });

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

      function enableSyncTimers() {
        env.deps.setTimeout = (cb: () => void, _ms: number) => {
          cb();
          return null;
        };
      }

      test('spawn → poll lock → delegate to attach mode (no utilityProcess.fork)', async () => {
        enableSyncTimers();
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

        expect(spawn).toHaveBeenCalledTimes(1);
        const call = spawn.mock.calls[0]?.[0] as
          | { contentDir: string; reactShellDistDir: string }
          | undefined;
        expect(call?.contentDir).toBe('/tmp/spawned-project');
        expect(call?.reactShellDistDir).toBe('/fake/renderer');

        expect(env.utilities.length).toBe(0);

        expect(ctx.ownsServer).toBe(false);
        expect(ctx.utility).toBeNull();
        expect(ctx.port).toBe(60111);
        expect(ctx.apiOrigin).toBe('http://localhost:60111');
        expect(env.windows.length).toBe(1);
        expect(env.createWindowOpts[0]?.title).toBe('spawned-project — OpenKnowledge');
      });

      test('spawned pid is tracked for stopAllOwnedServers (US-008)', async () => {
        enableSyncTimers();
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

        const pids = (wm as unknown as { spawnedDetachedPids: Map<string, number> })
          .spawnedDetachedPids;
        expect(pids.size).toBe(1);
        expect([...pids.values()]).toEqual([88001]);
      });

      test('lock-poll timeout surfaces spawn-lock-timeout error', async () => {
        enableSyncTimers();
        env.deps.readServerLock = () => null;
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });
        env.deps.spawnLockPollDeadlineMs = 1;

        const wm = new WindowManager(env.deps);
        await expect(
          wm.createProjectWindow({ projectPath: '/tmp/never-binds' }),
        ).rejects.toMatchObject({
          kind: 'spawn-lock-timeout',
          pid: 88001,
        });

        expect(env.windows.length).toBe(0);
        const pids = (wm as unknown as { spawnedDetachedPids: Map<string, number> })
          .spawnedDetachedPids;
        expect(pids.size).toBe(0);
      });

      test('detached-mode window close: no shutdown IPC, no spawn pid removal', async () => {
        enableSyncTimers();
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

        expect(ctx.utility).toBeNull();
        expect(ctx.ownsServer).toBe(false);

        env.windows[0]?.fireClose();
        const pids = (wm as unknown as { spawnedDetachedPids: Map<string, number> })
          .spawnedDetachedPids;
        expect(pids.size).toBe(1);
        expect(env.utilities.length).toBe(0);
      });

      test('attach-eligible lock pre-empts detached spawn (does NOT spawn a duplicate)', async () => {
        enableSyncTimers();
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
        const lockByCwd = new Map<string, ServerLockMetadataLike>();
        lockByCwd.set('/tmp/proj-a/.ok/local', { ...spawnedLock, pid: 91001 });
        lockByCwd.set('/tmp/proj-b/.ok/local', { ...spawnedLock, pid: 91002 });
        let readCounts = new Map<string, number>();
        env.deps.readServerLock = (lockDir) => {
          const n = (readCounts.get(lockDir) ?? 0) + 1;
          readCounts.set(lockDir, n);
          return n === 1 ? null : (lockByCwd.get(lockDir) ?? null);
        };
        env.deps.isProcessAlive = () => true;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        let nextSpawnPid = 91001;
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: nextSpawnPid++ });

        const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
        env.deps.killProbe = (pid: number, signal: NodeJS.Signals | 0) => {
          killCalls.push({ pid, signal });
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
        readCounts = new Map<string, number>();
        await wm.createProjectWindow({ projectPath: '/tmp/proj-b' });

        const pidsBefore = (wm as unknown as { spawnedDetachedPids: Map<string, number> })
          .spawnedDetachedPids;
        expect(pidsBefore.size).toBe(2);

        await wm.stopAllOwnedServers();

        expect(
          killCalls
            .filter((c) => c.signal === 'SIGTERM')
            .map((c) => c.pid)
            .sort(),
        ).toEqual([91001, 91002]);
        expect(killCalls.filter((c) => c.signal === 'SIGKILL')).toHaveLength(0);

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
        env.deps.sigtermGraceMs = 5;

        const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
        env.deps.killProbe = (pid: number, signal: NodeJS.Signals | 0) => {
          killCalls.push({ pid, signal });
        };

        const wm = new WindowManager(env.deps);
        await wm.createProjectWindow({ projectPath: '/tmp/wedged-project' });

        await wm.stopAllOwnedServers();

        const signals = killCalls.filter((c) => c.pid === 91001).map((c) => c.signal);
        expect(signals).toContain('SIGTERM');
        expect(signals).toContain('SIGKILL');
        expect(signals.indexOf('SIGTERM')).toBeLessThan(signals.indexOf('SIGKILL'));
      });

      test('attached-only windows (no spawned pid) are not signaled', async () => {
        enableAttachProbe();
        const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
        env.deps.killProbe = (pid: number, signal: NodeJS.Signals | 0) => {
          killCalls.push({ pid, signal });
        };
        const wm = new WindowManager(env.deps);
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
        await expect(wm.stopAllOwnedServers()).resolves.toBeUndefined();
      });

      test('utility-fork (dev path, ownsServer=true) is SIGKILLed by stopAllOwnedServers', async () => {
        delete env.deps.spawnDetachedServer;
        const wm = new WindowManager(env.deps);
        const p = wm.createProjectWindow({ projectPath: '/tmp/utility-mode' });
        await new Promise<void>((r) => setTimeout(r, 5));
        const utility = env.utilities[0];
        expect(utility).toBeDefined();
        utility?.fire({ type: 'ready', port: 60500, apiOrigin: 'http://localhost:60500' });
        await p;

        await wm.stopAllOwnedServers();

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
      env.deps.readServerLock = () => liveLock;
      env.deps.isProcessAlive = () => true;
      env.deps.hostname = () => 'my-host';
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

  test('canonicalizes project path before lookup (resolve equivalence)', async () => {
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/canon' });
    env.utilities[0]?.fire({ type: 'ready', port: 51202, apiOrigin: 'http://localhost:51202' });
    await p;

    expect(wm.focusWindowForProject('/tmp/canon/.')).not.toBeNull();
  });

  test('realpath canonicalization: open via symlink, focus via realpath matches', async () => {
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

    const found = wm.focusWindowForProject('/Users/me/projects/dragon');
    expect(found).toBe(ctx.window);
    expect(ctx.window.focus).toHaveBeenCalled();
    expect(wm.getWindowFor('/Users/me/projects/dragon')).toBe(ctx);
    expect(ctx.canonicalKey).toBe('/Users/me/projects/dragon');
    expect(ctx.projectPath).toBe('/Users/me/workspaces/dragon');
  });

  test('realpathSync throws (ENOENT) → falls back to resolve(projectPath)', async () => {
    env.deps.realpathSync = () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/ghost-path' });
    env.utilities[0]?.fire({ type: 'ready', port: 51211, apiOrigin: 'http://localhost:51211' });
    const ctx = await p;
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

    const fiveSecondTimers = env.timers.filter((t) => t.ms === 5_000);
    expect(fiveSecondTimers).toHaveLength(0);
  });
});
