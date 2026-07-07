/**
 * PTY flood harness — RUN UNDER NODE, not Bun.
 *
 * The no-precedent backpressure + UTF-8-integrity gate for the terminal's
 * real-PTY output path. This is the one place the main-side mediator
 * (`terminal-manager.ts`: read-coalescing + high/low-water `pause()`/`resume()`)
 * is wired to the real PTY host (`pty-host.ts`: node-pty `pause()`/`resume()`)
 * against a real login shell under sustained flood. The real-PTY output path
 * must not ship unless this stays green — nothing else proves the coalescing
 * keeps the consumer responsive, that backpressure bounds in-flight memory, or
 * that multibyte UTF-8 survives the real StringDecoder + coalesce boundaries.
 *
 * node-pty's PTY-fd reads are libuv-driven and do not pump under Bun (a spawned
 * shell yields zero bytes), so this runs under the Node runtime; `pty-flood.test.ts`
 * invokes it as a Node subprocess from Bun and asserts all scenarios report green.
 *
 * Four scenarios drive the real manager↔host path:
 *   1. fast consumer   — the loop stays responsive and bytes are byte-exact;
 *   2. slow consumer   — pause/resume bounds in-flight bytes far below the flood;
 *   3. two sessions    — a flood pauses ONLY its own PTY; bytes never cross tabs;
 *   4. N-way aggregate — concurrent floods isolate per-session; the active tab
 *                        completes once the fallback pauses the hidden sources.
 *
 * Scenarios 3-4 multiplex multiple real PTYs through ONE shared host per window,
 * proving the per-session isolation the single-PTY scenarios above cannot reach.
 */

import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createTerminalManager,
  type PtyUtilityLike,
  type TerminalManager,
} from '../../src/main/terminal-manager.ts';
import type { SendableWebContents } from '../../src/shared/ipc-send.ts';
import {
  type PtyHostHandle,
  type PtyHostIncomingMessage,
  type PtyHostOutgoingMessage,
  type SpawnPty,
  setupPtyHost,
} from '../../src/utility/pty-host.ts';

const require = createRequire(import.meta.url);

// node-pty's prebuilt `spawn-helper` ships mode 0644 (node-pty#850); a real PTY
// spawn fails with "posix_spawnp failed" until it is executable. The packaged
// app fixes this in afterPack; for the dev node_modules we chmod it here.
function ensureSpawnHelperExecutable(): void {
  const pkgDir = dirname(dirname(require.resolve('node-pty')));
  const helper = join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
}

const { spawn } = require('node-pty') as { spawn: SpawnPty };

// 8 UTF-16 code units / 19 UTF-8 bytes per unit — a deliberate mix of 3-byte
// CJK, a 4-byte (surrogate-pair) emoji, and 2-byte Greek, so a split anywhere
// on a read or coalesce boundary would surface as a U+FFFD. It appears only in
// the flooded file content — never in the shell prompt, the echoed `cat`
// command, or the completion sentinel — so an exact occurrence count is a clean
// integrity oracle.
const UNIT = '日本語🎉αβγ';
const SENTINEL = '__OKFLOOD_42__';
// `$((6*7))` resolves to 42 only when the shell EVALUATES it; the echoed input
// line keeps the literal, so the sentinel matches the program output alone.
const SENTINEL_CMD = '__OKFLOOD_$((6*7))__';
const PTY_ID = 'flood-pty';
const COALESCE_MS = 12;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// A flood is "done" when its CONTENT has fully arrived (the `units` occurrences
// the scenario already asserts) — NOT when a trailing `echo` sentinel appears.
// node-pty can DEFER a tiny trailing read across a pause()/resume() cycle, so
// the shell's final sentinel line is intermittently stranded in the PTY even
// though every flood byte was delivered (the coalescer flushes everything it
// receives; the residual is stuck below it). Gating completion on that sentinel
// timed the harness out on a perfectly-correct, byte-complete flood.
//
// The wait is also gated on PROGRESS, not an absolute wall-clock budget: a
// real-PTY flood on a contended runner is arbitrarily slow but still advances,
// so "done within T ms" turns a slow-but-correct run into a flake. Resolve when
// `done()`; fail only on a true stall (no advance in `progress()` for STALL_MS)
// or the HARD_CAP_MS deadlock backstop (kept under the 120s harness hardTimeout).
const FLOOD_STALL_MS = 15_000;
const FLOOD_HARD_CAP_MS = 90_000;

async function waitForFloodCompletion(
  done: () => boolean,
  progress: () => number,
  label: string,
): Promise<void> {
  const start = Date.now();
  let lastAdvance = start;
  let last = progress();
  while (!done()) {
    await sleep(20);
    const now = progress();
    if (now !== last) {
      last = now;
      lastAdvance = Date.now();
    } else if (Date.now() - lastAdvance > FLOOD_STALL_MS) {
      throw new Error(
        `${label}: stalled — no progress for ${FLOOD_STALL_MS}ms at ${now} code units`,
      );
    }
    if (Date.now() - start > FLOOD_HARD_CAP_MS) {
      throw new Error(
        `${label}: exceeded ${FLOOD_HARD_CAP_MS}ms backstop at ${progress()} code units`,
      );
    }
  }
}

/**
 * In-process stand-in for the per-window `utilityProcess` + its `parentPort`.
 * It is the SAME protocol the production fork marshals — the manager's
 * `postMessage` lands on the host's `parentPort` message handler, and the
 * host's `parentPort.postMessage` fans out to the manager's subscribers — only
 * without a process hop, so a single Node loop runs both real modules + real
 * node-pty. `pause`/`resume` counts are observed here because they cross this
 * real IPC contract; they corroborate (not stand in for) the bounded-in-flight
 * outcome the slow-consumer scenario asserts.
 */
class InProcessBridge implements PtyUtilityLike {
  pauseCount = 0;
  resumeCount = 0;
  // Per-ptyId tallies — the multi-session scenarios assert a flood pauses ONLY
  // its own PTY, which the aggregate counters above structurally can't witness.
  private readonly pausesByPty = new Map<string, number>();
  private readonly resumesByPty = new Map<string, number>();
  private hostHandler: ((event: { data: unknown }) => void) | null = null;
  private readonly msgSubs: Array<(message: unknown) => void> = [];
  private readonly exitSubs: Array<(code: number | null) => void> = [];
  private readonly hostHandle: PtyHostHandle;

  constructor(spawnPty: SpawnPty, env: Record<string, string | undefined>) {
    this.hostHandle = setupPtyHost({
      parentPort: {
        on: (_event, handler) => {
          this.hostHandler = handler;
        },
        postMessage: (value: PtyHostOutgoingMessage) => {
          for (const sub of this.msgSubs) sub(value);
        },
      },
      spawn: spawnPty,
      env,
    });
  }

  postMessage(message: PtyHostIncomingMessage): void {
    if (message.type === 'pause') {
      this.pauseCount += 1;
      this.pausesByPty.set(message.ptyId, (this.pausesByPty.get(message.ptyId) ?? 0) + 1);
    } else if (message.type === 'resume') {
      this.resumeCount += 1;
      this.resumesByPty.set(message.ptyId, (this.resumesByPty.get(message.ptyId) ?? 0) + 1);
    }
    this.hostHandler?.({ data: message });
  }

  pauseCountFor(ptyId: string): number {
    return this.pausesByPty.get(ptyId) ?? 0;
  }

  resumeCountFor(ptyId: string): number {
    return this.resumesByPty.get(ptyId) ?? 0;
  }

  on(event: 'message', cb: (message: unknown) => void): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'message' | 'exit', cb: (arg: never) => void): void {
    if (event === 'message') this.msgSubs.push(cb as (message: unknown) => void);
    else this.exitSubs.push(cb as (code: number | null) => void);
  }

  kill(): boolean {
    this.reap();
    for (const sub of this.exitSubs) sub(0);
    return true;
  }

  /** Reap the real shell on teardown (idempotent — `safeKill` swallows ESRCH). */
  reap(): void {
    this.hostHandle.killActive();
  }
}

interface FloodOptions {
  units: number;
  highWaterBytes: number;
  lowWaterBytes: number;
  drain: 'immediate' | 'metered';
  /** Metered only: hold off draining until backpressure has paused the source. */
  stallUntilPaused?: boolean;
  meterUnitsPerTick?: number;
  meterTickMs?: number;
  heartbeat?: boolean;
}

interface FloodMetrics {
  units: number;
  receivedUnitCount: number;
  hasReplacementChar: boolean;
  totalPushedCodeUnits: number;
  pushCount: number;
  maxInFlight: number;
  pauseCount: number;
  resumeCount: number;
  maxHeartbeatGapMs: number;
  heartbeats: number;
  floodMs: number;
  // Diagnostic only: whether the trailing sentinel echo arrived. Completion is
  // gated on content, not this — a false value is the node-pty trailing-read
  // defer, harmless once completion no longer depends on it.
  sawSentinel: boolean;
}

async function runFloodScenario(opts: FloodOptions): Promise<FloodMetrics> {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pty-flood-')));
  const file = join(tmp, 'flood.txt');
  writeFileSync(file, UNIT.repeat(opts.units), 'utf8');

  const bridge = new InProcessBridge(spawn, { ...process.env });

  const chunks: string[] = [];
  let totalPushed = 0;
  let totalAcked = 0;
  let pushCount = 0;
  let maxInFlight = 0;
  let tail = '';
  let sawSentinel = false;
  let drainEnabled = opts.drain === 'immediate';

  const webContents: SendableWebContents = { send: () => {}, isDestroyed: () => false };

  let manager!: TerminalManager;
  // Acking models the renderer's `drain` reply. NEVER call it synchronously from
  // inside `sendData` — the manager increments its in-flight accounting AFTER
  // `sendData` returns, so a synchronous drain would underflow that accounting
  // (reentrancy). A microtask defers the ack out of the flush call stack, which
  // also matches the real async IPC round-trip.
  const ackBytes = (n: number): void => {
    totalAcked += n;
    manager.drain({ windowId: 1, ptyId: PTY_ID, bytes: n });
  };

  manager = createTerminalManager({
    forkPtyHost: () => bridge,
    sendData: (_wc, payload) => {
      chunks.push(payload.data);
      totalPushed += payload.data.length;
      pushCount += 1;
      const inFlight = totalPushed - totalAcked;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      tail = (tail + payload.data).slice(-256);
      if (!sawSentinel && tail.includes(SENTINEL)) sawSentinel = true;
      if (opts.drain === 'immediate' && drainEnabled) {
        const n = payload.data.length;
        queueMicrotask(() => ackBytes(n));
      }
    },
    sendExit: () => {},
    newPtyId: () => PTY_ID,
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    coalesceMs: COALESCE_MS,
    highWaterBytes: opts.highWaterBytes,
    lowWaterBytes: opts.lowWaterBytes,
  });

  let lastBeat = 0;
  let maxGap = 0;
  let beats = 0;
  let measuring = false;
  const heartbeat = opts.heartbeat
    ? setInterval(() => {
        const now = Date.now();
        if (measuring && lastBeat > 0) {
          const gap = now - lastBeat;
          if (gap > maxGap) maxGap = gap;
          beats += 1;
        }
        lastBeat = now;
      }, 10)
    : null;

  const meterUnits = opts.meterUnitsPerTick ?? 262144;
  const meterMs = opts.meterTickMs ?? 20;
  const pump =
    opts.drain === 'metered'
      ? setInterval(() => {
          if (!drainEnabled) return;
          const available = totalPushed - totalAcked;
          if (available <= 0) return;
          ackBytes(Math.min(meterUnits, available));
        }, meterMs)
      : null;

  try {
    manager.create({ windowId: 1, webContents, projectRoot: tmp, cols: 80, rows: 24 });
    await waitFor(() => totalPushed > 0, 'shell prompt', 15000);

    const floodStart = Date.now();
    measuring = true;
    manager.input({ windowId: 1, ptyId: PTY_ID, data: `cat '${file}'; echo ${SENTINEL_CMD}\r` });

    if (opts.stallUntilPaused) {
      // A zero-drain stall guarantees in-flight climbs past the high-water mark
      // and the source pauses, independent of pty throughput; only then do we
      // start draining, which guarantees the matching resume.
      await waitFor(() => bridge.pauseCount > 0, 'backpressure pause to engage', 20000);
      drainEnabled = true;
    }

    // Done when the full flood content has arrived (the units we assert below),
    // gated on progress — not on the trailing sentinel, which node-pty can defer.
    const expectedCodeUnits = opts.units * UNIT.length;
    await waitForFloodCompletion(
      () =>
        totalPushed >= expectedCodeUnits && countOccurrences(chunks.join(''), UNIT) >= opts.units,
      () => totalPushed,
      'flood content fully delivered',
    );
    const floodMs = Date.now() - floodStart;
    measuring = false;

    const all = chunks.join('');
    return {
      units: opts.units,
      receivedUnitCount: countOccurrences(all, UNIT),
      hasReplacementChar: all.includes('�'),
      totalPushedCodeUnits: totalPushed,
      pushCount,
      maxInFlight,
      pauseCount: bridge.pauseCount,
      resumeCount: bridge.resumeCount,
      maxHeartbeatGapMs: maxGap,
      heartbeats: beats,
      floodMs,
      sawSentinel,
    };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (pump) clearInterval(pump);
    try {
      manager.kill({ windowId: 1, ptyId: PTY_ID });
    } catch {
      // Best-effort: the shell may already be gone.
    }
    bridge.reap();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Best-effort tmpdir cleanup.
    }
  }
}

const results: Array<{ name: string; ok: boolean }> = [];
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name} :: ${(err as Error).message}`);
  }
}

// Responsiveness wants a sustained window so the heartbeat is exercised across
// many ticks (a frozen loop then shows as a long gap); backpressure wants only
// enough volume to cycle pause/resume several times. Sized accordingly.
const FLOOD_UNITS_RESPONSIVE = 1_500_000; // ~28.5 MB UTF-8 / 12M UTF-16 code units
const FLOOD_UNITS_BACKPRESSURE = 300_000; // ~5.7 MB UTF-8 / 2.4M UTF-16 code units
// The gap gate is secondary to the load-independent push-count assertion; on a
// CPU-starved CI runner a fixed 500ms can false-fail, so allow an env override.
const MAX_HEARTBEAT_GAP_MS = (() => {
  const override = Number(process.env.OK_FLOOD_MAX_GAP_MS);
  return Number.isFinite(override) && override > 0 ? override : 500;
})();

// ── Multi-session (tabs): concurrent real PTYs through ONE window host ────────
//
// The window host multiplexes N PTYs. These scenarios drive several real shells
// through ONE InProcessBridge + ONE manager (one manager.create() per session,
// each minting a fresh ptyId) to exercise the per-session isolation the
// single-session scenarios above structurally cannot reach: backpressure,
// byte-exactness, and cross-session non-interference under concurrent floods. A
// faked-host manager unit test can't reach it either — only real shells flooding
// through the real host expose a routing or pause-sharing regression.

// Distinct multibyte content per session: a cross-session leak surfaces as the
// wrong marker in a session's bucket AND a wrong unit count. The scripts are
// disjoint (A Japanese, B Korean, active Chinese), so a marker uniquely names
// its origin session, and each mixes 2-/3-/4-byte sequences so a split on any
// read or coalesce boundary surfaces as U+FFFD.
const UNIT_A = '日本語🎉αβγ';
const UNIT_B = '한국어🚀ΔΣΩ';
const UNIT_ACTIVE = '中文🌟λμν';
const SENTINEL_A = '__OKFLOOD_A_42__';
const SENTINEL_A_CMD = '__OKFLOOD_A_$((6*7))__';
const SENTINEL_B = '__OKFLOOD_B_42__';
const SENTINEL_B_CMD = '__OKFLOOD_B_$((6*7))__';
const SENTINEL_ACTIVE = '__OKFLOOD_ACTIVE_42__';
const SENTINEL_ACTIVE_CMD = '__OKFLOOD_ACTIVE_$((6*7))__';
// `yes '<marker>'` is the unbounded source for the hidden floods; the marker is
// ASCII so it can never appear in a multibyte bucket — the active session
// asserts zero occurrences of it.
const HIDDEN_MARKER = 'HIDDEN_FLOOD_LINE';

interface SessionRuntime {
  readonly ptyId: string;
  readonly sentinel: string;
  readonly accumulate: boolean;
  readonly drainMode: 'immediate' | 'metered';
  readonly meterUnitsPerTick: number;
  /** Toggled to model the renderer acking (true) or withholding (false) drain. */
  drainEnabled: boolean;
  readonly chunks: string[];
  totalPushed: number;
  totalAcked: number;
  pushCount: number;
  tail: string;
  sawFirstByte: boolean;
  sawSentinel: boolean;
}

interface AddSessionSpec {
  sentinel: string;
  drainMode: 'immediate' | 'metered';
  /** Keep the full received stream (default true). Hidden floods set false so an
   *  unbounded `yes` stream doesn't accumulate gigabytes of chunks. */
  accumulate?: boolean;
  meterUnitsPerTick?: number;
}

interface MultiSessionRig {
  readonly bridge: InProcessBridge;
  readonly tmp: string;
  addSession(spec: AddSessionSpec): SessionRuntime;
  input(session: SessionRuntime, data: string): void;
  inFlight(session: SessionRuntime): number;
  received(session: SessionRuntime): string;
  cleanup(): void;
}

// Live rigs, so an abnormal harness exit still reaps their real shells — the
// unbounded `yes` floods would otherwise orphan to the init process and spin.
const activeRigCleanups = new Set<() => void>();

function reapActiveRigs(): void {
  // Each cleanup deletes only itself from the set, which is safe to do while
  // iterating it (the current element is allowed to be removed mid-iteration).
  for (const cleanup of activeRigCleanups) {
    try {
      cleanup();
    } catch {
      // Best-effort reap on an abnormal exit path.
    }
  }
}

function writeFloodFile(tmp: string, name: string, unit: string, units: number): string {
  const file = join(tmp, name);
  writeFileSync(file, unit.repeat(units), 'utf8');
  return file;
}

function createMultiSessionRig(opts: {
  highWaterBytes: number;
  lowWaterBytes: number;
  meterTickMs?: number;
}): MultiSessionRig {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ok-pty-multi-')));
  const bridge = new InProcessBridge(spawn, { ...process.env });
  const sessions = new Map<string, SessionRuntime>();
  const webContents: SendableWebContents = { send: () => {}, isDestroyed: () => false };
  let idCounter = 0;

  let manager!: TerminalManager;
  // Defer the ack a microtask out of the flush stack so the manager's
  // post-`sendData` in-flight bump can't underflow (the single-session harness's
  // reentrancy guard, applied per session here).
  const ackBytes = (session: SessionRuntime, n: number): void => {
    session.totalAcked += n;
    manager.drain({ windowId: 1, ptyId: session.ptyId, bytes: n });
  };

  manager = createTerminalManager({
    forkPtyHost: () => bridge,
    sendData: (_wc, payload) => {
      const session = sessions.get(payload.ptyId);
      if (!session) return;
      session.totalPushed += payload.data.length;
      session.pushCount += 1;
      session.sawFirstByte = true;
      // Hidden floods skip accumulation + sentinel scan so an unbounded stream
      // stays O(1) per push and can't starve the loop being measured.
      if (session.accumulate) {
        session.chunks.push(payload.data);
        session.tail = (session.tail + payload.data).slice(-256);
        if (
          !session.sawSentinel &&
          session.sentinel.length > 0 &&
          session.tail.includes(session.sentinel)
        ) {
          session.sawSentinel = true;
        }
      }
      if (session.drainEnabled && session.drainMode === 'immediate') {
        const n = payload.data.length;
        queueMicrotask(() => ackBytes(session, n));
      }
    },
    sendExit: () => {},
    newPtyId: () => `mpty-${idCounter++}`,
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    coalesceMs: COALESCE_MS,
    highWaterBytes: opts.highWaterBytes,
    lowWaterBytes: opts.lowWaterBytes,
  });

  // One pump drains every metered session whose drain is currently enabled.
  const meterMs = opts.meterTickMs ?? 20;
  const pump = setInterval(() => {
    for (const session of sessions.values()) {
      if (session.drainMode !== 'metered' || !session.drainEnabled) continue;
      const available = session.totalPushed - session.totalAcked;
      if (available <= 0) continue;
      ackBytes(session, Math.min(session.meterUnitsPerTick, available));
    }
  }, meterMs);

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(pump);
    for (const session of sessions.values()) {
      try {
        manager.kill({ windowId: 1, ptyId: session.ptyId });
      } catch {
        // Best-effort: the shell may already be gone.
      }
    }
    bridge.reap();
    activeRigCleanups.delete(cleanup);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Best-effort tmpdir cleanup.
    }
  };
  activeRigCleanups.add(cleanup);

  return {
    bridge,
    tmp,
    addSession(spec): SessionRuntime {
      const result = manager.create({
        windowId: 1,
        webContents,
        projectRoot: tmp,
        cols: 80,
        rows: 24,
      });
      if (!result.ok) throw new Error(`create rejected: ${result.reason}`);
      const session: SessionRuntime = {
        ptyId: result.ptyId,
        sentinel: spec.sentinel,
        accumulate: spec.accumulate ?? true,
        drainMode: spec.drainMode,
        meterUnitsPerTick: spec.meterUnitsPerTick ?? 131072,
        drainEnabled: spec.drainMode === 'immediate',
        chunks: [],
        totalPushed: 0,
        totalAcked: 0,
        pushCount: 0,
        tail: '',
        sawFirstByte: false,
        sawSentinel: false,
      };
      sessions.set(session.ptyId, session);
      return session;
    },
    input(session, data): void {
      manager.input({ windowId: 1, ptyId: session.ptyId, data });
    },
    inFlight(session): number {
      return session.totalPushed - session.totalAcked;
    },
    received(session): string {
      return session.chunks.join('');
    },
    cleanup,
  };
}

// Scenario 3 — two concurrent sessions. While A is HELD paused by its own
// backpressure, B must run a full flood to completion with exact bytes and no
// cross-contamination — proving the pause state is per-session, not shared. This
// is the isolation that single-session coverage and a faked-host manager unit
// test cannot reach at real-PTY fidelity.
async function runTwoSessionIsolation(): Promise<void> {
  // A is large enough to cross the high-water mark and, while undrained, stay
  // paused. B is smaller than the high-water mark, so it can NEVER back up on its
  // own — any B pause would mean pause state leaked from A.
  const UNITS_A = 200_000;
  const UNITS_B = 20_000;
  const highWater = 256 * 1024;
  const rig = createMultiSessionRig({ highWaterBytes: highWater, lowWaterBytes: 64 * 1024 });
  try {
    const fileA = writeFloodFile(rig.tmp, 'flood-a.txt', UNIT_A, UNITS_A);
    const fileB = writeFloodFile(rig.tmp, 'flood-b.txt', UNIT_B, UNITS_B);
    const a = rig.addSession({ sentinel: SENTINEL_A, drainMode: 'metered' });
    const b = rig.addSession({ sentinel: SENTINEL_B, drainMode: 'immediate' });

    await waitFor(() => a.sawFirstByte && b.sawFirstByte, 'both shell prompts', 15000);

    // Flood A with its drain withheld so it crosses the high-water mark and,
    // because nothing acks it, stays paused.
    rig.input(a, `cat '${fileA}'; echo ${SENTINEL_A_CMD}\r`);
    await waitFor(() => rig.bridge.pauseCountFor(a.ptyId) > 0, "A's backpressure to engage", 20000);

    // With A held paused, B must still complete a full flood. If pause state were
    // shared, A's pause would stall B and this would time out.
    rig.input(b, `cat '${fileB}'; echo ${SENTINEL_B_CMD}\r`);
    // Completion = B's content fully arrived (progress-gated), not B's sentinel.
    await waitForFloodCompletion(
      () =>
        b.totalPushed >= UNITS_B * UNIT_B.length &&
        countOccurrences(rig.received(b), UNIT_B) >= UNITS_B,
      () => b.totalPushed,
      'B content delivered while A is held paused',
    );

    // A was never drained, so it must still be paused — proving B finished under
    // A's engaged backpressure, not because A quietly resumed.
    assert(
      rig.bridge.resumeCountFor(a.ptyId) === 0,
      'A resumed before being drained — its backpressure did not actually hold',
    );
    const bPauses = rig.bridge.pauseCountFor(b.ptyId);
    assert(
      bPauses === 0,
      `pause state leaked across sessions: B paused ${bPauses}x under A's flood`,
    );

    const bRecv = rig.received(b);
    const bUnits = countOccurrences(bRecv, UNIT_B);
    assert(bUnits === UNITS_B, `B byte corruption: ${bUnits} units delivered, expected ${UNITS_B}`);
    assert(!bRecv.includes('�'), 'U+FFFD in session B (split multibyte sequence)');
    assert(
      countOccurrences(bRecv, UNIT_A) === 0,
      "cross-session interleave: A's content reached B",
    );

    // Drain A so it finishes too, and confirm its own bytes survived the
    // pause/resume cycle intact and uncontaminated by B.
    a.drainEnabled = true;
    await waitForFloodCompletion(
      () =>
        a.totalPushed >= UNITS_A * UNIT_A.length &&
        countOccurrences(rig.received(a), UNIT_A) >= UNITS_A,
      () => a.totalPushed,
      'A content delivered after draining',
    );
    const aRecv = rig.received(a);
    const aUnits = countOccurrences(aRecv, UNIT_A);
    assert(aUnits === UNITS_A, `A byte corruption: ${aUnits} units delivered, expected ${UNITS_A}`);
    assert(!aRecv.includes('�'), 'U+FFFD in session A (split multibyte sequence)');
    assert(
      countOccurrences(aRecv, UNIT_B) === 0,
      "cross-session interleave: B's content reached A",
    );
    assert(rig.bridge.resumeCountFor(a.ptyId) >= 1, 'A never resumed after draining');
    console.log(
      `  A: units=${UNITS_A} pauses=${rig.bridge.pauseCountFor(a.ptyId)} resumes=${rig.bridge.resumeCountFor(a.ptyId)} | B: units=${UNITS_B} pauses=${bPauses} (done while A paused)`,
    );
  } finally {
    rig.cleanup();
  }
}

// Scenario 4 — N-way aggregate. k hidden sessions flood continuously while one
// active session runs. Phase 1 holds every hidden tab draining (a hidden-but-
// live tab's default) and asserts only what the design guarantees UNDER that
// load: the active PTY is never paused by the others (isolation), no byte is
// corrupted or leaked across tabs, and the loop is not frozen. Phase 2 engages
// the fallback — stop draining the hidden tabs so per-session backpressure
// pauses them — proves the sources actually stop, and only THEN asserts the
// active session completes with exact bytes.
//
// Completion is asserted in phase 2, not phase 1, on purpose: there is no
// cross-session read scheduler (per-session backpressure pauses each stream
// independently; fairness across streams is left to libuv's fd polling, which
// bounds starvation to added latency, not lockout). "The active tab finishes
// within a wall-clock budget while unbounded sources flood" is therefore NOT a
// design guarantee — asserting it couples to host speed and turns a slow-but-
// correct run into a flake. The guaranteed state is the fallback: once the
// hidden sources are paused, the active session completes. That is the bound.
//
// FIDELITY NOTE: this models the real IPC/coalesce/backpressure loop, not xterm's
// escape-sequence parse cost. Phase 1's heartbeat proves the transport loop is
// not frozen (necessary, not sufficient); phase 2 proves the fallback stops the
// hidden sources — the load-bearing guarantee, since per-session backpressure
// bounds each PTY stream but not the renderer's shared parse thread. The
// parse-thread aggregate under real rendering is a manual / real-app check.
async function runNWayAggregate(): Promise<void> {
  const HIDDEN_COUNT = 3;
  const ACTIVE_UNITS = 20_000; // < high-water: the active tab must never self-pause
  const highWater = 256 * 1024;
  const rig = createMultiSessionRig({ highWaterBytes: highWater, lowWaterBytes: 64 * 1024 });

  let lastBeat = 0;
  let maxGap = 0;
  let beats = 0;
  let measuring = false;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    if (measuring && lastBeat > 0) {
      const gap = now - lastBeat;
      if (gap > maxGap) maxGap = gap;
      beats += 1;
    }
    lastBeat = now;
  }, 10);

  try {
    const activeFile = writeFloodFile(rig.tmp, 'active.txt', UNIT_ACTIVE, ACTIVE_UNITS);
    const active = rig.addSession({ sentinel: SENTINEL_ACTIVE, drainMode: 'immediate' });
    const hidden: SessionRuntime[] = [];
    for (let i = 0; i < HIDDEN_COUNT; i += 1) {
      hidden.push(rig.addSession({ sentinel: '', drainMode: 'immediate', accumulate: false }));
    }

    await waitFor(
      () => active.sawFirstByte && hidden.every((h) => h.sawFirstByte),
      'all shell prompts',
      15000,
    );

    // Phase 1 — every hidden tab floods AND keeps draining. Under this sustained
    // aggregate, assert only what the design guarantees: the active PTY is never
    // paused by the others (isolation), nothing is corrupted or leaked across
    // tabs, and the loop is not frozen. Completion + full byte-exactness are
    // asserted in phase 2, once the fallback pauses the sources — never here,
    // while an unbounded `yes` is live (a wall-clock completion/latency budget
    // under unbounded floods couples to host speed and isn't design-guaranteed).
    for (const h of hidden) rig.input(h, `yes '${HIDDEN_MARKER}'\r`);
    await sleep(250); // let the hidden floods ramp to steady state

    lastBeat = Date.now();
    measuring = true;
    rig.input(active, `cat '${activeFile}'; echo ${SENTINEL_ACTIVE_CMD}\r`);
    await sleep(1000); // sample the active stream + loop under the sustained aggregate
    measuring = false;
    const maxGapUnderLoad = maxGap;

    // Corruption or a cross-tab leak shows even on the partial stream the active
    // tab has received so far under load; the full count is asserted in phase 2.
    const activeUnderLoad = rig.received(active);
    assert(!activeUnderLoad.includes('�'), 'U+FFFD in the active stream under aggregate load');
    assert(
      !activeUnderLoad.includes(HIDDEN_MARKER),
      'cross-session interleave: a hidden flood reached the active stream',
    );
    assert(beats > 0, 'event loop frozen under aggregate hidden floods');
    assert(
      rig.bridge.pauseCountFor(active.ptyId) === 0,
      'the active tab self-paused — pause state may be shared, or its flood exceeded high-water',
    );
    // maxGapUnderLoad is a DIAGNOSTIC, not a gate: latency under concurrent load
    // is not design-bounded (no cross-session scheduler; libuv bounds lockout,
    // not latency), so an absolute gap budget here would be a host-coupled flake.

    // Phase 2 — the fallback: stop draining the hidden tabs. Per-session
    // backpressure then pauses each, and the sources must actually stop — the
    // proof the fallback bounds the aggregate, not merely that one tab paused.
    for (const h of hidden) h.drainEnabled = false;
    await waitFor(
      () => hidden.every((h) => rig.bridge.pauseCountFor(h.ptyId) > 0),
      'every hidden flood to pause under the fallback',
      20000,
    );
    await sleep(300); // let in-flight coalesce buffers drain after the pause
    const pushedAfterPause = new Map(hidden.map((h) => [h.ptyId, h.totalPushed]));
    await sleep(400);
    let idx = 0;
    for (const h of hidden) {
      // The byte rate collapsing to ~0 after the pause is the real proof the
      // fallback bounded the aggregate (phase 1 ran these at hundreds of MB/s).
      const delta = h.totalPushed - (pushedAfterPause.get(h.ptyId) ?? 0);
      assert(
        delta < highWater,
        `fallback did not stop hidden session ${idx}: +${delta} code units after pausing`,
      );
      // Sanity bound: a still-running flood would be tens of millions of code
      // units in flight by now, not a single buffered window.
      const inFlight = rig.inFlight(h);
      assert(
        inFlight < 4 * 1024 * 1024,
        `hidden session ${idx} in-flight unbounded after pause: ${inFlight} code units`,
      );
      idx += 1;
    }
    assert(
      rig.bridge.pauseCountFor(active.ptyId) === 0,
      'the active tab paused when only hidden tabs were throttled',
    );

    // The hidden sources are now paused — the design's guaranteed state — so the
    // active session must complete with exact bytes. Gated on the active CONTENT
    // arriving (progress-based), not the trailing sentinel node-pty can defer.
    await waitForFloodCompletion(
      () =>
        active.totalPushed >= ACTIVE_UNITS * UNIT_ACTIVE.length &&
        countOccurrences(rig.received(active), UNIT_ACTIVE) >= ACTIVE_UNITS,
      () => active.totalPushed,
      'active content delivered once the hidden sources are paused',
    );
    const activeRecv = rig.received(active);
    const activeUnits = countOccurrences(activeRecv, UNIT_ACTIVE);
    assert(
      activeUnits === ACTIVE_UNITS,
      `active byte corruption: ${activeUnits} units delivered, expected ${ACTIVE_UNITS}`,
    );
    assert(!activeRecv.includes('�'), 'U+FFFD in the active stream after the fallback');
    assert(
      !activeRecv.includes(HIDDEN_MARKER),
      'cross-session interleave: a hidden flood reached the active stream',
    );

    const aggregateInFlight = hidden.reduce((sum, h) => sum + rig.inFlight(h), 0);
    console.log(
      `  hidden=${HIDDEN_COUNT} active=${ACTIVE_UNITS} activeSentinel=${active.sawSentinel} maxGapUnderLoad=${maxGapUnderLoad}ms beats=${beats} aggregateInFlight=${aggregateInFlight}`,
    );
  } finally {
    clearInterval(heartbeat);
    rig.cleanup();
  }
}

async function main(): Promise<void> {
  ensureSpawnHelperExecutable();

  // Fast consumer: isolate coalescing + responsiveness (high-water set out of
  // reach so the source never pauses). Proves the loop stays responsive and the
  // bytes are byte-exact across read + coalesce boundaries.
  await scenario('flood stays responsive and byte-exact under a fast consumer', async () => {
    const m = await runFloodScenario({
      units: FLOOD_UNITS_RESPONSIVE,
      highWaterBytes: Number.MAX_SAFE_INTEGER,
      lowWaterBytes: 0,
      drain: 'immediate',
      heartbeat: true,
    });
    assert(
      m.receivedUnitCount === m.units,
      `byte corruption: ${m.receivedUnitCount} units delivered, expected ${m.units}`,
    );
    assert(!m.hasReplacementChar, 'U+FFFD replacement char in stream (split multibyte sequence)');
    assert(m.heartbeats > 0, 'event loop frozen: no heartbeats fired during the flood');
    assert(
      m.maxHeartbeatGapMs < MAX_HEARTBEAT_GAP_MS,
      `event loop starved: max heartbeat gap ${m.maxHeartbeatGapMs}ms >= ${MAX_HEARTBEAT_GAP_MS}ms`,
    );
    // Coalescing batches reads onto the timer, so pushes are bounded by the
    // tick rate (one flush per coalesce window), NOT by byte volume. Pushing
    // per node-pty read would blow this bound under a multi-MB flood — that is
    // exactly the renderer-flood regression the coalescer prevents.
    const maxExpectedPushes = Math.ceil(m.floodMs / COALESCE_MS) + 8;
    assert(
      m.pushCount <= maxExpectedPushes,
      `coalescing ineffective: ${m.pushCount} pushes for a ${m.floodMs}ms flood (tick-bound ${maxExpectedPushes})`,
    );
    const avgPushUnits = m.totalPushedCodeUnits / Math.max(1, m.pushCount);
    console.log(
      `  units=${m.units} pushes=${m.pushCount} avgPush=${avgPushUnits.toFixed(0)} maxGap=${m.maxHeartbeatGapMs}ms beats=${m.heartbeats} floodMs=${m.floodMs} sentinel=${m.sawSentinel}`,
    );
  });

  // Slow consumer: drive the pause()/resume() + drain backpressure path. Proves
  // in-flight bytes stay bounded far below the flood instead of growing
  // unbounded, while every byte still arrives uncorrupted.
  await scenario('flood backpressure bounds in-flight under a slow consumer', async () => {
    const highWater = 256 * 1024;
    const m = await runFloodScenario({
      units: FLOOD_UNITS_BACKPRESSURE,
      highWaterBytes: highWater,
      lowWaterBytes: 64 * 1024,
      drain: 'metered',
      stallUntilPaused: true,
      meterUnitsPerTick: 131072,
      meterTickMs: 20,
    });
    assert(
      m.receivedUnitCount === m.units,
      `byte corruption: ${m.receivedUnitCount} units delivered, expected ${m.units}`,
    );
    assert(!m.hasReplacementChar, 'U+FFFD replacement char in stream (split multibyte sequence)');
    assert(m.pauseCount >= 1, 'backpressure never paused the source under sustained flood');
    assert(m.resumeCount >= 1, 'backpressure never resumed the source after draining');
    assert(
      m.maxInFlight < m.totalPushedCodeUnits * 0.6,
      `in-flight not bounded: peak ${m.maxInFlight} vs ${m.totalPushedCodeUnits} total code units`,
    );
    console.log(
      `  units=${m.units} maxInFlight=${m.maxInFlight} highWater=${highWater} pauses=${m.pauseCount} resumes=${m.resumeCount} floodMs=${m.floodMs} sentinel=${m.sawSentinel}`,
    );
  });

  // Multi-session (tabs): the per-session isolation only N concurrent real PTYs
  // through one host can exercise.
  await scenario('two concurrent sessions isolate backpressure and bytes', runTwoSessionIsolation);
  await scenario(
    'hidden floods stay bounded and keep the active session responsive',
    runNWayAggregate,
  );

  const failed = results.filter((r) => !r.ok).length;
  console.log(`HARNESS_RESULT ok=${results.length - failed} fail=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

// Hard ceiling so a wedged shell can never hang the parent `bun test`. The
// multi-session scenarios spawn unbounded `yes` floods, so reap every live host
// before exiting on this path — a process exit without reaping would orphan
// those shells to keep spinning.
const hardTimeout = setTimeout(() => {
  reapActiveRigs();
  console.log('HARNESS_RESULT ok=0 fail=1 :: hard timeout');
  process.exit(1);
}, 120000);
hardTimeout.unref();

// Synchronous backstop: even an unexpected exit reaps the real shells (node-pty
// kills are synchronous), so an unbounded `yes` flood can't outlive the harness.
process.on('exit', reapActiveRigs);

void main().catch((err) => {
  reapActiveRigs();
  console.log(`HARNESS_RESULT ok=0 fail=1 :: ${(err as Error).message}`);
  process.exit(1);
});
