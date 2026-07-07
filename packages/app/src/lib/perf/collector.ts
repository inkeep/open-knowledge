/**
 * Dev-only `window.__ok_perf` collector.
 *
 * Gated on `!import.meta.env.PROD` so Vite's build-time constant folding drops
 * the buffer allocation (and the global assignment) from production bundles.
 * In production `getCollector()` returns `undefined`; `mark()` skips the push.
 *
 * The negated-PROD form (rather than DEV) is deliberate: under `bun test`,
 * neither constant exists and both are `undefined` — `!undefined === true`
 * keeps the collector live in tests, while `import.meta.env.DEV` would
 * evaluate falsy and break unit-test verification of collector behavior.
 */

import { CircularBuffer } from './circular-buffer';
import { readNumericOverride } from './env-override';
import { Histogram } from './hdr-histogram';
import type {
  HistogramSnapshot,
  PerfCollector,
  PerfCounter,
  PerfMark,
  WebVitalsMark,
} from './types';

declare global {
  interface Window {
    __ok_perf?: PerfCollector;
  }
  // eslint-disable-next-line no-var -- required for `globalThis` augmentation
  var __ok_perf: PerfCollector | undefined;
}

const GLOBAL_KEY = '__ok_perf' as const;

interface PerfGlobal {
  __ok_perf?: PerfCollector;
}

function createCollector(): PerfCollector {
  const startedAt = performance.now();
  // Capacity bounds: mark ring sized for ~30 min of typical emission;
  // vitals ring far smaller because Web Vitals events arrive sparsely.
  // Both reachable via env-override for sweep scenarios.
  const markCapacity = readNumericOverride('MAX_RING_ENTRIES', 5000);
  const vitalsCapacity = readNumericOverride('MAX_VITALS_RING_ENTRIES', 200);
  const collector: PerfCollector = {
    marks: new CircularBuffer<PerfMark>(markCapacity),
    vitals: new CircularBuffer<WebVitalsMark>(vitalsCapacity),
    counters: {},
    histograms: {},
    startedAt,
    reset() {
      collector.marks.clear();
      collector.vitals.clear();
      for (const k of Object.keys(collector.counters)) {
        delete collector.counters[k];
      }
      for (const k of Object.keys(collector.histograms)) {
        delete collector.histograms[k];
      }
      collector.startedAt = performance.now();
    },
  };
  return collector;
}

/**
 * Returns the live dev-only collector, creating it on first access.
 * Returns `undefined` in production builds.
 *
 * Storage lives on `globalThis` (which is `window` in a browser, the module
 * global in Node/Bun) so unit tests and browser scenarios share one shape.
 */
export function getCollector(): PerfCollector | undefined {
  if (import.meta.env?.PROD) return undefined;
  const g = globalThis as unknown as PerfGlobal;
  g[GLOBAL_KEY] ||= createCollector();
  return g[GLOBAL_KEY];
}

/**
 * Push a mark to the collector. No-op when the collector is absent
 * (non-DEV build, or non-browser environment).
 */
export function recordMark(mark: PerfMark): void {
  const c = getCollector();
  if (!c) return;
  c.marks.push(mark);
}

/**
 * Push a web vitals event to the collector.
 */
export function recordVital(v: WebVitalsMark): void {
  const c = getCollector();
  if (!c) return;
  c.vitals.push(v);
}

/**
 * Cardinality footgun threshold: warn once when a single
 * counter prop key accumulates >100 distinct values. Prevents per-doc-content
 * keys from silently bloating the in-memory map.
 */
const CARDINALITY_WARN_THRESHOLD = 100;
const cardinalityWarned = new Set<string>();

function ensureCounter(c: PerfCollector, name: string): PerfCounter {
  let entry = c.counters[name];
  if (!entry) {
    entry = { total: 0, byProp: {} };
    c.counters[name] = entry;
  }
  return entry;
}

function checkCardinality(name: string, key: string, distinctCount: number): void {
  if (distinctCount <= CARDINALITY_WARN_THRESHOLD) return;
  // Bun's `import.meta.env.DEV` is undefined under `bun test`. The collector
  // is gated on `!PROD`, so when this code runs at all, we're outside prod.
  // Fire the warning whenever the threshold is crossed.
  const cacheKey = `${name}::${key}`;
  if (cardinalityWarned.has(cacheKey)) return;
  cardinalityWarned.add(cacheKey);
  console.warn(
    `[perf-counter] cardinality footgun: ${name} key ${key} exceeded ${CARDINALITY_WARN_THRESHOLD} distinct values`,
  );
}

/**
 * Increment the counter at `name`. Optional `props` increment per-key
 * subcounters so consumers can read e.g. hit-vs-miss without parsing
 * mark payloads. Cardinality-watchdogged in DEV.
 */
export function recordCounter(
  name: string,
  props?: Record<string, string | number | boolean>,
): void {
  const c = getCollector();
  if (!c) return;
  const entry = ensureCounter(c, name);
  entry.total += 1;
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    let bucket = entry.byProp[k];
    if (!bucket) {
      bucket = {};
      entry.byProp[k] = bucket;
    }
    const valueKey = String(v);
    const wasNew = !(valueKey in bucket);
    bucket[valueKey] = (bucket[valueKey] ?? 0) + 1;
    if (wasNew) checkCardinality(name, k, Object.keys(bucket).length);
  }
}

/** Test-only: clear the cardinality warn-once cache so tests can re-observe. */
export function __resetCardinalityWarnings(): void {
  cardinalityWarned.clear();
}

/**
 * Push `durationMs` into the histogram named `name`. Lazily allocates the
 * Histogram on first emit. The class reference flows through getCollector(),
 * which Vite tree-shakes from production builds (see hdr-histogram.ts).
 */
export function recordHistogram(name: string, durationMs: number): void {
  const c = getCollector();
  if (!c) return;
  let h = c.histograms[name];
  if (!h) {
    h = new Histogram();
    c.histograms[name] = h;
  }
  h.push(durationMs);
}

/**
 * Read a snapshot for the histogram named `name`. Returns undefined when
 * no samples have been recorded for that name (or in production where the
 * collector is absent).
 */
export function getHistogramSnapshot(name: string): HistogramSnapshot | undefined {
  const c = getCollector();
  if (!c) return undefined;
  const h = c.histograms[name];
  if (!h) return undefined;
  return h.snapshot();
}
