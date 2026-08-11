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
import { getMeter, withSpan, withSpanSync } from './telemetry.ts';

/** Bounded label set — extend only for a NEW derived index, never per-doc. */
export type IndexName = 'backlink' | 'tag' | 'local-target';

/** `full` = whole-corpus re-parse; `reconcile` = mtime-gated incremental pass. */
export type IndexRebuildMode = 'full' | 'reconcile';

/** Incremental mutation class. Bounded: never derive this value from a path or event name. */
export type IndexUpdateMode = 'source' | 'document-target' | 'file-target';

/** Bounded publication path for generation-lag observations. */
export type IndexPublicationMode = 'signal' | 'baseline';

let _rebuildCounter: Counter | null = null;
function rebuildCounter(): Counter {
  _rebuildCounter ||= getMeter().createCounter('ok.index.rebuild_total', {
    description:
      'Count of derived-index rebuild passes. Bounded labels: index.name ∈ {backlink, tag, local-target}, index.mode ∈ {full, reconcile}.',
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

let _updateCounter: Counter | null = null;
function updateCounter(): Counter {
  _updateCounter ||= getMeter().createCounter('ok.index.update_total', {
    description:
      'Count of incremental derived-index updates. Bounded labels: index.name and index.mode.',
  });
  return _updateCounter;
}

let _updateDurationHist: Histogram | null = null;
function updateDurationHist(): Histogram {
  _updateDurationHist ||= getMeter().createHistogram('ok.index.update_duration_ms', {
    description: 'Duration of incremental derived-index updates in milliseconds.',
    unit: 'ms',
  });
  return _updateDurationHist;
}

let _occurrenceCountHist: Histogram | null = null;
function occurrenceCountHist(): Histogram {
  _occurrenceCountHist ||= getMeter().createHistogram('ok.index.occurrence_count', {
    description: 'Local-target occurrences processed by an index operation.',
    unit: '{occurrence}',
  });
  return _occurrenceCountHist;
}

let _affectedSourceCountHist: Histogram | null = null;
function affectedSourceCountHist(): Histogram {
  _affectedSourceCountHist ||= getMeter().createHistogram('ok.index.affected_source_count', {
    description: 'Source documents whose assessment changed during an index operation.',
    unit: '{source}',
  });
  return _affectedSourceCountHist;
}

let _generationLagHist: Histogram | null = null;
function generationLagHist(): Histogram {
  _generationLagHist ||= getMeter().createHistogram('ok.index.generation_lag', {
    description: 'Index generations accumulated between consumer publications.',
    unit: '{generation}',
  });
  return _generationLagHist;
}

function recordBoundedMeasurements(attrs: Attributes, labels: Attributes): void {
  const occurrences = attrs['index.occurrences'];
  if (typeof occurrences === 'number') occurrenceCountHist().record(occurrences, labels);
  const affectedSources = attrs['index.affected_sources'];
  if (typeof affectedSources === 'number') {
    affectedSourceCountHist().record(affectedSources, labels);
  }
}

/** Record real publication lag, never a per-operation placeholder. */
export function recordIndexGenerationLag(
  name: IndexName,
  publication: IndexPublicationMode,
  lag: number,
): void {
  generationLagHist().record(lag, { 'index.name': name, 'index.publication': publication });
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
        if (resultAttrs) {
          const attrs = resultAttrs(result);
          span.setAttributes(attrs);
          recordBoundedMeasurements(attrs, { 'index.name': name, 'index.mode': mode });
        }
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
 * Instrument one synchronous incremental update. Result attributes are numeric,
 * bounded measurements only; callers must never attach paths, hrefs, or content.
 */
export function instrumentIndexUpdate<T>(
  name: IndexName,
  mode: IndexUpdateMode,
  fn: () => T,
  resultAttrs: (result: T) => Attributes,
): T {
  const labels = { 'index.name': name, 'index.mode': mode };
  return withSpanSync('ok.index.update', { attributes: labels }, (span) => {
    const start = performance.now();
    try {
      const result = fn();
      const attrs = resultAttrs(result);
      span.setAttributes(attrs);
      recordBoundedMeasurements(attrs, labels);
      return result;
    } finally {
      updateCounter().add(1, labels);
      updateDurationHist().record(performance.now() - start, labels);
    }
  });
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
  _updateCounter = null;
  _updateDurationHist = null;
  _occurrenceCountHist = null;
  _affectedSourceCountHist = null;
  _generationLagHist = null;
}
