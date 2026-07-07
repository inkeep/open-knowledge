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

/**
 * DI-seam unit tests for `WindowManager.createEphemeralWindow` — the no-project
 * single-file session (`ok <file>`). No real Electron, no real server: every
 * side-effect (spawn, temp-dir create/remove, lock read, signal) is an injected
 * stub, so the highest-risk seam in the feature (the leak class) is asserted
 * deterministically:
 *   - the spawn carries `--single-file` + `--project-dir` (ephemeral shape);
 *   - two `ok <samefile>` opens DEDUP to one server + one temp dir and the
 *     focus path creates NO throwaway dir;
 *   - window-close terminates the server THEN removes the temp dir (sequential);
 *   - a spawn-lock timeout still SIGTERMs the orphan AND removes the temp dir;
 *   - the `'closed'` ownership guard makes teardown single-pass.
 */

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
  /** Ordered effect log so teardown sequencing (terminate THEN rm) is assertable. */
  effectLog: string[];
  killCalls: Array<{ pid: number; signal: number | NodeJS.Signals }>;
  /** Control: when false, the spawn stub does NOT publish a lock (timeout path). */
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
  // lockDir → live lock; the spawn stub publishes, killProbe(SIGTERM) releases.
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
      // Unused on the ephemeral path, but the dep is non-optional.
      forkUtility: () => {
        throw new Error('forkUtility must not be called on the ephemeral path');
      },
      utilityEntryPath: '/fake/utility-entry.js',
      rendererEntryPath: '/fake/renderer/index.html',
      appVersion: '9.9.9-test',
      // Fast, deterministic poll: the success path finds the lock on the first
      // read, so the recorded timers are never fired.
      spawnLockPollDeadlineMs: 5_000,
      setTimeout: () => null,
      killProbe: (pid, signal) => {
        killCalls.push({ pid, signal });
        if (signal === 'SIGTERM') {
          effectLog.push(`sigterm:${pid}`);
          // Release every lock this pid holds (mirrors a graceful drain).
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

    // One throwaway temp dir, created from the file's real parent.
    expect(env.createTempCalls).toEqual([PARENT]);
    // Spawn carries the file (write-back target) as singleFile and the temp dir
    // as projectDir — distinct from contentDir (the real parent).
    expect(env.spawnCalls).toHaveLength(1);
    expect(env.spawnCalls[0]).toMatchObject({
      contentDir: PARENT,
      singleFile: FILE,
      projectDir: '/tmp/ok-ephemeral-1',
      reactShellDistDir: '/fake/renderer',
    });

    // Window built against the bound port; title from the file's basename.
    expect(ctx.port).toBe(52001);
    expect(env.createWindowOpts[0]?.title).toBe('todo.md — OpenKnowledge');
    expect(env.createWindowOpts[0]?.additionalArguments).toContain(
      '--ok-collab-url=ws://localhost:52001/collab',
    );
    expect(env.createWindowOpts[0]?.additionalArguments).toContain(`--ok-project-path=${PARENT}`);
    // The single-file signal for the renderer's no-project chrome gate rides
    // the bridge config (the desktop loads from `file://`, off-origin from
    // `/api/config`). Without this arg the chrome gate silently fails on desktop.
    expect(env.createWindowOpts[0]?.additionalArguments).toContain('--ok-single-file=1');
    // The doc to open rides the SAME bridge-config channel (`--ok-initial-doc`),
    // not a post-load `ok:deep-link` IPC: the renderer seeds it into the hash
    // before React mounts, so navigation is deterministic. The IPC raced the
    // renderer's lazy subscriber and dropped → the empty-state splash.
    expect(env.createWindowOpts[0]?.additionalArguments).toContain('--ok-initial-doc=todo');

    // Teardown state recorded on the context for the 'closed' handler.
    expect(ctx.ephemeral).toEqual({
      projectDir: '/tmp/ok-ephemeral-1',
      pid: 42001,
      lockDir: getLocalDir('/tmp/ok-ephemeral-1'),
    });

    // No `ok:deep-link` IPC on the ephemeral path — the config channel is the
    // single navigation mechanism. Firing dom-ready sends nothing.
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

    // Same window focused, not a second spawn.
    expect(second).toBe(first);
    expect(env.spawnCalls).toHaveLength(1);
    expect(env.createTempCalls).toHaveLength(1); // focus must NOT create a 2nd temp dir
    expect(env.windows).toHaveLength(1);
    expect(env.windows[0]?.focus).toHaveBeenCalledTimes(1);
  });

  test('CONCURRENT `ok <samefile>` opens (TOCTOU) still dedup to one server + one temp dir', async () => {
    const wm = new WindowManager(env.deps);
    // Fire BOTH without awaiting the first: the second arrives while the first
    // is still mid spawn/poll/load, BEFORE `windowsByPath.set`. Without the
    // in-flight reservation this is the dedup TOCTOU — both miss the window map,
    // both spawn a server on the same inode (dual-writer → lost edits) and one
    // orphans (absent from the map, so neither its 'closed' handler nor
    // stopAllOwnedServers reaps it). The reservation must collapse them to one.
    const [first, second] = await Promise.all([
      wm.createEphemeralWindow({ canonicalFilePath: FILE, contentDir: PARENT, docName: 'todo' }),
      wm.createEphemeralWindow({ canonicalFilePath: FILE, contentDir: PARENT, docName: 'todo' }),
    ]);

    expect(second).toBe(first); // both opens resolve to the one window
    expect(env.spawnCalls).toHaveLength(1); // ONE server (the bug spawns 2)
    expect(env.createTempCalls).toHaveLength(1); // ONE temp dir (the bug makes 2)
    expect(env.windows).toHaveLength(1);
    // The awaiting (second) caller focused the shared window.
    expect(env.windows[0]?.focus).toHaveBeenCalledTimes(1);
    // The reservation is cleared once the open settles, so a later open takes
    // the plain focus path (no leftover pending entry wedging the key).
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
    // Teardown is fire-and-forget (the 'closed' event is sync) — flush.
    await wait(20);

    // Both the SIGTERM and the rm fired...
    expect(env.killCalls).toContainEqual({ pid: 42001, signal: 'SIGTERM' });
    expect(env.removedDirs).toEqual(['/tmp/ok-ephemeral-1']);
    // ...in order: terminate first (lock release is destroy()'s last step), rm
    // only after — removing the dir under a live server is a race.
    expect(env.effectLog).toEqual(['sigterm:42001', 'rm:/tmp/ok-ephemeral-1']);
  });

  test('a spawn-lock timeout SIGTERMs the orphan AND removes the temp dir, then throws', async () => {
    env.publishLock = false; // server never publishes its lock
    env.deps.spawnLockPollDeadlineMs = 0; // deadline already elapsed → no hang
    const wm = new WindowManager(env.deps);

    await expect(
      wm.createEphemeralWindow({ canonicalFilePath: FILE, contentDir: PARENT, docName: 'todo' }),
    ).rejects.toThrow(/did not bind a port/);

    // Orphan reaped + temp dir removed (no leak on the failure path).
    expect(env.killCalls).toContainEqual({ pid: 42001, signal: 'SIGTERM' });
    expect(env.removedDirs).toEqual(['/tmp/ok-ephemeral-1']);
    // No window was ever created.
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
    // The server spawns and binds its lock, THEN `loadFile`/`loadURL` rejects.
    // The window is not yet in `windowsByPath`, so the `'closed'` teardown never
    // fires — the catch must reap the detached server pid AND the temp dir, and
    // destroy the never-shown window, or both orphan.
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

    // Server reaped (SIGTERM on the bound pid) + temp dir removed — no leak.
    expect(env.killCalls).toContainEqual({ pid: 42001, signal: 'SIGTERM' });
    expect(env.removedDirs).toEqual(['/tmp/ok-ephemeral-1']);
    // The never-shown window was destroyed (not left dangling).
    expect(env.windows[0]?.destroy).toHaveBeenCalled();
    // It was never registered, so no later 'closed' teardown can double-fire.
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
    // A second 'closed' (double-fire, or a late native event) is a no-op: the
    // map slot was already cleared, so the guard short-circuits before a second
    // SIGTERM / rm.
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
    // Seed a detached project server (normally populated by the createProjectWindow
    // spawn path) directly, alongside an open ephemeral single-file session.
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

    // Both the detached project server and the open ephemeral session server are
    // signalled — the latter is the gap this method closes vs. only draining
    // `spawnedDetachedPids`.
    expect(env.killCalls).toContainEqual({ pid: 77001, signal: 'SIGTERM' });
    expect(env.killCalls).toContainEqual({ pid: 42001, signal: 'SIGTERM' });

    // Idempotent for the detached map: a second call drains nothing, so the
    // detached pid is not re-signalled. (Ephemeral pids live on `windowsByPath`,
    // not the drained map, so they may re-signal — ESRCH-safe, not asserted.)
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
