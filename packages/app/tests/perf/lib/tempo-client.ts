/**
 * Tempo HTTP API query helper for the convention-cap-graduation sweep.
 *
 * Queries Tempo's /api/search by a time-window, then post-filters the
 * returned spans by `mountId` attribute to assemble per-cycle decomposed
 * timings. Tempo's TraceQL filter form is intentionally NOT used because
 * the helper needs to distinguish three outcomes:
 *
 *   - `success`               — spans found and at least one matches the mountId
 *   - `empty`                 — no spans returned at all (BSP not flushed yet)
 *   - `correlation-missing`   — spans returned, but none carry the mountId
 *
 * A pure TraceQL filter (e.g. `{ .mountId="<id>" }`) collapses `empty` and
 * `correlation-missing` into the same response shape — Tempo just returns
 * zero traces in both cases. The sweep needs the distinction because
 * `correlation-missing` is an actionable STOP_IF for the operator
 * (frontend forgot to append mountId to the WS URL; server didn't extract
 * it) whereas `empty` is a transient retry-after-BSP-flush condition.
 *
 * Single round-trip per cycle: query once by time-window, iterate spans,
 * partition by mountId. Bounded by Tempo's `limit` param so a cycle
 * window with many concurrent traces doesn't pull megabytes.
 */

const DEFAULT_TEMPO_BASE_URL = 'http://localhost:3200';
const DEFAULT_FETCH_TIMEOUT_MS = 2000;
const DEFAULT_LIMIT = 100;

/** Span name constants — the 6 spans the sweep decomposes per cycle. */
const SPAN_NAMES = {
  coldMount: 'ok.cold-mount',
  providerPoolOpen: 'ok.provider-pool.open',
  mountPromise: 'ok.mount-promise',
  syncPromise: 'ok.sync-promise',
  syncHandshake: 'sync.handshake',
  persistenceLoadDocument: 'persistence.onLoadDocument',
} as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

/**
 * Discriminated union of Tempo query outcomes. Each variant has the
 * exact set of fields the caller needs — making illegal states
 * unrepresentable: a cycle either has span timings (`success`) or has
 * a named reason (other variants), never both-null silently.
 */
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
  /** Pre-validated mountId — the cycle's correlation seed. */
  mountId: string;
  /** Time-window lower bound (Unix ms). Tempo converts to seconds. */
  startTimeMs: number;
  /** Time-window upper bound (Unix ms). Tempo converts to seconds. */
  endTimeMs: number;
  /** Override the Tempo base URL. Defaults to http://localhost:3200. */
  tempoBaseUrl?: string;
  /** Fetch timeout in ms. Defaults to 2000 (accounts for BSP flush delay). */
  fetchTimeoutMs?: number;
  /** Hard cap on returned traces. Defaults to 100 — bounds per-cycle payload. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Tempo response shape (permissive — Tempo's response varies across versions)
// ---------------------------------------------------------------------------

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
  /** Tempo's older shape — single spanSet per trace. */
  spanSet?: TempoSpanSet;
  /** Tempo's TraceQL grouped shape — multiple spanSets per trace. */
  spanSets?: TempoSpanSet[];
}

export interface TempoSearchResponse {
  traces?: TempoTrace[];
}

// ---------------------------------------------------------------------------
// HTTP query
// ---------------------------------------------------------------------------

/**
 * Query Tempo by time-window, then post-filter spans by mountId.
 */
export async function queryTempoByMountId(opts: TempoSearchOptions): Promise<TempoQueryResult> {
  const baseUrl = opts.tempoBaseUrl ?? DEFAULT_TEMPO_BASE_URL;
  const timeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  // Tempo's /api/search expects start/end in Unix seconds, not ms.
  // Floor for start (don't lose the earliest moments of the window) and
  // ceil for end (don't lose the last moments).
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

  // Permissive cast — `parseTempoTimings` re-validates the shape it actually
  // depends on (traces[].spanSet.spans[].{name, durationNanos, attributes}).
  return parseTempoTimings(body as TempoSearchResponse, opts.mountId);
}

// ---------------------------------------------------------------------------
// Pure parsing (split out so tests can exercise without fetch)
// ---------------------------------------------------------------------------

/**
 * Pure-function extractor: given a Tempo /api/search response body and
 * the target mountId, partitions spans by mountId match and returns the
 * appropriate result variant.
 *
 * Splitting parse from fetch keeps the assertion surface small — fetch
 * boundary tests cover HTTP errors / malformed JSON; parse tests cover
 * span-shape edge cases (spanSet vs spanSets, multi-trace responses,
 * partial coverage).
 */
export function parseTempoTimings(
  response: TempoSearchResponse,
  mountId: string,
): TempoQueryResult {
  const traces = response?.traces ?? [];
  if (traces.length === 0) {
    return { kind: 'empty' };
  }

  // Flatten all spans across traces and spanSet shapes.
  const allSpans = flattenSpans(traces);
  if (allSpans.length === 0) {
    // Traces returned but contained no spans — same operational meaning
    // as empty (Tempo had nothing to show, BSP not flushed).
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
