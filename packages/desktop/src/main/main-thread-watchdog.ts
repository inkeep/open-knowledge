import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

export const WATCHDOG_TICK_MS = 5_000;

export const STALL_THRESHOLD_TICKS = 3;

export const STALL_SNAPSHOT_MAX_FRAMES = 24;

export const STALL_SNAPSHOT_MAX_CHARS = 256;

const STALL_ERROR_MAX_CHARS = 200;

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

export interface StallFrame {
  readonly functionName: string;
  readonly url: string;
  readonly line: number;
  readonly column: number;
}

interface StallSnapshotRequest {
  readonly schemaVersion: 1;
  readonly bootId: string;
  readonly stallStartedAt: string;
  readonly requestedAt: string;
  readonly blockedForMsAtRequest: number;
}

export type StallSnapshot =
  | (StallSnapshotRequest & { readonly outcome: 'pending' })
  | (StallSnapshotRequest & {
      readonly outcome: 'captured';
      readonly capturedAt: string;
      readonly pauseLatencyMs: number;
      readonly frames: readonly StallFrame[];
      readonly framesTruncated: boolean;
    })
  | (StallSnapshotRequest & { readonly outcome: 'failed'; readonly error: string });

export type StallRead = PreviousFileRead<StallSnapshot>;

type StallEpisode = 'final' | 'earlier';

export type PreviousSessionStall =
  | { kind: 'matched'; snapshot: StallSnapshot; episode: StallEpisode }
  | { kind: 'no-evidence'; why: 'absent' | 'unreadable' | 'no-previous-boot' | 'boot-mismatch' };

export interface StallLogFields {
  mainThreadStall: {
    outcome: StallSnapshot['outcome'];
    episode: StallEpisode;
    stallStartedAt: string;
    requestedAt: string;
    blockedForMsAtRequest: number;
    capturedAt: string | null;
    pauseLatencyMs: number | null;
    frames: readonly StallFrame[] | null;
    framesTruncated: boolean | null;
    error: string | null;
  } | null;
  mainThreadStallEvidence:
    | 'matched'
    | Extract<PreviousSessionStall, { kind: 'no-evidence' }>['why'];
}

export interface MainThreadWatchdogHandle {
  stop(): void;
}

export interface MainThreadWatchdog {
  readPrevious(): WatchdogRead;
  readPreviousStall(): StallRead;
  start(bootId: string): MainThreadWatchdogHandle;
}

export type PreviousFileRead<T> =
  | { kind: 'record'; value: T }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

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

export function boundStallFrames(
  callFrames: unknown,
  urlByScriptId: ReadonlyMap<string, string>,
  maxFrames: number,
  maxChars: number,
): { frames: StallFrame[]; framesTruncated: boolean } {
  const all: unknown[] = Array.isArray(callFrames) ? callFrames : [];
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const oneBased = (value: unknown): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value + 1 : 0;
  const frames: StallFrame[] = [];
  for (const raw of all.slice(0, maxFrames)) {
    const frame = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const location = (
      typeof frame.location === 'object' && frame.location !== null ? frame.location : {}
    ) as Record<string, unknown>;
    const url = text(frame.url) || (urlByScriptId.get(text(location.scriptId)) ?? '');
    const functionName = text(frame.functionName);
    frames.push({
      functionName: functionName.slice(0, maxChars),
      url: url.length > maxChars ? `...${url.slice(url.length - maxChars + 3)}` : url,
      line: oneBased(location.lineNumber),
      column: oneBased(location.columnNumber),
    });
  }
  return { frames, framesTruncated: all.length > maxFrames };
}

/* STOP: computeWatchdogTick and boundStallFrames are serialized into WORKER_SOURCE through
   toString(), so they must stay closure-free and import-free. WORKER_SOURCE is an eval string
   rather than a file-backed worker entry because electron-builder.yml unpacks node-pty's worker
   on the recorded ground that worker_threads cannot load JS from inside app.asar; a file-backed
   entry has to prove it loads from a packaged build before it replaces this. */
const WORKER_SOURCE = `
const { mkdirSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

const { path, stallPath, bootId, tickMs } = workerData;
const stallThresholdMs = tickMs * ${STALL_THRESHOLD_TICKS};
const computeTick = ${computeWatchdogTick.toString()};
const boundFrames = ${boundStallFrames.toString()};
const state = {
  lastMainAt: performance.now(),
  lastTickAt: Date.now(),
  mainTicksObserved: 0,
};
let reportedFailure = false;
let stallEpisodeCaptured = false;

parentPort.on('message', () => {
  state.lastMainAt = performance.now();
  state.mainTicksObserved += 1;
  stallEpisodeCaptured = false;
});

function writeJsonAtomically(target, value) {
  const tmpPath = target + '.tmp-' + process.pid + '-' + Date.now();
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(value) + '\\n');
    renameSync(tmpPath, target);
    return null;
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    return errorCode(err);
  }
}

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
  const failedCode = writeJsonAtomically(path, record);
  if (failedCode !== null && !reportedFailure) {
    reportedFailure = true;
    parentPort.postMessage({ type: 'write-failed', code: failedCode });
  }
  if (record.blockedForMs >= stallThresholdMs && !stallEpisodeCaptured) {
    stallEpisodeCaptured = true;
    requestStallSnapshot(record);
  }
}

function requestStallSnapshot(record) {
  const request = {
    schemaVersion: 1,
    bootId,
    stallStartedAt: new Date(Date.parse(record.writtenAt) - record.blockedForMs).toISOString(),
    requestedAt: record.writtenAt,
    blockedForMsAtRequest: record.blockedForMs,
  };
  writeJsonAtomically(stallPath, Object.assign({}, request, { outcome: 'pending' }));
  const requestedPerf = performance.now();
  let session = null;
  let settled = false;
  let pauseRequested = false;
  let ownPauseResumed = false;
  const settle = (fields) => {
    if (settled) return;
    settled = true;
    const snapshot = Object.assign({}, request, fields);
    const writeError = writeJsonAtomically(stallPath, snapshot);
    parentPort.postMessage({ type: 'stall-snapshot', snapshot, writeError });
    if (session === null) return;
    try {
      session.post('Debugger.disable');
    } catch {}
    try {
      session.disconnect();
    } catch {}
  };
  const fail = (err) => {
    settle({ outcome: 'failed', error: describeError(err) });
  };
  try {
    const inspector = require('node:inspector');
    session = new inspector.Session();
    session.connectToMainThread();
    const urlByScriptId = new Map();
    session.on('Debugger.scriptParsed', (message) => {
      const params = message && message.params;
      if (params && params.url) urlByScriptId.set(params.scriptId, params.url);
    });
    session.on('Debugger.paused', (message) => {
      const params = message && message.params ? message.params : {};
      if (!pauseRequested || ownPauseResumed) {
        fail(new Error('the main thread was already paused by another debugger session'));
        return;
      }
      ownPauseResumed = true;
      const pauseLatencyMs = Math.round(performance.now() - requestedPerf);
      try {
        session.post('Debugger.resume');
      } catch {}
      if (settled) return;
      const bounded = boundFrames(
        params.callFrames,
        urlByScriptId,
        ${STALL_SNAPSHOT_MAX_FRAMES},
        ${STALL_SNAPSHOT_MAX_CHARS},
      );
      settle({
        outcome: 'captured',
        capturedAt: new Date().toISOString(),
        pauseLatencyMs,
        frames: bounded.frames,
        framesTruncated: bounded.framesTruncated,
      });
    });
    session.post('Debugger.enable', (enableErr) => {
      if (enableErr) {
        fail(enableErr);
        return;
      }
      pauseRequested = true;
      session.post('Debugger.pause', (pauseErr) => {
        if (pauseErr) fail(pauseErr);
      });
    });
  } catch (err) {
    fail(err);
  }
}

writeWitness();
setInterval(writeWitness, tickMs);

function errorCode(err) {
  return err && typeof err.code === 'string' ? err.code : 'unknown';
}

function describeError(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  const message = err && typeof err.message === 'string' ? err.message : String(err);
  const described = (code ? code + ': ' : '') + message;
  return (described || 'unknown').slice(0, ${STALL_ERROR_MAX_CHARS});
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

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validateStallFrame(value: unknown): StallFrame | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const f = value as Record<string, unknown>;
  if (typeof f.functionName !== 'string' || f.functionName.length > STALL_SNAPSHOT_MAX_CHARS) {
    return null;
  }
  if (typeof f.url !== 'string' || f.url.length > STALL_SNAPSHOT_MAX_CHARS) return null;
  if (!isNonNegativeInteger(f.line) || !isNonNegativeInteger(f.column)) return null;
  return { functionName: f.functionName, url: f.url, line: f.line, column: f.column };
}

function validateStallSnapshot(value: unknown): StallSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (p.schemaVersion !== 1) return null;
  if (typeof p.bootId !== 'string' || p.bootId === '') return null;
  if (!isIsoDate(p.stallStartedAt) || !isIsoDate(p.requestedAt)) return null;
  if (!isNonNegativeFinite(p.blockedForMsAtRequest)) return null;
  const request: StallSnapshotRequest = {
    schemaVersion: 1,
    bootId: p.bootId,
    stallStartedAt: p.stallStartedAt,
    requestedAt: p.requestedAt,
    blockedForMsAtRequest: p.blockedForMsAtRequest,
  };
  switch (p.outcome) {
    case 'pending':
      return { ...request, outcome: 'pending' };
    case 'failed':
      if (typeof p.error !== 'string' || p.error === '') return null;
      return { ...request, outcome: 'failed', error: p.error };
    case 'captured': {
      if (!isIsoDate(p.capturedAt)) return null;
      if (!isNonNegativeFinite(p.pauseLatencyMs)) return null;
      if (typeof p.framesTruncated !== 'boolean') return null;
      if (!Array.isArray(p.frames) || p.frames.length > STALL_SNAPSHOT_MAX_FRAMES) return null;
      const frames: StallFrame[] = [];
      for (const raw of p.frames) {
        const frame = validateStallFrame(raw);
        if (frame === null) return null;
        frames.push(frame);
      }
      return {
        ...request,
        outcome: 'captured',
        capturedAt: p.capturedAt,
        pauseLatencyMs: p.pauseLatencyMs,
        frames,
        framesTruncated: p.framesTruncated,
      };
    }
    default:
      return null;
  }
}

export function parseStallSnapshot(raw: string): StallSnapshot | null {
  try {
    return validateStallSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function classifyPreviousStall(
  read: StallRead,
  prevBootId: string | null,
  liveness: PreviousSessionLiveness,
): PreviousSessionStall {
  if (read.kind === 'absent') return { kind: 'no-evidence', why: 'absent' };
  if (read.kind === 'unreadable') return { kind: 'no-evidence', why: 'unreadable' };
  const snapshot = read.value;
  if (prevBootId === null) return { kind: 'no-evidence', why: 'no-previous-boot' };
  if (snapshot.bootId !== prevBootId) return { kind: 'no-evidence', why: 'boot-mismatch' };
  const finalStallStartedAtMs =
    liveness.kind === 'blocked' ? Date.parse(liveness.writtenAt) - liveness.blockedForMs : null;
  const tickMs =
    liveness.kind === 'blocked' ? liveness.stallThresholdMs / STALL_THRESHOLD_TICKS : 0;
  const episode: StallEpisode =
    finalStallStartedAtMs !== null &&
    Math.abs(finalStallStartedAtMs - Date.parse(snapshot.stallStartedAt)) <= tickMs
      ? 'final'
      : 'earlier';
  return { kind: 'matched', snapshot, episode };
}

export function stallLogFields(stall: PreviousSessionStall): StallLogFields {
  if (stall.kind === 'no-evidence') {
    return { mainThreadStall: null, mainThreadStallEvidence: stall.why };
  }
  const { snapshot } = stall;
  const captured = snapshot.outcome === 'captured' ? snapshot : null;
  return {
    mainThreadStall: {
      outcome: snapshot.outcome,
      episode: stall.episode,
      stallStartedAt: snapshot.stallStartedAt,
      requestedAt: snapshot.requestedAt,
      blockedForMsAtRequest: snapshot.blockedForMsAtRequest,
      capturedAt: captured?.capturedAt ?? null,
      pauseLatencyMs: captured?.pauseLatencyMs ?? null,
      frames: captured?.frames ?? null,
      framesTruncated: captured?.framesTruncated ?? null,
      error: snapshot.outcome === 'failed' ? snapshot.error : null,
    },
    mainThreadStallEvidence: 'matched',
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

function logStallSnapshot(logger: WatchdogLogger, raw: unknown, writeError: unknown): void {
  const snapshot = validateStallSnapshot(raw);
  if (snapshot === null) {
    const fields = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    logger.warn(
      {
        event: 'main-thread-watchdog.stall-message-invalid',
        payloadType: raw === null ? 'null' : typeof raw,
        keys: Object.keys(fields).slice(0, 16),
        outcome: typeof fields.outcome === 'string' ? fields.outcome.slice(0, 32) : null,
      },
      'the main-thread watchdog sent a stall snapshot that did not validate',
    );
    return;
  }
  if (snapshot.outcome === 'pending') return;
  const persistFailure = typeof writeError === 'string' ? writeError : null;
  if (snapshot.outcome === 'failed') {
    logger.warn(
      { event: 'main-thread-watchdog.stall-capture-failed', snapshot, persistFailure },
      'the main thread stalled past the threshold but its stack could not be captured',
    );
    return;
  }
  logger.warn(
    { event: 'main-thread-watchdog.stall-captured', snapshot, persistFailure },
    'the main thread stalled past the threshold and recovered; captured where it was',
  );
}

export function readPreviousFile<T>(
  path: string,
  parse: (raw: string) => T | null,
  logger: WatchdogLogger,
  event: string,
  noun: string,
): PreviousFileRead<T> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (isFileMissingError(err)) return { kind: 'absent' };
    logger.warn(
      { event, ...watchdogFailureFields(err) },
      `the previous session ${noun} could not be read`,
    );
    return { kind: 'unreadable' };
  }
  const value = parse(raw);
  if (value === null) {
    logger.warn(
      { event, bytes: raw.length },
      `the previous session ${noun} did not parse as a record`,
    );
    return { kind: 'unreadable' };
  }
  return { kind: 'record', value };
}

export function createMainThreadWatchdog(opts: {
  path: string;
  stallPath: string;
  logger: WatchdogLogger;
  tickMs?: number;
}): MainThreadWatchdog {
  const tickMs = opts.tickMs ?? WATCHDOG_TICK_MS;

  return {
    readPrevious(): WatchdogRead {
      const read = readPreviousFile(
        opts.path,
        parseWatchdogRecord,
        opts.logger,
        'main-thread-watchdog.read-failed',
        'witness file',
      );
      return read.kind === 'record' ? { kind: 'record', record: read.value } : read;
    },

    readPreviousStall(): StallRead {
      return readPreviousFile(
        opts.stallPath,
        parseStallSnapshot,
        opts.logger,
        'main-thread-watchdog.stall-read-failed',
        'stall snapshot file',
      );
    },

    start(bootId: string): MainThreadWatchdogHandle {
      let worker: Worker;
      try {
        worker = new Worker(WORKER_SOURCE, {
          eval: true,
          workerData: { path: opts.path, stallPath: opts.stallPath, bootId, tickMs },
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
        const { type, code, snapshot, writeError } = message as {
          type?: unknown;
          code?: unknown;
          snapshot?: unknown;
          writeError?: unknown;
        };
        if (type === 'stall-snapshot') {
          logStallSnapshot(opts.logger, snapshot, writeError);
          return;
        }
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
