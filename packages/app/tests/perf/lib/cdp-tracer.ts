/**
 * CDP Tracing helper.
 *
 * `traceStart(cdp)` opens the Chrome DevTools Protocol Tracing domain with
 * the category set we care about (long tasks, layout, style recalc,
 * script execution, paint). `traceEnd(cdp)` flushes the buffer, reads every
 * `Tracing.dataCollected` chunk, and returns a `TraceSummary` — per-category
 * aggregates plus the raw event count.
 *
 * The summary (not the raw events) is what goes into the scenario result
 * JSON — raw events routinely exceed 10 MB and drown the artifact.
 *
 * Aggregation is a pure function (`aggregateTrace`) so it can be unit-tested
 * with hand-crafted event arrays — no Playwright/CDP required for coverage.
 *
 * Category rationale (reverified against Chrome DevTools Performance panel's
 * own defaults):
 *   - cc, gpu: compositor + GPU raster
 *   - blink.user_timing: our own `performance.measure` marks show up here
 *   - devtools.timeline: LayoutShift, LargestContentfulPaint, LongTask
 *   - disabled-by-default-devtools.timeline: MajorGC, MinorGC, ThreadStateSampling
 *   - v8: JS compilation, GC
 *   - blink: RunMicrotasks, RunTask, UpdateLayoutTree, Layout, PaintImage
 *   - loading: Navigation, ResourceSendRequest, ResourceReceiveResponse
 */

import type { CDPSession } from '@playwright/test';

// ─────────────────────────── Types ─────────────────────────────────────────

/**
 * A single CDP trace event. Only the fields we read are typed — the CDP
 * protocol emits many more. `args` has no stable shape (category-dependent),
 * so we leave it `unknown` and narrow at use sites.
 */
export interface CdpTraceEvent {
  /** Event name, e.g. `Layout`, `UpdateLayoutTree`, `RunTask`, `LongTask`. */
  name: string;
  /** Category list, comma-joined: `"disabled-by-default-devtools.timeline"`. */
  cat: string;
  /** Microsecond timestamp since trace start. */
  ts: number;
  /** Event duration in microseconds (present on `B`/`E` pairs and `X`). */
  dur?: number;
  /** Phase: `'X'` = complete, `'B'/'E'` = begin/end, `'I'` = instant, `'M'` = metadata. */
  ph: string;
  /** Event-specific args. */
  args?: Record<string, unknown>;
  /** Thread ID. */
  tid?: number;
  /** Process ID. */
  pid?: number;
}

export interface TraceSummary {
  /** Total events collected. */
  eventCount: number;
  /**
   * Tasks considered "long" — anything ≥ 50ms per Web Perf Working Group
   * convention (window.PerformanceLongTaskTiming threshold). Counted from
   * `RunTask` events in the `disabled-by-default-devtools.timeline` category.
   */
  longTaskCount: number;
  /** The single longest task duration observed, in milliseconds. */
  longestTaskMs: number;
  /** Sum of every `RunTask` dur, in ms. Caps at ~wall-clock. */
  taskDurationMs: number;
  /** Sum of `UpdateLayoutTree` + `RecalcStyle` durations, in ms. */
  styleMs: number;
  /** Sum of `Layout` durations, in ms. */
  layoutMs: number;
  /** Sum of V8/script-execution durations (`v8.compile`, `EvaluateScript`, `FunctionCall`), in ms. */
  scriptMs: number;
  /** Paint-family event count (`Paint`, `PaintImage`, `CompositeLayers`). */
  paintEvents: number;
  /** User-timing marks captured in `blink.user_timing` — our own `ok/*` marks travel through here. */
  userTimingMarkCount: number;
  /** LargestContentfulPaint's last `ts` (ms). `null` if never emitted. */
  lastLcpMs: number | null;
  /** LayoutShift score accumulator (sum of `score` args). */
  cumulativeLayoutShift: number;
}

// ─────────────────────────── Category set ──────────────────────────────────

export const TRACE_CATEGORIES: readonly string[] = [
  'cc',
  'gpu',
  'blink',
  'blink.user_timing',
  'loading',
  'v8',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-v8.cpu_profiler',
] as const;

// ─────────────────────────── CDP driver ───────────────────────────────────

/**
 * Playwright types `Tracing.dataCollected.value` as `Array<{[k]:string}>`,
 * which disagrees with Chromium's actual shape (the CDP spec emits per-event
 * records with numeric/nested fields). We cast at the boundary — events are
 * only ever read through `aggregateTrace`, which narrows each event
 * defensively so the runtime shape is what survives.
 */

// Playwright's `CDPSession.on('Tracing.dataCollected', ...)` handler signature
// uses a narrow `{ value: {[k]:string}[] }` shape that disagrees with the real
// protocol. We call into that overload directly, then cast `.value` to the
// structural `Record<string, unknown>[]` shape for internal narrowing. The
// `off` side accepts the same listener reference, so pass the wrapper we kept
// on the token — never the raw arrow we never saved.

// biome-ignore lint/suspicious/noExplicitAny: Playwright's dataCollectedPayload is mistyped; cast at the boundary.
type DataCollectedHandler = (payload: any) => void;

/**
 * Start collecting CDP trace events. Returns a token — pass it to `traceEnd`
 * to flush + aggregate. Safe to call once per CDP session; nested calls
 * throw on the CDP side.
 *
 * The tracer subscribes to `Tracing.dataCollected` eagerly (events start
 * streaming as soon as `Tracing.start` resolves, not at `end`).
 */
export async function traceStart(cdp: CDPSession): Promise<TraceToken> {
  const events: CdpTraceEvent[] = [];
  const handler: DataCollectedHandler = (payload) => {
    const value = payload?.value as unknown;
    if (!Array.isArray(value)) return;
    for (const raw of value as Record<string, unknown>[]) {
      const ev = coerceEvent(raw);
      if (ev) events.push(ev);
    }
  };
  cdp.on('Tracing.dataCollected', handler);

  await cdp.send('Tracing.start', {
    categories: TRACE_CATEGORIES.join(','),
    transferMode: 'ReportEvents',
    options: 'sampling-frequency=10000',
  });

  return { cdp, events, handler };
}

/**
 * Flush + aggregate. After this returns, `dataCollected` events are no
 * longer captured (handler detached), and the CDP Tracing domain is closed.
 */
export async function traceEnd(token: TraceToken): Promise<TraceSummary> {
  const { cdp, events, handler } = token;

  const completed = new Promise<void>((resolve) => {
    const onComplete: DataCollectedHandler = () => {
      cdp.off('Tracing.tracingComplete', onComplete);
      resolve();
    };
    cdp.on('Tracing.tracingComplete', onComplete);
  });

  await cdp.send('Tracing.end');
  await completed;
  cdp.off('Tracing.dataCollected', handler);

  return aggregateTrace(events);
}

export interface TraceToken {
  cdp: CDPSession;
  events: CdpTraceEvent[];
  handler: DataCollectedHandler;
}

/**
 * Narrow an arbitrary CDP event record into `CdpTraceEvent`. Rejects
 * anything without the three minimum fields (`name`, `cat`, `ts`, `ph`).
 */
function coerceEvent(raw: Record<string, unknown>): CdpTraceEvent | null {
  if (typeof raw.name !== 'string') return null;
  if (typeof raw.cat !== 'string') return null;
  if (typeof raw.ts !== 'number') return null;
  if (typeof raw.ph !== 'string') return null;
  return {
    name: raw.name,
    cat: raw.cat,
    ts: raw.ts,
    ph: raw.ph,
    ...(typeof raw.dur === 'number' ? { dur: raw.dur } : {}),
    ...(raw.args && typeof raw.args === 'object'
      ? { args: raw.args as Record<string, unknown> }
      : {}),
    ...(typeof raw.tid === 'number' ? { tid: raw.tid } : {}),
    ...(typeof raw.pid === 'number' ? { pid: raw.pid } : {}),
  };
}

// ─────────────────────────── Pure aggregation (unit-tested) ────────────────

/** `≥ 50ms` is the Web Perf Working Group long-task threshold. */
export const LONG_TASK_THRESHOLD_MS = 50;

/**
 * Pure aggregation: events → `TraceSummary`. Never throws; tolerates
 * malformed / incomplete events by skipping them.
 */
export function aggregateTrace(events: readonly CdpTraceEvent[]): TraceSummary {
  let longTaskCount = 0;
  let longestTaskMs = 0;
  let taskDurationMs = 0;
  let styleMs = 0;
  let layoutMs = 0;
  let scriptMs = 0;
  let paintEvents = 0;
  let userTimingMarkCount = 0;
  let lastLcpMs: number | null = null;
  let cumulativeLayoutShift = 0;

  for (const ev of events) {
    if (!ev || typeof ev.name !== 'string') continue;
    const catList = typeof ev.cat === 'string' ? ev.cat.split(',') : [];
    const durUs = typeof ev.dur === 'number' && Number.isFinite(ev.dur) ? ev.dur : 0;
    const durMs = durUs / 1000;

    // Long tasks + total task duration
    if (ev.name === 'RunTask' || ev.name === 'ThreadControllerImpl::RunTask') {
      taskDurationMs += durMs;
      if (durMs >= LONG_TASK_THRESHOLD_MS) longTaskCount += 1;
      if (durMs > longestTaskMs) longestTaskMs = durMs;
      continue;
    }

    // Style recalc
    if (ev.name === 'UpdateLayoutTree' || ev.name === 'RecalcStyle') {
      styleMs += durMs;
      continue;
    }

    // Layout
    if (ev.name === 'Layout') {
      layoutMs += durMs;
      continue;
    }

    // Script/V8 execution
    if (
      ev.name === 'EvaluateScript' ||
      ev.name === 'FunctionCall' ||
      ev.name === 'v8.compile' ||
      ev.name === 'V8.Execute'
    ) {
      scriptMs += durMs;
      continue;
    }

    // Paint family
    if (ev.name === 'Paint' || ev.name === 'PaintImage' || ev.name === 'CompositeLayers') {
      paintEvents += 1;
      continue;
    }

    // User-timing marks (our ok/* marks)
    if (catList.includes('blink.user_timing')) {
      userTimingMarkCount += 1;
      continue;
    }

    // LCP
    if (ev.name === 'largestContentfulPaint::Candidate' || ev.name === 'LargestContentfulPaint') {
      const ms = typeof ev.ts === 'number' ? ev.ts / 1000 : null;
      if (ms !== null && Number.isFinite(ms)) lastLcpMs = ms;
      continue;
    }

    // CLS
    if (ev.name === 'LayoutShift') {
      const score =
        ev.args?.data && typeof ev.args.data === 'object'
          ? (ev.args.data as { score?: number }).score
          : undefined;
      if (typeof score === 'number' && Number.isFinite(score)) {
        cumulativeLayoutShift += score;
      }
    }
  }

  return {
    eventCount: events.length,
    longTaskCount,
    longestTaskMs: roundMs(longestTaskMs),
    taskDurationMs: roundMs(taskDurationMs),
    styleMs: roundMs(styleMs),
    layoutMs: roundMs(layoutMs),
    scriptMs: roundMs(scriptMs),
    paintEvents,
    userTimingMarkCount,
    lastLcpMs: lastLcpMs === null ? null : roundMs(lastLcpMs),
    cumulativeLayoutShift: Math.round(cumulativeLayoutShift * 10000) / 10000,
  };
}

function roundMs(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

// ─────────────────────────── Performance.getMetrics ────────────────────────
//
// Companion to the Tracing-domain aggregation above. CDP's `Performance` domain
// exposes accumulating counters (`LayoutDuration`, `RecalcStyleDuration`,
// `ScriptDuration`, `TaskDuration`) that grow over the page lifetime. Two
// snapshots before/after a window — `getPerfMetricsSnapshot` then a delta
// — yield the per-axis cost of the window without the full Tracing buffer.
//
// Why both: Tracing gives per-event detail (name, ts, dur, args) but the
// buffer routinely exceeds 10 MB for a 5 s cold-mount and is heavyweight to
// read + aggregate. `Performance.getMetrics` is two RPC calls, returns
// pre-aggregated axes, and is the canonical way to capture style-recalc
// cost when no `getMetrics` call brackets the cold-mount span.
//
// ─────────────────────────────────────────────────────────────────────────

/**
 * Per-axis delta in milliseconds. CDP's underlying counters are in seconds;
 * this helper converts at extraction time so consumers stay in ms.
 */
export interface PerfMetricsDelta {
  layoutMs: number;
  recalcStyleMs: number;
  scriptMs: number;
  taskMs: number;
}

/**
 * Raw snapshot — CDP metric names are PascalCase and in seconds. Kept as a
 * `Map<name, value>` because callers may want axes beyond the four we
 * extract by default (e.g., `LayoutCount`, `JSHeapUsedSize`).
 */
export type PerfMetricsSnapshot = ReadonlyMap<string, number>;

/**
 * Minimal subset of `CDPSession` we exercise — typed locally so the helper
 * can be unit-tested with a hand-rolled mock that doesn't require Playwright.
 *
 * `send(method, params?)` is the single CDP RPC entry; we only ever call
 * `Performance.enable` and `Performance.getMetrics`.
 */
export interface MinimalCdpClient {
  send(method: 'Performance.enable'): Promise<unknown>;
  send(
    method: 'Performance.getMetrics',
  ): Promise<{ metrics: Array<{ name: string; value: number }> }>;
  // biome-ignore lint/suspicious/noExplicitAny: pass-through signature; only the two overloads above are exercised by this helper.
  send(method: string, params?: unknown): Promise<any>;
}

/**
 * Enable the `Performance` domain. Idempotent — CDP `Performance.enable`
 * accepts re-enable without erroring (returns the same domain handle).
 *
 * Should be called once before the first `getPerfMetricsSnapshot` in a
 * session; ad-hoc callers can call it before any snapshot.
 */
export async function enablePerformanceMetrics(cdp: MinimalCdpClient): Promise<void> {
  await cdp.send('Performance.enable');
}

/**
 * Single snapshot of CDP `Performance.getMetrics`. Returns a Map keyed by
 * metric name (e.g., `LayoutDuration`). Values are CDP-native units
 * (seconds for *Duration metrics, counts for *Count, bytes for *Size).
 */
export async function getPerfMetricsSnapshot(cdp: MinimalCdpClient): Promise<PerfMetricsSnapshot> {
  const result = await cdp.send('Performance.getMetrics');
  const map = new Map<string, number>();
  for (const m of result.metrics) {
    if (typeof m?.name === 'string' && typeof m?.value === 'number') {
      map.set(m.name, m.value);
    }
  }
  return map;
}

function deltaSeconds(end: PerfMetricsSnapshot, start: PerfMetricsSnapshot, name: string): number {
  const e = end.get(name);
  const s = start.get(name);
  if (typeof e !== 'number' || typeof s !== 'number') return 0;
  return Math.max(0, e - s);
}

/**
 * Compute per-axis ms delta between two snapshots. CDP `*Duration` metrics
 * are accumulating (always increasing over the page lifetime), so a simple
 * subtract produces the window's contribution. Negative deltas (which can
 * occur if the page reloaded between snapshots) clamp to zero.
 */
export function computePerfMetricsDelta(
  start: PerfMetricsSnapshot,
  end: PerfMetricsSnapshot,
): PerfMetricsDelta {
  return {
    layoutMs: roundMs(deltaSeconds(end, start, 'LayoutDuration') * 1000),
    recalcStyleMs: roundMs(deltaSeconds(end, start, 'RecalcStyleDuration') * 1000),
    scriptMs: roundMs(deltaSeconds(end, start, 'ScriptDuration') * 1000),
    taskMs: roundMs(deltaSeconds(end, start, 'TaskDuration') * 1000),
  };
}

/**
 * Convenience: bracket an async work function with two `getPerfMetricsSnapshot`
 * calls and return the delta. Captures the style-recalc axis when
 * invoked around the cold-mount span.
 *
 * The "startMark" and "endMark" labels in spec text refer to the two
 * `Performance.getMetrics` calls that bracket `fn()` — start runs before
 * `await fn()`, end runs after, regardless of whether `fn` resolves or
 * rejects. On rejection, the delta is still computed + returned via a
 * `try/finally` shape (the rejection is rethrown after extraction).
 */
export async function capturePerfMetricsWindow<T>(
  cdp: MinimalCdpClient,
  fn: () => Promise<T>,
): Promise<{ result: T; deltas: PerfMetricsDelta }> {
  const start = await getPerfMetricsSnapshot(cdp);
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    // Snapshot the END side anyway so the delta is captured even on throw.
    // Re-throw with the deltas as a property of the error so the caller can
    // still extract them; tooling that doesn't read them just sees the err.
    const end = await getPerfMetricsSnapshot(cdp);
    const deltas = computePerfMetricsDelta(start, end);
    if (err && typeof err === 'object') {
      (err as { perfMetricsDeltas?: PerfMetricsDelta }).perfMetricsDeltas = deltas;
    }
    throw err;
  }
  const end = await getPerfMetricsSnapshot(cdp);
  return { result, deltas: computePerfMetricsDelta(start, end) };
}
