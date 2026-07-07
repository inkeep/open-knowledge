/**
 * Telemetry for the shadow-repo maintenance coordinator.
 *
 * Lazy-init meters so registration binds to the real provider post-
 * `initTelemetry`. Cardinality discipline (STOP rule): every attribute is a
 * bounded enum. Loose-object counts are NEVER metric attributes (they would be
 * unbounded) — they ride structured logs in the coordinator. No paths, no
 * content, no free-form strings reach a metric here.
 */
import type { Counter, Histogram } from '@opentelemetry/api';
import { getMeter } from './telemetry.ts';

/** Bounded label: which maintenance leg ran. */
export type MaintenanceOp = 'gc' | 'consolidation' | 'reap';

/** Bounded label: the run's outcome. */
export type MaintenanceOutcome = 'ok' | 'skipped' | 'error';

/** Bounded label: why an auto-consolidation fired (mirrors AutoConsolidationTrigger). */
export type ConsolidationTriggerLabel = 'dead-chain' | 'session-close' | 'boot' | 'ttl';

let _runDuration: Histogram | null = null;
let _gcLatch: Counter | null = null;
let _consolidation: Counter | null = null;

function runDurationHist(): Histogram {
  _runDuration ||= getMeter().createHistogram('ok.shadow.maintenance.run_duration_ms', {
    description:
      'Wall-clock duration of one maintenance op. Bounded labels: op ∈ {gc, consolidation, reap}, outcome ∈ {ok, skipped, error}.',
    unit: 'ms',
  });
  return _runDuration;
}

function gcLatchCounter(): Counter {
  _gcLatch ||= getMeter().createCounter('ok.shadow.maintenance.gc_latch_total', {
    description:
      'Distinct gc.log latch EPISODES (counted on the absent→present transition, not per observation, so one persistent ~1-day latch counts once). A latch means auto-gc is silently disabled until it self-expires; a nonzero rate means a repo is re-degrading invisibly.',
  });
  return _gcLatch;
}

function consolidationCounter(): Counter {
  _consolidation ||= getMeter().createCounter('ok.shadow.maintenance.consolidation_total', {
    description:
      'Auto-consolidation runs that folded ≥1 dead chain. Bounded label: trigger ∈ {dead-chain, session-close, boot, ttl}. Width before/after ride the structured log, not metric labels.',
  });
  return _consolidation;
}

/** Record one maintenance op's wall-clock duration + outcome. */
export function recordMaintenanceRun(
  op: MaintenanceOp,
  outcome: MaintenanceOutcome,
  durationMs: number,
): void {
  runDurationHist().record(Math.max(0, durationMs), { op, outcome });
}

/** Count an observed gc.log latch. */
export function recordGcLatch(): void {
  gcLatchCounter().add(1);
}

/** Count an auto-consolidation that folded ≥1 chain, by trigger. */
export function recordConsolidation(trigger: ConsolidationTriggerLabel): void {
  consolidationCounter().add(1, { trigger });
}

/**
 * Drop cached lazy-init instruments so the next call rebinds against the
 * currently-registered global MeterProvider. Test-only.
 */
export function __resetMaintenanceTelemetryForTesting(): void {
  _runDuration = null;
  _gcLatch = null;
  _consolidation = null;
}
