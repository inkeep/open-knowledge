/**
 * Write-spine workload exposed as bounded OpenTelemetry observable gauges:
 * loaded Y.Doc count, persistence queue depths, and bridge drain backlog.
 *
 * Pull-based by design: producers (server-factory, persistence, the server
 * observer bridge) register read-only provider closures here at construction
 * and unregister at teardown; the gauge callbacks sample the providers only
 * at metric-export time. That keeps the write spine's hot paths untouched —
 * no counter increments inside observers or store hooks — and keeps the
 * registries safe to populate when OTel is disabled (a Set add/delete; the
 * no-op meter never invokes the callbacks).
 */
import type { ObservableGauge, ObservableResult } from '@opentelemetry/api';
import type { PersistenceQueueDepths } from './persistence.ts';
import { getMeter, onTelemetryShutdown } from './telemetry.ts';

const loadedDocsProviders = new Set<() => number>();
const persistenceQueueProviders = new Set<() => PersistenceQueueDepths>();
const bridgeDirtyProbes = new Set<() => boolean>();

let cachedLoadedDocsGauge: ObservableGauge | null = null;
let cachedQueueDepthGauge: ObservableGauge | null = null;
let cachedDrainBacklogGauge: ObservableGauge | null = null;

// Cached instruments drop on telemetry shutdown so the next install rebinds
// against the fresh meter (same lifecycle contract as the server-memory
// gauge). Provider registries survive — they mirror live server objects
// whose lifecycle is owned by their register/unregister call sites.
onTelemetryShutdown(() => {
  cachedLoadedDocsGauge = null;
  cachedQueueDepthGauge = null;
  cachedDrainBacklogGauge = null;
});

/**
 * Register a provider for the currently-loaded server-side Y.Doc count
 * (typically `() => hocuspocus.documents.size`, which includes synthetic
 * system/config docs). Returns an unregister function; call it at server
 * teardown so the registry doesn't retain the closure.
 */
export function registerLoadedDocsProvider(provider: () => number): () => void {
  loadedDocsProviders.add(provider);
  return () => {
    loadedDocsProviders.delete(provider);
  };
}

/** Register a persistence queue-depth provider. Returns an unregister function. */
export function registerPersistenceQueueDepthProvider(
  provider: () => PersistenceQueueDepths,
): () => void {
  persistenceQueueProviders.add(provider);
  return () => {
    persistenceQueueProviders.delete(provider);
  };
}

/**
 * Register a per-doc probe reporting whether the doc's bridge observers hold
 * an un-settled dirty flag (an `afterAllTransactions` settlement is owed).
 * Returns an unregister function; the observer cleanup path must call it.
 */
export function registerBridgeDirtyProbe(probe: () => boolean): () => void {
  bridgeDirtyProbes.add(probe);
  return () => {
    bridgeDirtyProbes.delete(probe);
  };
}

/**
 * Register the workload gauges against the currently-registered global meter.
 * Idempotent — a second call is a no-op so a double boot can't
 * double-register the callbacks. A throwing provider is skipped rather than
 * propagated: instrumentation must never feed back into the write spine.
 */
export function installServerWorkloadGauges(): void {
  if (cachedLoadedDocsGauge && cachedQueueDepthGauge && cachedDrainBacklogGauge) return;

  if (!cachedLoadedDocsGauge) {
    const gauge = getMeter().createObservableGauge('ok.server.docs.loaded', {
      description:
        'Server-side Y.Docs currently resident in memory (includes synthetic system/config docs).',
      unit: '{documents}',
    });
    gauge.addCallback((result: ObservableResult) => {
      let total = 0;
      for (const provider of loadedDocsProviders) {
        try {
          total += provider();
        } catch {
          // Skip a torn-down provider; the remaining sum stays meaningful.
        }
      }
      result.observe(total);
    });
    cachedLoadedDocsGauge = gauge;
  }

  if (!cachedQueueDepthGauge) {
    const gauge = getMeter().createObservableGauge('ok.persistence.queue.depth', {
      description:
        'Pending persistence stores by queue. Bounded labels: queue ∈ {branch_deferred, quiescence_deferred}.',
      unit: '{documents}',
    });
    gauge.addCallback((result: ObservableResult) => {
      let branchDeferred = 0;
      let quiescenceDeferred = 0;
      for (const provider of persistenceQueueProviders) {
        try {
          const depths = provider();
          branchDeferred += depths.branchDeferred;
          quiescenceDeferred += depths.quiescenceDeferred;
        } catch {
          // Skip a torn-down provider; the remaining sum stays meaningful.
        }
      }
      result.observe(branchDeferred, { queue: 'branch_deferred' });
      result.observe(quiescenceDeferred, { queue: 'quiescence_deferred' });
    });
    cachedQueueDepthGauge = gauge;
  }

  if (!cachedDrainBacklogGauge) {
    const gauge = getMeter().createObservableGauge('ok.bridge.drain_backlog', {
      description:
        'Docs whose bridge observers hold an un-settled dirty flag at sample time (settlement is synchronous per drain, so a sustained non-zero value indicates a stuck drain).',
      unit: '{documents}',
    });
    gauge.addCallback((result: ObservableResult) => {
      let dirty = 0;
      for (const probe of bridgeDirtyProbes) {
        try {
          if (probe()) dirty++;
        } catch {
          // Skip a torn-down probe; the remaining count stays meaningful.
        }
      }
      result.observe(dirty);
    });
    cachedDrainBacklogGauge = gauge;
  }
}

/** Drop cached instruments and clear registries. Test-only. */
export function __resetServerWorkloadTelemetryForTests(): void {
  cachedLoadedDocsGauge = null;
  cachedQueueDepthGauge = null;
  cachedDrainBacklogGauge = null;
  loadedDocsProviders.clear();
  persistenceQueueProviders.clear();
  bridgeDirtyProbes.clear();
}
