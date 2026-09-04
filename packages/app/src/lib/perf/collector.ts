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

export function getCollector(): PerfCollector | undefined {
  if (import.meta.env?.PROD) return undefined;
  const g = globalThis as unknown as PerfGlobal;
  g[GLOBAL_KEY] ||= createCollector();
  return g[GLOBAL_KEY];
}

export function recordMark(mark: PerfMark): void {
  const c = getCollector();
  if (!c) return;
  c.marks.push(mark);
}

export function recordVital(v: WebVitalsMark): void {
  const c = getCollector();
  if (!c) return;
  c.vitals.push(v);
}

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
  const cacheKey = `${name}::${key}`;
  if (cardinalityWarned.has(cacheKey)) return;
  cardinalityWarned.add(cacheKey);
  console.warn(
    `[perf-counter] cardinality footgun: ${name} key ${key} exceeded ${CARDINALITY_WARN_THRESHOLD} distinct values`,
  );
}

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

export function __resetCardinalityWarnings(): void {
  cardinalityWarned.clear();
}

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

export function getHistogramSnapshot(name: string): HistogramSnapshot | undefined {
  const c = getCollector();
  if (!c) return undefined;
  const h = c.histograms[name];
  if (!h) return undefined;
  return h.snapshot();
}
