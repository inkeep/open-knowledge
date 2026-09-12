import { WINDOWS_SHELL_FAMILIES } from '@inkeep/open-knowledge-core';
import {
  TERMINAL_SHELL_NOTICE_REASONS,
  TERMINAL_SUPPORT_FILE_NOTICE_REASONS,
} from '@inkeep/open-knowledge-core/desktop-bridge';
import { describe, expect, test, vi } from 'vitest';
import {
  clampPtyDimension,
  createTerminalManager,
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  type PtyUtilityLike,
  type TerminalManagerDeps,
} from '../../src/main/terminal-manager.ts';
import type { SendableWebContents } from '../../src/shared/ipc-send.ts';
import type { PtyHostIncomingMessage } from '../../src/utility/pty-host.ts';
import { createStartedTerminal } from '../support/terminal-create.test-helper.ts';

class FakeUtility {
  posted: PtyHostIncomingMessage[] = [];
  attempted: PtyHostIncomingMessage[] = [];
  killed = 0;
  throwOnPost: unknown = null;
  private msgCb: ((raw: unknown) => void) | null = null;
  private exitCb: ((code: number | null) => void) | null = null;
  postMessage(m: PtyHostIncomingMessage): void {
    this.attempted.push(m);
    if (this.throwOnPost !== null) throw this.throwOnPost;
    this.posted.push(m);
  }
  on(event: 'message' | 'exit', cb: (arg: never) => void): void {
    if (event === 'message') this.msgCb = cb as (raw: unknown) => void;
    else this.exitCb = cb as (code: number | null) => void;
  }
  kill(): boolean {
    this.killed += 1;
    return true;
  }
  emitMessage(raw: unknown): void {
    this.msgCb?.(raw);
  }
  emitExit(code: number | null): void {
    this.exitCb?.(code);
  }
}

interface FakeWebContents extends SendableWebContents {
  destroyed: boolean;
}
function makeWebContents(): FakeWebContents {
  const wc: FakeWebContents = {
    destroyed: false,
    send() {},
    isDestroyed() {
      return wc.destroyed;
    },
  };
  return wc;
}

interface SentRecord {
  channel: string;
  payload: Record<string, unknown>;
}

function makeManager(over?: Partial<TerminalManagerDeps>) {
  const sent: SentRecord[] = [];
  const forked: FakeUtility[] = [];
  const timers: Array<(() => void) | null> = [];
  const timerDelays: number[] = [];
  const warns: Array<Record<string, unknown>> = [];
  let idn = 0;
  const mgr = createTerminalManager({
    canSpawnAt: () => true,
    forkPtyHost: () => {
      const u = new FakeUtility();
      forked.push(u);
      return u as unknown as PtyUtilityLike;
    },
    sendData: (_wc, payload) => {
      sent.push({ channel: 'ok:pty:data', payload: payload as unknown as Record<string, unknown> });
    },
    sendExit: (_wc, payload) => {
      sent.push({ channel: 'ok:pty:exit', payload: payload as unknown as Record<string, unknown> });
    },
    sendNotice: (_wc, payload) => {
      sent.push({
        channel: 'ok:pty:notice',
        payload: payload as unknown as Record<string, unknown>,
      });
    },
    newPtyId: () => `pty-${++idn}`,
    setTimer: (cb, ms) => {
      timers.push(cb);
      timerDelays.push(ms);
      return timers.length - 1;
    },
    clearTimer: (t) => {
      if (typeof t === 'number') timers[t] = null;
    },
    coalesceMs: 12,
    highWaterBytes: 100,
    lowWaterBytes: 20,
    logger: { warn: (o) => warns.push(o) },
    ...over,
  });
  const runTimers = (): void => {
    const snapshot = timers.slice();
    for (let i = 0; i < snapshot.length; i += 1) {
      const cb = snapshot[i];
      if (cb) {
        timers[i] = null;
        cb();
      }
    }
  };
  const dataPayloads = (): string[] =>
    sent.filter((s) => s.channel === 'ok:pty:data').map((s) => s.payload.data as string);
  const exits = (): Array<Record<string, unknown>> =>
    sent.filter((s) => s.channel === 'ok:pty:exit').map((s) => s.payload);
  const liveTimerCount = (): number => timers.filter((t) => t !== null).length;
  const staleTimerArmed = (): boolean => timers[0] !== null;
  return {
    mgr,
    staleTimerArmed,
    sent,
    forked,
    warns,
    runTimers,
    dataPayloads,
    exits,
    liveTimerCount,
    timerDelays,
  };
}

const PROJECT = '/Users/me/project';

describe('terminal creation waits for the renderer to subscribe', () => {
  function reserve(over?: Partial<TerminalManagerDeps>) {
    const h = makeManager(over);
    const webContents = makeWebContents();
    const result = h.mgr.create({
      windowId: 1,
      webContents,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
      launchCommand: 'echo ready',
    });
    expect(result).toEqual({ ok: true, ptyId: 'pty-1' });
    const start = () =>
      h.mgr.adoptSession({ windowId: 1, ptyId: 'pty-1', webContents, start: true });
    return { ...h, webContents, start };
  }

  test('neither create nor a replay request starts the shell; the first start starts it once', () => {
    const h = reserve();
    h.runTimers();
    expect(h.forked[0]?.posted).toEqual([]);
    expect(h.mgr.adoptSession({ windowId: 1, ptyId: 'pty-1', webContents: h.webContents })).toEqual(
      {
        ok: false,
        reason: 'not-started',
      },
    );
    expect(h.warns).toContainEqual(
      expect.objectContaining({ event: 'terminal-manager-adopt-unstarted-reservation' }),
    );
    expect(h.forked[0]?.posted).toEqual([]);
    expect(h.start()).toEqual({ ok: true, replay: '' });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'prompt$ ' });
    h.runTimers();
    expect(h.dataPayloads()).toEqual(['prompt$ ']);
    expect(h.forked[0]?.posted).toEqual([
      {
        type: 'create',
        ptyId: 'pty-1',
        cwd: PROJECT,
        cols: 80,
        rows: 24,
        launchCommand: 'echo ready',
      },
    ]);
  });

  test('a start against an already-live session adopts it instead of respawning', () => {
    const h = reserve();
    expect(h.start()).toEqual({ ok: true, replay: '' });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'prompt$ ' });
    h.runTimers();
    expect(h.start()).toEqual({ ok: true, replay: 'prompt$ ' });
    expect(h.forked[0]?.posted.filter((m) => m.type === 'create')).toHaveLength(1);
  });

  test('delivers immediate output and exit in order without needing later input', () => {
    const h = reserve();
    const utility = h.forked[0];
    if (!utility) throw new Error('missing host');
    vi.spyOn(utility, 'postMessage').mockImplementation((message) => {
      if (message.type !== 'create') return;
      utility.emitMessage({ type: 'data', ptyId: message.ptyId, data: 'prompt$ ' });
      utility.emitMessage({ type: 'exit', ptyId: message.ptyId, exitCode: 0, signal: null });
    });
    expect(h.sent).toEqual([]);
    expect(h.start()).toEqual({ ok: true, replay: '' });
    expect(h.sent).toEqual([
      { channel: 'ok:pty:data', payload: { ptyId: 'pty-1', data: 'prompt$ ' } },
      { channel: 'ok:pty:exit', payload: { ptyId: 'pty-1', exitCode: 0, signal: null } },
    ]);
    h.runTimers();
    expect(h.sent).toHaveLength(2);
    expect(h.mgr.listSessions(1)).toEqual([]);
  });

  test('delivers an immediate spawn failure after the start', () => {
    const h = reserve();
    const utility = h.forked[0];
    if (!utility) throw new Error('missing host');
    vi.spyOn(utility, 'postMessage').mockImplementation((message) => {
      if (message.type === 'create') {
        utility.emitMessage({ type: 'spawn-error', ptyId: message.ptyId, message: 'spawn failed' });
      }
    });
    h.start();
    expect(h.exits()).toEqual([{ ptyId: 'pty-1', error: 'spawn failed', neverStarted: true }]);
    expect(h.warns).toContainEqual(
      expect.objectContaining({ event: 'terminal-manager-spawn-error', ptyId: 'pty-1' }),
    );
  });

  test('cancels an unstarted tab without starting a shell', () => {
    const h = reserve();
    h.mgr.kill({ windowId: 1, ptyId: 'pty-1' });
    expect(h.start()).toEqual({ ok: false, reason: 'unknown-session' });
    expect(h.forked[0]?.posted).toEqual([]);
    expect(h.mgr.listSessions(1)).toEqual([]);
  });

  test('keeps the start scoped to the owning window', () => {
    const h = reserve();
    expect(
      h.mgr.adoptSession({ windowId: 2, ptyId: 'pty-1', webContents: h.webContents, start: true }),
    ).toEqual({
      ok: false,
      reason: 'unknown-session',
    });
    expect(h.forked[0]?.posted).toEqual([]);
    expect(h.start().ok).toBe(true);
  });

  test('applies pre-start resizing and posts no input until the shell starts', () => {
    const h = reserve();
    h.mgr.resize({ windowId: 1, ptyId: 'pty-1', cols: 100, rows: 40 });
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: 'too early\r' });
    expect(h.forked[0]?.posted).toEqual([]);
    h.start();
    expect(h.forked[0]?.posted[0]).toMatchObject({ type: 'create', cols: 100, rows: 40 });
  });

  test('reports a failed start and removes its reservation', () => {
    const h = reserve();
    const utility = h.forked[0];
    if (!utility) throw new Error('missing host');
    utility.throwOnPost = new Error('host gone');
    expect(h.start()).toEqual({ ok: false, reason: 'host-unavailable' });
    expect(h.mgr.listSessions(1)).toEqual([]);
    expect(h.warns).toContainEqual(
      expect.objectContaining({ event: 'terminal-manager-start-failed' }),
    );
  });

  test('reports an unavailable session when the host dies before the start', () => {
    const h = reserve();
    h.forked[0]?.emitExit(1);
    expect(h.start()).toEqual({ ok: false, reason: 'unknown-session' });
    expect(h.exits()).toEqual([{ ptyId: 'pty-1', neverStarted: true, hostExited: true }]);
    expect(h.warns).toContainEqual(
      expect.objectContaining({ event: 'terminal-manager-host-exited', reserved: 1 }),
    );
  });

  test('a killed session is refused by both adopt forms, and the refusal names the session', () => {
    const h = makeManager();
    const wc = makeWebContents();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.mgr.kill({ windowId: 1, ptyId: 'pty-1' });

    expect(h.mgr.adoptSession({ windowId: 1, ptyId: 'pty-1', webContents: wc })).toEqual({
      ok: false,
      reason: 'unknown-session',
    });
    expect(
      h.mgr.adoptSession({ windowId: 1, ptyId: 'pty-1', webContents: wc, start: true }),
    ).toEqual({ ok: false, reason: 'unknown-session' });
    expect(h.warns).toContainEqual(
      expect.objectContaining({
        event: 'terminal-manager-adopt-killed-session',
        windowId: 1,
        ptyId: 'pty-1',
      }),
    );
  });

  test('logs the reservations it reaps when the owning window closes', () => {
    const h = reserve();
    h.mgr.killForWindow(1);
    expect(h.warns).toContainEqual(
      expect.objectContaining({ event: 'terminal-manager-reaped-reservations', reserved: 1 }),
    );
  });

  test('logs the reservations it reaps when the app quits', () => {
    const h = reserve();
    h.mgr.killAll();
    expect(h.warns).toContainEqual(
      expect.objectContaining({ event: 'terminal-manager-reaped-reservations', reserved: 1 }),
    );
  });

  test('refuses to spawn when consent was withdrawn between the create and the start', () => {
    let consented = true;
    const h = reserve({ canSpawnAt: () => consented });
    consented = false;
    expect(h.start()).toEqual({ ok: false, reason: 'not-consented' });
    expect(h.forked[0]?.posted).toEqual([]);
    expect(h.mgr.listSessions(1)).toEqual([]);
    expect(h.warns).toContainEqual(
      expect.objectContaining({ event: 'terminal-manager-start-refused' }),
    );
  });

  test('a reservation is never offered for reload rehydration and listing does not cancel it', () => {
    const h = reserve();
    expect(h.mgr.listSessions(1)).toEqual([]);
    expect(h.start()).toEqual({ ok: true, replay: '' });
    expect(h.forked[0]?.posted).toHaveLength(1);
    expect(h.mgr.listSessions(1).map((e) => e.ptyId)).toEqual(['pty-1']);
  });

  test('a granted spawn check receives the reserved cwd and lets the create through', () => {
    const roots: string[] = [];
    const h = reserve({
      canSpawnAt: (root) => {
        roots.push(root);
        return root === PROJECT;
      },
    });
    expect(h.start()).toEqual({ ok: true, replay: '' });
    expect(roots).toEqual([PROJECT]);
    expect(h.forked[0]?.posted).toHaveLength(1);
  });

  test('a reservation left pending past the staleness threshold warns while the window is open', () => {
    const h = reserve();
    expect(h.timerDelays[0]).toBe(30_000);
    expect(h.warns).toEqual([]);
    h.runTimers();
    expect(h.warns).toContainEqual({
      event: 'terminal-manager-stale-reservation',
      windowId: 1,
      ptyId: 'pty-1',
    });
    expect(h.mgr.listSessions(1)).toEqual([]);
    expect(h.exits()).toEqual([]);
    expect(h.start()).toEqual({ ok: true, replay: '' });
  });

  test('a healthy handshake disarms the staleness warn', () => {
    const h = reserve();
    expect(h.staleTimerArmed()).toBe(true);
    expect(h.start()).toEqual({ ok: true, replay: '' });
    expect(h.staleTimerArmed()).toBe(false);
    h.runTimers();
    expect(h.warns).not.toContainEqual(
      expect.objectContaining({ event: 'terminal-manager-stale-reservation' }),
    );
  });

  test('a reaped reservation disarms the staleness warn', () => {
    const h = reserve();
    h.mgr.kill({ windowId: 1, ptyId: 'pty-1' });
    expect(h.staleTimerArmed()).toBe(false);
    h.runTimers();
    expect(h.warns).not.toContainEqual(
      expect.objectContaining({ event: 'terminal-manager-stale-reservation' }),
    );
  });

  test('killForWindow disarms the staleness warn', () => {
    const h = reserve();
    h.mgr.killForWindow(1);
    expect(h.staleTimerArmed()).toBe(false);
    h.runTimers();
    expect(h.warns).not.toContainEqual(
      expect.objectContaining({ event: 'terminal-manager-stale-reservation' }),
    );
  });

  test('a reservation deleted without its timer cleared warns for nobody', () => {
    const h = reserve({ clearTimer: () => {} });
    h.mgr.killForWindow(1);
    h.runTimers();
    expect(h.warns).not.toContainEqual(
      expect.objectContaining({ event: 'terminal-manager-stale-reservation' }),
    );
  });

  test('a live session stays listed while a sibling reservation stays hidden and startable', () => {
    const h = reserve();
    expect(h.start().ok).toBe(true);
    h.mgr.create({
      windowId: 1,
      webContents: h.webContents,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    expect(h.mgr.listSessions(1).map((e) => e.ptyId)).toEqual(['pty-1']);
    expect(
      h.mgr.adoptSession({
        windowId: 1,
        ptyId: 'pty-2',
        webContents: h.webContents,
        start: true,
      }),
    ).toEqual({ ok: true, replay: '' });
  });
});

describe('createTerminalManager — create', () => {
  test('forks a host, posts create at the project root, returns the ptyId', () => {
    const h = makeManager();
    const wc = makeWebContents();
    const r = createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    expect(r).toEqual({ ok: true, ptyId: 'pty-1' });
    expect(h.forked).toHaveLength(1);
    expect(h.forked[0]?.posted).toEqual([
      { type: 'create', ptyId: 'pty-1', cwd: PROJECT, cols: 80, rows: 24 },
    ]);
  });

  test('forwards configured and invalid shell override state to the host resolver', () => {
    const h = makeManager();
    const wc = makeWebContents();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
      shell: 'C:\\Tools\\pwsh.exe',
      shellInvalidReason: 'invalid-value',
    });

    expect(h.forked[0]?.posted[0]).toEqual({
      type: 'create',
      ptyId: 'pty-1',
      cwd: PROJECT,
      cols: 80,
      rows: 24,
      shell: 'C:\\Tools\\pwsh.exe',
      shellInvalidReason: 'invalid-value',
    });
  });

  test('forwards an invalid-override notice only to the addressed renderer session', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });

    h.forked[0]?.emitMessage({
      type: 'shell-notice',
      ptyId: 'pty-1',
      notice: 'invalid-shell-override',
      reason: 'not-found',
    });

    expect(h.sent).toContainEqual({
      channel: 'ok:pty:notice',
      payload: { ptyId: 'pty-1', notice: 'invalid-shell-override', reason: 'not-found' },
    });
  });

  test('forwards the resolved Windows shell family to the addressed renderer session', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });

    h.forked[0]?.emitMessage({
      type: 'shell-notice',
      ptyId: 'pty-1',
      notice: 'shell-resolved',
      shellFamily: 'bash',
    });

    expect(h.sent).toContainEqual({
      channel: 'ok:pty:notice',
      payload: { ptyId: 'pty-1', notice: 'shell-resolved', shellFamily: 'bash' },
    });
  });

  test.each([...TERMINAL_SHELL_NOTICE_REASONS])(
    'forwards the shared invalid-override reason %s to the renderer',
    (reason) => {
      const h = makeManager();
      createStartedTerminal(h.mgr, {
        windowId: 1,
        webContents: makeWebContents(),
        projectRoot: PROJECT,
        cols: 80,
        rows: 24,
      });

      h.forked[0]?.emitMessage({
        type: 'shell-notice',
        ptyId: 'pty-1',
        notice: 'invalid-shell-override',
        reason,
      });

      expect(h.sent).toContainEqual({
        channel: 'ok:pty:notice',
        payload: { ptyId: 'pty-1', notice: 'invalid-shell-override', reason },
      });
    },
  );

  test.each([...WINDOWS_SHELL_FAMILIES])(
    'forwards the shared resolved shell family %s to the renderer',
    (shellFamily) => {
      const h = makeManager();
      createStartedTerminal(h.mgr, {
        windowId: 1,
        webContents: makeWebContents(),
        projectRoot: PROJECT,
        cols: 80,
        rows: 24,
      });

      h.forked[0]?.emitMessage({
        type: 'shell-notice',
        ptyId: 'pty-1',
        notice: 'shell-resolved',
        shellFamily,
      });

      expect(h.sent).toContainEqual({
        channel: 'ok:pty:notice',
        payload: { ptyId: 'pty-1', notice: 'shell-resolved', shellFamily },
      });
    },
  );

  test.each([...TERMINAL_SUPPORT_FILE_NOTICE_REASONS])(
    'forwards the support-file degradation reason %s to the renderer',
    (reason) => {
      const h = makeManager();
      createStartedTerminal(h.mgr, {
        windowId: 1,
        webContents: makeWebContents(),
        projectRoot: PROJECT,
        cols: 80,
        rows: 24,
      });

      h.forked[0]?.emitMessage({
        type: 'shell-notice',
        ptyId: 'pty-1',
        notice: 'support-file-degraded',
        reason,
      });

      expect(h.sent).toContainEqual({
        channel: 'ok:pty:notice',
        payload: { ptyId: 'pty-1', notice: 'support-file-degraded', reason },
      });
    },
  );

  test('drops a shell notice whose reason or family is outside the shared sets', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });

    h.forked[0]?.emitMessage({
      type: 'shell-notice',
      ptyId: 'pty-1',
      notice: 'invalid-shell-override',
      reason: 'not-found-ish',
    });
    h.forked[0]?.emitMessage({
      type: 'shell-notice',
      ptyId: 'pty-1',
      notice: 'shell-resolved',
      shellFamily: 'zsh',
    });
    h.forked[0]?.emitMessage({
      type: 'shell-notice',
      ptyId: 'pty-1',
      notice: 'support-file-degraded',
      reason: 'escaped',
    });

    expect(h.sent.filter((s) => s.channel === 'ok:pty:notice')).toEqual([]);
    expect(h.warns.length).toBeGreaterThan(0);
  });

  test('drops a shell notice when the addressed WebContents is already destroyed', () => {
    const sendNotice = vi.fn((wc: SendableWebContents) => {
      if (wc.isDestroyed?.()) throw new Error('send on destroyed WebContents');
    });
    const h = makeManager({ sendNotice });
    const wc = makeWebContents();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    wc.destroyed = true;

    expect(() =>
      h.forked[0]?.emitMessage({
        type: 'shell-notice',
        ptyId: 'pty-1',
        notice: 'invalid-shell-override',
        reason: 'not-found',
      }),
    ).not.toThrow();
    expect(sendNotice).not.toHaveBeenCalled();
  });

  test('a window with no project root gets no terminal and no fork', () => {
    const h = makeManager();
    const r = createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: null,
      cols: 80,
      rows: 24,
    });
    expect(r).toEqual({ ok: false, reason: 'no-project' });
    expect(h.forked).toHaveLength(0);
  });

  test('a second create for the same window reuses the host with a fresh ptyId', () => {
    const h = makeManager();
    const wc = makeWebContents();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const r2 = createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 100,
      rows: 30,
    });
    expect(r2).toEqual({ ok: true, ptyId: 'pty-2' });
    expect(h.forked).toHaveLength(1);
    expect(h.forked[0]?.posted).toContainEqual({
      type: 'create',
      ptyId: 'pty-2',
      cwd: PROJECT,
      cols: 100,
      rows: 30,
    });
  });

  test('separate windows each fork their own host', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    createStartedTerminal(h.mgr, {
      windowId: 2,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    expect(h.forked).toHaveLength(2);
  });
});

describe('createTerminalManager — addressing', () => {
  function setup() {
    const h = makeManager();
    const wc = makeWebContents();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    return h;
  }

  test('routes input/resize/kill to the host for the live ptyId', () => {
    const h = setup();
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: 'ls -la\r' });
    h.mgr.resize({ windowId: 1, ptyId: 'pty-1', cols: 120, rows: 40 });
    h.mgr.kill({ windowId: 1, ptyId: 'pty-1' });
    const posted = h.forked[0]?.posted ?? [];
    expect(posted).toContainEqual({ type: 'input', ptyId: 'pty-1', data: 'ls -la\r' });
    expect(posted).toContainEqual({ type: 'resize', ptyId: 'pty-1', cols: 120, rows: 40 });
    expect(posted).toContainEqual({ type: 'kill', ptyId: 'pty-1' });
  });

  test('drops input for a stale ptyId (a superseded renderer cannot drive the live shell)', () => {
    const h = setup();
    const before = h.forked[0]?.posted.length ?? 0;
    h.mgr.input({ windowId: 1, ptyId: 'pty-OLD', data: 'rm -rf /\r' });
    expect(h.forked[0]?.posted.length).toBe(before);
  });

  test('drops input for an unknown window', () => {
    const h = setup();
    const before = h.forked[0]?.posted.length ?? 0;
    h.mgr.input({ windowId: 999, ptyId: 'pty-1', data: 'x' });
    expect(h.forked[0]?.posted.length).toBe(before);
  });
});

describe('createTerminalManager — coalescing + UTF-8 integrity', () => {
  test('batches multiple host reads into one push on the timer tick', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'a' });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'b' });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'c' });
    expect(h.dataPayloads()).toEqual([]);
    h.runTimers();
    expect(h.dataPayloads()).toEqual(['abc']);
  });

  test('concatenating whole reads preserves multibyte UTF-8 across the coalesce boundary', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: '日本' });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: '語 €' });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: ' 🚀' });
    h.runTimers();
    expect(h.dataPayloads()).toEqual(['日本語 € 🚀']);
  });

  test('drops host data tagged with a superseded ptyId', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-OLD', data: 'ghost' });
    h.runTimers();
    expect(h.dataPayloads()).toEqual([]);
  });
});

describe('createTerminalManager — exit + crash surfacing', () => {
  test('flushes buffered output before the exit state, then clears the pty', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'goodbye' });
    h.forked[0]?.emitMessage({ type: 'exit', ptyId: 'pty-1', exitCode: 0, signal: null });
    expect(h.sent.map((s) => s.channel)).toEqual(['ok:pty:data', 'ok:pty:exit']);
    expect(h.exits()[0]).toEqual({ ptyId: 'pty-1', exitCode: 0, signal: null });
    const before = h.forked[0]?.posted.length ?? 0;
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: 'x' });
    expect(h.forked[0]?.posted.length).toBe(before);
  });

  test('passes a crash signal through on the exit payload', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({ type: 'exit', ptyId: 'pty-1', exitCode: 0, signal: 9 });
    expect(h.exits()[0]).toEqual({ ptyId: 'pty-1', exitCode: 0, signal: 9 });
  });

  test('normalizes the node-pty undefined exitCode race before renderer delivery', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({
      type: 'exit',
      ptyId: 'pty-1',
      exitCode: undefined,
      signal: null,
    });

    expect(h.exits()[0]).toEqual({ ptyId: 'pty-1', exitCode: -1, signal: null });
  });

  test('maps a host spawn-error to a never-started exit carrying the message', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({
      type: 'spawn-error',
      ptyId: 'pty-1',
      message: 'EMFILE: too many open files',
    });
    expect(h.exits()[0]).toEqual({
      ptyId: 'pty-1',
      error: 'EMFILE: too many open files',
      neverStarted: true,
    });
  });

  test('maps a launch-composition failure to a structured reason, never to prose', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({
      type: 'spawn-error',
      ptyId: 'pty-1',
      launchFailure: 'unsafe-argument',
    });
    expect(h.exits()[0]).toEqual({
      ptyId: 'pty-1',
      launchFailure: 'unsafe-argument',
      neverStarted: true,
    });
    expect(h.warns).toContainEqual(
      expect.objectContaining({
        event: 'terminal-manager-spawn-error',
        launchFailure: 'unsafe-argument',
      }),
    );
  });

  test('rejects a spawn-error that carries neither a message nor a known launch reason', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({ type: 'spawn-error', ptyId: 'pty-1', launchFailure: 'made-up' });
    expect(h.exits()).toEqual([{ ptyId: 'pty-1', neverStarted: true }]);
    expect(h.warns).toContainEqual(
      expect.objectContaining({
        event: 'pty-host-unexpected-message',
        ptyId: 'pty-1',
        rawType: 'spawn-error',
        reaped: true,
      }),
    );
  });

  test('rejects a spawn-error carrying both a message and a launch reason', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({
      type: 'spawn-error',
      ptyId: 'pty-1',
      message: 'EACCES',
      launchFailure: 'unsafe-argument',
    });
    expect(h.exits()).toEqual([{ ptyId: 'pty-1', neverStarted: true }]);
    expect(h.warns).toContainEqual(
      expect.objectContaining({ event: 'pty-host-unexpected-message', reaped: true }),
    );
  });

  test('rejects a spawn-error whose message rides an out-of-vocabulary launch reason', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({
      type: 'spawn-error',
      ptyId: 'pty-1',
      message: 'spawn ENOENT',
      launchFailure: 'made-up',
    });
    expect(h.exits()).toEqual([{ ptyId: 'pty-1', neverStarted: true }]);
    expect(h.forked[0]?.posted).toContainEqual({ type: 'kill', ptyId: 'pty-1' });
    expect(h.warns).toContainEqual(
      expect.objectContaining({ event: 'pty-host-unexpected-message', reaped: true }),
    );
  });

  test('a reaped spawn-error drops its session and lands its exit before the best-effort kill post', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const utility = h.forked[0];
    if (!utility) throw new Error('missing host');
    utility.throwOnPost = new Error('injected post failure');
    try {
      utility.emitMessage({ type: 'spawn-error', ptyId: 'pty-1', launchFailure: 'made-up' });
    } catch (err) {
      if (err !== utility.throwOnPost) throw err;
    }
    expect(utility.attempted).toContainEqual({ type: 'kill', ptyId: 'pty-1' });
    expect(utility.posted).not.toContainEqual({ type: 'kill', ptyId: 'pty-1' });
    expect(h.exits()).toEqual([{ ptyId: 'pty-1', neverStarted: true }]);
    expect(h.mgr.listSessions(1)).toEqual([]);
    expect(h.warns).toContainEqual(
      expect.objectContaining({
        event: 'pty-host-unexpected-message',
        ptyId: 'pty-1',
        rawType: 'spawn-error',
        reaped: true,
      }),
    );
  });

  test('a rejected data message leaves the session running', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 42 });
    expect(h.exits()).toEqual([]);
    expect(h.mgr.listSessions(1).map((s) => s.ptyId)).toEqual(['pty-1']);
    expect(h.warns).toContainEqual(
      expect.objectContaining({
        event: 'pty-host-unexpected-message',
        rawType: 'data',
        reaped: false,
      }),
    );
  });

  test('a rejected spawn-error for an unknown session pushes no exit', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({
      type: 'spawn-error',
      ptyId: 'pty-absent',
      launchFailure: 'made-up',
    });
    expect(h.exits()).toEqual([]);
    expect(h.forked[0]?.posted).not.toContainEqual({ type: 'kill', ptyId: 'pty-absent' });
    expect(h.warns).toContainEqual(
      expect.objectContaining({
        event: 'pty-host-unexpected-message',
        ptyId: 'pty-absent',
        reaped: false,
      }),
    );
  });

  test('surfaces a utilityProcess crash as an exit and drops the dead host', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitExit(1);
    expect(h.exits()[0]).toEqual({
      ptyId: 'pty-1',
      exitCode: 1,
      signal: null,
      hostExited: true,
    });
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    expect(h.forked).toHaveLength(2);
  });

  test('flushes a session buffered output before its exit on a host crash', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'last gasp' });
    h.forked[0]?.emitExit(1);
    expect(h.sent.map((s) => s.channel)).toEqual(['ok:pty:data', 'ok:pty:exit']);
    expect(h.dataPayloads()).toEqual(['last gasp']);
  });

  test('ignores a malformed host message without crashing or sending', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    expect(() => {
      h.forked[0]?.emitMessage({ type: 'bogus' });
      h.forked[0]?.emitMessage(null);
      h.forked[0]?.emitMessage('not an object');
      h.forked[0]?.emitMessage({ ptyId: 'pty-1' });
    }).not.toThrow();
    h.runTimers();
    expect(h.sent).toEqual([]);
    expect(h.warns.length).toBeGreaterThan(0);
  });
});

describe('createTerminalManager — backpressure', () => {
  test('pauses the host when in-flight bytes cross the high-water mark', () => {
    const h = makeManager({ highWaterBytes: 100, lowWaterBytes: 20 });
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'x'.repeat(150) });
    h.runTimers();
    expect(h.forked[0]?.posted).toContainEqual({ type: 'pause', ptyId: 'pty-1' });
  });

  test('resumes only once drain acks bring in-flight back under the low-water mark', () => {
    const h = makeManager({ highWaterBytes: 100, lowWaterBytes: 20 });
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'x'.repeat(150) });
    h.runTimers();
    h.mgr.drain({ windowId: 1, ptyId: 'pty-1', bytes: 130 });
    expect(h.forked[0]?.posted).not.toContainEqual({ type: 'resume', ptyId: 'pty-1' });
    h.mgr.drain({ windowId: 1, ptyId: 'pty-1', bytes: 5 });
    expect(h.forked[0]?.posted).toContainEqual({ type: 'resume', ptyId: 'pty-1' });
  });

  test('does not resume a host that was never paused', () => {
    const h = makeManager({ highWaterBytes: 100, lowWaterBytes: 20 });
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'x'.repeat(10) });
    h.runTimers();
    h.mgr.drain({ windowId: 1, ptyId: 'pty-1', bytes: 10 });
    expect(h.forked[0]?.posted).not.toContainEqual({ type: 'resume', ptyId: 'pty-1' });
  });

  test('a kill lifts the pause it can no longer drain, before it posts the kill', () => {
    const h = makeManager({ highWaterBytes: 100, lowWaterBytes: 20 });
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'x'.repeat(150) });
    h.runTimers();
    expect(h.forked[0]?.posted).toContainEqual({ type: 'pause', ptyId: 'pty-1' });

    h.mgr.kill({ windowId: 1, ptyId: 'pty-1' });

    const posted = h.forked[0]?.posted ?? [];
    const resumedAt = posted.findIndex((m) => m.type === 'resume' && m.ptyId === 'pty-1');
    const killedAt = posted.findIndex((m) => m.type === 'kill' && m.ptyId === 'pty-1');
    expect(resumedAt).toBeGreaterThanOrEqual(0);
    expect(killedAt).toBeGreaterThan(resumedAt);
  });

  test('post-kill output does not re-arm the pause the kill just lifted', () => {
    const h = makeManager({ highWaterBytes: 100, lowWaterBytes: 20 });
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'x'.repeat(150) });
    h.runTimers();
    h.mgr.kill({ windowId: 1, ptyId: 'pty-1' });

    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'y'.repeat(150) });
    h.runTimers();

    expect(h.dataPayloads()).toEqual(['x'.repeat(150), 'y'.repeat(150)]);
    expect(
      (h.forked[0]?.posted ?? []).filter((m) => m.type === 'pause' && m.ptyId === 'pty-1'),
    ).toHaveLength(1);
  });

  test('a kill on an unpaused session posts no resume', () => {
    const h = makeManager({ highWaterBytes: 100, lowWaterBytes: 20 });
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'x'.repeat(10) });
    h.runTimers();

    h.mgr.kill({ windowId: 1, ptyId: 'pty-1' });

    expect(h.forked[0]?.posted).not.toContainEqual({ type: 'resume', ptyId: 'pty-1' });
    expect(h.forked[0]?.posted).toContainEqual({ type: 'kill', ptyId: 'pty-1' });
  });

  test('drain for a stale ptyId is ignored', () => {
    const h = makeManager({ highWaterBytes: 100, lowWaterBytes: 20 });
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'x'.repeat(150) });
    h.runTimers();
    h.mgr.drain({ windowId: 1, ptyId: 'pty-OLD', bytes: 200 });
    expect(h.forked[0]?.posted).not.toContainEqual({ type: 'resume', ptyId: 'pty-1' });
  });
});

describe('createTerminalManager — destroyed-window guard', () => {
  test('skips data + exit pushes once the window is destroyed', () => {
    const h = makeManager();
    const wc = makeWebContents();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    wc.destroyed = true;
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'late' });
    h.runTimers();
    h.forked[0]?.emitMessage({ type: 'exit', ptyId: 'pty-1', exitCode: 0, signal: null });
    expect(h.sent).toEqual([]);
  });

  test('a dead page does not spin the flush timer: a tick that delivered nothing stays disarmed', () => {
    const h = makeManager();
    const wc = makeWebContents();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    wc.destroyed = true;
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'a' });
    h.runTimers();
    expect(h.liveTimerCount()).toBe(0);
    expect(h.dataPayloads()).toEqual([]);
  });
});

describe('createTerminalManager — lifecycle reap', () => {
  test('killForWindow requests shutdown, then force-kills at the deadline', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const utility = h.forked[0];
    h.mgr.killForWindow(1);
    expect(utility?.posted.at(-1)).toEqual({ type: 'shutdown' });
    expect(utility?.killed).toBe(0);
    expect(h.timerDelays.at(-1)).toBe(2000);
    h.runTimers();
    expect(utility?.killed).toBe(1);
    expect(h.warns).toContainEqual({ event: 'terminal-manager-shutdown-deadline' });
    utility?.emitExit(0);
    expect(h.exits()).toEqual([]);
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    expect(h.forked).toHaveLength(2);
  });

  test('a cooperative host exit cancels the force-kill deadline', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const utility = h.forked[0];
    h.mgr.killForWindow(1);
    utility?.emitExit(0);
    h.runTimers();

    expect(utility?.posted.at(-1)).toEqual({ type: 'shutdown' });
    expect(utility?.killed).toBe(0);
  });

  test('killForWindow on an unknown window is a no-op', () => {
    const h = makeManager();
    expect(() => h.mgr.killForWindow(42)).not.toThrow();
  });

  test('killAll reaps every window host', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    createStartedTerminal(h.mgr, {
      windowId: 2,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.mgr.killAll();
    expect(h.forked[0]?.posted.at(-1)).toEqual({ type: 'shutdown' });
    expect(h.forked[1]?.posted.at(-1)).toEqual({ type: 'shutdown' });
    expect(h.forked[0]?.killed).toBe(0);
    expect(h.forked[1]?.killed).toBe(0);
    h.runTimers();
    expect(h.forked[0]?.killed).toBe(1);
    expect(h.forked[1]?.killed).toBe(1);
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    expect(h.forked).toHaveLength(3);
  });

  test('the killAll promise stays pending until the host exit arrives', async () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });

    let settled = false;
    const quit = h.mgr.killAll().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    h.forked[0]?.emitExit(0);
    await quit;
    expect(settled).toBe(true);
  });

  test('the killAll promise settles at the deadline when the host never exits', async () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });

    let settled = false;
    const quit = h.mgr.killAll().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    h.runTimers();
    await quit;
    expect(settled).toBe(true);
    expect(h.forked[0]?.killed).toBe(1);
  });

  test('killAll completes the reap even when one host throws on kill (no orphans)', () => {
    const forked: ThrowingUtility[] = [];
    const timers: Array<() => void> = [];
    let idn = 0;
    const mgr = createTerminalManager({
      canSpawnAt: () => true,
      forkPtyHost: () => {
        const u = new ThrowingUtility(forked.length === 0);
        forked.push(u);
        return u as unknown as PtyUtilityLike;
      },
      sendData: () => {},
      sendExit: () => {},
      newPtyId: () => `pty-${++idn}`,
      setTimer: (cb) => {
        timers.push(cb);
        return timers.length - 1;
      },
      clearTimer: () => {},
    });
    for (const windowId of [1, 2, 3]) {
      createStartedTerminal(mgr, {
        windowId,
        webContents: makeWebContents(),
        projectRoot: PROJECT,
        cols: 80,
        rows: 24,
      });
    }

    expect(() => mgr.killAll()).not.toThrow();
    for (const timer of timers) expect(() => timer()).not.toThrow();
    expect(forked.map((u) => u.killAttempts)).toEqual([1, 1, 1]);
  });

  test('a shutdown-send failure is surfaced even when it carries a kill-shaped code', () => {
    const h = makeManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const utility = h.forked[0];
    if (utility) utility.throwOnPost = Object.assign(new Error('post failed'), { code: 'ESRCH' });

    h.mgr.killForWindow(1);

    expect(h.warns).toContainEqual({
      event: 'terminal-manager-shutdown-send-failed',
      code: 'ESRCH',
    });
    expect(utility?.killed).toBe(1);
    expect(h.liveTimerCount()).toBe(0);
  });

  test('killForWindow swallows a throwing kill instead of crashing the reap', () => {
    const forked: ThrowingUtility[] = [];
    const timers: Array<() => void> = [];
    let idn = 0;
    const mgr = createTerminalManager({
      canSpawnAt: () => true,
      forkPtyHost: () => {
        const u = new ThrowingUtility(true);
        forked.push(u);
        return u as unknown as PtyUtilityLike;
      },
      sendData: () => {},
      sendExit: () => {},
      newPtyId: () => `pty-${++idn}`,
      setTimer: (cb) => {
        timers.push(cb);
        return timers.length - 1;
      },
      clearTimer: () => {},
    });
    createStartedTerminal(mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    expect(() => mgr.killForWindow(1)).not.toThrow();
    expect(() => timers.at(-1)?.()).not.toThrow();
    expect(forked[0]?.killAttempts).toBe(1);
  });
});

class ThrowingUtility {
  killAttempts = 0;
  constructor(private readonly throwsOnKill: boolean) {}
  postMessage(): void {}
  on(): void {}
  kill(): boolean {
    this.killAttempts += 1;
    if (this.throwsOnKill) throw new Error('host already gone');
    return true;
  }
}

describe('createTerminalManager — telemetry', () => {
  function makeTelemetryManager() {
    const shellExits: Array<{ crashed: boolean }> = [];
    const sessions: true[] = [];
    const concurrent: Array<{ count: number }> = [];
    const h = makeManager({
      recordShellExit: (info) => shellExits.push(info),
      recordTerminalSession: () => sessions.push(true),
      recordConcurrentSessions: (info) => concurrent.push(info),
    });
    const start = (windowId: number): void => {
      createStartedTerminal(h.mgr, {
        windowId,
        webContents: makeWebContents(),
        projectRoot: PROJECT,
        cols: 80,
        rows: 24,
      });
    };
    return { ...h, shellExits, sessions, concurrent, start };
  }

  test('a clean shell exit emits a non-crash shell-exit; no session without a command', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.forked[0]?.emitMessage({ type: 'exit', ptyId: 'pty-1', exitCode: 0, signal: null });
    expect(h.shellExits).toEqual([{ crashed: false }]);
    expect(h.sessions).toEqual([]);
  });

  test('a session with at least one command emits one terminal-session on exit', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: 'ls -la\r' });
    h.forked[0]?.emitMessage({ type: 'exit', ptyId: 'pty-1', exitCode: 0, signal: null });
    expect(h.sessions).toHaveLength(1);
    expect(h.shellExits).toEqual([{ crashed: false }]);
  });

  test('keystrokes without a line terminator do not count as a command', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: 'ls' });
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: ' -la' });
    h.forked[0]?.emitMessage({ type: 'exit', ptyId: 'pty-1', exitCode: 0, signal: null });
    expect(h.sessions).toEqual([]);
  });

  test('a newline-terminated input also counts as a command', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: 'pwd\n' });
    h.forked[0]?.emitMessage({ type: 'exit', ptyId: 'pty-1', exitCode: 0, signal: null });
    expect(h.sessions).toHaveLength(1);
  });

  test('a start that never reaches the host is not counted as a crashed shell', () => {
    const h = makeTelemetryManager();
    const wc = makeWebContents();
    const created = h.mgr.create({
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    expect(created.ok).toBe(true);
    const utility = h.forked[0];
    if (!utility) throw new Error('missing host');
    utility.throwOnPost = new Error('host gone');
    expect(
      h.mgr.adoptSession({ windowId: 1, ptyId: 'pty-1', webContents: wc, start: true }),
    ).toEqual({ ok: false, reason: 'host-unavailable' });
    expect(h.shellExits).toEqual([]);
  });

  test('the concurrency count reports live shells only, never outstanding reservations', () => {
    const h = makeTelemetryManager();
    const wc = makeWebContents();
    h.start(1);
    h.mgr.create({ windowId: 1, webContents: wc, projectRoot: PROJECT, cols: 80, rows: 24 });
    h.mgr.create({ windowId: 1, webContents: wc, projectRoot: PROJECT, cols: 80, rows: 24 });
    expect(
      h.mgr.adoptSession({ windowId: 1, ptyId: 'pty-2', webContents: wc, start: true }).ok,
    ).toBe(true);
    expect(h.concurrent).toEqual([{ count: 1 }, { count: 2 }]);
  });

  test('the concurrency count drops a killed shell at the kill, not at its exit', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.start(1);
    h.mgr.kill({ windowId: 1, ptyId: 'pty-1' });
    h.start(1);
    h.forked[0]?.emitMessage({ type: 'exit', ptyId: 'pty-1', exitCode: 0, signal: null });
    h.start(1);
    expect(h.concurrent.map((c) => c.count)).toEqual([1, 2, 2, 3]);
  });

  test('a host death books a shell the window had already closed as a clean exit', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.start(1);
    h.mgr.kill({ windowId: 1, ptyId: 'pty-1' });
    h.forked[0]?.emitExit(1);
    expect(h.shellExits).toEqual([{ crashed: false }, { crashed: true }]);
  });

  test('a spawn-error books no shell exit at all — the shell never ran', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.forked[0]?.emitMessage({ type: 'spawn-error', ptyId: 'pty-1', message: 'EMFILE' });
    expect(h.shellExits).toEqual([]);
    expect(h.sessions).toEqual([]);
    expect(h.warns).toContainEqual(
      expect.objectContaining({ event: 'terminal-manager-spawn-error', message: 'EMFILE' }),
    );
  });

  test('a host crash emits a crashed shell-exit and counts the session if a command ran', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: 'npm test\r' });
    h.forked[0]?.emitExit(1);
    expect(h.shellExits).toEqual([{ crashed: true }]);
    expect(h.sessions).toHaveLength(1);
  });

  test('a window-close reap counts the session but emits no shell-exit', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: 'git status\r' });
    h.mgr.killForWindow(1);
    expect(h.sessions).toHaveLength(1);
    expect(h.shellExits).toEqual([]);
  });

  test('a window-close reap with no command run emits neither signal', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.mgr.killForWindow(1);
    expect(h.sessions).toEqual([]);
    expect(h.shellExits).toEqual([]);
  });

  test('killAll counts only the windows that ran a command', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.start(2);
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: 'build\r' });
    h.mgr.killAll();
    expect(h.sessions).toHaveLength(1);
    expect(h.shellExits).toEqual([]);
  });

  test('each PTY lifecycle is one session: a post-restart shell with no command is not counted', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: 'first\r' });
    h.forked[0]?.emitMessage({ type: 'exit', ptyId: 'pty-1', exitCode: 0, signal: null });
    h.start(1);
    h.forked[0]?.emitMessage({ type: 'exit', ptyId: 'pty-2', exitCode: 0, signal: null });
    expect(h.sessions).toHaveLength(1);
    expect(h.shellExits).toEqual([{ crashed: false }, { crashed: false }]);
  });

  test('a window-close reap counts every concurrent session that ran a command', () => {
    const h = makeTelemetryManager();
    h.start(1);
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: 'a\r' });
    h.mgr.input({ windowId: 1, ptyId: 'pty-2', data: 'b\r' });
    h.mgr.killForWindow(1);
    expect(h.sessions).toHaveLength(2);
    expect(h.shellExits).toEqual([]);
  });

  test('a host crash emits a crashed shell-exit per session and counts only the ones that ran a command', () => {
    const h = makeTelemetryManager();
    h.start(1);
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: 'a\r' });
    h.forked[0]?.emitExit(1);
    expect(h.shellExits).toEqual([{ crashed: true }, { crashed: true }]);
    expect(h.sessions).toHaveLength(1);
  });

  test('each started shell emits the concurrency signal with the window’s live session count', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.start(1);
    expect(h.concurrent.map((c) => c.count)).toEqual([1, 2]);
  });

  test('a reservation that never started emits no concurrency signal', () => {
    const h = makeTelemetryManager();
    h.mgr.create({
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    expect(h.concurrent).toEqual([]);
  });

  test('a host crash books no crashed shell-exit for a session that never spawned', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.mgr.create({
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.forked[0]?.emitExit(1);
    expect(h.shellExits).toEqual([{ crashed: true }]);
    expect(h.exits().map((e) => e.ptyId)).toEqual(['pty-1', 'pty-2']);
  });

  test('concurrency is counted per window independently', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.start(1);
    h.start(2);
    expect(h.concurrent.map((c) => c.count)).toEqual([1, 2, 1]);
  });

  test('a create reaching a concurrency level again after an exit re-emits that level', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.start(1);
    h.forked[0]?.emitMessage({ type: 'exit', ptyId: 'pty-1', exitCode: 0, signal: null });
    h.start(1);
    expect(h.concurrent.map((c) => c.count)).toEqual([1, 2, 2]);
  });

  test('a refused create (no project) emits no concurrency signal', () => {
    const h = makeTelemetryManager();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: null,
      cols: 80,
      rows: 24,
    });
    expect(h.concurrent).toEqual([]);
  });

  test('a session exit does not emit a concurrency signal (it marks concurrency reached on open)', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.start(1);
    h.forked[0]?.emitMessage({ type: 'exit', ptyId: 'pty-1', exitCode: 0, signal: null });
    h.mgr.killForWindow(1);
    expect(h.concurrent.map((c) => c.count)).toEqual([1, 2]);
  });

  test('the concurrency signal carries only the bounded count — command input never leaks into it', () => {
    const h = makeTelemetryManager();
    h.start(1);
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: 'secret --token=abc\r' });
    h.start(1);
    expect(h.concurrent.every((c) => Object.keys(c).join(',') === 'count')).toBe(true);
    expect(h.concurrent.map((c) => c.count)).toEqual([1, 2]);
  });
});

describe('createTerminalManager — concurrent sessions', () => {
  function twoSessions(over?: Partial<TerminalManagerDeps>) {
    const h = makeManager({ highWaterBytes: 100, lowWaterBytes: 20, ...over });
    const wc = makeWebContents();
    const a = createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const b = createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    return { h, a, b };
  }
  const dataFor = (h: ReturnType<typeof makeManager>, ptyId: string): string[] =>
    h.sent
      .filter((s) => s.channel === 'ok:pty:data' && s.payload.ptyId === ptyId)
      .map((s) => s.payload.data as string);

  test('a second create adds a session over the same host without killing the first', () => {
    const { h, a, b } = twoSessions();
    expect(a).toEqual({ ok: true, ptyId: 'pty-1' });
    expect(b).toEqual({ ok: true, ptyId: 'pty-2' });
    expect(h.forked).toHaveLength(1);
    const posted = h.forked[0]?.posted ?? [];
    expect(posted).toContainEqual({
      type: 'create',
      ptyId: 'pty-1',
      cwd: PROJECT,
      cols: 80,
      rows: 24,
    });
    expect(posted).toContainEqual({
      type: 'create',
      ptyId: 'pty-2',
      cwd: PROJECT,
      cols: 80,
      rows: 24,
    });
    expect(posted.filter((m) => m.type === 'kill')).toEqual([]);
  });

  test('input routes to the addressed session only', () => {
    const { h } = twoSessions();
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: 'in-A\r' });
    h.mgr.input({ windowId: 1, ptyId: 'pty-2', data: 'in-B\r' });
    const posted = h.forked[0]?.posted ?? [];
    expect(posted).toContainEqual({ type: 'input', ptyId: 'pty-1', data: 'in-A\r' });
    expect(posted).toContainEqual({ type: 'input', ptyId: 'pty-2', data: 'in-B\r' });
  });

  test("each session's output renders only in its own tab", () => {
    const { h } = twoSessions();
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'alpha' });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-2', data: 'beta' });
    h.runTimers();
    expect(dataFor(h, 'pty-1')).toEqual(['alpha']);
    expect(dataFor(h, 'pty-2')).toEqual(['beta']);
  });

  test('a flood in one session pauses only that session; the other keeps flushing', () => {
    const { h } = twoSessions();
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'x'.repeat(150) });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-2', data: 'y'.repeat(10) });
    h.runTimers();
    const posted = h.forked[0]?.posted ?? [];
    expect(posted).toContainEqual({ type: 'pause', ptyId: 'pty-1' });
    expect(posted).not.toContainEqual({ type: 'pause', ptyId: 'pty-2' });
    expect(dataFor(h, 'pty-2')).toEqual(['y'.repeat(10)]);
  });

  test('drain resumes only the session that fell below the low-water mark', () => {
    const { h } = twoSessions();
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'x'.repeat(150) });
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-2', data: 'y'.repeat(150) });
    h.runTimers();
    expect(h.forked[0]?.posted).toContainEqual({ type: 'pause', ptyId: 'pty-1' });
    expect(h.forked[0]?.posted).toContainEqual({ type: 'pause', ptyId: 'pty-2' });
    h.mgr.drain({ windowId: 1, ptyId: 'pty-1', bytes: 140 });
    expect(h.forked[0]?.posted).toContainEqual({ type: 'resume', ptyId: 'pty-1' });
    expect(h.forked[0]?.posted).not.toContainEqual({ type: 'resume', ptyId: 'pty-2' });
  });

  test('a paused session never leaks its pause latch to a sibling', () => {
    const { h } = twoSessions();
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'x'.repeat(150) });
    h.runTimers();
    h.mgr.drain({ windowId: 1, ptyId: 'pty-2', bytes: 5 });
    expect(h.forked[0]?.posted).not.toContainEqual({ type: 'resume', ptyId: 'pty-2' });
  });

  test('an exit in one session leaves the other running', () => {
    const { h } = twoSessions();
    h.forked[0]?.emitMessage({ type: 'exit', ptyId: 'pty-1', exitCode: 0, signal: null });
    expect(h.exits()).toContainEqual({ ptyId: 'pty-1', exitCode: 0, signal: null });
    const before = h.forked[0]?.posted.length ?? 0;
    h.mgr.input({ windowId: 1, ptyId: 'pty-2', data: 'alive\r' });
    h.mgr.input({ windowId: 1, ptyId: 'pty-1', data: 'ghost\r' });
    expect(h.forked[0]?.posted.length).toBe(before + 1);
    expect(h.forked[0]?.posted).toContainEqual({ type: 'input', ptyId: 'pty-2', data: 'alive\r' });
  });

  test("one session's flood and pause do not disturb a sibling's exit accounting", () => {
    const { h } = twoSessions();
    h.forked[0]?.emitMessage({ type: 'data', ptyId: 'pty-1', data: 'x'.repeat(150) });
    h.runTimers();
    h.forked[0]?.emitMessage({ type: 'exit', ptyId: 'pty-2', exitCode: 0, signal: null });
    expect(h.exits()).toContainEqual({ ptyId: 'pty-2', exitCode: 0, signal: null });
    h.mgr.drain({ windowId: 1, ptyId: 'pty-1', bytes: 150 });
    expect(h.forked[0]?.posted).toContainEqual({ type: 'resume', ptyId: 'pty-1' });
  });

  test('a host crash surfaces an exit on every live session in the window', () => {
    const { h } = twoSessions();
    h.forked[0]?.emitExit(7);
    expect(h.exits()).toContainEqual({
      ptyId: 'pty-1',
      exitCode: 7,
      signal: null,
      hostExited: true,
    });
    expect(h.exits()).toContainEqual({
      ptyId: 'pty-2',
      exitCode: 7,
      signal: null,
      hostExited: true,
    });
  });

  test('killForWindow reaps a multi-session window with a single host kill', () => {
    const { h } = twoSessions();
    h.mgr.killForWindow(1);
    expect(h.forked).toHaveLength(1);
    expect(h.forked[0]?.posted.at(-1)).toEqual({ type: 'shutdown' });
    h.runTimers();
    expect(h.forked[0]?.killed).toBe(1);
  });
});

describe('clampPtyDimension', () => {
  test('passes a valid in-range integer through', () => {
    expect(clampPtyDimension(80, DEFAULT_PTY_COLS)).toBe(80);
    expect(clampPtyDimension(1, DEFAULT_PTY_ROWS)).toBe(1);
    expect(clampPtyDimension(1000, DEFAULT_PTY_COLS)).toBe(1000);
  });

  test('falls back for NaN, zero, negative, non-integer, and over-range values', () => {
    expect(clampPtyDimension(Number.NaN, DEFAULT_PTY_COLS)).toBe(DEFAULT_PTY_COLS);
    expect(clampPtyDimension(0, DEFAULT_PTY_COLS)).toBe(DEFAULT_PTY_COLS);
    expect(clampPtyDimension(-5, DEFAULT_PTY_ROWS)).toBe(DEFAULT_PTY_ROWS);
    expect(clampPtyDimension(40.5, DEFAULT_PTY_ROWS)).toBe(DEFAULT_PTY_ROWS);
    expect(clampPtyDimension(5_000_000, DEFAULT_PTY_COLS)).toBe(DEFAULT_PTY_COLS);
  });

  test('falls back for non-number inputs (a malformed renderer payload)', () => {
    expect(clampPtyDimension('80', DEFAULT_PTY_COLS)).toBe(DEFAULT_PTY_COLS);
    expect(clampPtyDimension(undefined, DEFAULT_PTY_ROWS)).toBe(DEFAULT_PTY_ROWS);
    expect(clampPtyDimension(null, DEFAULT_PTY_COLS)).toBe(DEFAULT_PTY_COLS);
  });
});

describe('createTerminalManager — reload-survival metadata (label + order)', () => {
  test('listSessions returns creation order with null label/ordinal until set', () => {
    const h = makeManager();
    const wc = makeWebContents();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    expect(h.mgr.listSessions(1)).toEqual([
      { ptyId: 'pty-1', customLabel: null, ordinal: null },
      { ptyId: 'pty-2', customLabel: null, ordinal: null },
    ]);
  });

  test('setSessionMeta persists name + ordinal, setSessionOrder reorders, listSessions restores both', () => {
    const h = makeManager();
    const wc = makeWebContents();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });

    h.mgr.setSessionMeta({ windowId: 1, ptyId: 'pty-1', customLabel: 'alpha', ordinal: 1 });
    h.mgr.setSessionMeta({ windowId: 1, ptyId: 'pty-3', customLabel: 'gamma', ordinal: 3 });
    h.mgr.setSessionOrder({ windowId: 1, orderedPtyIds: ['pty-3', 'pty-1', 'pty-2'] });

    expect(h.mgr.listSessions(1)).toEqual([
      { ptyId: 'pty-3', customLabel: 'gamma', ordinal: 3 },
      { ptyId: 'pty-1', customLabel: 'alpha', ordinal: 1 },
      { ptyId: 'pty-2', customLabel: null, ordinal: null },
    ]);
  });

  test('setSessionMeta is a partial update — one field never clobbers the other', () => {
    const h = makeManager();
    const wc = makeWebContents();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.mgr.setSessionMeta({ windowId: 1, ptyId: 'pty-1', ordinal: 5 });
    h.mgr.setSessionMeta({ windowId: 1, ptyId: 'pty-1', customLabel: 'renamed' });
    expect(h.mgr.listSessions(1)).toEqual([{ ptyId: 'pty-1', customLabel: 'renamed', ordinal: 5 }]);
    h.mgr.setSessionMeta({ windowId: 1, ptyId: 'pty-1', customLabel: null });
    expect(h.mgr.listSessions(1)).toEqual([{ ptyId: 'pty-1', customLabel: null, ordinal: 5 }]);
  });

  test('a session created after a reorder appends after the reordered block', () => {
    const h = makeManager();
    const wc = makeWebContents();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.mgr.setSessionOrder({ windowId: 1, orderedPtyIds: ['pty-2', 'pty-1'] });
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    expect(h.mgr.listSessions(1).map((e) => e.ptyId)).toEqual(['pty-2', 'pty-1', 'pty-3']);
  });

  test('setSessionMeta / setSessionOrder on an unknown window or ptyId is a no-op', () => {
    const h = makeManager();
    const wc = makeWebContents();
    createStartedTerminal(h.mgr, {
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.mgr.setSessionMeta({ windowId: 999, ptyId: 'pty-1', customLabel: 'x' });
    h.mgr.setSessionMeta({ windowId: 1, ptyId: 'pty-UNKNOWN', customLabel: 'x' });
    h.mgr.setSessionOrder({ windowId: 999, orderedPtyIds: ['pty-1'] });
    expect(h.mgr.listSessions(1)).toEqual([{ ptyId: 'pty-1', customLabel: null, ordinal: null }]);
  });
});
