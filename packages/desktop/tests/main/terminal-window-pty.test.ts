/**
 * Seam 7 integration: a standalone terminal window — deliberately absent
 * from `windowsByPath` — resolves its PTY cwd from the windowId-keyed
 * terminalWindows registry (or homedir() when project-less) and yields a live
 * PTY. Composes the real registry + the real `resolvePtyProjectRoot` + a real
 * `terminalManager` over a fake pty-host, so the cwd that reaches `create()` is
 * the one the registry/resolver produced. The full real-shell fidelity is the
 * `_electron` smoke (terminal-window.e2e.ts); this is the gate-run rung.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createTerminalManager, type PtyUtilityLike } from '../../src/main/terminal-manager.ts';
import {
  getTerminalWindowContext,
  registerTerminalWindow,
  resolvePtyProjectRoot,
  unregisterTerminalWindow,
} from '../../src/main/terminal-window-registry.ts';
import type { SendableWebContents } from '../../src/shared/ipc-send.ts';

const HOME = '/Users/test-home';
const PROJECT = '/Users/me/proj';

class FakeHost {
  posted: Array<Record<string, unknown>> = [];
  postMessage(m: Record<string, unknown>): void {
    this.posted.push(m);
  }
  on(): void {}
  kill(): boolean {
    return true;
  }
}

function makeWebContents(): SendableWebContents {
  return { send() {}, isDestroyed: () => false };
}

function makeManager() {
  const forked: FakeHost[] = [];
  let idn = 0;
  const mgr = createTerminalManager({
    forkPtyHost: () => {
      const h = new FakeHost();
      forked.push(h);
      return h as unknown as PtyUtilityLike;
    },
    sendData: () => {},
    sendExit: () => {},
    newPtyId: () => `pty-${++idn}`,
    setTimer: () => 0,
    clearTimer: () => {},
    logger: { warn: () => {} },
  });
  return { mgr, forked };
}

/** The create handler's terminal-window cwd resolution: a terminal window is
 *  absent from windowsByPath, so cwd comes from the registry (or homedir). */
function resolveTerminalWindowCwd(windowId: number): string | null {
  return resolvePtyProjectRoot({
    editorProjectPath: null,
    terminalWindow: getTerminalWindowContext(windowId),
    homedir: HOME,
  });
}

const WIN_BOUND = 80_001;
const WIN_LESS = 80_002;
const WIN_A = 80_003;
const WIN_B = 80_004;

afterEach(() => {
  for (const id of [WIN_BOUND, WIN_LESS, WIN_A, WIN_B]) unregisterTerminalWindow(id);
});

describe('terminal window ok:pty:create cwd resolution (seam 7 / D10)', () => {
  test('a project-bound terminal window spawns a live PTY at its registered project root', () => {
    registerTerminalWindow(WIN_BOUND, { projectRoot: PROJECT });
    const cwd = resolveTerminalWindowCwd(WIN_BOUND);
    expect(cwd).toBe(PROJECT);

    const { mgr, forked } = makeManager();
    const result = mgr.create({
      windowId: WIN_BOUND,
      webContents: makeWebContents(),
      projectRoot: cwd,
      cols: 80,
      rows: 24,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a live PTY');
    expect(forked).toHaveLength(1);
    expect(forked[0]?.posted).toContainEqual({
      type: 'create',
      ptyId: result.ptyId,
      cwd: PROJECT,
      cols: 80,
      rows: 24,
    });
  });

  test('a project-less terminal window spawns a live PTY at the home directory (never null)', () => {
    registerTerminalWindow(WIN_LESS, { projectRoot: null });
    const cwd = resolveTerminalWindowCwd(WIN_LESS);
    expect(cwd).toBe(HOME);

    const { mgr, forked } = makeManager();
    const result = mgr.create({
      windowId: WIN_LESS,
      webContents: makeWebContents(),
      projectRoot: cwd,
      cols: 80,
      rows: 24,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a live PTY');
    expect(forked[0]?.posted).toContainEqual({
      type: 'create',
      ptyId: result.ptyId,
      cwd: HOME,
      cols: 80,
      rows: 24,
    });
  });

  test('multiple terminal windows for the same project each fork their own PTY host', () => {
    registerTerminalWindow(WIN_A, { projectRoot: PROJECT });
    registerTerminalWindow(WIN_B, { projectRoot: PROJECT });
    const { mgr, forked } = makeManager();

    const a = mgr.create({
      windowId: WIN_A,
      webContents: makeWebContents(),
      projectRoot: resolveTerminalWindowCwd(WIN_A),
      cols: 80,
      rows: 24,
    });
    const b = mgr.create({
      windowId: WIN_B,
      webContents: makeWebContents(),
      projectRoot: resolveTerminalWindowCwd(WIN_B),
      cols: 80,
      rows: 24,
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // Independent hosts (per-window), so closing one never reaps the other.
    expect(forked).toHaveLength(2);
  });
});
