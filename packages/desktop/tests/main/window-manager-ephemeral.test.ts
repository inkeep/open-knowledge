import { setTimeout as wait } from 'node:timers/promises';
import { getLocalDir } from '@inkeep/open-knowledge-server';
import { beforeEach, describe, expect, test, vi } from 'vitest';
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
  /** Ordered effect log so teardown sequencing (terminate THEN rm) is assertable. */
  effectLog: string[];
  killCalls: Array<{ pid: number; signal: number | NodeJS.Signals }>;
  /** Control: when false, the spawn stub does NOT publish a lock (timeout path). */
  publishLock: boolean;
  /**
   * Simulate the detached server dying out-of-band (a `kill -TERM <pid>` from a
   * shell, a crash, or an idle-shutdown) — WITHOUT going through the manager's
   * own teardown. Mirrors a real exit: the pid stops being alive and its lock is
   * released. Used to exercise the server-liveness paths.
   */
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
  // lockDir → live lock; the spawn stub publishes. killProbe(SIGTERM) kills
  // the pid AND drops its lock — mirroring a real exit, where the unlink
  // happens in the dying process's exit handler. The teardown poll watches
  // pid death (not lock release), so liveness must track the kill.
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
      // Unused on the ephemeral path, but the dep is non-optional.
      forkUtility: () => {
        throw new Error('forkUtility must not be called on the ephemeral path');
      },
      utilityEntryPath: '/fake/utility-entry.js',
      rendererEntryPath: '/fake/renderer/index.html',
      appVersion: '9.9.9-test',
      // Fast, deterministic poll: the success path finds the lock on the first
      // read, so no sleep is ever attempted. This stub DISCARDS the callback
      // rather than recording it — a test that needs the loop to advance has
      // to supply its own firing timer.
      spawnLockPollDeadlineMs: 5_000,
      setTimeout: () => null,
      killProbe: (pid, signal) => {
        killCalls.push({ pid, signal });
        if (signal === 'SIGTERM') {
          effectLog.push(`sigterm:${pid}`);
          killedPids.add(pid);
          // Release every lock this pid holds (mirrors process exit).
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

  // Same two-tier wait as the project-open path, second call site. Without
  // this, dropping the progress-deadline argument here would regress the
  // ephemeral path to the original bug while the project-open coverage stayed
  // green. The base env's `setTimeout` is a no-op that never invokes its
  // callback — fine for the `deadlineMs = 0` tests, which return before any
  // sleep is attempted — so this test supplies one that fires immediately.
  test('a live child that binds after the startup deadline is not SIGTERMd', async () => {
    env.publishLock = false; // the lock is published late, by the reader below
    env.deps.setTimeout = (cb: () => void) => {
      cb();
      return null;
    };
    const spawnedAt = Date.now();
    // Past the DERIVED cap (5 * 8 = 40ms) as well as the startup deadline, so
    // the test fails if the explicit progress deadline stops being forwarded
    // — dropping it would otherwise still leave a 40ms cap that covers a
    // shorter bind, and the regression would pass unnoticed.
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

    // The session came up, and nothing killed the healthy child or tore down
    // the temp project underneath it.
    expect(env.windows).toHaveLength(1);
    expect(env.killCalls).toEqual([]);
    expect(env.removedDirs).toEqual([]);
  });

  // This path SIGTERMs the orphan and then awaits `removeDir` before throwing.
  // The child therefore dies, and its exit record lands, inside that await. If
  // the error consulted the exit record at throw time it would report our own
  // kill as the child's failure — a merely-slow start described as "killed by
  // SIGTERM", with the deadline dropped from the message entirely.
  test('a slow child killed by our own SIGTERM is not reported as having crashed', async () => {
    env.publishLock = false; // server never publishes its lock
    env.deps.spawnLockPollDeadlineMs = 0; // deadline already elapsed, child still alive

    // The exit record appears only once WE signal, mirroring production where
    // the 'exit' listener fires during the removeDir await.
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

    // Reported as what it was: a deadline reached with the process alive.
    expect(err?.message).toMatch(/did not bind a port/);
    expect(err?.message).not.toMatch(/killed by SIGTERM/);
    expect(err?.message).not.toMatch(/exited before binding/);
    // The orphan is still signalled and the temp dir still cleaned up.
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
    // The server spawns and binds its lock, THEN `loadFile`/`loadURL` rejects.
    // The window is not yet in `windowsByPath`, so the `'closed'` teardown never
    // fires — the catch must reap the detached server pid AND the temp dir, and
    // destroy the never-shown window, or both orphan.
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

    // Server reaped (SIGTERM on the bound pid) + temp dir removed — no leak.
    expect(env.killCalls).toContainEqual({ pid: 42001, signal: 'SIGTERM' });
    expect(env.removedDirs).toEqual(['/tmp/ok-ephemeral-1']);
    // The never-shown window was destroyed (not left dangling).
    expect(env.windows[0]?.destroy).toHaveBeenCalled();
    // It was never registered, so no later 'closed' teardown can double-fire.
    expect(env.killCalls.filter((k) => k.signal === 'SIGTERM')).toHaveLength(1);
    // ...and it stops resolving to a project: the reap released the loading
    // context, so nothing hands New Terminal Window a destroyed window.
    const failed = env.windows[0];
    if (!failed) throw new Error('window was never created');
    expect(wm.getContextForBrowserWindow(failed)).toBeUndefined();
  });

  test('an ephemeral window resolves to its content dir while its renderer loads', async () => {
    // The ephemeral factory carries the same gap as the project factory, and its
    // window is an ordinary editor window as far as New Terminal Window cares.
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

  // --- dedup must gate on SERVER liveness, not just WINDOW liveness ---
  // An ephemeral server is a DETACHED process; it can die (kill / crash / idle-
  // shutdown) while its BrowserWindow stays open. The pre-fix dedup returned the
  // cached ProjectContext whenever the window was alive, handing the renderer a
  // dead `apiOrigin` — `ok open <file>` "succeeded" but started no session.

  /** Controllable `setInterval`/`clearInterval` stubs for the exit-watch. Each
   *  interval is a record whose `cb` fires on `tick()` until cleared. */
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
  /** Advance every live interval `rounds` times (a cleared interval is inert). */
  function tick(intervals: FakeInterval[], rounds: number): void {
    for (let r = 0; r < rounds; r++) {
      for (const rec of intervals) {
        if (!rec.cleared) rec.cb();
      }
    }
  }

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

    // The detached server dies while the window stays open (isDestroyed stays
    // false). Pre-fix, the next open focus-dedups onto this dead session.
    env.killServer(deadPid as number);

    const second = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    // Fire-and-forget teardown of the dead session runs during the fresh spawn.
    await wait(20);

    // A fresh server was spawned; the returned context points at the LIVE origin.
    expect(env.spawnCalls).toHaveLength(2);
    expect(second.apiOrigin).not.toBe(deadApiOrigin);
    expect(second.ephemeral?.pid).not.toBe(deadPid);
    // The map now resolves the file to the live session.
    expect(wm.getWindowFor(FILE)?.apiOrigin).toBe(second.apiOrigin);
    // The dead session's throwaway temp dir was reaped (no leak on re-open).
    expect(env.removedDirs).toContain(first.ephemeral?.projectDir);
  });

  test('a live re-open still focus-dedups (server-liveness gate does not break the healthy path)', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    // Server is alive → the second open must focus the SAME window, not respawn.
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

    // A poll while the server is ALIVE must not reap a healthy session.
    tick(intervals, 1);
    expect(wm.getWindowFor(FILE)).toBe(ctx);
    expect(env.removedDirs).toEqual([]);

    // The server dies out-of-band; the next poll reaps its throwaway temp dir.
    env.killServer(pid);
    tick(intervals, 1);
    await wait(20);
    expect(env.removedDirs).toContain(ctx.ephemeral?.projectDir);

    // Regression guard: the map entry is deliberately KEPT so the still-open
    // window stays in the session-restore snapshot (`getOpenWindows`). Dropping
    // it here would silently exclude the loose file from next-launch restore.
    // Dedup correctness is the live-probe's job on the next open, not a delete.
    expect(wm.getWindowFor(FILE)).toBe(ctx);
    expect(wm.getOpenWindows()).toContainEqual({ kind: 'file', filePath: ctx.canonicalKey });

    // The watch stopped after the reap — a further poll does not reap again.
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

    // Pid stays alive, but its lock flips to `draining` — a server mid graceful
    // shutdown whose pid has not exited yet. `isEphemeralServerAlive` must treat
    // this as dead, so the re-open re-spawns instead of focusing the dying one.
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
    const stale = realReader(lockDir) as ServerLockMetadataLike; // capture before kill

    // SIGKILL: pid dies but the lock file is never released, so a reader still
    // returns the stale, non-draining lock. Pid liveness is authoritative, so the
    // dead pid must win over the present lock and the re-open must re-spawn.
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
    // Kill the first server, then re-open: probe-on-dedup reaps + drops the first
    // entry and spawns a fresh session (its OWN watch). The FIRST session's watch
    // is still armed and must self-stop on its next poll via the superseded-slot
    // check rather than tearing down the live replacement.
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
    tick(intervals, 1); // intervals[0] = stale first watch, intervals[1] = live second watch
    expect(wm.getWindowFor(FILE)).toBe(second); // live session untouched
    expect(intervals[0]?.cleared).toBe(true); // stale watch self-stopped
    expect(intervals[1]?.cleared).toBe(false); // live watch still armed
    expect(env.removedDirs).toHaveLength(rmBefore); // stale watch reaped nothing new
  });

  test('exit-watch stops once the window closes (no invalidation churn on a closed window)', async () => {
    const intervals = wireIntervalTimers(env.deps);
    const wm = new WindowManager(env.deps);
    await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });

    // Normal close reaps once (server SIGTERM + rm) and stops the watch.
    env.windows[0]?.fireClose();
    await wait(20);
    // Pin the close handler's `stopExitWatch()` directly: the interval is cleared
    // AT CLOSE, not merely self-healed on a later poll. Without this the test
    // would still pass via the superseded-slot check on the next `tick`, so it
    // would not catch a regression that dropped the close-handler stop call.
    expect(intervals[0]?.cleared).toBe(true);
    const rmAfterClose = env.removedDirs.length;
    const sigtermsAfterClose = env.killCalls.filter((k) => k.signal === 'SIGTERM').length;

    // Any subsequent poll after close must be inert — the interval was cleared,
    // so no second teardown fires.
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
    // Server dies; re-open reaps the dead session and spawns a fresh one that now
    // owns the canonicalKey slot. The stale first window is deliberately left open.
    env.killServer(first.ephemeral?.pid as number);
    const second = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    await wait(20);
    expect(second).not.toBe(first);
    expect(wm.getWindowFor(FILE)).toBe(second);

    // The user now closes the STALE (first) window. Its `'closed'` ownership
    // guard must decline to touch the live replacement's server + temp dir.
    env.windows[0]?.fireClose();
    await wait(20);

    expect(wm.getWindowFor(FILE)).toBe(second);
    expect(env.removedDirs).not.toContain(second.ephemeral?.projectDir);
    // The live replacement's server was never SIGTERM'd by the stale close.
    expect(env.killCalls.filter((k) => k.pid === second.ephemeral?.pid)).toEqual([]);
  });
});
