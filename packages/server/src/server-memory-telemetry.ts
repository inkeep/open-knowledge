/**
 * Server process runtime health exposed as bounded OpenTelemetry observable
 * gauges: memory by section, event-loop delay percentiles, and CPU
 * utilization.
 *
 * Server-side memory growth (e.g. a large `?showAll=true` walk) is invisible
 * from the renderer. The memory gauge samples `process.memoryUsage()` — via
 * the shared `captureServerMemorySnapshot()` helper — at each metric-export
 * interval. Cardinality is fixed through the `section` enum.
 *
 * Zero overhead when OTel is disabled: `getMeter()` returns the API no-op
 * meter, whose observable gauge never invokes the callback. The event-loop
 * delay histogram is likewise only enabled from inside the gauge callback,
 * so its constant sampling cost is paid only when a real meter is live.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { ObservableGauge, ObservableResult } from '@opentelemetry/api';
import { captureServerMemorySnapshot } from './perf-measurement.ts';
import { getMeter, onTelemetryShutdown } from './telemetry.ts';

let cachedGauge: ObservableGauge | null = null;
let cachedEventLoopGauge: ObservableGauge | null = null;
let cachedCpuGauge: ObservableGauge | null = null;

const NANOS_PER_MS = 1e6;

/**
 * Lazily-enabled event-loop delay histogram. `monitorEventLoopDelay` costs a
 * periodic timer while enabled, so it is only started from inside the gauge
 * callback — which the no-op meter never invokes — preserving the
 * zero-overhead-when-disabled contract. Reset after each observation so each
 * export interval reports its own window rather than a since-boot aggregate.
 */
let eventLoopHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;

/** Previous CPU/wall sample for utilization deltas. Null until first callback. */
let lastCpuSample: { cpu: NodeJS.CpuUsage; hrtimeNs: bigint } | null = null;

// Drop the cached gauges whenever telemetry shuts down. The gauges are bound
// to the meter provider torn down by shutdownTelemetry; keeping the cache
// would make the next install call a no-op (idempotency guards below) so the
// callbacks would never rebind to the freshly-initialized meter. Registered
// once at import — onTelemetryShutdown dedups, and a reset hook is cheaper
// than the alternative (telemetry.ts importing this module → circular).
onTelemetryShutdown(() => {
  cachedGauge = null;
  cachedEventLoopGauge = null;
  cachedCpuGauge = null;
  eventLoopHistogram?.disable();
  eventLoopHistogram = null;
  lastCpuSample = null;
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
      'Server process memory by section. Bounded labels: section ∈ {heap_used, heap_total, rss, external, array_buffers}.',
    unit: 'MB',
  });
  gauge.addCallback((result: ObservableResult) => {
    const { snapshot } = captureServerMemorySnapshot();
    result.observe(snapshot.heapUsedMb, { section: 'heap_used' });
    result.observe(snapshot.heapTotalMb, { section: 'heap_total' });
    result.observe(snapshot.rssMb, { section: 'rss' });
    result.observe(snapshot.externalMb, { section: 'external' });
    result.observe(snapshot.arrayBuffersMb, { section: 'array_buffers' });
  });
  cachedGauge = gauge;
}

/**
 * Register the event-loop delay and CPU utilization gauges. Idempotent per
 * instrument, same lifecycle contract as {@link installServerMemoryGauge}.
 *
 * Event-loop delay reports p50/p99 in milliseconds over the window since the
 * previous export (the histogram resets after each read); the first callback
 * only enables the histogram, so the first export interval observes nothing.
 * CPU utilization reports user/system CPU time as a fraction of wall time
 * since the previous callback (may exceed 1 on multi-core parallelism); the
 * first callback only records the baseline sample.
 */
export function installServerRuntimeGauges(): void {
  if (!cachedEventLoopGauge) {
    const gauge = getMeter().createObservableGauge('ok.server.event_loop.delay_ms', {
      description:
        'Event-loop delay percentiles over the last export window. Bounded labels: stat ∈ {p50, p99}.',
      unit: 'ms',
    });
    gauge.addCallback((result: ObservableResult) => {
      if (!eventLoopHistogram) {
        eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
        eventLoopHistogram.enable();
        return;
      }
      result.observe(eventLoopHistogram.percentile(50) / NANOS_PER_MS, { stat: 'p50' });
      result.observe(eventLoopHistogram.percentile(99) / NANOS_PER_MS, { stat: 'p99' });
      eventLoopHistogram.reset();
    });
    cachedEventLoopGauge = gauge;
  }

  if (!cachedCpuGauge) {
    const gauge = getMeter().createObservableGauge('ok.server.cpu.utilization', {
      description:
        'Process CPU time as a fraction of wall time since the previous export. Bounded labels: mode ∈ {user, system}.',
      unit: '1',
    });
    gauge.addCallback((result: ObservableResult) => {
      const cpu = process.cpuUsage();
      const hrtimeNs = process.hrtime.bigint();
      const prev = lastCpuSample;
      lastCpuSample = { cpu, hrtimeNs };
      if (!prev) return;
      const wallMicros = Number(hrtimeNs - prev.hrtimeNs) / 1_000;
      if (wallMicros <= 0) return;
      result.observe((cpu.user - prev.cpu.user) / wallMicros, { mode: 'user' });
      result.observe((cpu.system - prev.cpu.system) / wallMicros, { mode: 'system' });
    });
    cachedCpuGauge = gauge;
  }
}

/**
 * Drop every cached runtime instrument (memory, event-loop, CPU) plus the
 * event-loop histogram and CPU baseline so a test can rebind against a fresh
 * meter. Test-only.
 */
export function __resetServerRuntimeTelemetryForTests(): void {
  cachedGauge = null;
  cachedEventLoopGauge = null;
  cachedCpuGauge = null;
  eventLoopHistogram?.disable();
  eventLoopHistogram = null;
  lastCpuSample = null;
}
