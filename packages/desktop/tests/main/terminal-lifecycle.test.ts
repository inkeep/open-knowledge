import { describe, expect, test } from 'vitest';
import {
  type ClosableWindow,
  type TerminalReaper,
  wireWindowTerminalReap,
} from '../../src/main/terminal-lifecycle.ts';
import {
  createTerminalManager,
  type PtyUtilityLike,
  type TerminalManager,
} from '../../src/main/terminal-manager.ts';
import type { SendableWebContents } from '../../src/shared/ipc-send.ts';
import type { PtyHostIncomingMessage } from '../../src/utility/pty-host.ts';

class FakeUtility {
  posted: PtyHostIncomingMessage[] = [];
  killed = 0;
  private exitCb: ((code: number | null) => void) | null = null;
  postMessage(m: PtyHostIncomingMessage): void {
    this.posted.push(m);
  }
  on(event: 'message' | 'exit', cb: (arg: never) => void): void {
    if (event === 'exit') this.exitCb = cb as (code: number | null) => void;
  }
  kill(): boolean {
    this.killed += 1;
    return true;
  }
  emitExit(code: number | null): void {
    this.exitCb?.(code);
  }
}

function makeWebContents(): SendableWebContents {
  return { send() {}, isDestroyed: () => false };
}

class FakeWindow implements ClosableWindow {
  private readonly closedCbs: Array<() => void> = [];
  private destroyed = false;
  constructor(private readonly _id: number) {}
  get id(): number {
    if (this.destroyed) throw new Error('Object has been destroyed');
    return this._id;
  }
  on(event: 'closed', cb: () => void): void {
    if (event === 'closed') this.closedCbs.push(cb);
  }
  close(): void {
    this.destroyed = true;
    for (const cb of this.closedCbs) cb();
  }
}

const PROJECT = '/Users/me/project';

function makeRig() {
  const forked: FakeUtility[] = [];
  const timers: Array<{ cb: () => void; ms: number; cancelled: boolean }> = [];
  const warnings: Array<Record<string, unknown>> = [];
  let idn = 0;
  const mgr: TerminalManager = createTerminalManager({
    forkPtyHost: () => {
      const u = new FakeUtility();
      forked.push(u);
      return u as unknown as PtyUtilityLike;
    },
    sendData: () => {},
    sendExit: () => {},
    newPtyId: () => `pty-${++idn}`,
    setTimer: (cb, ms) => {
      timers.push({ cb, ms, cancelled: false });
      return timers.length - 1;
    },
    clearTimer: (token) => {
      if (typeof token === 'number' && timers[token]) timers[token].cancelled = true;
    },
    logger: { warn: (event) => warnings.push(event) },
  });
  const reaper: TerminalReaper = mgr;
  function openTerminalWindow(id: number): { win: FakeWindow; ptyId: string } {
    const win = new FakeWindow(id);
    wireWindowTerminalReap(win, reaper);
    const res = mgr.create({
      windowId: id,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    if (!res.ok) throw new Error('expected a terminal to be created');
    return { win, ptyId: res.ptyId };
  }
  const runTimers = (): void => {
    for (const timer of timers) {
      if (!timer.cancelled) timer.cb();
      timer.cancelled = true;
    }
  };
  return { mgr, reaper, forked, timers, warnings, runTimers, openTerminalWindow };
}

describe('terminal lifecycle — window close reap', () => {
  test('closing a window requests host shutdown and force-kills after two seconds', () => {
    const rig = makeRig();
    const { win } = rig.openTerminalWindow(1);
    expect(rig.forked[0]?.killed).toBe(0);

    win.close();
    expect(rig.forked[0]?.posted.at(-1)).toEqual({ type: 'shutdown' });
    expect(rig.forked[0]?.killed).toBe(0);
    expect(rig.timers.at(-1)?.ms).toBe(2000);
    rig.runTimers();
    expect(rig.forked[0]?.killed).toBe(1);
    expect(rig.warnings).toContainEqual({ event: 'terminal-manager-shutdown-deadline' });

    rig.openTerminalWindow(1);
    expect(rig.forked).toHaveLength(2);
  });

  test('eager id capture: a window that throws on post-close id still reaps', () => {
    const rig = makeRig();
    const { win } = rig.openTerminalWindow(7);
    expect(() => win.close()).not.toThrow();
    expect(rig.forked[0]?.posted.at(-1)).toEqual({ type: 'shutdown' });
    rig.forked[0]?.emitExit(0);
    rig.runTimers();
    expect(rig.forked[0]?.killed).toBe(0);
  });

  test('closing a window that never opened a terminal is a no-op', () => {
    const rig = makeRig();
    const win = new FakeWindow(3);
    wireWindowTerminalReap(win, rig.reaper);
    expect(() => win.close()).not.toThrow();
    expect(rig.forked).toHaveLength(0);
  });
});

describe('terminal lifecycle — per-window isolation', () => {
  test('closing one window leaves the other window PTY alive and routable', () => {
    const rig = makeRig();
    const a = rig.openTerminalWindow(1);
    const b = rig.openTerminalWindow(2);

    a.win.close();
    expect(rig.forked[0]?.posted.at(-1)).toEqual({ type: 'shutdown' });
    rig.runTimers();
    expect(rig.forked[0]?.killed).toBe(1);
    expect(rig.forked[1]?.killed).toBe(0);

    rig.mgr.input({ windowId: 2, ptyId: b.ptyId, data: 'ls\r' });
    expect(rig.forked[1]?.posted.at(-1)).toEqual({
      type: 'input',
      ptyId: b.ptyId,
      data: 'ls\r',
    });
  });
});

describe('terminal lifecycle — hide does not kill', () => {
  test('a window kept open (panel hidden) keeps its shell alive and routable', () => {
    const rig = makeRig();
    const { ptyId } = rig.openTerminalWindow(1);
    rig.mgr.input({ windowId: 1, ptyId, data: 'echo still-alive\r' });
    expect(rig.forked[0]?.killed).toBe(0);
    expect(rig.forked[0]?.posted.at(-1)).toEqual({
      type: 'input',
      ptyId,
      data: 'echo still-alive\r',
    });
  });
});

describe('terminal lifecycle — app quit reap', () => {
  test('killAll reaps every window PTY host with no survivor', () => {
    const rig = makeRig();
    rig.openTerminalWindow(1);
    rig.openTerminalWindow(2);

    rig.reaper.killAll();
    expect(rig.forked[0]?.posted.at(-1)).toEqual({ type: 'shutdown' });
    expect(rig.forked[1]?.posted.at(-1)).toEqual({ type: 'shutdown' });
    rig.runTimers();
    expect(rig.forked[0]?.killed).toBe(1);
    expect(rig.forked[1]?.killed).toBe(1);

    rig.openTerminalWindow(3);
    expect(rig.forked).toHaveLength(3);
  });
});
