/**
 * Seam 6 integration: a terminal window launched from a project
 * attaches to that project's already-running server (`ownsServer:false`), and
 * its PTY SURVIVES when the owning editor window's server is torn down. The PTY
 * host is server-independent by construction — `terminalManager` forks a
 * per-`windowId` utilityProcess and never holds a reference to the collab/api
 * server, so server teardown cannot reap it.
 *
 * Composes the real pieces at the seam-7 gate-run rung (fake pty-host + fake
 * BrowserWindow/utility, real everything else):
 *   - real `WindowManager` attach path (the owner editor window, `ownsServer:false`)
 *   - real `terminalWindow` registry + `resolvePtyProjectRoot` (the terminal
 *     window's cwd/consent source)
 *   - real `terminalManager` (the per-window PTY host)
 * It exercises the genuine survival path: the owner window closes and its
 * server is torn down (no cross-window ref-counting), then a command typed into
 * the terminal window's shell still routes to its live host and host output
 * still reaches the terminal renderer. Full real-shell fidelity is the
 * `_electron` smoke (seam 4); this is the gate-run rung, matching
 * terminal-window-pty.test.ts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createTerminalManager, type PtyUtilityLike } from '../../src/main/terminal-manager.ts';
import {
  getTerminalWindowContext,
  registerTerminalWindow,
  resolvePtyProjectRoot,
  unregisterTerminalWindow,
} from '../../src/main/terminal-window-registry.ts';
import {
  type BrowserWindowLike,
  type ServerLockMetadataLike,
  type UtilityProcessLike,
  WindowManager,
  type WindowManagerDeps,
} from '../../src/main/window-manager.ts';
import type { SendableWebContents } from '../../src/shared/ipc-send.ts';

const HOME = '/Users/test-home';
const PROJECT = '/tmp/attach-survival-project';

/** Per-window fake pty-host. Captures every message the manager posts so a test
 *  can assert input routing, and lets a test drive host->renderer `data`. */
class FakeHost {
  posted: Array<Record<string, unknown>> = [];
  private messageCb: ((m: unknown) => void) | null = null;
  killed = false;
  postMessage(m: Record<string, unknown>): void {
    this.posted.push(m);
  }
  on(event: 'message' | 'exit', cb: (m: unknown) => void): void {
    if (event === 'message') this.messageCb = cb;
  }
  /** Simulate the utilityProcess emitting output for a session. */
  emit(m: Record<string, unknown>): void {
    this.messageCb?.(m);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function makeWebContents(): SendableWebContents & { destroyed: boolean } {
  const wc = {
    destroyed: false,
    send() {},
    isDestroyed() {
      return wc.destroyed;
    },
  };
  return wc;
}

/** Real terminalManager over fake hosts, with captured data/exit sinks so we can
 *  prove the terminal renderer still receives output after server teardown. */
function makeTerminalManager() {
  const forked: FakeHost[] = [];
  const dataPushes: Array<{ ptyId: string; data: string }> = [];
  let idn = 0;
  const mgr = createTerminalManager({
    forkPtyHost: () => {
      const h = new FakeHost();
      forked.push(h);
      return h as unknown as PtyUtilityLike;
    },
    sendData: (_wc, payload) => dataPushes.push(payload),
    sendExit: () => {},
    newPtyId: () => `pty-${++idn}`,
    // Fire the coalesce flush synchronously so a host->renderer `data` push is
    // observable within the test without real timers.
    setTimer: (cb: () => void) => {
      cb();
      return 0;
    },
    clearTimer: () => {},
    logger: { warn: () => {} },
  });
  return { mgr, forked, dataPushes };
}

// --- WindowManager attach harness (owner editor window owns the server) ------

function makeOwnerWindow() {
  const closedHandlers: Array<() => void> = [];
  let destroyed = false;
  const window = {
    focus: () => {},
    show: () => {},
    restore: () => {},
    isMinimized: () => false,
    isDestroyed: () => destroyed,
    isVisible: () => true,
    on: (_event: 'closed', cb: () => void) => {
      closedHandlers.push(cb);
    },
    once: () => {},
    close: () => {
      destroyed = true;
      for (const h of closedHandlers) h();
    },
    destroy: () => {
      destroyed = true;
      for (const h of closedHandlers) h();
    },
    webContents: { send: () => {}, once: () => {} },
    loadFile: () => Promise.resolve(),
    loadURL: () => Promise.resolve(),
  } as unknown as BrowserWindowLike;
  return window;
}

/**
 * A WindowManager wired for the attach path, with a server "torn down" hook the
 * test drives. The lock disappears once the owner is torn down so any later
 * attach attempt would correctly fall through — modeling the real "owner closed,
 * server gone" topology.
 */
function makeOwnerWindowManager() {
  let serverAlive = true;
  const liveLock: ServerLockMetadataLike = {
    pid: 90_111,
    hostname: 'my-host',
    port: 59_900,
    startedAt: '2026-06-22T00:00:00.000Z',
    worktreeRoot: PROJECT,
    kind: 'interactive',
    capabilities: ['http', 'ws'],
  };
  const killed: number[] = [];
  const deps: WindowManagerDeps = {
    createWindow: () => makeOwnerWindow(),
    // The attach path never forks a utility (it reuses the live lock); this is
    // wired only to satisfy the deps contract.
    forkUtility: (): UtilityProcessLike => ({
      pid: 90_222,
      postMessage: () => {},
      on: () => {},
      once: () => {},
      removeListener: () => {},
      kill: () => true,
    }),
    utilityEntryPath: '/fake/utility-entry.js',
    rendererEntryPath: '/fake/renderer/index.html',
    appVersion: '9.9.9-test',
    setTimeout: () => null,
    killProbe: (pid: number, signal: string | number) => {
      if (signal === 'SIGTERM') killed.push(pid);
    },
    showGate: {
      register: () => () => {},
      fireThemeApplied: () => {},
    },
    // Attach-mode probe: a live same-host server holds the lock until teardown.
    readServerLock: () => (serverAlive ? liveLock : null),
    isProcessAlive: () => serverAlive,
    hostname: () => 'my-host',
    probeWsUpgrade: () => Promise.resolve(true),
  };
  return {
    wm: new WindowManager(deps),
    liveLock,
    killed,
    tearDownServer: () => {
      serverAlive = false;
    },
  };
}

const TERM_WIN_ID = 90_500;

afterEach(() => {
  unregisterTerminalWindow(TERM_WIN_ID);
});

describe('terminal window PTY survives owner-server teardown (seam 6 / FR4 / D2)', () => {
  test('attach-mode terminal window: PTY keeps routing after the owner editor window closes and its server is torn down', async () => {
    const owner = makeOwnerWindowManager();

    // 1) The owning editor window attaches to the project's running server.
    const ownerCtx = await owner.wm.createProjectWindow({ projectPath: PROJECT });
    expect(ownerCtx.ownsServer).toBe(false); // attached, not owned
    expect(ownerCtx.port).toBe(59_900);

    // 2) A terminal window is launched from that project (attach-mode: it
    //    inherits the collab/api argv). It is registered in the terminalWindows
    //    registry — deliberately absent from windowsByPath — so ok:pty:create
    //    resolves its cwd from the registry.
    registerTerminalWindow(TERM_WIN_ID, {
      projectRoot: PROJECT,
      collabUrl: `ws://localhost:${ownerCtx.port}/collab`,
      apiOrigin: ownerCtx.apiOrigin,
    });
    const cwd = resolvePtyProjectRoot({
      editorProjectPath: null,
      terminalWindow: getTerminalWindowContext(TERM_WIN_ID),
      homedir: HOME,
    });
    expect(cwd).toBe(PROJECT);

    // 3) The terminal window spawns a live PTY at the inherited cwd.
    const { mgr, forked, dataPushes } = makeTerminalManager();
    const termWc = makeWebContents();
    const created = mgr.create({
      windowId: TERM_WIN_ID,
      webContents: termWc,
      projectRoot: cwd,
      cols: 80,
      rows: 24,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected a live PTY');
    const host = forked[0];
    if (!host) throw new Error('expected a forked PTY host');
    expect(host.posted).toContainEqual({
      type: 'create',
      ptyId: created.ptyId,
      cwd: PROJECT,
      cols: 80,
      rows: 24,
    });

    // 4) THE TEARDOWN: the owning editor window closes and its server is torn
    //    down (no cross-window ref-counting). This is the event the PTY must
    //    survive.
    owner.tearDownServer();
    ownerCtx.window.close();
    expect(owner.wm.getWindowFor(PROJECT)).toBeUndefined(); // owner gone
    expect(owner.wm.windowCount()).toBe(0); // its server context is reaped

    // 5) SURVIVAL PROOF — the terminal window's PTY host was NEVER touched by
    //    the server teardown (it is a separate per-windowId utilityProcess).
    expect(host.killed).toBe(false);

    //    a) Input still routes to the live host: typing a command after teardown
    //       reaches the host's postMessage (the shell still accepts input).
    const beforeInput = host.posted.length;
    mgr.input({ windowId: TERM_WIN_ID, ptyId: created.ptyId, data: 'echo alive\r' });
    expect(host.posted.length).toBe(beforeInput + 1);
    expect(host.posted.at(-1)).toEqual({
      type: 'input',
      ptyId: created.ptyId,
      data: 'echo alive\r',
    });

    //    b) Host output still flows to the terminal renderer after teardown
    //       (the data path is intact — the window is not destroyed).
    host.emit({ type: 'data', ptyId: created.ptyId, data: 'alive\r\n' });
    expect(dataPushes).toContainEqual({ ptyId: created.ptyId, data: 'alive\r\n' });

    // Sanity: reaping the TERMINAL window (its own close) is what kills its PTY
    // — proving step 5 was not a no-op because nothing reaps anything.
    mgr.killForWindow(TERM_WIN_ID);
    expect(host.killed).toBe(true);
  });
});
