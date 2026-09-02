import { setTimeout as wait } from 'node:timers/promises';
import { getLocalDir } from '@inkeep/open-knowledge-server';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ShowGateRegistry } from '../../src/main/show-gate.ts';
import {
  type BrowserWindowLike,
  type EphemeralOpenIdentity,
  type ServerLockMetadataLike,
  WindowManager,
  type WindowManagerDeps,
} from '../../src/main/window-manager.ts';

interface FakeWindow extends BrowserWindowLike {
  fireClose: () => void;
  fireDomReady: () => void;
  sent: Array<{ channel: string; payload: unknown }>;
}

function makeWindow(): FakeWindow {
  const closeHandlers: Array<() => void> = [];
  let domReadyHandler: (() => void) | null = null;
  let destroyed = false;
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const fireClose = () => {
    for (const h of closeHandlers) h();
  };
  return {
    focus: vi.fn(() => {}),
    show: vi.fn(() => {}),
    restore: vi.fn(() => {}),
    isMinimized: vi.fn(() => false),
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => true),
    on: vi.fn((_event: 'closed', cb: () => void) => {
      closeHandlers.push(cb);
    }) as BrowserWindowLike['on'],
    once: vi.fn(() => {}) as BrowserWindowLike['once'],
    close: vi.fn(() => {
      destroyed = true;
      fireClose();
    }),
    destroy: vi.fn(() => {
      destroyed = true;
      fireClose();
    }),
    webContents: {
      send: vi.fn((channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      }),
      once: vi.fn((event: 'dom-ready' | 'did-finish-load', cb: () => void) => {
        if (event === 'dom-ready') domReadyHandler = cb;
      }),
      isDestroyed: () => destroyed,
    },
    loadFile: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
    fireClose,
    fireDomReady: () => domReadyHandler?.(),
    sent,
  };
}

interface EphemeralEnv {
  deps: WindowManagerDeps;
  windows: FakeWindow[];
  createWindowOpts: Array<{ additionalArguments: string[]; title: string }>;
  spawnCalls: Array<{
    contentDir: string;
    reactShellDistDir: string;
    singleFile?: string;
    projectDir?: string;
  }>;
  createTempCalls: string[];
  removedDirs: string[];
  effectLog: string[];
  killCalls: Array<{ pid: number; signal: number | NodeJS.Signals }>;
  publishLock: boolean;
  killServer: (pid: number) => void;
}

function buildEphemeralEnv(): EphemeralEnv {
  const windows: FakeWindow[] = [];
  const createWindowOpts: Array<{ additionalArguments: string[]; title: string }> = [];
  const spawnCalls: EphemeralEnv['spawnCalls'] = [];
  const createTempCalls: string[] = [];
  const removedDirs: string[] = [];
  const effectLog: string[] = [];
  const killCalls: EphemeralEnv['killCalls'] = [];
  const locks = new Map<string, ServerLockMetadataLike>();
  const killedPids = new Set<number>();
  let tempCounter = 0;
  let pidCounter = 42000;

  const showGate: ShowGateRegistry = {
    register: () => () => {},
    fireThemeApplied: () => {},
  };

  const env: EphemeralEnv = {
    windows,
    createWindowOpts,
    spawnCalls,
    createTempCalls,
    removedDirs,
    effectLog,
    killCalls,
    publishLock: true,
    killServer: (pid) => {
      killedPids.add(pid);
      for (const [dir, lock] of locks) {
        if (lock.pid === pid) locks.delete(dir);
      }
    },
    deps: {
      createWindow: (opts) => {
        createWindowOpts.push(opts);
        const w = makeWindow();
        windows.push(w);
        return w;
      },
      forkUtility: () => {
        throw new Error('forkUtility must not be called on the ephemeral path');
      },
      utilityEntryPath: '/fake/utility-entry.js',
      rendererEntryPath: '/fake/renderer/index.html',
      appVersion: '9.9.9-test',
      spawnLockPollDeadlineMs: 5_000,
      setTimeout: () => null,
      killProbe: (pid, signal) => {
        killCalls.push({ pid, signal });
        if (signal === 'SIGTERM') {
          effectLog.push(`sigterm:${pid}`);
          killedPids.add(pid);
          for (const [dir, lock] of locks) {
            if (lock.pid === pid) locks.delete(dir);
          }
        }
      },
      isProcessAlive: (pid) => !killedPids.has(pid),
      readServerLock: (lockDir) => locks.get(lockDir) ?? null,
      showGate,
      createEphemeralProjectDir: (contentDir) => {
        createTempCalls.push(contentDir);
        return `/tmp/ok-ephemeral-${++tempCounter}`;
      },
      removeDir: async (dir) => {
        removedDirs.push(dir);
        effectLog.push(`rm:${dir}`);
      },
      spawnDetachedServer: async (opts) => {
        spawnCalls.push(opts);
        const pid = ++pidCounter;
        if (env.publishLock && opts.projectDir !== undefined) {
          locks.set(getLocalDir(opts.projectDir), {
            pid,
            hostname: 'testhost',
            port: 52000 + spawnCalls.length,
            startedAt: '2026-06-05T00:00:00.000Z',
            worktreeRoot: opts.projectDir,
            kind: 'interactive',
            capabilities: ['ws'],
          });
        }
        return { pid };
      },
    },
  };
  return env;
}

const FILE = '/Users/me/notes/todo.md';
const PARENT = '/Users/me/notes';

interface FakeInterval {
  cb: () => void;
  cleared: boolean;
}
function wireIntervalTimers(deps: WindowManagerDeps): FakeInterval[] {
  const intervals: FakeInterval[] = [];
  deps.setInterval = (cb: () => void) => {
    const rec: FakeInterval = { cb, cleared: false };
    intervals.push(rec);
    return rec;
  };
  deps.clearInterval = (handle: unknown) => {
    (handle as FakeInterval).cleared = true;
  };
  return intervals;
}
function tick(intervals: FakeInterval[], rounds: number): void {
  for (let r = 0; r < rounds; r++) {
    for (const rec of intervals) {
      if (!rec.cleared) rec.cb();
    }
  }
}

describe('createEphemeralWindow', () => {
  let env: EphemeralEnv;
  beforeEach(() => {
    env = buildEphemeralEnv();
  });

  test('spawns the ephemeral shape (--single-file + --project-dir) and opens the doc', async () => {
    const wm = new WindowManager(env.deps);
    const ctx = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });

    expect(env.createTempCalls).toEqual([PARENT]);
    expect(env.spawnCalls).toHaveLength(1);
    expect(env.spawnCalls[0]).toMatchObject({
      contentDir: PARENT,
      singleFile: FILE,
      projectDir: '/tmp/ok-ephemeral-1',
      reactShellDistDir: '/fake/renderer',
    });

    expect(ctx.port).toBe(52001);
    expect(env.createWindowOpts[0]?.title).toBe('todo.md — OpenKnowledge');
    expect(env.createWindowOpts[0]?.additionalArguments).toContain(
      '--ok-collab-url=ws://localhost:52001/collab',
    );
    expect(env.createWindowOpts[0]?.additionalArguments).toContain(`--ok-project-path=${PARENT}`);
    expect(env.createWindowOpts[0]?.additionalArguments).toContain('--ok-single-file=1');
    expect(env.createWindowOpts[0]?.additionalArguments).toContain('--ok-initial-doc=todo');

    expect(ctx.ephemeral).toEqual({
      projectDir: '/tmp/ok-ephemeral-1',
      pid: 42001,
      lockDir: getLocalDir('/tmp/ok-ephemeral-1'),
    });

    env.windows[0]?.fireDomReady();
    expect(env.windows[0]?.sent.some((m) => m.channel === 'ok:deep-link')).toBe(false);
  });

  test('two `ok <samefile>` opens dedup to one server + one temp dir (C4); focus creates no temp dir', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    const second = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });

    expect(second).toBe(first);
    expect(env.spawnCalls).toHaveLength(1);
    expect(env.createTempCalls).toHaveLength(1);
    expect(env.windows).toHaveLength(1);
    expect(env.windows[0]?.focus).toHaveBeenCalledTimes(1);
  });

  test('CONCURRENT `ok <samefile>` opens (TOCTOU) still dedup to one server + one temp dir', async () => {
    const wm = new WindowManager(env.deps);
    const [first, second] = await Promise.all([
      wm.createEphemeralWindow({ canonicalFilePath: FILE, contentDir: PARENT, docName: 'todo' }),
      wm.createEphemeralWindow({ canonicalFilePath: FILE, contentDir: PARENT, docName: 'todo' }),
    ]);

    expect(second).toBe(first);
    expect(env.spawnCalls).toHaveLength(1);
    expect(env.createTempCalls).toHaveLength(1);
    expect(env.windows).toHaveLength(1);
    expect(env.windows[0]?.focus).toHaveBeenCalledTimes(1);
    const third = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    expect(third).toBe(first);
    expect(env.spawnCalls).toHaveLength(1);
  });

  test('window close terminates the server THEN removes the temp dir (sequential)', async () => {
    const wm = new WindowManager(env.deps);
    await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });

    env.windows[0]?.fireClose();
    await wait(20);

    expect(env.killCalls).toContainEqual({ pid: 42001, signal: 'SIGTERM' });
    expect(env.removedDirs).toEqual(['/tmp/ok-ephemeral-1']);
    expect(env.effectLog).toEqual(['sigterm:42001', 'rm:/tmp/ok-ephemeral-1']);
  });

  test('a spawn-lock timeout SIGTERMs the orphan AND removes the temp dir, then throws', async () => {
    env.publishLock = false;
    env.deps.spawnLockPollDeadlineMs = 0;
    const wm = new WindowManager(env.deps);

    await expect(
      wm.createEphemeralWindow({ canonicalFilePath: FILE, contentDir: PARENT, docName: 'todo' }),
    ).rejects.toThrow(/did not bind a port/);

    expect(env.killCalls).toContainEqual({ pid: 42001, signal: 'SIGTERM' });
    expect(env.removedDirs).toEqual(['/tmp/ok-ephemeral-1']);
    expect(env.windows).toHaveLength(0);
  });

  test('a live child that binds after the startup deadline is not SIGTERMd', async () => {
    env.publishLock = false;
    env.deps.setTimeout = (cb: () => void) => {
      cb();
      return null;
    };
    const spawnedAt = Date.now();
    const BINDS_AFTER_MS = 150;
    env.deps.readServerLock = () =>
      Date.now() - spawnedAt >= BINDS_AFTER_MS
        ? {
            pid: 42001,
            hostname: 'testhost',
            port: 52001,
            startedAt: '2026-06-05T00:00:00.000Z',
            worktreeRoot: '/tmp/ok-ephemeral-1',
            kind: 'interactive',
            capabilities: ['ws'],
          }
        : null;
    env.deps.spawnLockPollDeadlineMs = 5;
    env.deps.spawnLockProgressDeadlineMs = 30_000;

    const wm = new WindowManager(env.deps);
    await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });

    expect(env.windows).toHaveLength(1);
    expect(env.killCalls).toEqual([]);
    expect(env.removedDirs).toEqual([]);
  });

  test('a slow child killed by our own SIGTERM is not reported as having crashed', async () => {
    env.publishLock = false;
    env.deps.spawnLockPollDeadlineMs = 0;

    let exitRecord: { code: number | null; signal: string | null } | null = null;
    const recordingKill = env.deps.killProbe;
    env.deps.killProbe = (pid, signal) => {
      recordingKill(pid, signal);
      if (signal === 'SIGTERM') exitRecord = { code: null, signal: 'SIGTERM' };
    };
    env.deps.spawnDetachedServer = async () => ({ pid: 42001, readExit: () => exitRecord });

    const wm = new WindowManager(env.deps);
    const err = await wm
      .createEphemeralWindow({ canonicalFilePath: FILE, contentDir: PARENT, docName: 'todo' })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );

    expect(err?.message).toMatch(/did not bind a port/);
    expect(err?.message).not.toMatch(/killed by SIGTERM/);
    expect(err?.message).not.toMatch(/exited before binding/);
    expect(env.killCalls).toContainEqual({ pid: 42001, signal: 'SIGTERM' });
    expect(env.removedDirs).toEqual(['/tmp/ok-ephemeral-1']);
  });

  test('a spawn failure removes the temp dir before rethrowing (no leak)', async () => {
    env.deps.spawnDetachedServer = async () => {
      throw Object.assign(new Error('spawn boom'), { kind: 'spawn-error' });
    };
    const wm = new WindowManager(env.deps);

    await expect(
      wm.createEphemeralWindow({ canonicalFilePath: FILE, contentDir: PARENT, docName: 'todo' }),
    ).rejects.toThrow('spawn boom');
    expect(env.removedDirs).toEqual(['/tmp/ok-ephemeral-1']);
  });

  test('a renderer-load failure reaps the spawned server + temp dir and destroys the window', async () => {
    env.deps.createWindow = (opts) => {
      env.createWindowOpts.push(opts);
      const w = makeWindow();
      w.loadFile = vi.fn(() => Promise.reject(new Error('renderer load boom')));
      env.windows.push(w);
      return w;
    };
    const wm = new WindowManager(env.deps);

    await expect(
      wm.createEphemeralWindow({ canonicalFilePath: FILE, contentDir: PARENT, docName: 'todo' }),
    ).rejects.toThrow('renderer load boom');

    expect(env.killCalls).toContainEqual({ pid: 42001, signal: 'SIGTERM' });
    expect(env.removedDirs).toEqual(['/tmp/ok-ephemeral-1']);
    expect(env.windows[0]?.destroy).toHaveBeenCalled();
    expect(env.killCalls.filter((k) => k.signal === 'SIGTERM')).toHaveLength(1);
    const failed = env.windows[0];
    if (!failed) throw new Error('window was never created');
    expect(wm.getContextForBrowserWindow(failed)).toBeUndefined();
  });

  test('an ephemeral window resolves to its content dir while its renderer loads', async () => {
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
    const pending = wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    await vi.waitFor(() => {
      expect(releaseLoad).toBeDefined();
    });

    const loading = env.windows[0];
    if (!loading) throw new Error('window was never created');
    expect(wm.getContextForBrowserWindow(loading)?.projectPath).toBe(PARENT);

    releaseLoad?.();
    expect(wm.getContextForBrowserWindow(loading)).toBe(await pending);
  });

  test("the 'closed' ownership guard makes teardown single-pass", async () => {
    const wm = new WindowManager(env.deps);
    await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });

    env.windows[0]?.fireClose();
    await wait(20);
    env.windows[0]?.fireClose();
    await wait(20);

    expect(env.killCalls.filter((k) => k.signal === 'SIGTERM')).toHaveLength(1);
    expect(env.removedDirs).toEqual(['/tmp/ok-ephemeral-1']);
  });

  test('stopAllOwnedServers reaps an open ephemeral session (server + temp dir)', async () => {
    const wm = new WindowManager(env.deps);
    await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });

    await wm.stopAllOwnedServers();

    expect(env.killCalls).toContainEqual({ pid: 42001, signal: 'SIGTERM' });
    expect(env.removedDirs).toEqual(['/tmp/ok-ephemeral-1']);
  });

  test('signalStopAllOwnedServers (before-quit-for-update) SIGTERMs detached + ephemeral pids and drains the detached map', async () => {
    const wm = new WindowManager(env.deps);
    (wm as unknown as { spawnedDetachedPids: Map<string, number> }).spawnedDetachedPids.set(
      '/proj/detached',
      77001,
    );
    await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });

    wm.signalStopAllOwnedServers();

    expect(env.killCalls).toContainEqual({ pid: 77001, signal: 'SIGTERM' });
    expect(env.killCalls).toContainEqual({ pid: 42001, signal: 'SIGTERM' });

    wm.signalStopAllOwnedServers();
    expect(env.killCalls.filter((k) => k.pid === 77001 && k.signal === 'SIGTERM')).toHaveLength(1);
  });

  test('requires the ephemeral deps to be wired', async () => {
    const partial = buildEphemeralEnv();
    partial.deps.createEphemeralProjectDir = undefined;
    const wm = new WindowManager(partial.deps);
    await expect(
      wm.createEphemeralWindow({ canonicalFilePath: FILE, contentDir: PARENT, docName: 'todo' }),
    ).rejects.toThrow(/requires createEphemeralProjectDir/);
  });

  test('re-open after the ephemeral server dies spawns a FRESH live session, not the dead one', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    expect(env.spawnCalls).toHaveLength(1);
    const deadApiOrigin = first.apiOrigin;
    const deadPid = first.ephemeral?.pid;
    expect(deadPid).toBeDefined();

    env.killServer(deadPid as number);

    const second = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    await wait(20);

    expect(env.spawnCalls).toHaveLength(2);
    expect(second.apiOrigin).not.toBe(deadApiOrigin);
    expect(second.ephemeral?.pid).not.toBe(deadPid);
    expect(wm.getWindowFor(FILE)?.apiOrigin).toBe(second.apiOrigin);
    expect(env.removedDirs).toContain(first.ephemeral?.projectDir);
  });

  test('a live re-open still focus-dedups (server-liveness gate does not break the healthy path)', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    const second = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    expect(second).toBe(first);
    expect(env.spawnCalls).toHaveLength(1);
    expect(env.removedDirs).toEqual([]);
    expect(env.windows[0]?.focus).toHaveBeenCalledTimes(1);
  });

  test('exit-watch reaps the dead server temp dir but keeps the window in the restore set', async () => {
    const intervals = wireIntervalTimers(env.deps);
    const wm = new WindowManager(env.deps);
    const ctx = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    const pid = ctx.ephemeral?.pid as number;
    expect(wm.getWindowFor(FILE)).toBe(ctx);

    tick(intervals, 1);
    expect(wm.getWindowFor(FILE)).toBe(ctx);
    expect(env.removedDirs).toEqual([]);

    env.killServer(pid);
    tick(intervals, 1);
    await wait(20);
    expect(env.removedDirs).toContain(ctx.ephemeral?.projectDir);

    expect(wm.getWindowFor(FILE)).toBe(ctx);
    expect(wm.getOpenWindows()).toContainEqual({ kind: 'file', filePath: ctx.canonicalKey });

    const rmCount = env.removedDirs.length;
    tick(intervals, 3);
    await wait(20);
    expect(env.removedDirs).toHaveLength(rmCount);
  });

  test('a server mid-graceful-shutdown (lock draining, pid still alive) is treated as dead on re-open', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    expect(env.spawnCalls).toHaveLength(1);

    const lockDir = first.ephemeral?.lockDir as string;
    const realReader = env.deps.readServerLock as NonNullable<WindowManagerDeps['readServerLock']>;
    const original = realReader(lockDir) as ServerLockMetadataLike;
    env.deps.readServerLock = (dir) =>
      dir === lockDir ? { ...original, draining: true } : realReader(dir);

    const second = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    await wait(20);
    expect(env.spawnCalls).toHaveLength(2);
    expect(second).not.toBe(first);
  });

  test('a dead pid whose lock was never cleaned up (SIGKILL) is treated as dead on re-open', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    const lockDir = first.ephemeral?.lockDir as string;
    const realReader = env.deps.readServerLock as NonNullable<WindowManagerDeps['readServerLock']>;
    const stale = realReader(lockDir) as ServerLockMetadataLike;

    env.killServer(first.ephemeral?.pid as number);
    env.deps.readServerLock = (dir) => (dir === lockDir ? stale : realReader(dir));

    const second = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    await wait(20);
    expect(env.spawnCalls).toHaveLength(2);
    expect(second).not.toBe(first);
  });

  test('a stale exit-watch from a superseded session does not act on the fresh re-open', async () => {
    const intervals = wireIntervalTimers(env.deps);
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    env.killServer(first.ephemeral?.pid as number);
    const second = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    await wait(20);
    expect(second).not.toBe(first);
    expect(wm.getWindowFor(FILE)).toBe(second);

    const rmBefore = env.removedDirs.length;
    tick(intervals, 1);
    expect(wm.getWindowFor(FILE)).toBe(second);
    expect(intervals[0]?.cleared).toBe(true);
    expect(intervals[1]?.cleared).toBe(false);
    expect(env.removedDirs).toHaveLength(rmBefore);
  });

  test('exit-watch stops once the window closes (no invalidation churn on a closed window)', async () => {
    const intervals = wireIntervalTimers(env.deps);
    const wm = new WindowManager(env.deps);
    await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });

    env.windows[0]?.fireClose();
    await wait(20);
    expect(intervals[0]?.cleared).toBe(true);
    const rmAfterClose = env.removedDirs.length;
    const sigtermsAfterClose = env.killCalls.filter((k) => k.signal === 'SIGTERM').length;

    tick(intervals, 10);
    await wait(20);
    expect(env.removedDirs).toHaveLength(rmAfterClose);
    expect(env.killCalls.filter((k) => k.signal === 'SIGTERM')).toHaveLength(sigtermsAfterClose);
  });

  test('closing the stale window after dedup-repair does not tear down the live replacement', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    env.killServer(first.ephemeral?.pid as number);
    const second = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    await wait(20);
    expect(second).not.toBe(first);
    expect(wm.getWindowFor(FILE)).toBe(second);

    env.windows[0]?.fireClose();
    await wait(20);

    expect(wm.getWindowFor(FILE)).toBe(second);
    expect(env.removedDirs).not.toContain(second.ephemeral?.projectDir);
    expect(env.killCalls.filter((k) => k.pid === second.ephemeral?.pid)).toEqual([]);
  });
});

describe('ephemeral keepalive lifecycle', () => {
  let env: EphemeralEnv;
  beforeEach(() => {
    env = buildEphemeralEnv();
  });

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

  test('opens a keepalive against the ephemeral lock when the window mounts', async () => {
    const ka = makeKeepaliveMock();
    env.deps.createKeepalive = ka.create as unknown as WindowManagerDeps['createKeepalive'];
    const wm = new WindowManager(env.deps);
    const ctx = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });

    expect(ka.calls).toHaveLength(1);
    expect(ka.calls[0]?.lockDir).toBe(getLocalDir('/tmp/ok-ephemeral-1'));
    expect(ka.calls[0]?.lockDir).toBe(ctx.ephemeral?.lockDir);
    expect(ka.handles[0]?.closed).toBe(false);
  });

  test('closes the keepalive when the window closes', async () => {
    const ka = makeKeepaliveMock();
    env.deps.createKeepalive = ka.create as unknown as WindowManagerDeps['createKeepalive'];
    const wm = new WindowManager(env.deps);
    await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    expect(ka.handles[0]?.closed).toBe(false);

    env.windows[0]?.fireClose();
    await wait(20);
    expect(ka.handles[0]?.closed).toBe(true);
  });

  test('re-open after the server died replaces the keepalive (old closed, fresh open)', async () => {
    const ka = makeKeepaliveMock();
    env.deps.createKeepalive = ka.create as unknown as WindowManagerDeps['createKeepalive'];
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    env.killServer(first.ephemeral?.pid as number);
    await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    await wait(20);

    expect(ka.calls).toHaveLength(2);
    expect(ka.handles[0]?.closed).toBe(true);
    expect(ka.handles[1]?.closed).toBe(false);
  });

  test('no createKeepalive dep → no keepalive opened (back-compat)', async () => {
    const wm = new WindowManager(env.deps);
    await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    expect(env.windows).toHaveLength(1);
  });

  test('exit-watch closes the keepalive when the server dies out-of-band', async () => {
    const ka = makeKeepaliveMock();
    env.deps.createKeepalive = ka.create as unknown as WindowManagerDeps['createKeepalive'];
    const intervals = wireIntervalTimers(env.deps);

    const wm = new WindowManager(env.deps);
    const ctx = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    expect(ka.handles[0]?.closed).toBe(false);

    env.killServer(ctx.ephemeral?.pid as number);
    tick(intervals, 1);
    await wait(20);

    expect(ka.handles[0]?.closed).toBe(true);
    expect(wm.getWindowFor(FILE)).toBe(ctx);
  });

  test('a re-open whose respawn fails still closes the dead session keepalive (no orphan loop)', async () => {
    const ka = makeKeepaliveMock();
    env.deps.createKeepalive = ka.create as unknown as WindowManagerDeps['createKeepalive'];
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    expect(ka.handles[0]?.closed).toBe(false);

    env.killServer(first.ephemeral?.pid as number);
    env.deps.spawnDetachedServer = async () => {
      throw Object.assign(new Error('spawn boom'), { kind: 'spawn-error' });
    };
    await expect(
      wm.createEphemeralWindow({ canonicalFilePath: FILE, contentDir: PARENT, docName: 'todo' }),
    ).rejects.toThrow('spawn boom');

    expect(ka.handles[0]?.closed).toBe(true);
    expect(ka.calls).toHaveLength(1);
  });
});

describe('restartEphemeralServer', () => {
  let env: EphemeralEnv;
  beforeEach(() => {
    env = buildEphemeralEnv();
  });

  const identityOf = (wm: WindowManager, win: BrowserWindowLike): EphemeralOpenIdentity => {
    const id = wm.getEphemeralIdentityForWindow(win);
    if (!id) throw new Error('expected an ephemeral identity for the window');
    return id;
  };

  test('dead server (no re-open): restart respawns a fresh session and retires the dead window', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    const deadPid = first.ephemeral?.pid as number;
    const deadOrigin = first.apiOrigin;
    const deadTempDir = first.ephemeral?.projectDir as string;

    env.killServer(deadPid);

    const outcome = await wm.restartEphemeralServer(identityOf(wm, first.window), first.window);
    await wait(20);

    expect(outcome).toEqual({ ok: true });
    expect(env.spawnCalls).toHaveLength(2);
    const live = wm.getWindowFor(FILE);
    expect(live).toBeDefined();
    expect(live).not.toBe(first);
    expect(live?.apiOrigin).not.toBe(deadOrigin);
    expect(env.windows[0]?.isDestroyed()).toBe(true);
    expect(env.removedDirs).toContain(deadTempDir);
    expect(live?.window.isDestroyed()).toBe(false);
  });

  test('live session (restart raced a healthy server): terminates it and respawns fresh — a restart must restart', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    const livePid = first.ephemeral?.pid as number;
    const liveTempDir = first.ephemeral?.projectDir as string;
    const liveOrigin = first.apiOrigin;

    const outcome = await wm.restartEphemeralServer(identityOf(wm, first.window), first.window);
    await wait(20);

    expect(outcome).toEqual({ ok: true });
    expect(env.spawnCalls).toHaveLength(2);
    expect(env.killCalls.some((k) => k.pid === livePid && k.signal === 'SIGTERM')).toBe(true);
    expect(env.removedDirs).toContain(liveTempDir);
    expect(env.windows[0]?.isDestroyed()).toBe(true);
    const live = wm.getWindowFor(FILE);
    expect(live).not.toBe(first);
    expect(live?.apiOrigin).not.toBe(liveOrigin);
    expect(live?.window.isDestroyed()).toBe(false);
  });

  test("ownership gate: a genuine orphan's restart converges onto the live sibling without killing it", async () => {
    const wm = new WindowManager(env.deps);
    const orphan = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    const orphanClose = vi.fn();
    (env.windows[0] as FakeWindow).close = orphanClose as unknown as FakeWindow['close'];

    env.killServer(orphan.ephemeral?.pid as number);
    const live = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    await wait(20);
    const livePid = live.ephemeral?.pid as number;
    expect(wm.getWindowFor(FILE)).toBe(live);
    expect(orphanClose).toHaveBeenCalled();
    expect(wm.getEphemeralIdentityForWindow(orphan.window)).toBeDefined();

    orphanClose.mockClear();
    const spawnsBefore = env.spawnCalls.length;
    const outcome = await wm.restartEphemeralServer(identityOf(wm, orphan.window), orphan.window);
    await wait(20);

    expect(outcome).toEqual({ ok: true });
    expect(env.spawnCalls).toHaveLength(spawnsBefore);
    expect(env.killCalls.some((k) => k.pid === livePid)).toBe(false);
    expect(wm.getWindowFor(FILE)).toBe(live);
    expect(orphanClose).toHaveBeenCalled();
  });

  test('the retire sweep closes EVERY stale window in one pass (stale.length > 1)', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    const firstClose = vi.fn();
    (env.windows[0] as FakeWindow).close = firstClose as unknown as FakeWindow['close'];
    env.killServer(first.ephemeral?.pid as number);

    const second = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    await wait(20);
    const secondClose = vi.fn();
    (env.windows[1] as FakeWindow).close = secondClose as unknown as FakeWindow['close'];
    env.killServer(second.ephemeral?.pid as number);
    firstClose.mockClear();
    secondClose.mockClear();

    const third = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    await wait(20);

    expect(wm.getWindowFor(FILE)).toBe(third);
    expect(firstClose).toHaveBeenCalled();
    expect(secondClose).toHaveBeenCalled();
    expect(third.window.isDestroyed()).toBe(false);
  });

  test('re-open after server death auto-retires the dead window (converges to one)', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    env.killServer(first.ephemeral?.pid as number);

    const reopened = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    await wait(20);

    expect(reopened).not.toBe(first);
    expect(env.spawnCalls).toHaveLength(2);
    expect(env.windows[0]?.isDestroyed()).toBe(true);
    expect(reopened.window.isDestroyed()).toBe(false);
    expect(wm.getWindowFor(FILE)).toBe(reopened);
    expect(wm.getEphemeralIdentityForWindow(first.window)).toBeUndefined();
    expect(wm.getEphemeralIdentityForWindow(reopened.window)).toBeDefined();
  });

  test('re-open then all servers die: restart respawns once and retires every stale window', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    env.killServer(first.ephemeral?.pid as number);
    const reopened = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    await wait(20);
    expect(env.windows[0]?.isDestroyed()).toBe(true);

    env.killServer(reopened.ephemeral?.pid as number);

    const outcome = await wm.restartEphemeralServer(
      identityOf(wm, reopened.window),
      reopened.window,
    );
    await wait(20);

    expect(outcome).toEqual({ ok: true });
    expect(env.spawnCalls).toHaveLength(3);
    expect(env.windows[1]?.isDestroyed()).toBe(true);
    const live = wm.getWindowFor(FILE);
    expect(live?.window.isDestroyed()).toBe(false);
    expect(wm.getEphemeralIdentityForWindow(reopened.window)).toBeUndefined();
    expect(live && wm.getEphemeralIdentityForWindow(live.window)).toBeDefined();
  });

  test('respawn failure: returns {ok:false} and leaves the originating window open', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    const identity = identityOf(wm, first.window);
    env.killServer(first.ephemeral?.pid as number);
    env.deps.spawnDetachedServer = async () => {
      throw Object.assign(new Error('spawn boom'), { kind: 'spawn-error' });
    };

    const outcome = await wm.restartEphemeralServer(identity, first.window);

    expect(outcome).toEqual({ ok: false, reason: 'other' });
    expect(env.windows[0]?.isDestroyed()).toBe(false);
  });

  test('getEphemeralIdentityForWindow: present for an ephemeral window, absent for others, cleared on close', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });

    expect(wm.getEphemeralIdentityForWindow(first.window)).toEqual({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    const strangerWindow = makeWindow();
    expect(wm.getEphemeralIdentityForWindow(strangerWindow)).toBeUndefined();

    first.window.fireClose();
    await wait(20);
    expect(wm.getEphemeralIdentityForWindow(first.window)).toBeUndefined();
  });
});

describe('restartServerForWindow (IPC routing seam)', () => {
  let env: EphemeralEnv;
  beforeEach(() => {
    env = buildEphemeralEnv();
  });

  test('an ephemeral sender routes to the ephemeral respawn (observable), ignoring the projectPath arg', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    env.killServer(first.ephemeral?.pid as number);

    const outcome = await wm.restartServerForWindow(first.window, '/some/unrelated/project', {});
    await wait(20);

    expect(outcome).toEqual({ ok: true });
    expect(env.spawnCalls).toHaveLength(2);
    expect(wm.getWindowFor(FILE)?.window.isDestroyed()).toBe(false);
  });

  test('a plain project sender window routes to restartAttachedServer with the projectPath + args', async () => {
    const wm = new WindowManager(env.deps);
    const projectWindow = makeWindow();
    const attached = vi
      .spyOn(wm, 'restartAttachedServer')
      .mockResolvedValue({ ok: false, reason: 'eperm' });

    const outcome = await wm.restartServerForWindow(projectWindow, '/some/project', {
      localOpCliArgs: ['--y'],
    });

    expect(attached).toHaveBeenCalledWith('/some/project', { localOpCliArgs: ['--y'] });
    expect(outcome).toEqual({ ok: false, reason: 'eperm' });
  });

  test('a null sender (destroyed webContents) routes to restartAttachedServer', async () => {
    const wm = new WindowManager(env.deps);
    const attached = vi
      .spyOn(wm, 'restartAttachedServer')
      .mockResolvedValue({ ok: false, reason: 'eperm' });

    const outcome = await wm.restartServerForWindow(null, '/some/project', {});

    expect(attached).toHaveBeenCalledWith('/some/project', {});
    expect(outcome).toEqual({ ok: false, reason: 'eperm' });
  });
});
