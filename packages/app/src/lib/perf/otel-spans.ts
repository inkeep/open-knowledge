/**
 * Frontend OTel span helpers.
 *
 * Produces a 4-span tree per cold-mount cycle, joined by `mountId`:
 *
 *   ok.cold-mount  (root)
 *     ├── ok.provider-pool.open
 *     ├── ok.mount-promise
 *     └── ok.sync-promise
 *
 * The Tempo HTTP API query side (packages/app/tests/perf/lib/tempo-client.ts)
 * filters by the `mountId` attribute to materialize per-cycle decomposed
 * timings for the cell-results JSON.
 *
 * Minimal overhead when OTel is disabled: `@opentelemetry/api` returns a
 * no-op tracer when no SDK is registered, so startSpan/end calls are
 * no-ops (production builds skip the lazy SDK chunk unless
 * `VITE_OTEL_ENABLED='true'`). The module's Map / Set bookkeeping
 * (mountId → entry / finalized-id eviction) still runs unconditionally —
 * O(1) per cold-mount cycle, microseconds, on a path that fires once per
 * mount (not per keystroke). No `__ok_perf` / Histogram references —
 * bundle-check guards pass.
 *
 * The cold-mount root span uses a lazy-creation pattern: whichever child
 * emits first creates the root with its own startTime. Subsequent children
 * attach as descendants. The first call to `finalizeColdMountSpan(mountId)`
 * ends the root; subsequent calls are no-ops. Late children (e.g., mount
 * resolve arriving after sync has already finalized) attach to a
 * just-ended span — OTel permits this and Tempo renders the trace tree
 * by trace_id + parent_span_id without requiring strict end-time
 * ordering.
 */
import type { Attributes, Span } from '@opentelemetry/api';
import { context, trace } from '@opentelemetry/api';

const TRACER_NAME = 'open-knowledge-app';

interface ColdMountEntry {
  span: Span;
  startTimeMs: number;
}

const coldMountByMountId = new Map<string, ColdMountEntry>();
/**
 * Mount-ids whose cold-mount root span has already been finalized. Used so
 * a late child (e.g. mount-promise resolving after sync-promise has already
 * finalized) does NOT lazy-create a fresh root with the late timestamp —
 * Tempo would render the two roots as separate traces for the same cycle,
 * polluting the sweep's correlation join. Bounded by a per-instance
 * eviction cap so a long-running process can't grow this set unboundedly.
 */
const finalizedMountIds = new Set<string>();
const FINALIZED_SET_CAP = 1024;
/**
 * Same FIFO-eviction cap protects `coldMountByMountId`: if a sibling emit
 * (provider-pool.open) lazy-creates a root but a subsequent throw skips
 * the matching `finalizeColdMountSpan` call (narrow window between
 * `emitColdMountChild` and the return on the error path), the Map entry
 * leaks the Span reference. Capping at the same bound as `finalizedMountIds`
 * keeps the asymmetry from accumulating in a long-running tab. Force-end
 * + delete the oldest entry on overflow so its Span gets exported.
 */
const COLD_MOUNT_MAP_CAP = 1024;

function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Lazy-create the cold-mount root span for `mountId`. Idempotent on the
 * same mountId — first caller creates, subsequent calls return the
 * existing entry. The `startTimeMs` parameter is only honored on the
 * first call (when the cold-mount window begins).
 *
 * Returns `null` when the mountId has already been finalized — callers
 * must handle the no-root case (typically by emitting a parent-less span).
 */
export function ensureColdMountSpan(
  mountId: string,
  attributes: Attributes,
  startTimeMs: number,
): ColdMountEntry | null {
  if (finalizedMountIds.has(mountId)) return null;
  const existing = coldMountByMountId.get(mountId);
  if (existing) return existing;
  // Force-evict the oldest open entry when the Map is at cap. Closes the
  // leaked Span (so the SDK exports it) and removes its registry slot —
  // protects against a narrow-window leak where a provider-pool throw
  // between emit and finalize would otherwise strand the entry forever.
  // Symmetric with finalizeColdMountSpan: delete first, then end inside a
  // try/catch so an OTel SDK throw doesn't escape this call site or
  // strand the Map entry. ensureColdMountSpan is exported; defensive
  // ordering protects future callers without their own outer wrap.
  if (coldMountByMountId.size >= COLD_MOUNT_MAP_CAP) {
    const oldestKey = coldMountByMountId.keys().next().value;
    if (oldestKey !== undefined) {
      const oldestEntry = coldMountByMountId.get(oldestKey);
      coldMountByMountId.delete(oldestKey);
      try {
        oldestEntry?.span.end();
      } catch (err) {
        console.warn(
          '[otel-spans] eviction span.end failed:',
          err instanceof Error ? err : String(err),
        );
      }
    }
  }
  const span = getTracer().startSpan('ok.cold-mount', {
    attributes: { 'mount.id': mountId, ...attributes },
    startTime: startTimeMs,
  });
  const entry = { span, startTimeMs };
  coldMountByMountId.set(mountId, entry);
  return entry;
}

/**
 * Emit a child span under the cold-mount root for `mountId`. Lazily
 * creates the root if absent (the first child's `startTimeMs` becomes
 * the cold-mount start). If the root has already been finalized, emits
 * a parent-less span instead — still queryable by mountId attribute so
 * the sweep's Tempo join sees the timing.
 */
export function emitColdMountChild(
  mountId: string,
  name: string,
  attributes: Attributes,
  startTimeMs: number,
  endTimeMs?: number,
): void {
  // Wrap in try/catch so a misbehaving OTel SDK fault (BatchSpanProcessor
  // flush-while-shutdown race, misconfigured tracer-provider) cannot
  // propagate out of the call site. Callers on the frontend resolve
  // promises BEFORE this helper runs, but the throw would still escape
  // synchronous EventEmitter listeners and surface as an unhandled error
  // in the WebSocket message-receive path. Mirrors the server-side
  // sync-handshake-span-extension fault-isolation wrap.
  try {
    // Propagate the child's attributes to the lazy-created root so the
    // first child's context (e.g. `doc.name`) becomes the root's context
    // too. Without this, the root carries only `mount.id` and Tempo's
    // search UI shows a bare root with no doc identifier. Idempotent on
    // an existing root (only the first call seeds the attributes).
    const root = ensureColdMountSpan(mountId, attributes, startTimeMs);
    const parentCtx = root ? trace.setSpan(context.active(), root.span) : context.active();
    const span = getTracer().startSpan(
      name,
      { attributes: { 'mount.id': mountId, ...attributes }, startTime: startTimeMs },
      parentCtx,
    );
    span.end(endTimeMs ?? Date.now());
  } catch (err) {
    // Pass the Error instance through so Node and Chromium render the full
    // stack — coercing to `.message` discards the only information that
    // localizes a rare SDK regression to a specific call frame.
    console.warn(
      '[otel-spans] emitColdMountChild failed:',
      err instanceof Error ? err : String(err),
    );
  }
}

/**
 * Finalize the cold-mount root for `mountId`. First call ends the span
 * and records the finalization; subsequent calls are no-ops. Safe to
 * call from BOTH sync-promise and mount-promise resolve sites — either
 * one finalizes, the other becomes a no-op. Production callers should
 * call this from both sites because either may complete last.
 */
export function finalizeColdMountSpan(mountId: string, endTimeMs?: number): void {
  // Same fault-isolation wrap as emitColdMountChild — an OTel SDK throw
  // from `span.end()` must not escape this call site.
  try {
    const entry = coldMountByMountId.get(mountId);
    if (entry) {
      // Delete BEFORE end so a throw from `span.end()` doesn't strand
      // the Map entry. The try/catch around this block still swallows
      // the throw, but with delete-first the Map is consistent on
      // either outcome (clean end OR thrown end).
      coldMountByMountId.delete(mountId);
      entry.span.end(endTimeMs ?? Date.now());
    }
    // Mark finalized even when no entry existed — a finalize call from a
    // surface where pool/mount/sync never created a root still suppresses
    // late lazy-creation by some other surface for the same mountId.
    // Guard eviction-and-add on absence: per-cycle double-finalize (sync-
    // promise + mount-promise both call this) reaches here twice for the
    // same mountId. Without the guard, the second call evicts the oldest
    // entry before `.add()` no-ops on the already-present mountId — net
    // effect is one wrongly-evicted neighbor per cycle past the cap.
    if (!finalizedMountIds.has(mountId)) {
      if (finalizedMountIds.size >= FINALIZED_SET_CAP) {
        // Evict the oldest entry to keep the set bounded. Iteration order
        // is insertion order so the first iterator value is the oldest.
        const oldest = finalizedMountIds.values().next().value;
        if (oldest !== undefined) finalizedMountIds.delete(oldest);
      }
      finalizedMountIds.add(mountId);
    }
  } catch (err) {
    console.warn(
      '[otel-spans] finalizeColdMountSpan failed:',
      err instanceof Error ? err : String(err),
    );
  }
}

/**
 * Test-only: clear all registered cold-mount spans and finalize records.
 * Drops any in-flight spans cleanly so tests start from a clean slate.
 */
export function __resetColdMountSpans(): void {
  for (const entry of coldMountByMountId.values()) {
    entry.span.end();
  }
  coldMountByMountId.clear();
  finalizedMountIds.clear();
}

/** Test-only: report how many cold-mount entries are currently registered. */
export function __coldMountSpanCount(): number {
  return coldMountByMountId.size;
}
