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

/** Controllable `setInterval`/`clearInterval` stubs for the exit-watch. Each
 *  interval is a record whose `cb` fires on `tick()` until cleared. Module-scoped
 *  so both the createEphemeralWindow and keepalive describes share one impl. */
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
  // ephemeral path's spawn-lock progress-deadline handling while the project-open
  // coverage stayed green. The base env's `setTimeout` is a no-op that never invokes its
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
  // (`wireIntervalTimers` / `tick` are module-scoped, shared with the keepalive
  // describe below.)

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

// An ephemeral single-file server inherits the 30-min idle-shutdown default, and
// the idle timer counts only /collab connections. These pin that an ephemeral
// window opens a keepalive against its own (temp) lock and tears it down on close,
// mirroring the project-window keepalive, so the server is held up for as long as
// the editor window is open.
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
    // Keyed to the throwaway temp lock, NOT the file's parent dir.
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

    expect(ka.calls).toHaveLength(2); // fresh session opened its own keepalive
    expect(ka.handles[0]?.closed).toBe(true); // the dead session's keepalive was retired
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

    // The detached server dies while the window stays open; the next exit-watch
    // poll reaps the session AND must close the keepalive — otherwise it
    // reconnect-loops against the removed lockDir for the window's whole
    // remaining lifetime.
    env.killServer(ctx.ephemeral?.pid as number);
    tick(intervals, 1);
    await wait(20);

    expect(ka.handles[0]?.closed).toBe(true);
    // The map entry is deliberately KEPT for session-restore; a later real close
    // is then a no-op on the already-closed keepalive.
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
    // The re-open's respawn throws AFTER the stale-entry branch has evicted the
    // slot but BEFORE a fresh keepalive is installed: the stale-entry
    // `closeKeepalive` must have already closed the dead session's keepalive,
    // because the old window's `'closed'` teardown can no longer run (the slot is
    // gone), so this is the only path that would clean it up.
    env.deps.spawnDetachedServer = async () => {
      throw Object.assign(new Error('spawn boom'), { kind: 'spawn-error' });
    };
    await expect(
      wm.createEphemeralWindow({ canonicalFilePath: FILE, contentDir: PARENT, docName: 'todo' }),
    ).rejects.toThrow('spawn boom');

    // The dead session's keepalive was closed by the stale-entry teardown, not
    // left pointing at the removed lock; the failed respawn opened no new one.
    expect(ka.handles[0]?.closed).toBe(true);
    expect(ka.calls).toHaveLength(1);
  });
});

// --- restartEphemeralServer: the in-window "Restart server" affordance for a
// single-file session. The project restart path is directory-keyed and cannot
// reach a file-keyed ephemeral session; this replays the open through
// `createEphemeralWindow` (dead → reap + respawn; live → dedup) and retires the
// dead window once a live replacement exists (recreate-then-close). Same DI
// harness as createEphemeralWindow above.
describe('restartEphemeralServer', () => {
  let env: EphemeralEnv;
  beforeEach(() => {
    env = buildEphemeralEnv();
  });

  // Resolve the restart identity the IPC router would hand this method — the
  // durable window→identity lookup, NOT `windowsByPath` (which a re-open evicts).
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

    // The detached server dies while its window stays open — the exact state the
    // "server gone" affordance renders against.
    env.killServer(deadPid);

    const outcome = await wm.restartEphemeralServer(identityOf(wm, first.window), first.window);
    await wait(20);

    expect(outcome).toEqual({ ok: true });
    // A fresh server was spawned; the map now resolves the file to the live one.
    expect(env.spawnCalls).toHaveLength(2);
    const live = wm.getWindowFor(FILE);
    expect(live).toBeDefined();
    expect(live).not.toBe(first);
    expect(live?.apiOrigin).not.toBe(deadOrigin);
    // The dead window was retired, and the dead session's throwaway temp dir was
    // reaped — converged to one window, no zombie, no leak.
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

    // The server is alive but the user explicitly asked to restart (e.g. sync is
    // wedged and the reach-error affordance fired). An explicit restart must
    // ACTUALLY restart: `createEphemeralWindow` would otherwise focus-dedup onto
    // the live server and report success having done nothing (the renderer reads
    // that as "torn down and recreated" and shows no feedback). So the live
    // server is terminated and a fresh one spawned.
    const outcome = await wm.restartEphemeralServer(identityOf(wm, first.window), first.window);
    await wait(20);

    expect(outcome).toEqual({ ok: true });
    expect(env.spawnCalls).toHaveLength(2); // a real respawn, not a no-op dedup
    // The previously-live server was terminated and its throwaway temp dir reaped.
    expect(env.killCalls.some((k) => k.pid === livePid && k.signal === 'SIGTERM')).toBe(true);
    expect(env.removedDirs).toContain(liveTempDir);
    // Converged to one fresh live window; the originating one was retired.
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
    // Neuter the orphan's close so the re-open's retire sweep can't actually
    // destroy it — leaving a REAL orphan: still open, still in the identity map,
    // but no longer the slot owner. Production reaches this state only inside
    // the <=2s `closeAndAwait` grace; the harness's synchronous close would
    // otherwise collapse it instantly, making the retire-the-orphan path the
    // gate's docblock promises unreachable.
    const orphanClose = vi.fn();
    (env.windows[0] as FakeWindow).close = orphanClose as unknown as FakeWindow['close'];

    env.killServer(orphan.ephemeral?.pid as number);
    // Re-open spawns the live sibling and tries (via retire) to close the orphan.
    const live = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    await wait(20);
    const livePid = live.ephemeral?.pid as number;
    expect(wm.getWindowFor(FILE)).toBe(live);
    expect(orphanClose).toHaveBeenCalled(); // the re-open's retire swept the orphan
    expect(wm.getEphemeralIdentityForWindow(orphan.window)).toBeDefined(); // still an orphan

    // The orphan (not the slot owner) fires Restart. The gate must decline to
    // terminate the LIVE sibling's server and instead dedup onto it, retiring the
    // orphan again — converge, don't kill a healthy session.
    orphanClose.mockClear();
    const spawnsBefore = env.spawnCalls.length;
    const outcome = await wm.restartEphemeralServer(identityOf(wm, orphan.window), orphan.window);
    await wait(20);

    expect(outcome).toEqual({ ok: true });
    // The two assertions that discriminate the gate's arms: a wrongly-terminating
    // branch would add a spawn AND a SIGTERM against the live pid.
    expect(env.spawnCalls).toHaveLength(spawnsBefore); // dedup onto the sibling; no third spawn
    expect(env.killCalls.some((k) => k.pid === livePid)).toBe(false); // sibling's server untouched
    expect(wm.getWindowFor(FILE)).toBe(live);
    // Sanity, not discrimination: the retire sweep targets the orphan under
    // EITHER arm (a wrong terminate also ends in a fresh spawn whose sweep runs).
    expect(orphanClose).toHaveBeenCalled();
  });

  test('the retire sweep closes EVERY stale window in one pass (stale.length > 1)', async () => {
    // Two orphans for the same file (each with a neutered close so the sweep
    // cannot collapse them) plus a fresh live spawn — the docblock's plural
    // ("every OTHER open ephemeral window") exercised with a stale set larger
    // than one, which a `break` after the first target would fail.
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
    // Both prior windows are now stale identity-map entries; both survived their
    // sweeps (neutered close), so the next spawn's sweep sees stale.length === 2.
    firstClose.mockClear();
    secondClose.mockClear();

    const third = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    await wait(20);

    expect(wm.getWindowFor(FILE)).toBe(third);
    expect(firstClose).toHaveBeenCalled(); // both stale windows swept, not just
    expect(secondClose).toHaveBeenCalled(); // the most recent one
    expect(third.window.isDestroyed()).toBe(false);
  });

  // Re-opening `ok open <file>` after the server died must not leave the dead
  // window dangling beside the fresh one: the re-open retires the dead window
  // itself, with no manual "Restart server" click needed.
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
    // The dead window is retired by the re-open — not left dangling.
    expect(env.windows[0]?.isDestroyed()).toBe(true);
    expect(reopened.window.isDestroyed()).toBe(false);
    expect(wm.getWindowFor(FILE)).toBe(reopened);
    // Only the live window's identity survives.
    expect(wm.getEphemeralIdentityForWindow(first.window)).toBeUndefined();
    expect(wm.getEphemeralIdentityForWindow(reopened.window)).toBeDefined();
  });

  // Re-open, then EVERY server for the file dies at once (e.g. `pkill -f
  // ok-ephemeral` hits them all). Restart from the surviving window must respawn
  // ONE fresh session and retire every stale window — converge to one, never
  // accumulate a third window.
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
    // The re-open already retired the first window; the second is live.
    expect(env.windows[0]?.isDestroyed()).toBe(true);

    // Now the second server dies too.
    env.killServer(reopened.ephemeral?.pid as number);

    const outcome = await wm.restartEphemeralServer(
      identityOf(wm, reopened.window),
      reopened.window,
    );
    await wait(20);

    expect(outcome).toEqual({ ok: true });
    expect(env.spawnCalls).toHaveLength(3); // second was dead → one fresh spawn (no accumulation)
    expect(env.windows[1]?.isDestroyed()).toBe(true); // the now-dead reopened window retired
    const live = wm.getWindowFor(FILE);
    expect(live?.window.isDestroyed()).toBe(false);
    // Exactly one live identity remains for the file.
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
    // The respawn throws (spawn failure) — the affordance must surface a failure
    // the renderer can act on, not tear down the window the user is still reading.
    env.deps.spawnDetachedServer = async () => {
      throw Object.assign(new Error('spawn boom'), { kind: 'spawn-error' });
    };

    const outcome = await wm.restartEphemeralServer(identity, first.window);

    expect(outcome).toEqual({ ok: false, reason: 'other' });
    expect(env.windows[0]?.isDestroyed()).toBe(false); // originating window kept
  });

  test('getEphemeralIdentityForWindow: present for an ephemeral window, absent for others, cleared on close', async () => {
    const wm = new WindowManager(env.deps);
    const first = await wm.createEphemeralWindow({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });

    // Present + carries the exact replay inputs.
    expect(wm.getEphemeralIdentityForWindow(first.window)).toEqual({
      canonicalFilePath: FILE,
      contentDir: PARENT,
      docName: 'todo',
    });
    // A window this manager never created (a project window, in practice) has no
    // ephemeral identity → the IPC routes it to the project restart path.
    const strangerWindow = makeWindow();
    expect(wm.getEphemeralIdentityForWindow(strangerWindow)).toBeUndefined();

    // Cleared when the window actually closes.
    first.window.fireClose();
    await wait(20);
    expect(wm.getEphemeralIdentityForWindow(first.window)).toBeUndefined();
  });
});

// The `ok:project:restart-server` IPC picks the restart path from the REQUESTING
// window, not the `projectPath` arg. Keeping that decision on the class that owns
// the identity map (rather than as a ternary in the IPC handler, which no test
// tier can reach — the bootstrap suite stubs `registerIpcHandlers` out) makes each
// branch reachable here: ephemeral window, plain project window, null/destroyed
// sender. Deleting or inverting the branch would restore the directory-keyed
// misroute for ephemeral single-file sessions, and now fails a test.
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

    // A deliberately-wrong projectPath: if routing fell through to the
    // directory-keyed `restartAttachedServer` (the misroute this chain removes),
    // it would drive that bogus dir and never touch the file.
    const outcome = await wm.restartServerForWindow(first.window, '/some/unrelated/project', {});
    await wait(20);

    // Observable proof of the ephemeral path: a fresh single-file server spawned
    // and the file converged to a live window. `restartAttachedServer` would have
    // found no lock at the bogus dir and spawned nothing for this file.
    expect(outcome).toEqual({ ok: true });
    expect(env.spawnCalls).toHaveLength(2);
    expect(wm.getWindowFor(FILE)?.window.isDestroyed()).toBe(false);
  });

  test('a plain project sender window routes to restartAttachedServer with the projectPath + args', async () => {
    const wm = new WindowManager(env.deps);
    // A window this manager never registered as ephemeral (a project window).
    const projectWindow = makeWindow();
    // `restartAttachedServer`'s real path can't run in this ephemeral harness
    // (its `forkUtility` dep deliberately throws), so spy on it — with a
    // distinctive outcome, so the pass-through assertion below discriminates
    // this branch from anything the ephemeral path could produce.
    const attached = vi
      .spyOn(wm, 'restartAttachedServer')
      .mockResolvedValue({ ok: false, reason: 'eperm' });

    const outcome = await wm.restartServerForWindow(projectWindow, '/some/project', {
      localOpCliArgs: ['--y'],
    });

    expect(attached).toHaveBeenCalledWith('/some/project', { localOpCliArgs: ['--y'] });
    expect(outcome).toEqual({ ok: false, reason: 'eperm' }); // the attached outcome, verbatim
  });

  test('a null sender (destroyed webContents) routes to restartAttachedServer', async () => {
    const wm = new WindowManager(env.deps);
    const attached = vi
      .spyOn(wm, 'restartAttachedServer')
      .mockResolvedValue({ ok: false, reason: 'eperm' });

    const outcome = await wm.restartServerForWindow(null, '/some/project', {});

    expect(attached).toHaveBeenCalledWith('/some/project', {});
    expect(outcome).toEqual({ ok: false, reason: 'eperm' }); // the attached outcome, verbatim
  });
});
