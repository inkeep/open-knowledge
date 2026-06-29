import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { getLocalDir } from '@inkeep/open-knowledge-server';
import type { ShowGateRegistry } from '../../src/main/show-gate.ts';
import {
  type BrowserWindowLike,
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
    focus: mock(() => {}),
    show: mock(() => {}),
    restore: mock(() => {}),
    isMinimized: mock(() => false),
    isDestroyed: mock(() => destroyed),
    isVisible: mock(() => true),
    on: mock((_event: 'closed', cb: () => void) => {
      closeHandlers.push(cb);
    }) as BrowserWindowLike['on'],
    once: mock(() => {}) as BrowserWindowLike['once'],
    close: mock(() => {
      destroyed = true;
      fireClose();
    }),
    destroy: mock(() => {
      destroyed = true;
      fireClose();
    }),
    webContents: {
      send: mock((channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      }),
      once: mock((event: 'dom-ready' | 'did-finish-load', cb: () => void) => {
        if (event === 'dom-ready') domReadyHandler = cb;
      }),
      isDestroyed: () => destroyed,
    },
    loadFile: mock(() => Promise.resolve()),
    loadURL: mock(() => Promise.resolve()),
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
          for (const [dir, lock] of locks) {
            if (lock.pid === pid) locks.delete(dir);
          }
        }
      },
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
    expect(env.createTempCalls).toHaveLength(1); // focus must NOT create a 2nd temp dir
    expect(env.windows).toHaveLength(1);
    expect(env.windows[0]?.focus).toHaveBeenCalledTimes(1);
  });

  test('CONCURRENT `ok <samefile>` opens (TOCTOU) still dedup to one server + one temp dir', async () => {
    const wm = new WindowManager(env.deps);
    const [first, second] = await Promise.all([
      wm.createEphemeralWindow({ canonicalFilePath: FILE, contentDir: PARENT, docName: 'todo' }),
      wm.createEphemeralWindow({ canonicalFilePath: FILE, contentDir: PARENT, docName: 'todo' }),
    ]);

    expect(second).toBe(first); // both opens resolve to the one window
    expect(env.spawnCalls).toHaveLength(1); // ONE server (the bug spawns 2)
    expect(env.createTempCalls).toHaveLength(1); // ONE temp dir (the bug makes 2)
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
    env.publishLock = false; // server never publishes its lock
    env.deps.spawnLockPollDeadlineMs = 0; // deadline already elapsed → no hang
    const wm = new WindowManager(env.deps);

    await expect(
      wm.createEphemeralWindow({ canonicalFilePath: FILE, contentDir: PARENT, docName: 'todo' }),
    ).rejects.toThrow(/did not bind a port/);

    expect(env.killCalls).toContainEqual({ pid: 42001, signal: 'SIGTERM' });
    expect(env.removedDirs).toEqual(['/tmp/ok-ephemeral-1']);
    expect(env.windows).toHaveLength(0);
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
      w.loadFile = mock(() => Promise.reject(new Error('renderer load boom')));
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
    }); // ephemeral server pid = 42001

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
});
