
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
  startTime?: number;
  duration?: number;
  tooltipText?: string;
}

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
  markImpl(name, { ...props, durationMs }, { duration: durationMs });
  recordHistogram(name, durationMs);
}

export const mark: MarkFn = Object.assign(markImpl, {
  count: countImpl,
  histogram: histogramImpl,
});
