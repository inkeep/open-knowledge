import { describe, expect, test } from 'bun:test';
import {
  createTerminalManager,
  type PtyUtilityLike,
  type TerminalManager,
  type TerminalManagerDeps,
} from '../../src/main/terminal-manager.ts';
import type { SendableWebContents } from '../../src/shared/ipc-send.ts';
import type { PtyHostIncomingMessage } from '../../src/utility/pty-host.ts';

/**
 * Terminal-dock reload-survival — the MAIN-process half.
 *
 * A renderer reload (View → Reload, or the window reload macOS sleep/wake forces)
 * tears down only the renderer page; the per-window PTY host and its live shells
 * survive in the main process (reaped only on window-close / app-quit). For the
 * reloaded renderer to rehydrate its dock, the main-side terminal subsystem must
 * be able to answer "which sessions are still alive for this window?".
 *
 * Today {@link TerminalManager} exposes only create / input / resize / kill /
 * drain / killForWindow / killAll — there is no enumeration accessor, so the
 * surviving sessions are unreachable and the dock can only ever spawn a brand-new
 * PTY. This test pins that missing CAPABILITY: it resolves the enumerator by the
 * natural candidate names and normalizes its return to the set of live ptyIds, so
 * it asserts the behavior (which sessions are live for a window) rather than a
 * specific accessor name or return shape.
 *
 * Harness: every IPC boundary is an injected
 * fake, so the manager runs without an Electron runtime.
 */

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

/**
 * Resolve the per-window live-session enumerator the reload-survival fix must add
 * to the manager, normalizing its result to the set of live ptyIds. The accessor
 * name and exact return shape are the fix's choice — this probes the natural
 * candidates and accepts either bare ptyId strings or `{ ptyId | id }` records,
 * returning `null` only when no such accessor exists at all. That `null` is the
 * RED signal: it means the capability is missing, not that a window is empty.
 */
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

/**
 * The typed result the renderer branches on when it tries to re-adopt a session
 * after a reload: a still-live session yields `{ ok: true }`; an id that is no
 * longer live for the window yields `{ ok: false, reason: 'unknown-session' }` so
 * the panel falls through to a fresh create instead of wiring to a dead shell.
 */
type AdoptOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Resolve the per-session adopt accessor the reload-survival fix must add, call it
 * with the adopt request, and return its result — or `null` when no such accessor
 * exists yet. The method name is the fix's choice; this probes the natural
 * candidates. The `null` is the RED signal (the capability is missing) and is kept
 * a clean assertion failure rather than a TypeError, so the gap reads as "not
 * built" rather than "crashed".
 */
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
    // The manager has no way to report its live sessions,
    // so a reloaded renderer cannot rediscover the shells that survived in main.
    expect(live, 'the manager exposes a per-window live-session enumerator').not.toBeNull();

    // Both freshly-created shells are reported live for their window.
    expect(new Set(live)).toEqual(new Set([idA, idB]));

    // A shell that exits drops out of the inventory — the renderer must not try to
    // re-adopt a dead session.
    h.forked[0]?.emitMessage({ type: 'exit', ptyId: idA, exitCode: 0, signal: null });
    expect(new Set(resolveLiveSessionIds(h.mgr, 1))).toEqual(new Set([idB]));

    // A window that never forked a host has nothing to rehydrate.
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
    // Window 1 sees only its own shell — the inventory is keyed by window, so a
    // reloaded renderer never adopts a sibling window's PTYs.
    expect(new Set(live)).toEqual(new Set([idA]));
  });
});

/**
 * The ADOPT half of reload-survival — the cross-time edges the dock's
 * list→adopt sequence must survive, which the happy-path E2E never exercises.
 *
 * Enumerating the live sessions (above) is only half the rehydration: the renderer
 * then re-adopts each surviving ptyId. Two real hazards sit on that adopt:
 *
 *  - The shell can exit between the dock's list and the panel's adopt (the session
 *    finishes, or the user's command returns, in that millisecond window). Adopt
 *    must report the session is gone — `{ ok: false, reason: 'unknown-session' }` —
 *    so the panel spawns a fresh shell instead of wiring xterm to a dead ptyId and
 *    showing a blank, permanently-"running" terminal.
 *  - A session paused under a >1 MiB pre-reload flood would stay paused forever:
 *    the new renderer only drain-acks bytes it receives, never the old in-flight
 *    ones the dead renderer was holding. Adopt must un-stick it by clearing the
 *    backpressure and telling the host to resume the PTY.
 *
 * Both are pinned through the PUBLIC adopt result plus the injected host fake's
 * recorded messages — never the manager's private `paused`/`pendingBytes`. The
 * behavioral contract
 * (unknown→refused, live→ok+resume) is what is fixed.
 */
describe('issue #351 — re-adopting a surviving session is edge-correct across the reload gap', () => {
  test('a ptyId no longer live for the window is refused with unknown-session', () => {
    const h = makeManager();
    // The window has a real live host + session, but we adopt a DIFFERENT id —
    // modelling the shell that exited between the dock's list and this adopt. The
    // handle is present; only the addressed session is gone (the genuine TOCTOU).
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
    // With no adopt accessor the renderer cannot tell a
    // surviving session from a dead one, so it would adopt the corpse blindly.
    expect(outcome, 'the manager exposes a per-session adopt accessor').not.toBeNull();
    // The typed refusal is the contract the panel branches on to fall through to a
    // fresh create — not a silent success that strands xterm on a dead ptyId.
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

    // The reloaded renderer hands main a fresh webContents and re-adopts the
    // surviving shell by its id.
    const outcome = adoptViaManager(h.mgr, {
      windowId: 1,
      ptyId: idLive,
      webContents: makeWebContents(),
    });
    expect(outcome, 'the manager exposes a per-session adopt accessor').not.toBeNull();
    // toMatchObject (not toEqual): a successful adopt also carries a `replay`
    // payload (the retained screen for the reloaded renderer); this test pins only
    // the ok-shape + the resume side effect, leaving replay to its own test below.
    expect(outcome).toMatchObject({ ok: true });

    // The observable side effect of clearing backpressure: the host is told to
    // resume the adopted PTY, so a session paused under a pre-reload flood does not
    // stay stuck. `create` never posts a resume, so this message is adopt's signal.
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

    // The shell produced output BEFORE the reload. Main observes it on the host
    // message channel — independent of the renderer page that has since been torn
    // down. (The harness `setTimer` never fires, so this never reaches the
    // renderer via flush; the replay buffer must accumulate it regardless.)
    const host = h.forked[0];
    if (!host) throw new Error('expected window 1 to have forked a pty host');
    host.emitMessage({ type: 'data', ptyId: idLive, data: 'total 0\r\n$ ' });
    host.emitMessage({ type: 'data', ptyId: idLive, data: 'echo hi\r\nhi\r\n$ ' });

    // The reloaded renderer re-adopts the surviving shell.
    const outcome = adoptViaManager(h.mgr, {
      windowId: 1,
      ptyId: idLive,
      webContents: makeWebContents(),
    });
    expect(outcome, 'the manager exposes a per-session adopt accessor').not.toBeNull();
    expect(outcome).toMatchObject({ ok: true });

    // The load-bearing contract: adopt hands back the pre-reload screen so the
    // fresh xterm can repaint it. Without this the adopted tab is blank — the
    // exact #351 follow-up symptom (tabs return, content empty/broken).
    const replay = (outcome as { ok: true; replay?: string }).replay;
    expect(replay, 'adopt returns the buffered output for replay').toBeDefined();
    expect(replay).toContain('total 0');
    expect(replay).toContain('hi');
  });

  test('adopt clears the stale outbound buffer so replayed bytes are not also delivered live (no duplicate)', () => {
    // Controllable timer + delivery capture: the default harness never fires
    // flushes, but this bug is exactly about a flush firing post-adopt against the
    // rebound webContents.
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

    // The renderer reloads: its webContents is destroyed. Output produced in the
    // gap accumulates in `outbound` (flush bails on isDestroyed without clearing)
    // and in `replay`, leaving a flush timer pending.
    deadRenderer.destroyed = true;
    host.emitMessage({ type: 'data', ptyId: idLive, data: 'STALE-TAIL' });

    // The reloaded renderer adopts with a fresh, live webContents. The replay it
    // gets back already contains 'STALE-TAIL', and the renderer paints that.
    const outcome = adoptViaManager(h.mgr, {
      windowId: 1,
      ptyId: idLive,
      webContents: makeWebContents(),
    });
    expect((outcome as { ok: true; replay?: string }).replay).toContain('STALE-TAIL');

    // Fire any flush timer left pending from before adopt. If adopt did not clear
    // `outbound` + the pending timer, this re-delivers 'STALE-TAIL' live to the
    // now-live renderer — duplicating what `replay` already painted.
    for (const fire of timers) fire();
    expect(
      delivered,
      'adopt must drop the stale pre-reload outbound so it is not delivered again after replay',
    ).not.toContain('STALE-TAIL');
  });

  test('the replay buffer is capped — oldest output is trimmed, the recent tail is kept', () => {
    // A tiny cap so the trim fires without producing 256 KiB of output. The cap is
    // injectable for exactly this reason (mirrors highWaterBytes/lowWaterBytes).
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
    // 18 chars of output past a 10-char cap: the front must be dropped.
    host.emitMessage({ type: 'data', ptyId: idLive, data: 'AAAAAAAA' }); // 8
    host.emitMessage({ type: 'data', ptyId: idLive, data: 'BBBBBBBBBB' }); // +10 = 18

    const outcome = adoptViaManager(h.mgr, {
      windowId: 1,
      ptyId: idLive,
      webContents: makeWebContents(),
    });
    const replay = (outcome as { ok: true; replay?: string }).replay;
    expect(replay, 'adopt returns the (capped) replay buffer').toBeDefined();
    // Bounded to the cap, and it is the RECENT tail — never the stale head.
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

    // The genuine TOCTOU on the WRITE: the session is present, but the pty host
    // exits in the instant before adopt's resume post — posting to a dead
    // utilityProcess throws. An unexpected (non-ESRCH) code is surfaced.
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
    // A dead host means a dead session: refuse so the panel spawns fresh rather
    // than wiring xterm to a shell that no longer exists.
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
    // ESRCH is the expected host-gone signal — refuse, but do not log it as a
    // diagnostic; mirrors safeKillUtility's TOCTOU handling.
    expect(warns).toHaveLength(0);
  });

  test('a ptyId belonging to another window is refused (no cross-window adoption)', () => {
    const h = makeManager();
    // Window 1 owns a live session; window 2 has its own independent host.
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

    // Window 2's reloaded renderer tries to adopt window 1's ptyId. The inventory
    // is window-keyed, so this must refuse — a reloaded page never wires xterm to
    // a sibling window's shell and crosses two projects' output streams.
    const outcome = adoptViaManager(h.mgr, {
      windowId: 2,
      ptyId: idW1,
      webContents: makeWebContents(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'unknown-session' });
  });
});
