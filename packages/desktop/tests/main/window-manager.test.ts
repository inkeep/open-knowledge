import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { DEFAULT_SERVER_HOST, formatSpawnAttemptHeader } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { breakServerLockHeldBy } from '../../src/main/server-lock-break.ts';
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

function makeWindow(opts?: { minimized?: boolean; focused?: boolean }): BrowserWindowLike & {
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
    focus: vi.fn(() => {}),
    show: vi.fn(() => {
      visible = true;
    }),
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
    const wm = new WindowManager(env.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/dragon-wiki' });
    env.utilities[0]?.fire({ type: 'ready', port: 52010, apiOrigin: 'http://localhost:52010' });
    const ctx = await promise;
    expect(env.createWindowOpts[0]?.projectPath).toBe(ctx.projectPath);
  });

  test('createProjectWindow injects --ok-fresh-create=1 only when freshlyCreated is set', async () => {
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

  test('createProjectWindow binds the utility server to numeric IPv4 loopback, never a hostname', async () => {
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
        host: '127.0.0.1',
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
    expect(() => livenessProbe?.cb()).not.toThrow();
    expect(env.killProbe).toHaveBeenCalledTimes(1);
  });

  test('runClean (when provided) is called before forking utility', async () => {
    const runClean = vi.fn(() => Promise.resolve());
    env.deps.runClean = runClean;
    const wm = new WindowManager(env.deps);
    const promise = wm.createProjectWindow({ projectPath: '/tmp/clean-run' });
    expect(env.utilities.length).toBe(0);
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

  test('closeProjectWindow swallows postMessage errors', async () => {
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/detached-port' });
    env.utilities[0]?.fire({ type: 'ready', port: 51099, apiOrigin: 'http://localhost:51099' });
    await p;

    const utility = env.utilities[0];
    if (!utility) throw new Error('utility missing');
    utility.postMessage = vi.fn(() => {
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

  test('getContextForBrowserWindow resolves a window whose renderer is still loading', async () => {
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
    expect(wm.getContextForBrowserWindow(loading)).toBe(settled);
  });

  test('a window whose renderer load rejects stops resolving to a project', async () => {
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
      expect(env.createWindowOpts[0]?.title).toBe('dragon — OpenKnowledge');
      expect(env.createWindowOpts[0]?.projectPath).toBe(ctx.projectPath);
    });

    test('an attach-mode window resolves to its project while its renderer loads', async () => {
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
      enableAttachProbe();
      const wm = new WindowManager(env.deps);
      const ctx = await wm.createProjectWindow({
        projectPath: '/tmp/dragon',
        freshlyCreated: true,
      });
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

    test('attach consumes the v2 advertisement end-to-end — probe + renderer args derive from url', async () => {
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
      expect(probed).toEqual(['ws://[::1]:59534/collab/__attach_probe__']);
      const args = env.createWindowOpts[0]?.additionalArguments ?? [];
      expect(args).toContain('--ok-api-origin=http://[::1]:59534');
      expect(args).toContain('--ok-collab-url=ws://[::1]:59534/collab');
    });

    test('pre-v2 lock (no url) attaches with the localhost:<port> fallback end-to-end', async () => {
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
      enableAttachProbe();
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
      const killProbe = vi.fn((_pid: number, signal: string) => {
        if (signal === 'SIGTERM') killed = true;
      });
      enableAttachProbe({
        readServerLock: () => (spawned ? freshLock : killed ? null : oldLock),
        isProcessAlive: (pid) => (pid === 5555 ? !killed : true),
      });
      env.deps.killProbe = killProbe;
      env.deps.spawnDetachedServer = async () => {
        spawned = true;
        return { pid: 6666 };
      };

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
      expect(env.windows.length).toBe(2);
      const ctx = wm.getContextForBrowserWindow(env.windows[1] as BrowserWindowLike);
      expect(ctx?.port).toBe(60000);

      expect(restarted).toHaveLength(1);
      expect(restarted[0]?.projectPath).toBe('/tmp/dragon');
      expect(restarted[0]?.apiOrigin).toContain('60000');

      const newWindow = env.windows[1];
      if (!newWindow) throw new Error('no recreated window');
      newWindow.fireDomReady();
      expect(driftSends(newWindow).length).toBe(0);
      newWindow.fireDidFinishLoad();
      const restartedSends = (
        newWindow.webContents.send as ReturnType<typeof vi.fn>
      ).mock.calls.filter((c: unknown[]) => c[0] === 'ok:server-restarted');
      expect(restartedSends.length).toBe(1);
      expect((restartedSends[0] as unknown[])[1]).toEqual({ appRuntime: '0.8.2' });
    });

    test('a note-window recreate hook that throws does not fail the restart or strand the old window', async () => {
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
      expect(outcome).toEqual({ ok: true });
      expect(env.windows.length).toBe(2);
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
      expect(env.windows.length).toBe(0);
      expect(env.utilities.length).toBe(0);
    });

    test('restartAttachedServer breaks a stale lock whose unkillable holder serves nothing', async () => {
      env.deps.setTimeout = (cb: () => void, _ms: number) => {
        cb();
        return null;
      };
      const STALE_PID = 870;
      const FRESH_PID = 22018;
      const staleLock = { ...liveLock, pid: STALE_PID, port: 42117 };
      const freshLock = { ...liveLock, pid: FRESH_PID, port: 60222 };
      let spawned = false;
      env.deps.readServerLock = () => (spawned ? freshLock : staleLock);
      env.deps.isProcessAlive = () => true;
      env.deps.hostname = () => 'my-host';
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

      expect(outcome).not.toEqual({ ok: false, reason: 'eperm' });
      expect(outcome).toEqual({ ok: true });
      expect(env.windows.length).toBe(1);
      const ctx = wm.getContextForBrowserWindow(env.windows[0] as BrowserWindowLike);
      expect(ctx?.port).toBe(60222);
      expect(removeServerLock).toHaveBeenCalledTimes(1);
      expect(removeServerLock.mock.calls[0]?.[0]).toMatch(/[/\\]\.ok[/\\]local$/);
      expect(removeServerLock.mock.calls[0]?.[0]).toContain('/tmp/dragon');
      expect(removeServerLock.mock.calls[0]?.[1]).toEqual({ pid: STALE_PID });
    });

    test('restartAttachedServer survives a removeServerLock that throws', async () => {
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

    test('restartAttachedServer does not proceed when the break is declined', async () => {
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
      expect(outcome).toEqual({ ok: false, reason: 'eperm' });
      expect(removeServerLock).not.toHaveBeenCalled();
    });

    test('restartAttachedServer leaves the lock alone when the holder has not bound a port', async () => {
      env.deps.setTimeout = (cb: () => void, _ms: number) => {
        cb();
        return null;
      };
      const removeServerLock = vi.fn(() => true);
      env.deps.removeServerLock = removeServerLock;
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
      expect(probe).not.toHaveBeenCalled();
    });

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
      const probe = vi.fn(() => Promise.resolve(true));
      env.deps.probeWsUpgrade = probe;
      env.deps.killProbe = vi.fn(() => {
        throw Object.assign(new Error('eperm'), { code: 'EPERM' });
      });

      const wm = new WindowManager(env.deps);
      const outcome = await wm.restartAttachedServer('/tmp/dragon');

      expect(outcome).toEqual({ ok: false, reason: 'eperm' });
      expect(removeServerLock).not.toHaveBeenCalled();
      expect(probe).toHaveBeenCalled();
      expect(probe.mock.calls[0]?.[0]).toContain('42117');
    });

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

    test('restartAttachedServer does not break a lock when termination failed for a non-EPERM reason', async () => {
      const removeServerLock = vi.fn(() => true);
      env.deps.removeServerLock = removeServerLock;
      env.deps.readServerLock = () => ({ ...liveLock, pid: 5150, port: 42117 });
      env.deps.isProcessAlive = () => true;
      env.deps.hostname = () => 'my-host';
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
      env.deps.probeWsUpgrade = () => Promise.resolve(true);
      env.deps.killProbe = vi.fn(() => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      });
      env.deps.spawnDetachedServer = spawn;

      const wm = new WindowManager(env.deps);
      const outcome = await wm.restartAttachedServer('/tmp/dragon');

      expect(outcome).toEqual({ ok: false, reason: 'eperm' });
      expect(spawn).not.toHaveBeenCalled();
      expect(env.windows.length).toBe(0);
      expect(env.utilities.length).toBe(0);
    });

    test('restartAttachedServer keeps the originating window alive when the respawn fails', async () => {
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
      expect((originating.close as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
      expect(originating.isDestroyed?.()).toBe(false);
      expect(wm.getContextForBrowserWindow(originating as BrowserWindowLike)?.projectPath).toBe(
        '/tmp/dragon',
      );
      expect(env.windows.length).toBe(1);
    });

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
      const parked = parkedRestart();
      const wm = new WindowManager(env.deps);
      const attached = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      const originating = env.windows[0];
      if (!originating) throw new Error('no originating window');

      const restart = wm.restartAttachedServer('/tmp/dragon');
      await parked.awaitParked();

      expect(wm.getContextForBrowserWindow(originating as BrowserWindowLike)).toBe(attached);

      parked.release();
      await expect(restart).resolves.toEqual({ ok: true });
    });

    test('a completed restart leaves no entry behind for the window it closed', async () => {
      const parked = parkedRestart();
      const wm = new WindowManager(env.deps);
      await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      const originating = env.windows[0];
      if (!originating) throw new Error('no originating window');

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
      expect(closeTimeAnswer).toBeUndefined();
      const recreated = env.windows[1];
      if (!recreated) throw new Error('no recreated window');
      expect(wm.getContextForBrowserWindow(recreated as BrowserWindowLike)?.port).toBe(60000);
    });

    test('a failed restart whose window survives releases on the later close', async () => {
      const parked = parkedRestart();
      const wm = new WindowManager(env.deps);
      await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      const originating = env.windows[0];
      if (!originating) throw new Error('no originating window');

      const restart = wm.restartAttachedServer('/tmp/dragon');
      await parked.awaitParked();
      parked.fail(new Error('spawn failed to bind'));
      await expect(restart).resolves.toEqual({ ok: false, reason: 'other' });

      expect(wm.getContextForBrowserWindow(originating as BrowserWindowLike)?.projectPath).toBe(
        '/tmp/dragon',
      );

      originating.fireClose();
      expect(wm.getContextForBrowserWindow(originating as BrowserWindowLike)).toBeUndefined();
    });

    test('a failed restart whose window died meanwhile leaves no entry behind', async () => {
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
      enableAttachProbe({
        readServerLock: () => (killed ? null : liveLock),
        isProcessAlive: () => !killed,
      });

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

      expect(killProbe).toHaveBeenCalledWith(5555, 'SIGTERM');
      expect(ctx.port).toBe(60000);
      expect(env.windows.length).toBe(1);

      const w = env.windows[0];
      if (!w) throw new Error('no window created');
      w.fireDomReady();
      expect(driftSends(w).length).toBe(0);
      w.fireDidFinishLoad();
      const restartedSends = (w.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'ok:server-restarted',
      );
      expect(restartedSends.length).toBe(0);
    });

    test('upgrade reconcile also fires for a NEWER survivor (any drift direction qualifies)', async () => {
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
      expect(ctx.ownsServer).toBe(false);
      expect(ctx.port).toBe(59534);
      expect(killProbe).not.toHaveBeenCalled();
      expect(env.utilities.length).toBe(0);
      const w = env.windows[0];
      if (!w) throw new Error('no window created');
      w.fireDomReady();
      expect(driftSends(w).length).toBe(0);
    });

    test('a drifted server is left attached (manual prompt) when NOT the first launch after upgrade', async () => {
      env.deps.selfProtocolVersion = 1;
      env.deps.selfRuntimeVersion = '0.8.2';
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
      expect(driftSends(w).length).toBe(1);
      w.fireDidFinishLoad();
      const restartedSends = (w.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'ok:server-restarted',
      );
      expect(restartedSends.length).toBe(0);
    });

    test('upgrade reconcile falls back to attaching (with the manual prompt) when terminating the survivor fails', async () => {
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
      expect(ctx.ownsServer).toBe(false);
      expect(ctx.port).toBe(59534);
      expect(env.utilities.length).toBe(0);
      const w = env.windows[0];
      if (!w) throw new Error('no window created');
      w.fireDomReady();
      expect(driftSends(w).length).toBe(1);
      w.fireDidFinishLoad();
      const restartedSends = (w.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === 'ok:server-restarted',
      );
      expect(restartedSends.length).toBe(0);
    });

    test('reclaim does NOT terminate a server THIS session spawned (own-pid guard)', async () => {
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

      env.windows[0]?.fireClose();

      const ctx2 = await wm.createProjectWindow({ projectPath: '/tmp/dragon' });
      expect(killProbe).not.toHaveBeenCalled();
      expect(ctx2.ownsServer).toBe(false);
      expect(ctx2.port).toBe(60000);
      expect(env.utilities.length).toBe(0);
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

        const spawn = vi.fn(() => Promise.resolve({ pid: 88001 }));
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

      test('a live child that binds after the startup deadline still opens the window', async () => {
        enableSyncTimers();
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
        env.deps.spawnLockPollDeadlineMs = 5;
        env.deps.spawnLockProgressDeadlineMs = 30_000;

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' });

        expect(ctx.port).toBe(60111);
        expect(env.windows.length).toBe(1);
        expect(killed).toEqual([]);
      });

      test('with no progress override the cap is derived from the startup deadline', async () => {
        enableSyncTimers();
        const spawnedAt = Date.now();
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
        expect(err?.message).toMatch(/within 25ms/);
      });

      test('a live lock-holder earns the extension even though our child lost the race', async () => {
        enableSyncTimers();
        const spawnedAt = Date.now();
        const BINDS_AFTER_MS = 40;
        const winnerPid = 77002;
        env.deps.readServerLock = () =>
          Date.now() - spawnedAt >= BINDS_AFTER_MS
            ? { ...spawnedLock, pid: winnerPid }
            : { ...spawnedLock, pid: winnerPid, port: 0 };
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

      const spawnStderrRoots: string[] = [];
      afterEach(() => {
        while (spawnStderrRoots.length > 0) {
          const root = spawnStderrRoots.pop();
          if (root) rmSync(root, { recursive: true, force: true });
        }
      });

      function projectWithSpawnErrorLog(contents: string): string {
        const root = mkdtempSync(join(tmpdir(), 'ok-spawn-stderr-'));
        spawnStderrRoots.push(root);
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

      test('a silent attempt does not report the previous attempt stderr as its cause', async () => {
        enableSyncTimers();
        const projectPath = projectWithSpawnErrorLog(
          `${formatSpawnAttemptHeader(new Date('2026-08-25T10:00:00.000Z'), 4242)}` +
            'Error: EACCES on .ok/local\n' +
            `${formatSpawnAttemptHeader(new Date('2026-08-25T11:00:00.000Z'), 4243)}`,
        );
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
        expect(err?.message).not.toMatch(/EACCES/);
        expect(err?.message).not.toMatch(/^--- stderr ---$/m);
        expect(err?.message).not.toMatch(/spawn attempt/);
      });

      test('a child that writes only whitespace still counts as silent', async () => {
        enableSyncTimers();
        const projectPath = projectWithSpawnErrorLog(
          `${formatSpawnAttemptHeader(new Date('2026-08-25T11:00:00.000Z'), 4243)}\n   \n`,
        );
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
        expect(err?.message).not.toMatch(/^--- stderr ---$/m);
      });

      test('a huge attempt is bounded to a tail before it reaches the failure report', async () => {
        enableSyncTimers();
        const projectPath = projectWithSpawnErrorLog(
          `${formatSpawnAttemptHeader(new Date('2026-08-25T11:00:00.000Z'), 4243)}` +
            'FIRST-LINE-MARKER\n' +
            'x'.repeat(20_000),
        );
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

        expect(err?.message).not.toMatch(/FIRST-LINE-MARKER/);
        expect(err?.message).toContain('…');
        expect(err?.message.length).toBeLessThan(9_000);
      });

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

      test('a dead child ends the lock poll immediately instead of waiting out the deadline', async () => {
        enableSyncTimers();
        let readCount = 0;
        env.deps.readServerLock = () => {
          readCount++;
          return null;
        };
        env.deps.isProcessAlive = () => false;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });
        env.deps.spawnLockPollDeadlineMs = 500;

        const wm = new WindowManager(env.deps);
        const err = await wm.createProjectWindow({ projectPath: '/tmp/dead-child' }).then(
          () => null,
          (e: unknown) => e as Error,
        );

        expect(err).toMatchObject({ pid: 88001 });
        expect(err?.message).toMatch(/exited before binding a port/);
        expect(err?.message).not.toMatch(/did not bind a port/);

        expect(readCount).toBeLessThanOrEqual(3);
      });

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

        let reads = 0;
        env.deps.readServerLock = () => {
          reads++;
          if (reads === 1) return null;
          if (reads < 4) return winnerLock(0);
          return winnerLock(52999);
        };
        env.deps.isProcessAlive = (pid) => pid === WINNER_PID;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: 88001 });
        env.deps.spawnLockPollDeadlineMs = 500;

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/contended' });

        expect(ctx.port).toBe(52999);
        expect(env.windows.length).toBe(1);
      });

      test('a stale lock our child never replaced is NOT declared ready (dead port)', async () => {
        enableSyncTimers();
        const STALE_PID = 870;
        const OUR_CHILD_PID = 22018;
        const staleLock: ServerLockMetadataLike = {
          ...spawnedLock,
          pid: STALE_PID,
          port: 42117,
        };
        const probed: string[] = [];
        env.deps.readServerLock = () => staleLock;
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
        env.deps.spawnLockPollDeadlineMs = 50;
        env.deps.spawnLockProgressDeadlineMs = 50;

        const wm = new WindowManager(env.deps);
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

        expect(probed.some((u) => u.includes('42117'))).toBe(true);
        expect(outcome).toMatchObject({ kind: 'refused' });
        expect(env.windows.length).toBe(0);
        expect(outcome).toMatchObject({ errKind: 'stale-lock-holder', holderPid: STALE_PID });
        expect(outcome).toMatchObject({ reason: 'holder-not-serving' });
        if (outcome.kind === 'refused') {
          expect(outcome.message).toContain('not serving on port 42117');
        }
        expect(killCalls).toContainEqual({ pid: OUR_CHILD_PID, signal: 'SIGTERM' });
      });

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
        expect(outcome).toMatchObject({ holderIsOwnChild: false });
        if (outcome.kind === 'refused') {
          expect(outcome.message).toContain(`Another process (pid ${FOREIGN_PID})`);
        }
        expect(outcome).toMatchObject({ kind: 'refused' });
        if (outcome.kind === 'refused') {
          expect(outcome.message).not.toContain('not serving');
        }
        expect(env.windows.length).toBe(0);
        expect(killCalls).toContainEqual({ pid: OUR_CHILD_PID, signal: 'SIGTERM' });
      });

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
        expect(killCalls).toContainEqual({ pid: OUR_CHILD_PID, signal: 'SIGTERM' });
      });

      test('a healthy cross-pid lock-race winner is still attached (probe passes)', async () => {
        enableSyncTimers();
        const WINNER_PID = 870;
        const OUR_CHILD_PID = 22018;
        const winnerLock: ServerLockMetadataLike = {
          ...spawnedLock,
          pid: WINNER_PID,
          port: 42117,
        };
        let reads = 0;
        env.deps.readServerLock = () => {
          reads++;
          return reads === 1 ? null : winnerLock;
        };
        env.deps.isProcessAlive = (pid) => pid === WINNER_PID;
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        const spawn = vi.fn(() => Promise.resolve({ pid: OUR_CHILD_PID }));
        env.deps.spawnDetachedServer = spawn;
        env.deps.spawnLockPollDeadlineMs = 500;

        const wm = new WindowManager(env.deps);
        const ctx = await wm.createProjectWindow({ projectPath: '/tmp/spawned-project' });

        expect(spawn).toHaveBeenCalledTimes(1);
        expect(ctx.port).toBe(42117);
        expect(ctx.ownsServer).toBe(false);
        expect(env.windows.length).toBe(1);
      });

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

        expect(err?.message).toMatch(/SIGKILL/);
      });

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

      test('spawn-poll skips a draining predecessor lock and connects to the fresh spawn', async () => {
        enableSyncTimers();
        const drainingPredecessor: ServerLockMetadataLike = {
          ...spawnedLock,
          pid: 77001,
          port: 55555,
          draining: true,
        };
        let readCount = 0;
        env.deps.readServerLock = () => {
          readCount++;
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
        expect(ctx.port).toBe(spawnedLock.port);
        expect(ctx.ownsServer).toBe(false);
      });

      test('attach-eligible lock pre-empts detached spawn (does NOT spawn a duplicate)', async () => {
        enableSyncTimers();
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

      test('EPERM holder that serves nothing has its lock broken so the retry proceeds', async () => {
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
        env.deps.probeWsUpgrade = () => Promise.resolve(false);
        env.deps.killProbe = () => {
          throw Object.assign(new Error('eperm'), { code: 'EPERM' });
        };

        const wm = new WindowManager(env.deps);
        const outcome = await wm.forceStopConflictingServer(projectPath);

        expect(outcome).toEqual({ ok: true });
        expect(removeServerLock).toHaveBeenCalledTimes(1);
        expect(removeServerLock.mock.calls[0]?.[0]).toBe(join(projectPath, '.ok', 'local'));
        expect(removeServerLock.mock.calls[0]?.[1]).toEqual({ pid: 64323 });
      });

      test('the guarded unlink breaks only the holder it was told about', () => {
        const projectPath = seedRawLock(70001);
        const lockDir = join(projectPath, '.ok', 'local');
        const lockPath = join(lockDir, 'server.lock');

        expect(breakServerLockHeldBy(lockDir, { pid: 69999 })).toBe(false);
        expect(existsSync(lockPath)).toBe(true);

        expect(breakServerLockHeldBy(lockDir, { pid: 70001 })).toBe(true);
        expect(existsSync(lockPath)).toBe(false);

        expect(breakServerLockHeldBy(lockDir, { pid: 70001 })).toBe(false);

        writeFileSync(lockPath, 'not json', 'utf-8');
        expect(breakServerLockHeldBy(lockDir, { pid: 70001 })).toBe(false);
        expect(existsSync(lockPath)).toBe(true);
      });

      test('EPERM recovery works on a lock whose identity fields look foreign', async () => {
        env.deps.setTimeout = (cb: () => void, _ms: number) => {
          cb();
          return null;
        };
        const projectPath = seedRawLock(64325);
        const removeServerLock = vi.fn(() => true);
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

        expect(outcome).toEqual({ ok: true });
        expect(removeServerLock).toHaveBeenCalledTimes(1);
        expect(removeServerLock.mock.calls[0]?.[1]).toEqual({ pid: 64325 });
      });

      test('EPERM recovery survives a removeServerLock that throws', async () => {
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
        const lockByCwd = new Map<string, ServerLockMetadataLike>();
        lockByCwd.set('/tmp/proj-a/.ok/local', { ...spawnedLock, pid: 91001 });
        lockByCwd.set('/tmp/proj-b/.ok/local', { ...spawnedLock, pid: 91002 });
        let readCounts = new Map<string, number>();
        env.deps.readServerLock = (lockDir) => {
          const n = (readCounts.get(lockDir) ?? 0) + 1;
          readCounts.set(lockDir, n);
          return n === 1 ? null : (lockByCwd.get(lockDir) ?? null);
        };
        const killedPids = new Set<number>();
        env.deps.isProcessAlive = (pid) => !killedPids.has(pid);
        env.deps.hostname = () => 'my-host';
        env.deps.probeWsUpgrade = () => Promise.resolve(true);
        let nextSpawnPid = 91001;
        env.deps.spawnDetachedServer = () => Promise.resolve({ pid: nextSpawnPid++ });

        const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
        env.deps.killProbe = (pid: number, signal: NodeJS.Signals | 0) => {
          killCalls.push({ pid, signal });
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
      const probe = vi.fn(() => Promise.resolve(false));
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

  test('brings a backgrounded window to the front: show + moveTop + focus + app steal', async () => {
    const wm = new WindowManager(env.deps);
    const p = wm.createProjectWindow({ projectPath: '/tmp/bg-proj' });
    env.utilities[0]?.fire({ type: 'ready', port: 51210, apiOrigin: 'http://localhost:51210' });
    const ctx = await p;

    wm.focusWindowForProject('/tmp/bg-proj');
    expect(ctx.window.show).toHaveBeenCalled();
    expect(ctx.window.moveTop).toHaveBeenCalled();
    expect(ctx.window.focus).toHaveBeenCalled();
    expect(env.activateApp).toHaveBeenCalled();
  });

  test('reports a destroyed window as no window rather than calling into it', async () => {
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
    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.moveTop).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });

  test('activate:false leaves an already-visible window alone rather than re-revealing', async () => {
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
