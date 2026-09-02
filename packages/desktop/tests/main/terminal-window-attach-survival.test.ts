import { afterEach, describe, expect, test } from 'vitest';
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

function makeTerminalManager() {
  const forked: FakeHost[] = [];
  const dataPushes: Array<{ ptyId: string; data: string }> = [];
  const shutdownTimers: Array<() => void> = [];
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
    setTimer: (cb: () => void, ms: number) => {
      if (ms === 2000) shutdownTimers.push(cb);
      else cb();
      return shutdownTimers.length;
    },
    clearTimer: () => {},
    logger: { warn: () => {} },
  });
  const runShutdownTimers = (): void => {
    for (const cb of shutdownTimers) cb();
  };
  return { mgr, forked, dataPushes, runShutdownTimers };
}

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

    const ownerCtx = await owner.wm.createProjectWindow({ projectPath: PROJECT });
    expect(ownerCtx.ownsServer).toBe(false);
    expect(ownerCtx.port).toBe(59_900);

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

    const { mgr, forked, dataPushes, runShutdownTimers } = makeTerminalManager();
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

    owner.tearDownServer();
    ownerCtx.window.close();
    expect(owner.wm.getWindowFor(PROJECT)).toBeUndefined();
    expect(owner.wm.windowCount()).toBe(0);

    expect(host.killed).toBe(false);

    const beforeInput = host.posted.length;
    mgr.input({ windowId: TERM_WIN_ID, ptyId: created.ptyId, data: 'echo alive\r' });
    expect(host.posted.length).toBe(beforeInput + 1);
    expect(host.posted.at(-1)).toEqual({
      type: 'input',
      ptyId: created.ptyId,
      data: 'echo alive\r',
    });

    host.emit({ type: 'data', ptyId: created.ptyId, data: 'alive\r\n' });
    expect(dataPushes).toContainEqual({ ptyId: created.ptyId, data: 'alive\r\n' });

    mgr.killForWindow(TERM_WIN_ID);
    expect(host.posted.at(-1)).toEqual({ type: 'shutdown' });
    expect(host.killed).toBe(false);
    runShutdownTimers();
    expect(host.killed).toBe(true);
  });
});
