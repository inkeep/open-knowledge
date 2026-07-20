import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  __resetServerRuntimeTelemetryForTests,
  installServerMemoryGauge,
  installServerRuntimeGauges,
} from './server-memory-telemetry.ts';

const METRIC = 'ok.server.memory.usage_megabytes';
const EVENT_LOOP_METRIC = 'ok.server.event_loop.delay_ms';
const CPU_METRIC = 'ok.server.cpu.utilization';

describe('installServerMemoryGauge — no-op meter (OTel disabled)', () => {
  test('does not throw and is idempotent with the default no-op meter', () => {
    metrics.disable();
    __resetServerRuntimeTelemetryForTests();
    expect(() => {
      installServerMemoryGauge();
      installServerMemoryGauge();
      installServerRuntimeGauges();
      installServerRuntimeGauges();
    }).not.toThrow();
    __resetServerRuntimeTelemetryForTests();
  });
});

describe('installServerMemoryGauge — registered meter', () => {
  let exporter: InMemoryMetricExporter;
  let reader: PeriodicExportingMetricReader;
  let provider: MeterProvider;

  beforeAll(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    __resetServerRuntimeTelemetryForTests();
  });

  afterAll(async () => {
    await provider.shutdown();
    metrics.disable();
    __resetServerRuntimeTelemetryForTests();
  });

  async function collectPoints(
    metricName: string,
    label: string,
  ): Promise<Array<{ value: number; label: unknown }>> {
    exporter.reset();
    await reader.forceFlush();
    const out: Array<{ value: number; label: unknown }> = [];
    for (const rm of exporter.getMetrics()) {
      for (const sm of rm.scopeMetrics) {
        for (const metric of sm.metrics) {
          if (metric.descriptor.name !== metricName) continue;
          for (const dp of metric.dataPoints as Array<DataPoint<number>>) {
            out.push({ value: dp.value, label: dp.attributes[label] });
          }
        }
      }
    }
    return out;
  }

  test('records exactly the five bounded sections', async () => {
    installServerMemoryGauge();
    const points = await collectPoints(METRIC, 'section');
    expect(points.map((p) => p.label).sort()).toEqual([
      'array_buffers',
      'external',
      'heap_total',
      'heap_used',
      'rss',
    ]);
    for (const p of points) {
      expect(p.value).toBeGreaterThanOrEqual(0);
    }
    // The heap sections are always non-zero in a live process; external and
    // array_buffers can legitimately be near-zero, hence the >= 0 floor above.
    const heapUsed = points.find((p) => p.label === 'heap_used');
    expect(heapUsed?.value).toBeGreaterThan(0);
  });

  test('is idempotent — a second install does not duplicate the series', async () => {
    installServerMemoryGauge();
    const points = await collectPoints(METRIC, 'section');
    expect(points).toHaveLength(5);
  });

  test('event-loop gauge arms on first export and reports p50/p99 on the next', async () => {
    installServerRuntimeGauges();
    // First collection only enables the lazily-started histogram — the
    // export window has no data yet, so no points are observed.
    const first = await collectPoints(EVENT_LOOP_METRIC, 'stat');
    expect(first).toHaveLength(0);
    // Poll instead of sleeping a fixed interval: a heavily-loaded CI runner may
    // not iterate the event loop enough within a fixed wall-clock window. Each
    // forceFlush past the arming one observes p50/p99, so this converges to two
    // points as soon as the loop ticks the histogram once.
    let second: Awaited<ReturnType<typeof collectPoints>> = [];
    const deadline = Date.now() + 2000;
    while (second.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      second = await collectPoints(EVENT_LOOP_METRIC, 'stat');
    }
    expect(second.map((p) => p.label).sort()).toEqual(['p50', 'p99']);
    for (const p of second) {
      expect(p.value).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(p.value)).toBe(true);
    }
  });

  test('cpu gauge records the baseline on first export and utilization on the next', async () => {
    installServerRuntimeGauges();
    // Two callbacks are required: the first records the baseline sample and
    // observes nothing; the second computes the delta and reports both modes.
    // Collect twice explicitly so the test does not depend on a prior test
    // having already driven the first callback via shared module-level state.
    await collectPoints(CPU_METRIC, 'mode');
    const second = await collectPoints(CPU_METRIC, 'mode');
    expect(second.map((p) => p.label).sort()).toEqual(['system', 'user']);
    for (const p of second) {
      expect(p.value).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(p.value)).toBe(true);
    }
  });
});
