/**
 * Server process memory exposed as a bounded OpenTelemetry observable gauge.
 *
 * Server-side memory growth (e.g. a large `?showAll=true` walk) is invisible
 * from the renderer. This gauge samples `process.memoryUsage()` — via the
 * shared `captureServerMemorySnapshot()` helper — at each metric-export
 * interval. Cardinality is fixed at three series through the `section` enum.
 *
 * Zero overhead when OTel is disabled: `getMeter()` returns the API no-op
 * meter, whose observable gauge never invokes the callback.
 */
import type { ObservableGauge, ObservableResult } from '@opentelemetry/api';
import { captureServerMemorySnapshot } from './perf-measurement.ts';
import { getMeter, onTelemetryShutdown } from './telemetry.ts';

let cachedGauge: ObservableGauge | null = null;

// Drop the cached gauge whenever telemetry shuts down. The gauge is bound to
// the meter provider torn down by shutdownTelemetry; keeping the cache would
// make the next installServerMemoryGauge() a no-op (idempotency guard below) so
// the callback would never rebind to the freshly-initialized meter. Registered
// once at import — onTelemetryShutdown dedups, and a reset hook is cheaper than
// the alternative (telemetry.ts importing this module → circular).
onTelemetryShutdown(() => {
  cachedGauge = null;
});

/**
 * Register the gauge against the currently-registered global meter. Idempotent
 * — a second call is a no-op so a double boot can't double-register the
 * callback. Call once after telemetry is initialized.
 */
export function installServerMemoryGauge(): void {
  if (cachedGauge) return;
  const gauge = getMeter().createObservableGauge('ok.server.memory.usage_megabytes', {
    description:
      'Server process memory by section. Bounded labels: section ∈ {heap_used, heap_total, rss}.',
    unit: 'MB',
  });
  gauge.addCallback((result: ObservableResult) => {
    const { snapshot } = captureServerMemorySnapshot();
    result.observe(snapshot.heapUsedMb, { section: 'heap_used' });
    result.observe(snapshot.heapTotalMb, { section: 'heap_total' });
    result.observe(snapshot.rssMb, { section: 'rss' });
  });
  cachedGauge = gauge;
}

/** Drop the cached gauge so a test can rebind against a fresh meter. Test-only. */
export function __resetServerMemoryGaugeForTests(): void {
  cachedGauge = null;
}
