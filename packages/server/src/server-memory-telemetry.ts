import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { ObservableGauge, ObservableResult } from '@opentelemetry/api';
import { captureServerMemorySnapshot } from './perf-measurement.ts';
import { getMeter, onTelemetryShutdown } from './telemetry.ts';

let cachedGauge: ObservableGauge | null = null;
let cachedEventLoopGauge: ObservableGauge | null = null;
let cachedCpuGauge: ObservableGauge | null = null;

const NANOS_PER_MS = 1e6;

let eventLoopHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;

let lastCpuSample: { cpu: NodeJS.CpuUsage; hrtimeNs: bigint } | null = null;

onTelemetryShutdown(() => {
  cachedGauge = null;
  cachedEventLoopGauge = null;
  cachedCpuGauge = null;
  eventLoopHistogram?.disable();
  eventLoopHistogram = null;
  lastCpuSample = null;
});

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

export function __resetServerRuntimeTelemetryForTests(): void {
  cachedGauge = null;
  cachedEventLoopGauge = null;
  cachedCpuGauge = null;
  eventLoopHistogram?.disable();
  eventLoopHistogram = null;
  lastCpuSample = null;
}
