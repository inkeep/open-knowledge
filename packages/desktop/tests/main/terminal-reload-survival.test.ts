import { describe, expect, test } from 'bun:test';
import {
  createTerminalManager,
  type PtyUtilityLike,
  type TerminalManager,
  type TerminalManagerDeps,
} from '../../src/main/terminal-manager.ts';
import type { SendableWebContents } from '../../src/shared/ipc-send.ts';
import type { PtyHostIncomingMessage } from '../../src/utility/pty-host.ts';

class FakeUtility {
  posted: PtyHostIncomingMessage[] = [];
  killed = 0;
  private msgCb: ((raw: unknown) => void) | null = null;
  private exitCb: ((code: number | null) => void) | null = null;
  postMessage(m: PtyHostIncomingMessage): void {
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

function makeManager(over?: Partial<TerminalManagerDeps>) {
  const forked: FakeUtility[] = [];
  let idn = 0;
  const mgr = createTerminalManager({
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
    logger: { warn: () => {} },
    ...over,
  });
  return { mgr, forked };
}

function resolveLiveSessionIds(mgr: TerminalManager, windowId: number): readonly string[] | null {
  const candidates = [
    'listSessions',
    'getSessions',
    'sessionsForWindow',
    'listSessionsForWindow',
    'snapshotSessions',
  ] as const;
  const bag = mgr as unknown as Record<string, unknown>;
  for (const name of candidates) {
    const fn = bag[name];
    if (typeof fn === 'function') {
      const out = (fn as (w: number) => unknown).call(mgr, windowId);
      return normalizeIds(out);
    }
  }
  return null;
}

function normalizeIds(out: unknown): readonly string[] {
  if (!Array.isArray(out)) return [];
  return out
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      const rec = entry as { ptyId?: unknown; id?: unknown } | null;
      if (typeof rec?.ptyId === 'string') return rec.ptyId;
      if (typeof rec?.id === 'string') return rec.id;
      return '';
    })
    .filter((id) => id !== '');
}

type AdoptOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function adoptViaManager(
  mgr: TerminalManager,
  req: { windowId: number; ptyId: string; webContents: SendableWebContents },
): AdoptOutcome | null {
  const candidates = ['adoptSession', 'adopt', 'adoptSessionForWindow'] as const;
  const bag = mgr as unknown as Record<string, unknown>;
  for (const name of candidates) {
    const fn = bag[name];
    if (typeof fn === 'function') {
      return (fn as (r: typeof req) => AdoptOutcome).call(mgr, req);
    }
  }
  return null;
}

const PROJECT = '/Users/me/project';

describe('issue #351 — the terminal manager exposes a per-window live-session inventory for reload rehydration', () => {
  test('enumerates the live sessions for a window and tracks their lifecycle', () => {
    const h = makeManager();
    const wc = makeWebContents();
    const a = h.mgr.create({
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const b = h.mgr.create({
      windowId: 1,
      webContents: wc,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const idA = (a as { ok: true; ptyId: string }).ptyId;
    const idB = (b as { ok: true; ptyId: string }).ptyId;

    const live = resolveLiveSessionIds(h.mgr, 1);
    expect(live, 'the manager exposes a per-window live-session enumerator').not.toBeNull();

    expect(new Set(live)).toEqual(new Set([idA, idB]));

    h.forked[0]?.emitMessage({ type: 'exit', ptyId: idA, exitCode: 0, signal: null });
    expect(new Set(resolveLiveSessionIds(h.mgr, 1))).toEqual(new Set([idB]));

    expect(resolveLiveSessionIds(h.mgr, 999)).toEqual([]);
  });

  test("a separate window's sessions are not reported for this window", () => {
    const h = makeManager();
    const a = h.mgr.create({
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.mgr.create({
      windowId: 2,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const idA = (a as { ok: true; ptyId: string }).ptyId;

    const live = resolveLiveSessionIds(h.mgr, 1);
    expect(live, 'the manager exposes a per-window live-session enumerator').not.toBeNull();
    expect(new Set(live)).toEqual(new Set([idA]));
  });
});

describe('issue #351 — re-adopting a surviving session is edge-correct across the reload gap', () => {
  test('a ptyId no longer live for the window is refused with unknown-session', () => {
    const h = makeManager();
    h.mgr.create({
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });

    const outcome = adoptViaManager(h.mgr, {
      windowId: 1,
      ptyId: 'pty-never-lived',
      webContents: makeWebContents(),
    });
    expect(outcome, 'the manager exposes a per-session adopt accessor').not.toBeNull();
    expect(outcome).toEqual({ ok: false, reason: 'unknown-session' });
  });

  test('adopting a live session succeeds and clears its stale backpressure', () => {
    const h = makeManager();
    const created = h.mgr.create({
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const idLive = (created as { ok: true; ptyId: string }).ptyId;

    const outcome = adoptViaManager(h.mgr, {
      windowId: 1,
      ptyId: idLive,
      webContents: makeWebContents(),
    });
    expect(outcome, 'the manager exposes a per-session adopt accessor').not.toBeNull();
    expect(outcome).toMatchObject({ ok: true });

    const host = h.forked[0];
    expect(host, 'window 1 forked a pty host').toBeDefined();
    const resumedLive = (host?.posted ?? []).some((m) => m.type === 'resume' && m.ptyId === idLive);
    expect(
      resumedLive,
      'adopt posts a resume to the host to clear stale backpressure for the adopted session',
    ).toBe(true);
  });

  test('adopting a live session replays its pre-reload output into the reloaded renderer', () => {
    const h = makeManager();
    const created = h.mgr.create({
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const idLive = (created as { ok: true; ptyId: string }).ptyId;

    const host = h.forked[0];
    if (!host) throw new Error('expected window 1 to have forked a pty host');
    host.emitMessage({ type: 'data', ptyId: idLive, data: 'total 0\r\n$ ' });
    host.emitMessage({ type: 'data', ptyId: idLive, data: 'echo hi\r\nhi\r\n$ ' });

    const outcome = adoptViaManager(h.mgr, {
      windowId: 1,
      ptyId: idLive,
      webContents: makeWebContents(),
    });
    expect(outcome, 'the manager exposes a per-session adopt accessor').not.toBeNull();
    expect(outcome).toMatchObject({ ok: true });

    const replay = (outcome as { ok: true; replay?: string }).replay;
    expect(replay, 'adopt returns the buffered output for replay').toBeDefined();
    expect(replay).toContain('total 0');
    expect(replay).toContain('hi');
  });

  test('adopt clears the stale outbound buffer so replayed bytes are not also delivered live (no duplicate)', () => {
    const timers: Array<() => void> = [];
    const delivered: string[] = [];
    const h = makeManager({
      setTimer: (cb) => {
        timers.push(cb);
        return timers.length - 1;
      },
      clearTimer: (tok) => {
        if (typeof tok === 'number') timers[tok] = () => {};
      },
      sendData: (_wc, payload) => {
        delivered.push(payload.data);
      },
    });
    const deadRenderer = makeWebContents();
    const created = h.mgr.create({
      windowId: 1,
      webContents: deadRenderer,
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const idLive = (created as { ok: true; ptyId: string }).ptyId;
    const host = h.forked[0];
    if (!host) throw new Error('expected window 1 to have forked a pty host');

    deadRenderer.destroyed = true;
    host.emitMessage({ type: 'data', ptyId: idLive, data: 'STALE-TAIL' });

    const outcome = adoptViaManager(h.mgr, {
      windowId: 1,
      ptyId: idLive,
      webContents: makeWebContents(),
    });
    expect((outcome as { ok: true; replay?: string }).replay).toContain('STALE-TAIL');

    for (const fire of timers) fire();
    expect(
      delivered,
      'adopt must drop the stale pre-reload outbound so it is not delivered again after replay',
    ).not.toContain('STALE-TAIL');
  });

  test('the replay buffer is capped — oldest output is trimmed, the recent tail is kept', () => {
    const h = makeManager({ replayCapBytes: 10 });
    const created = h.mgr.create({
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const idLive = (created as { ok: true; ptyId: string }).ptyId;

    const host = h.forked[0];
    if (!host) throw new Error('expected window 1 to have forked a pty host');
    host.emitMessage({ type: 'data', ptyId: idLive, data: 'AAAAAAAA' }); // 8
    host.emitMessage({ type: 'data', ptyId: idLive, data: 'BBBBBBBBBB' }); // +10 = 18

    const outcome = adoptViaManager(h.mgr, {
      windowId: 1,
      ptyId: idLive,
      webContents: makeWebContents(),
    });
    const replay = (outcome as { ok: true; replay?: string }).replay;
    expect(replay, 'adopt returns the (capped) replay buffer').toBeDefined();
    expect(replay).toHaveLength(10);
    expect(replay).toBe('BBBBBBBBBB');
    expect(replay).not.toContain('A');
  });

  test('a host that dies between the presence check and the resume post is refused and warned', () => {
    const warns: Record<string, unknown>[] = [];
    const h = makeManager({ logger: { warn: (o) => warns.push(o) } });
    const created = h.mgr.create({
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const idLive = (created as { ok: true; ptyId: string }).ptyId;

    const host = h.forked[0];
    if (!host) throw new Error('expected window 1 to have forked a pty host');
    host.postMessage = (m: PtyHostIncomingMessage) => {
      if (m.type === 'resume') throw Object.assign(new Error('gone'), { code: 'EPERM' });
    };

    const outcome = adoptViaManager(h.mgr, {
      windowId: 1,
      ptyId: idLive,
      webContents: makeWebContents(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'unknown-session' });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      event: 'terminal-manager-adopt-resume-failed',
      code: 'EPERM',
      windowId: 1,
      ptyId: idLive,
    });
  });

  test('the expected ESRCH host-already-gone code is refused silently (a normal reload race, not a fault)', () => {
    const warns: Record<string, unknown>[] = [];
    const h = makeManager({ logger: { warn: (o) => warns.push(o) } });
    const created = h.mgr.create({
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const idLive = (created as { ok: true; ptyId: string }).ptyId;

    const host = h.forked[0];
    if (!host) throw new Error('expected window 1 to have forked a pty host');
    host.postMessage = (m: PtyHostIncomingMessage) => {
      if (m.type === 'resume') throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    };

    const outcome = adoptViaManager(h.mgr, {
      windowId: 1,
      ptyId: idLive,
      webContents: makeWebContents(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'unknown-session' });
    expect(warns).toHaveLength(0);
  });

  test('a ptyId belonging to another window is refused (no cross-window adoption)', () => {
    const h = makeManager();
    const w1 = h.mgr.create({
      windowId: 1,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    h.mgr.create({
      windowId: 2,
      webContents: makeWebContents(),
      projectRoot: PROJECT,
      cols: 80,
      rows: 24,
    });
    const idW1 = (w1 as { ok: true; ptyId: string }).ptyId;

    const outcome = adoptViaManager(h.mgr, {
      windowId: 2,
      ptyId: idW1,
      webContents: makeWebContents(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'unknown-session' });
  });
});
