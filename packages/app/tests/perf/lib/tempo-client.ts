
const DEFAULT_TEMPO_BASE_URL = 'http://localhost:3200';
const DEFAULT_FETCH_TIMEOUT_MS = 2000;
const DEFAULT_LIMIT = 100;

const SPAN_NAMES = {
  coldMount: 'ok.cold-mount',
  providerPoolOpen: 'ok.provider-pool.open',
  mountPromise: 'ok.mount-promise',
  syncPromise: 'ok.sync-promise',
  syncHandshake: 'sync.handshake',
  persistenceLoadDocument: 'persistence.onLoadDocument',
} as const;


export interface ServerSpanTimings {
  syncHandshakeMs: number | null;
  persistenceLoadMs: number | null;
}

export interface ClientSpanTimings {
  coldMountMs: number | null;
  providerPoolOpenMs: number | null;
  mountPromiseMs: number | null;
  syncPromiseMs: number | null;
}

export type TempoQueryResult =
  | {
      kind: 'success';
      serverSpanTimings: ServerSpanTimings;
      clientSpanTimings: ClientSpanTimings;
    }
  | { kind: 'empty' }
  | { kind: 'correlation-missing' }
  | { kind: 'error'; reason: string };

export interface TempoSearchOptions {
  mountId: string;
  startTimeMs: number;
  endTimeMs: number;
  tempoBaseUrl?: string;
  fetchTimeoutMs?: number;
  limit?: number;
}


interface TempoSpanAttributeValue {
  stringValue?: string;
  intValue?: string | number;
  boolValue?: boolean;
  doubleValue?: number;
}

interface TempoSpanAttribute {
  key: string;
  value: TempoSpanAttributeValue;
}

interface TempoSpan {
  spanID?: string;
  name: string;
  durationNanos: string | number;
  attributes?: TempoSpanAttribute[];
}

interface TempoSpanSet {
  spans?: TempoSpan[];
}

interface TempoTrace {
  traceID?: string;
  spanSet?: TempoSpanSet;
  spanSets?: TempoSpanSet[];
}

export interface TempoSearchResponse {
  traces?: TempoTrace[];
}


export async function queryTempoByMountId(opts: TempoSearchOptions): Promise<TempoQueryResult> {
  const baseUrl = opts.tempoBaseUrl ?? DEFAULT_TEMPO_BASE_URL;
  const timeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const startSec = Math.floor(opts.startTimeMs / 1000);
  const endSec = Math.ceil(opts.endTimeMs / 1000);

  const url = `${baseUrl}/api/search?start=${startSec}&end=${endSec}&limit=${limit}`;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    return {
      kind: 'error',
      reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    return {
      kind: 'error',
      reason: `tempo HTTP ${response.status}: ${response.statusText || 'unknown'}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return {
      kind: 'error',
      reason: `failed to parse Tempo JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return parseTempoTimings(body as TempoSearchResponse, opts.mountId);
}


export function parseTempoTimings(
  response: TempoSearchResponse,
  mountId: string,
): TempoQueryResult {
  const traces = response?.traces ?? [];
  if (traces.length === 0) {
    return { kind: 'empty' };
  }

  const allSpans = flattenSpans(traces);
  if (allSpans.length === 0) {
    return { kind: 'empty' };
  }

  const matchingSpans = allSpans.filter((s) => extractMountId(s) === mountId);
  if (matchingSpans.length === 0) {
    return { kind: 'correlation-missing' };
  }

  return {
    kind: 'success',
    serverSpanTimings: {
      syncHandshakeMs: findSpanDurationMs(matchingSpans, SPAN_NAMES.syncHandshake),
      persistenceLoadMs: findSpanDurationMs(matchingSpans, SPAN_NAMES.persistenceLoadDocument),
    },
    clientSpanTimings: {
      coldMountMs: findSpanDurationMs(matchingSpans, SPAN_NAMES.coldMount),
      providerPoolOpenMs: findSpanDurationMs(matchingSpans, SPAN_NAMES.providerPoolOpen),
      mountPromiseMs: findSpanDurationMs(matchingSpans, SPAN_NAMES.mountPromise),
      syncPromiseMs: findSpanDurationMs(matchingSpans, SPAN_NAMES.syncPromise),
    },
  };
}

function flattenSpans(traces: TempoTrace[]): TempoSpan[] {
  const out: TempoSpan[] = [];
  for (const trace of traces) {
    if (trace.spanSet?.spans) out.push(...trace.spanSet.spans);
    if (trace.spanSets) {
      for (const set of trace.spanSets) {
        if (set.spans) out.push(...set.spans);
      }
    }
  }
  return out;
}

function extractMountId(span: TempoSpan): string | undefined {
  const attrs = span.attributes ?? [];
  for (const attr of attrs) {
    if (attr.key === 'mount.id') {
      return attr.value.stringValue;
    }
  }
  return undefined;
}

function findSpanDurationMs(spans: TempoSpan[], name: string): number | null {
  const span = spans.find((s) => s.name === name);
  if (!span) return null;
  const nanos =
    typeof span.durationNanos === 'string' ? Number(span.durationNanos) : span.durationNanos;
  if (!Number.isFinite(nanos)) return null;
  return nanos / 1_000_000;
}
