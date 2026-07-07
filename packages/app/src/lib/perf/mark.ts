/**
 * `mark(name, props?)` — emit a semantic perf event.
 *
 * Wraps `performance.measure` with the Chrome DevTools Extensibility API
 * `detail.devtools` shape so the measure appears as a custom track in the
 * Performance panel under `ok/<subsystem>` (track group derived from the
 * second `/` segment of the name — e.g. `ok/nav/hash-change` → track `ok/nav`).
 *
 * Naming convention: `ok/<subsystem>/<event>` where subsystem is
 * one of `nav`, `sync`, `activity`, `render`, `editor`, `sidebar`, `outline`,
 * `vitals`, `mount`, `cold`, `startup`. `validatePerfMarkName` is a dev-only lint of the
 * shape; it `console.warn`s in dev and returns silently so emission is always
 * best-effort.
 *
 * Production cost is one `performance.measure` call. The collector push is
 * `no-op` in non-DEV builds (see `collector.ts`).
 */

import { recordCounter, recordHistogram, recordMark } from './collector';
import type { DevToolsTrackEntry, PerfMarkDetail } from './types';

const NAME_RE = /^ok\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

export function validatePerfMarkName(name: string): boolean {
  return NAME_RE.test(name);
}

function deriveTrack(name: string): string {
  const parts = name.split('/');
  if (parts.length < 2) return 'ok';
  return `${parts[0]}/${parts[1]}`;
}

function propsToDevToolsTuples(
  props: Record<string, unknown> | undefined,
): Array<[string, string]> | undefined {
  if (!props) return undefined;
  const entries = Object.entries(props);
  if (entries.length === 0) return undefined;
  return entries.map(([k, v]) => {
    if (v === null || v === undefined) return [k, String(v)];
    if (typeof v === 'string') return [k, v];
    if (typeof v === 'number' || typeof v === 'boolean') return [k, String(v)];
    try {
      return [k, JSON.stringify(v)];
    } catch {
      return [k, '[unserializable]'];
    }
  });
}

interface MarkOptions {
  /** Explicit start time (defaults to performance.now() at call time). */
  startTime?: number;
  /** Duration in ms. If omitted, a zero-duration marker is emitted. */
  duration?: number;
  /** Override tooltip. */
  tooltipText?: string;
}

/**
 * Emit a perf mark. Call at the moment the semantic event completes — pass
 * `startTime` to produce a measured span, or leave it off for a point event.
 *
 * `mark.count(name, props?)` increments a hit-rate counter on the collector
 * (hit/miss visibility for caches, prewarm, pool). Cardinality-watchdogged
 * in DEV — passing a per-doc-content prop key warns once at 100 distinct
 * values for that (name, key) pair.
 */
export interface MarkFn {
  (name: string, props?: Record<string, unknown>, opts?: MarkOptions): void;
  count(name: string, props?: Record<string, string | number | boolean>): void;
  histogram(
    name: string,
    props: Record<string, string | number | boolean>,
    durationMs: number,
  ): void;
}

function markImpl(name: string, props?: Record<string, unknown>, opts?: MarkOptions): void {
  if (!import.meta.env?.PROD && !validatePerfMarkName(name)) {
    // eslint-disable-next-line no-console -- dev-only lint
    console.warn(`[perf] mark name "${name}" does not match ok/<subsystem>/<event>`);
  }

  if (typeof performance === 'undefined' || !performance.measure) return;

  const track = deriveTrack(name);
  const properties = propsToDevToolsTuples(props);
  const devtools: DevToolsTrackEntry = {
    dataType: 'track-entry',
    track,
    ...(properties ? { properties } : {}),
    ...(opts?.tooltipText ? { tooltipText: opts.tooltipText } : {}),
  };
  const detail: PerfMarkDetail = { devtools };

  const now = performance.now();
  const start = opts?.startTime ?? now;
  const duration = opts?.duration ?? Math.max(0, now - start);

  try {
    performance.measure(name, {
      start,
      duration,
      detail,
    });
  } catch {
    // `performance.measure` can throw if `start` is before `timeOrigin`
    // on some browsers; swallow — instrumentation must never break the app.
  }

  recordMark({
    name,
    startTime: start,
    duration,
    track,
    ...(props ? { properties: props } : {}),
  });
}

function countImpl(name: string, props?: Record<string, string | number | boolean>): void {
  if (!import.meta.env?.PROD && !validatePerfMarkName(name)) {
    // eslint-disable-next-line no-console -- dev-only lint
    console.warn(`[perf] mark.count name "${name}" does not match ok/<subsystem>/<event>`);
  }
  recordCounter(name, props);
}

function histogramImpl(
  name: string,
  props: Record<string, string | number | boolean>,
  durationMs: number,
): void {
  if (!import.meta.env?.PROD && !validatePerfMarkName(name)) {
    // eslint-disable-next-line no-console -- dev-only lint
    console.warn(`[perf] mark.histogram name "${name}" does not match ok/<subsystem>/<event>`);
  }
  // Emit a paired DevTools-track mark so the same payload appears in
  // Performance traces alongside the histogram update.
  markImpl(name, { ...props, durationMs }, { duration: durationMs });
  recordHistogram(name, durationMs);
}

/**
 * `mark` is the single primitive — `mark()` records a measure-style event,
 * `mark.count(name, props?)` increments the hit-rate counter,
 * `mark.histogram` records a sample for in-process percentile
 * aggregation. Three methods on one callable.
 */
export const mark: MarkFn = Object.assign(markImpl, {
  count: countImpl,
  histogram: histogramImpl,
});
