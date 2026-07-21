/**
 * Telemetry primitives for derived-index rebuilds (backlink + tag).
 *
 * Lazy-init meter so registration runs against a real provider post-
 * `initTelemetry` (not the pre-init no-op). Same pattern as
 * `frontmatter-telemetry.ts`. One span name + one metric family with a
 * bounded `index.name` / `index.mode` label pair keeps Tempo/Prometheus
 * cardinality flat regardless of corpus size — NEVER add per-doc labels.
 */
import type { Attributes, Counter, Histogram } from '@opentelemetry/api';
import { getMeter, withSpan } from './telemetry.ts';

/** Bounded label set — extend only for a NEW derived index, never per-doc. */
export type IndexName = 'backlink' | 'tag';

/** `full` = whole-corpus re-parse; `reconcile` = mtime-gated incremental pass. */
export type IndexRebuildMode = 'full' | 'reconcile';

let _rebuildCounter: Counter | null = null;
function rebuildCounter(): Counter {
  _rebuildCounter ||= getMeter().createCounter('ok.index.rebuild_total', {
    description:
      'Count of derived-index rebuild passes. Bounded labels: index.name ∈ {backlink, tag}, index.mode ∈ {full, reconcile}.',
  });
  return _rebuildCounter;
}

let _rebuildDurationHist: Histogram | null = null;
function rebuildDurationHist(): Histogram {
  _rebuildDurationHist ||= getMeter().createHistogram('ok.index.rebuild_duration_ms', {
    description:
      'Duration of derived-index rebuild passes in milliseconds. Same bounded label pair as ok.index.rebuild_total.',
    unit: 'ms',
  });
  return _rebuildDurationHist;
}

/**
 * Run a rebuild/reconcile pass inside an `ok.index.rebuild` span and record
 * the counter + duration histogram. The duration lands even when `fn` throws
 * (the span records the exception via `withSpan`). `resultAttrs` maps the
 * result onto extra span attributes — bounded numbers only (counts, not
 * doc names).
 *
 * Zero overhead when OTel is disabled: the no-op tracer/meter make the span
 * and instruments free beyond a function-call indirection.
 */
export async function instrumentIndexRebuild<T>(
  name: IndexName,
  mode: IndexRebuildMode,
  fn: () => Promise<T>,
  resultAttrs?: (result: T) => Attributes,
): Promise<T> {
  return withSpan(
    'ok.index.rebuild',
    { attributes: { 'index.name': name, 'index.mode': mode } },
    async (span) => {
      const start = performance.now();
      try {
        const result = await fn();
        if (resultAttrs) span.setAttributes(resultAttrs(result));
        return result;
      } finally {
        const attrs = { 'index.name': name, 'index.mode': mode };
        rebuildCounter().add(1, attrs);
        rebuildDurationHist().record(performance.now() - start, attrs);
      }
    },
  );
}

/**
 * Drop the cached lazy-init instruments so the next call rebinds against the
 * currently-registered global MeterProvider. Test-only — production code
 * never needs this because the global provider is set once via
 * `initTelemetry()`.
 */
export function __resetIndexTelemetryForTests(): void {
  _rebuildCounter = null;
  _rebuildDurationHist = null;
}
