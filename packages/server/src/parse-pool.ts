import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { stripFrontmatter } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import type { PrecomputedParse } from './bridge-intake.ts';
import { getLogger } from './logger.ts';
import type {
  ParseWorkerEmbedResolution,
  ParseWorkerResult,
  ParseWorkerTask,
} from './parse-worker.ts';
import { getMeter, onTelemetryShutdown } from './telemetry.ts';

const log = getLogger('parse-pool');

export const PARSE_OFFLOAD_MIN_BYTES = 8 * 1024;

const PARSE_TASK_TIMEOUT_MS = 30_000;

const MAX_PENDING_TASKS = 32;

const WORKER_IDLE_REAP_MS = 30_000;

const POOL_SIZE = Math.max(1, Math.min(4, availableParallelism() - 1));

export interface ParsePoolEmbedResolver {
  resolveEmbed: (basename: string, sourcePath: string) => string | null;
  resolveSize?: (basename: string, sourcePath: string) => number | null;
  sourcePath: string;
}

type DispatchMode =
  | 'offload'
  | 'inline-small'
  | 'inline-unavailable'
  | 'inline-busy'
  | 'inline-timeout'
  | 'inline-error';

type Meter = ReturnType<typeof getMeter>;
let dispatchCounter: ReturnType<Meter['createCounter']> | null = null;
let taskLatencyHistogram: ReturnType<Meter['createHistogram']> | null = null;
let gaugesInstalled = false;

onTelemetryShutdown(() => {
  dispatchCounter = null;
  taskLatencyHistogram = null;
  gaugesInstalled = false;
});

function recordDispatch(mode: DispatchMode): void {
  dispatchCounter ||= getMeter().createCounter('ok.parse_pool.dispatch_total', {
    description:
      'Bridge-intake parse precompute dispatches by mode: offload (worker parse used) vs the inline-* fallback reasons (small doc, pool unavailable, queue saturated, task timeout, worker error).',
  });
  dispatchCounter.add(1, { mode });
}

function recordTaskLatency(ms: number): void {
  taskLatencyHistogram ||= getMeter().createHistogram('ok.parse_pool.task_ms', {
    description:
      'Wall-clock latency of a completed parse-pool offload (both passes for embed-bearing docs), in milliseconds.',
    unit: 'ms',
  });
  taskLatencyHistogram.record(ms);
}

function installGauges(): void {
  if (gaugesInstalled) return;
  gaugesInstalled = true;
  getMeter()
    .createObservableGauge('ok.parse_pool.queue_depth', {
      description: 'Parse-pool tasks waiting for a free worker.',
    })
    .addCallback((result) => {
      result.observe(queue.length);
    });
  getMeter()
    .createObservableGauge('ok.parse_pool.workers', {
      description: 'Live parse-pool worker threads.',
    })
    .addCallback((result) => {
      result.observe(workers.length);
    });
}

interface PendingTask {
  task: ParseWorkerTask;
  resolve: (result: ParseWorkerResult) => void;
  reject: (err: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  current: PendingTask | null;
  timer: NodeJS.Timeout | null;
}

const workers: PoolWorker[] = [];
const queue: PendingTask[] = [];
let nextTaskId = 1;
let idleReapTimer: NodeJS.Timeout | null = null;
let workerUrlOverride: URL | null | undefined;

export function _overrideParseWorkerUrlForTests(url: URL | null | undefined): void {
  workerUrlOverride = url;
}

let taskTimeoutMs = PARSE_TASK_TIMEOUT_MS;

export function _overrideParseTaskTimeoutForTests(ms: number | undefined): void {
  taskTimeoutMs = ms ?? PARSE_TASK_TIMEOUT_MS;
}

function resolveWorkerUrl(): URL | null {
  if (workerUrlOverride !== undefined) return workerUrlOverride;
  const candidates: URL[] = [
    new URL('./parse-worker.mjs', import.meta.url),
    new URL('./parse-worker.ts', import.meta.url),
  ];
  try {
    const requireFromHere = createRequire(import.meta.url);
    candidates.push(
      pathToFileURL(
        join(
          dirname(requireFromHere.resolve('@inkeep/open-knowledge-server/parse-worker')),
          'parse-worker.mjs',
        ),
      ),
    );
  } catch {}
  for (const candidate of candidates) {
    try {
      if (existsSync(fileURLToPath(candidate))) return candidate;
    } catch {}
  }
  return null;
}

function spawnWorker(url: URL): PoolWorker | null {
  try {
    const worker = new Worker(url);
    worker.unref();
    const poolWorker: PoolWorker = { worker, current: null, timer: null };
    worker.on('message', (result: ParseWorkerResult) => {
      completeTask(poolWorker, (pending) => pending.resolve(result));
    });
    worker.on('error', (err: Error) => {
      completeTask(poolWorker, (pending) => pending.reject(err));
      removeWorker(poolWorker);
    });
    worker.on('exit', () => {
      completeTask(poolWorker, (pending) =>
        pending.reject(new Error('parse worker exited mid-task')),
      );
      removeWorker(poolWorker);
    });
    return poolWorker;
  } catch (err) {
    log.warn({ err }, '[parse-pool] failed to spawn parse worker');
    return null;
  }
}

function completeTask(poolWorker: PoolWorker, settle: (pending: PendingTask) => void): void {
  const pending = poolWorker.current;
  if (pending === null) return;
  poolWorker.current = null;
  if (poolWorker.timer !== null) {
    clearTimeout(poolWorker.timer);
    poolWorker.timer = null;
  }
  settle(pending);
  pumpQueue();
}

function removeWorker(poolWorker: PoolWorker): void {
  const idx = workers.indexOf(poolWorker);
  if (idx !== -1) workers.splice(idx, 1);
}

function pumpQueue(): void {
  while (queue.length > 0) {
    let idle = workers.find((w) => w.current === null);
    if (idle === undefined && workers.length < POOL_SIZE) {
      const url = resolveWorkerUrl();
      const spawned = url === null ? null : spawnWorker(url);
      if (spawned !== null) {
        workers.push(spawned);
        idle = spawned;
      }
    }
    if (idle === undefined) break;
    const pending = queue.shift();
    if (pending === undefined) break;
    assignTask(idle, pending);
  }
  scheduleIdleReap();
}

function assignTask(poolWorker: PoolWorker, pending: PendingTask): void {
  poolWorker.current = pending;
  poolWorker.timer = setTimeout(() => {
    poolWorker.current = null;
    removeWorker(poolWorker);
    void poolWorker.worker.terminate();
    pending.reject(new ParseTaskTimeoutError());
    pumpQueue();
  }, taskTimeoutMs);
  poolWorker.timer.unref();
  poolWorker.worker.postMessage(pending.task);
}

class ParseTaskTimeoutError extends Error {
  constructor() {
    super(`parse worker task exceeded ${taskTimeoutMs}ms`);
    this.name = 'ParseTaskTimeoutError';
  }
}

function scheduleIdleReap(): void {
  if (idleReapTimer !== null) return;
  if (workers.length === 0) return;
  idleReapTimer = setTimeout(() => {
    idleReapTimer = null;
    const busy = workers.some((w) => w.current !== null);
    if (busy || queue.length > 0) {
      scheduleIdleReap();
      return;
    }
    for (const poolWorker of workers.splice(0)) {
      void poolWorker.worker.terminate();
    }
  }, WORKER_IDLE_REAP_MS);
  idleReapTimer.unref();
}

function dispatch(task: Omit<ParseWorkerTask, 'id'>): Promise<ParseWorkerResult> {
  const url = resolveWorkerUrl();
  if (url === null) {
    return Promise.reject(new ParsePoolUnavailableError());
  }
  installGauges();
  const pending: PendingTask = {
    task: { ...task, id: nextTaskId++ },
    resolve: () => {},
    reject: () => {},
  };
  const promise = new Promise<ParseWorkerResult>((resolve, reject) => {
    pending.resolve = resolve;
    pending.reject = reject;
  });
  const idle = workers.find((w) => w.current === null);
  if (idle !== undefined) {
    assignTask(idle, pending);
  } else if (workers.length < POOL_SIZE) {
    const spawned = spawnWorker(url);
    if (spawned === null) return Promise.reject(new ParsePoolUnavailableError());
    workers.push(spawned);
    assignTask(spawned, pending);
  } else if (queue.length < MAX_PENDING_TASKS) {
    queue.push(pending);
  } else {
    return Promise.reject(new ParsePoolBusyError());
  }
  return promise;
}

class ParsePoolUnavailableError extends Error {
  constructor() {
    super('parse worker unavailable in this packaging');
    this.name = 'ParsePoolUnavailableError';
  }
}

class ParsePoolBusyError extends Error {
  constructor() {
    super(`parse pool backlog exceeded ${MAX_PENDING_TASKS} tasks`);
    this.name = 'ParsePoolBusyError';
  }
}

export async function destroyParsePool(): Promise<void> {
  if (idleReapTimer !== null) {
    clearTimeout(idleReapTimer);
    idleReapTimer = null;
  }
  for (const pending of queue.splice(0)) {
    pending.reject(new Error('parse pool destroyed'));
  }
  const terminating = workers.splice(0).map((poolWorker) => {
    if (poolWorker.timer !== null) clearTimeout(poolWorker.timer);
    const pending = poolWorker.current;
    poolWorker.current = null;
    pending?.reject(new Error('parse pool destroyed'));
    return poolWorker.worker.terminate();
  });
  await Promise.allSettled(terminating);
}

export async function offloadParse(
  body: string,
  embedResolver?: ParsePoolEmbedResolver,
): Promise<JSONContent> {
  const base: Omit<ParseWorkerTask, 'id'> = {
    body,
    ...(embedResolver !== undefined
      ? {
          sourcePath: embedResolver.sourcePath,
          recordEmbeds: true,
          wantSizes: embedResolver.resolveSize !== undefined,
        }
      : {}),
  };
  const first = await dispatch(base);
  if (!first.ok) throw new Error(first.message);
  if (first.requestedTargets === undefined || first.requestedTargets.length === 0) {
    return first.parsedJson;
  }
  const resolver = embedResolver as ParsePoolEmbedResolver;
  const embedTable: Record<string, ParseWorkerEmbedResolution> = {};
  for (const target of first.requestedTargets) {
    embedTable[target] = {
      path: resolver.resolveEmbed(target, resolver.sourcePath) ?? null,
      size: resolver.resolveSize?.(target, resolver.sourcePath) ?? null,
    };
  }
  const second = await dispatch({
    body,
    sourcePath: resolver.sourcePath,
    wantSizes: resolver.resolveSize !== undefined,
    embedTable,
  });
  if (!second.ok) throw new Error(second.message);
  return second.parsedJson;
}

export async function precomputeParse(
  rawContent: string,
  embedResolver?: ParsePoolEmbedResolver,
): Promise<PrecomputedParse | undefined> {
  const { body } = stripFrontmatter(rawContent);
  if (body.length < PARSE_OFFLOAD_MIN_BYTES) {
    recordDispatch('inline-small');
    return undefined;
  }
  const started = performance.now();
  try {
    const parsedJson = await offloadParse(body, embedResolver);
    recordDispatch('offload');
    recordTaskLatency(performance.now() - started);
    return { rawContent, parsedJson };
  } catch (err) {
    if (err instanceof ParsePoolUnavailableError) {
      recordDispatch('inline-unavailable');
    } else if (err instanceof ParsePoolBusyError) {
      recordDispatch('inline-busy');
    } else if (err instanceof ParseTaskTimeoutError) {
      recordDispatch('inline-timeout');
      log.warn({ err, bodyBytes: body.length }, '[parse-pool] offload timed out; parsing inline');
    } else {
      recordDispatch('inline-error');
      log.warn({ err, bodyBytes: body.length }, '[parse-pool] offload failed; parsing inline');
    }
    return undefined;
  }
}
