import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

export const WATCHDOG_TICK_MS = 5_000;

export const STALL_THRESHOLD_TICKS = 3;

export interface WatchdogRecord {
  readonly schemaVersion: 1;
  readonly bootId: string;
  readonly writtenAt: string;
  readonly tickMs: number;
  readonly blockedForMs: number;
  readonly mainTicksObserved: number;
}

export interface WatchdogTickState {
  lastMainAt: number;
  lastTickAt: number;
  mainTicksObserved: number;
}

export type WatchdogRead =
  | { kind: 'record'; record: WatchdogRecord }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

export type PreviousSessionLiveness =
  | { kind: 'died'; blockedForMs: number; stallThresholdMs: number; writtenAt: string }
  | { kind: 'blocked'; blockedForMs: number; stallThresholdMs: number; writtenAt: string }
  | {
      kind: 'no-evidence';
      why:
        | 'absent'
        | 'unreadable'
        | 'no-previous-boot'
        | 'boot-mismatch'
        | 'stale-witness'
        | 'unwitnessed-main';
    };

export interface LivenessLogFields {
  livenessVerdict: 'died' | 'blocked' | null;
  mainThreadBlockedForMs: number | null;
  mainThreadStallThresholdMs: number | null;
  livenessWitnessAt: string | null;
  livenessEvidence:
    | 'matched'
    | 'absent'
    | 'unreadable'
    | 'no-previous-boot'
    | 'boot-mismatch'
    | 'stale-witness'
    | 'unwitnessed-main';
}

export interface MainThreadWatchdogHandle {
  stop(): void;
}

export interface MainThreadWatchdog {
  readPrevious(): WatchdogRead;
  start(bootId: string): MainThreadWatchdogHandle;
}

interface WatchdogLogger {
  warn(payload: Record<string, unknown>, msg: string): void;
}

export function computeWatchdogTick(
  state: WatchdogTickState,
  nowPerf: number,
  nowWall: number,
  tickMs: number,
  stallThresholdTicks: number,
  bootId: string,
  writtenAt: string,
): WatchdogRecord {
  if (nowWall - state.lastTickAt > tickMs * stallThresholdTicks) {
    state.lastMainAt = nowPerf;
    state.mainTicksObserved = 0;
  }
  state.lastTickAt = nowWall;
  return {
    schemaVersion: 1,
    bootId,
    writtenAt,
    tickMs,
    blockedForMs: Math.round(nowPerf - state.lastMainAt),
    mainTicksObserved: state.mainTicksObserved,
  };
}

/* STOP: computeWatchdogTick is serialized into WORKER_SOURCE through toString(), so it must stay
   closure-free and import-free. WORKER_SOURCE is an eval string rather than a file-backed worker
   entry because electron-builder.yml unpacks node-pty's worker on the recorded ground that
   worker_threads cannot load JS from inside app.asar; a file-backed entry has to prove it loads
   from a packaged build before it replaces this. */
const WORKER_SOURCE = `
const { mkdirSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

const { path, bootId, tickMs } = workerData;
const computeTick = ${computeWatchdogTick.toString()};
const state = {
  lastMainAt: performance.now(),
  lastTickAt: Date.now(),
  mainTicksObserved: 0,
};
let reportedFailure = false;

parentPort.on('message', () => {
  state.lastMainAt = performance.now();
  state.mainTicksObserved += 1;
});

function writeWitness() {
  const record = computeTick(
    state,
    performance.now(),
    Date.now(),
    tickMs,
    ${STALL_THRESHOLD_TICKS},
    bootId,
    new Date().toISOString(),
  );
  const tmpPath = path + '.tmp-' + process.pid + '-' + Date.now();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(record) + '\\n');
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    if (reportedFailure) return;
    reportedFailure = true;
    parentPort.postMessage({ type: 'write-failed', code: errorCode(err) });
  }
}

writeWitness();
setInterval(writeWitness, tickMs);

function errorCode(err) {
  return err && typeof err.code === 'string' ? err.code : 'unknown';
}
`;

export function isFileMissingError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function watchdogFailureFields(cause: unknown): Record<string, unknown> {
  return cause instanceof Error ? { err: cause } : { exitCode: cause };
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function parseWatchdogRecord(raw: string): WatchdogRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (p.schemaVersion !== 1) return null;
  if (typeof p.bootId !== 'string' || p.bootId === '') return null;
  if (typeof p.writtenAt !== 'string' || !Number.isFinite(Date.parse(p.writtenAt))) return null;
  if (!isPositiveFinite(p.tickMs)) return null;
  if (!isNonNegativeFinite(p.blockedForMs)) return null;
  if (!isNonNegativeFinite(p.mainTicksObserved)) return null;
  return {
    schemaVersion: 1,
    bootId: p.bootId,
    writtenAt: p.writtenAt,
    tickMs: p.tickMs,
    blockedForMs: p.blockedForMs,
    mainTicksObserved: p.mainTicksObserved,
  };
}

export function stallThresholdMs(record: WatchdogRecord): number {
  return record.tickMs * STALL_THRESHOLD_TICKS;
}

export function classifyPreviousLiveness(
  read: WatchdogRead,
  prevBootId: string | null,
  prevLastAliveAtMs: number | null,
): PreviousSessionLiveness {
  if (read.kind === 'absent') return { kind: 'no-evidence', why: 'absent' };
  if (read.kind === 'unreadable') return { kind: 'no-evidence', why: 'unreadable' };
  const { record } = read;
  if (prevBootId === null) return { kind: 'no-evidence', why: 'no-previous-boot' };
  if (record.bootId !== prevBootId) return { kind: 'no-evidence', why: 'boot-mismatch' };
  if (
    prevLastAliveAtMs !== null &&
    prevLastAliveAtMs - Date.parse(record.writtenAt) > stallThresholdMs(record)
  ) {
    return { kind: 'no-evidence', why: 'stale-witness' };
  }
  const threshold = stallThresholdMs(record);
  const blocked = record.blockedForMs >= threshold;
  if (!blocked && record.mainTicksObserved === 0) {
    return { kind: 'no-evidence', why: 'unwitnessed-main' };
  }
  return {
    kind: blocked ? 'blocked' : 'died',
    blockedForMs: record.blockedForMs,
    stallThresholdMs: threshold,
    writtenAt: record.writtenAt,
  };
}

export function livenessLogFields(liveness: PreviousSessionLiveness): LivenessLogFields {
  if (liveness.kind === 'no-evidence') {
    return {
      livenessVerdict: null,
      mainThreadBlockedForMs: null,
      mainThreadStallThresholdMs: null,
      livenessWitnessAt: null,
      livenessEvidence: liveness.why,
    };
  }
  return {
    livenessVerdict: liveness.kind,
    mainThreadBlockedForMs: liveness.blockedForMs,
    mainThreadStallThresholdMs: liveness.stallThresholdMs,
    livenessWitnessAt: liveness.writtenAt,
    livenessEvidence: 'matched',
  };
}

export function createMainThreadWatchdog(opts: {
  path: string;
  logger: WatchdogLogger;
  tickMs?: number;
}): MainThreadWatchdog {
  const tickMs = opts.tickMs ?? WATCHDOG_TICK_MS;

  return {
    readPrevious(): WatchdogRead {
      let raw: string;
      try {
        raw = readFileSync(opts.path, 'utf8');
      } catch (err) {
        if (isFileMissingError(err)) return { kind: 'absent' };
        opts.logger.warn(
          { event: 'main-thread-watchdog.read-failed', ...watchdogFailureFields(err) },
          'the previous session witness file could not be read',
        );
        return { kind: 'unreadable' };
      }
      const record = parseWatchdogRecord(raw);
      if (record === null) {
        opts.logger.warn(
          { event: 'main-thread-watchdog.read-failed', bytes: raw.length },
          'the previous session witness file did not parse as a record',
        );
        return { kind: 'unreadable' };
      }
      return { kind: 'record', record };
    },

    start(bootId: string): MainThreadWatchdogHandle {
      let worker: Worker;
      try {
        worker = new Worker(WORKER_SOURCE, {
          eval: true,
          workerData: { path: opts.path, bootId, tickMs },
        });
      } catch (err) {
        opts.logger.warn(
          { event: 'main-thread-watchdog.spawn-failed', ...watchdogFailureFields(err) },
          'could not start the main-thread watchdog — a hang will not be told apart from a death',
        );
        return { stop() {} };
      }
      worker.unref();
      const ping = setInterval(() => {
        worker.postMessage(1);
      }, tickMs);
      ping.unref();

      let stopped = false;
      let warnedWorkerFailed = false;
      const warnWorkerFailed = (cause: Error | number): void => {
        if (stopped || warnedWorkerFailed) return;
        warnedWorkerFailed = true;
        opts.logger.warn(
          { event: 'main-thread-watchdog.worker-failed', ...watchdogFailureFields(cause) },
          'the main-thread watchdog stopped witnessing this session',
        );
      };
      worker.on('error', (err) => {
        warnWorkerFailed(err);
      });
      worker.on('exit', (code) => {
        clearInterval(ping);
        if (code !== 0) warnWorkerFailed(code);
      });

      let warnedWriteFailed = false;
      worker.on('message', (message: unknown) => {
        if (typeof message !== 'object' || message === null) return;
        const { type, code } = message as { type?: unknown; code?: unknown };
        if (type !== 'write-failed' || warnedWriteFailed) return;
        warnedWriteFailed = true;
        opts.logger.warn(
          {
            event: 'main-thread-watchdog.write-failed',
            code: typeof code === 'string' ? code : 'unknown',
          },
          'the main-thread watchdog could not write its witness file',
        );
      });

      return {
        stop() {
          if (stopped) return;
          stopped = true;
          clearInterval(ping);
          void worker.terminate();
        },
      };
    },
  };
}
