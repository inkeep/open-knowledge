
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

function ensureSpawnHelperExecutable(): void {
  const pkgDir = dirname(dirname(require.resolve('node-pty')));
  const helper = join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
}

const { spawn } = require('node-pty') as { spawn: SpawnPty };

const UNIT = '日本語🎉αβγ';
const SENTINEL = '__OKFLOOD_42__';
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

class InProcessBridge implements PtyUtilityLike {
  pauseCount = 0;
  resumeCount = 0;
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

  reap(): void {
    this.hostHandle.killActive();
  }
}

interface FloodOptions {
  units: number;
  highWaterBytes: number;
  lowWaterBytes: number;
  drain: 'immediate' | 'metered';
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
      await waitFor(() => bridge.pauseCount > 0, 'backpressure pause to engage', 20000);
      drainEnabled = true;
    }

    await waitFor(() => sawSentinel, 'flood completion sentinel', 60000);
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
    };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (pump) clearInterval(pump);
    try {
      manager.kill({ windowId: 1, ptyId: PTY_ID });
    } catch {
    }
    bridge.reap();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
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

const FLOOD_UNITS_RESPONSIVE = 1_500_000; // ~28.5 MB UTF-8 / 12M UTF-16 code units
const FLOOD_UNITS_BACKPRESSURE = 300_000; // ~5.7 MB UTF-8 / 2.4M UTF-16 code units
const MAX_HEARTBEAT_GAP_MS = (() => {
  const override = Number(process.env.OK_FLOOD_MAX_GAP_MS);
  return Number.isFinite(override) && override > 0 ? override : 500;
})();


const UNIT_A = '日本語🎉αβγ';
const UNIT_B = '한국어🚀ΔΣΩ';
const UNIT_ACTIVE = '中文🌟λμν';
const SENTINEL_A = '__OKFLOOD_A_42__';
const SENTINEL_A_CMD = '__OKFLOOD_A_$((6*7))__';
const SENTINEL_B = '__OKFLOOD_B_42__';
const SENTINEL_B_CMD = '__OKFLOOD_B_$((6*7))__';
const SENTINEL_ACTIVE = '__OKFLOOD_ACTIVE_42__';
const SENTINEL_ACTIVE_CMD = '__OKFLOOD_ACTIVE_$((6*7))__';
const HIDDEN_MARKER = 'HIDDEN_FLOOD_LINE';

interface SessionRuntime {
  readonly ptyId: string;
  readonly sentinel: string;
  readonly accumulate: boolean;
  readonly drainMode: 'immediate' | 'metered';
  readonly meterUnitsPerTick: number;
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

const activeRigCleanups = new Set<() => void>();

function reapActiveRigs(): void {
  for (const cleanup of activeRigCleanups) {
    try {
      cleanup();
    } catch {
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
      }
    }
    bridge.reap();
    activeRigCleanups.delete(cleanup);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
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

async function runTwoSessionIsolation(): Promise<void> {
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

    rig.input(a, `cat '${fileA}'; echo ${SENTINEL_A_CMD}\r`);
    await waitFor(() => rig.bridge.pauseCountFor(a.ptyId) > 0, "A's backpressure to engage", 20000);

    rig.input(b, `cat '${fileB}'; echo ${SENTINEL_B_CMD}\r`);
    await waitFor(() => b.sawSentinel, 'B to complete while A is held paused', 60000);

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

    a.drainEnabled = true;
    await waitFor(() => a.sawSentinel, 'A to complete after draining', 60000);
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

    for (const h of hidden) rig.input(h, `yes '${HIDDEN_MARKER}'\r`);
    await sleep(250); // let the hidden floods ramp to steady state

    lastBeat = Date.now();
    measuring = true;
    rig.input(active, `cat '${activeFile}'; echo ${SENTINEL_ACTIVE_CMD}\r`);
    await waitFor(() => active.sawSentinel, 'active flood completion under aggregate load', 30000);
    await sleep(1000); // keep sampling the sustained aggregate after the round-trip
    measuring = false;
    const maxGapUnderLoad = maxGap;

    const activeRecv = rig.received(active);
    const activeUnits = countOccurrences(activeRecv, UNIT_ACTIVE);
    assert(
      activeUnits === ACTIVE_UNITS,
      `active byte corruption: ${activeUnits} units delivered, expected ${ACTIVE_UNITS}`,
    );
    assert(!activeRecv.includes('�'), 'U+FFFD in the active stream under aggregate load');
    assert(
      !activeRecv.includes(HIDDEN_MARKER),
      'cross-session interleave: a hidden flood reached the active stream',
    );
    assert(beats > 0, 'event loop frozen under aggregate hidden floods');
    assert(
      rig.bridge.pauseCountFor(active.ptyId) === 0,
      'the active tab self-paused — pause state may be shared, or its flood exceeded high-water',
    );
    assert(
      maxGapUnderLoad < MAX_HEARTBEAT_GAP_MS,
      `active starved: max heartbeat gap ${maxGapUnderLoad}ms >= ${MAX_HEARTBEAT_GAP_MS}ms under ${HIDDEN_COUNT} hidden floods`,
    );

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
      const delta = h.totalPushed - (pushedAfterPause.get(h.ptyId) ?? 0);
      assert(
        delta < highWater,
        `fallback did not stop hidden session ${idx}: +${delta} code units after pausing`,
      );
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
    const aggregateInFlight = hidden.reduce((sum, h) => sum + rig.inFlight(h), 0);
    console.log(
      `  hidden=${HIDDEN_COUNT} active=${ACTIVE_UNITS} maxGapUnderLoad=${maxGapUnderLoad}ms beats=${beats} aggregateInFlight=${aggregateInFlight}`,
    );
  } finally {
    clearInterval(heartbeat);
    rig.cleanup();
  }
}

async function main(): Promise<void> {
  ensureSpawnHelperExecutable();

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
    const maxExpectedPushes = Math.ceil(m.floodMs / COALESCE_MS) + 8;
    assert(
      m.pushCount <= maxExpectedPushes,
      `coalescing ineffective: ${m.pushCount} pushes for a ${m.floodMs}ms flood (tick-bound ${maxExpectedPushes})`,
    );
    const avgPushUnits = m.totalPushedCodeUnits / Math.max(1, m.pushCount);
    console.log(
      `  units=${m.units} pushes=${m.pushCount} avgPush=${avgPushUnits.toFixed(0)} maxGap=${m.maxHeartbeatGapMs}ms beats=${m.heartbeats} floodMs=${m.floodMs}`,
    );
  });

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
      `  units=${m.units} maxInFlight=${m.maxInFlight} highWater=${highWater} pauses=${m.pauseCount} resumes=${m.resumeCount} floodMs=${m.floodMs}`,
    );
  });

  await scenario('two concurrent sessions isolate backpressure and bytes', runTwoSessionIsolation);
  await scenario(
    'hidden floods stay bounded and keep the active session responsive',
    runNWayAggregate,
  );

  const failed = results.filter((r) => !r.ok).length;
  console.log(`HARNESS_RESULT ok=${results.length - failed} fail=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

const hardTimeout = setTimeout(() => {
  reapActiveRigs();
  console.log('HARNESS_RESULT ok=0 fail=1 :: hard timeout');
  process.exit(1);
}, 120000);
hardTimeout.unref();

process.on('exit', reapActiveRigs);

void main().catch((err) => {
  reapActiveRigs();
  console.log(`HARNESS_RESULT ok=0 fail=1 :: ${(err as Error).message}`);
  process.exit(1);
});
