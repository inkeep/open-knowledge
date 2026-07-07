import { describe, expect, test } from 'bun:test';
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

/**
 * Multi-window lifecycle integration harness. Drives the REAL
 * `createTerminalManager` reaped through the REAL `wireWindowTerminalReap`
 * against fake windows + fake utilityProcess hosts — the only fakes are the
 * Electron boundary itself. Proves the cross-process wiring end to end:
 * window-close reaps only that window, hide does not kill, per-window
 * isolation holds, and app-quit reaps everything.
 *
 * The cross-process host reaping that prevents a real orphaned shell is the
 * other half — verified against a real node-pty shell under Node in
 * `tests/utility/pty-host.reap-harness.ts` (gated by `pty-host-reap.test.ts`).
 */

class FakeUtility {
  posted: PtyHostIncomingMessage[] = [];
  killed = 0;
  postMessage(m: PtyHostIncomingMessage): void {
    this.posted.push(m);
  }
  on(_event: 'message' | 'exit', _cb: (arg: never) => void): void {
    // The lifecycle harness drives create/input/kill, not host-originated
    // data/exit, so the message/exit subscriptions are intentionally inert.
  }
  kill(): boolean {
    this.killed += 1;
    return true;
  }
}

function makeWebContents(): SendableWebContents {
  return { send() {}, isDestroyed: () => false };
}

/**
 * Models an Electron BrowserWindow whose native object is destroyed BEFORE its
 * `'closed'` event fires — so `id` throws once closed. This is the real
 * failure-inducing input for the eager-id-capture guard: a reap closure that
 * deferred the `win.id` read would throw here instead of reaping.
 */
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
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const reaper: TerminalReaper = mgr;
  // Open a terminal for a fresh window and wire its close-reap, as production
  // does (manager.create in the ok:pty:create handler; wire in the factory).
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
  return { mgr, reaper, forked, openTerminalWindow };
}

describe('terminal lifecycle — window close reap', () => {
  test('closing a window kills its PTY host and deletes the map entry', () => {
    const rig = makeRig();
    const { win } = rig.openTerminalWindow(1);
    expect(rig.forked[0]?.killed).toBe(0);

    win.close();
    expect(rig.forked[0]?.killed).toBe(1);

    // Map entry deleted — a later create on the same window id forks anew.
    rig.openTerminalWindow(1);
    expect(rig.forked).toHaveLength(2);
  });

  test('eager id capture: a window that throws on post-close id still reaps', () => {
    const rig = makeRig();
    const { win } = rig.openTerminalWindow(7);
    // close() destroys the native window before firing 'closed' (FakeWindow.id
    // then throws). The reap must use the snapshotted id, not a deferred read.
    expect(() => win.close()).not.toThrow();
    expect(rig.forked[0]?.killed).toBe(1);
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
    expect(rig.forked[0]?.killed).toBe(1);
    expect(rig.forked[1]?.killed).toBe(0);

    // Window 2's shell still accepts input after window 1 closed.
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
    // "Hide" is a renderer-only concern — no close, no quit, no kill IPC reaches
    // the manager, so the only kill paths (close / quit / explicit kill) never
    // fire. The shell stays alive and still accepts input on reopen.
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
    expect(rig.forked[0]?.killed).toBe(1);
    expect(rig.forked[1]?.killed).toBe(1);

    // Map cleared — a later create forks a fresh host.
    rig.openTerminalWindow(3);
    expect(rig.forked).toHaveLength(3);
  });
});
