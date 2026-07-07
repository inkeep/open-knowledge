/**
 * Tests for frontmatter telemetry helpers.
 *
 * Verifies:
 *   - `recordFrontmatterEditSurface` increments the bounded-label counter
 *
 * Uses the InMemoryMetricExporter / InMemorySpanExporter test pattern from
 * `telemetry.test.ts` — registers a test provider, resets the lazy-init
 * caches so the helpers rebind, runs the operation, asserts the recorded
 * data.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { metrics, trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  __resetFrontmatterTelemetryForTests,
  recordFrontmatterEditSurface,
} from './frontmatter-telemetry.ts';

interface TelemetryHarness {
  metricExporter: InMemoryMetricExporter;
  meterProvider: MeterProvider;
  spanExporter: InMemorySpanExporter;
  tracerProvider: BasicTracerProvider;
  flush: () => Promise<void>;
  cleanup: () => Promise<void>;
}

function setupTelemetryHarness(): TelemetryHarness {
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  // Long export interval — we drive flush manually via forceFlush().
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);

  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  // Force the lazy-init helpers to rebind against the new global meter.
  __resetFrontmatterTelemetryForTests();

  return {
    metricExporter,
    meterProvider,
    spanExporter,
    tracerProvider,
    async flush() {
      await metricReader.forceFlush();
    },
    async cleanup() {
      await meterProvider.shutdown();
      await tracerProvider.shutdown();
      metrics.disable();
      trace.disable();
      __resetFrontmatterTelemetryForTests();
    },
  };
}

interface CounterPoint {
  attributes: Record<string, unknown>;
  value: number;
}

function readCounterPoints(harness: TelemetryHarness, name: string): CounterPoint[] {
  const out: CounterPoint[] = [];
  for (const rm of harness.metricExporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        if (metric.descriptor.name !== name) continue;
        for (const dp of metric.dataPoints) {
          out.push({ attributes: dp.attributes, value: dp.value as number });
        }
      }
    }
  }
  return out;
}

describe('frontmatter-telemetry', () => {
  let harness: TelemetryHarness;

  beforeEach(() => {
    harness = setupTelemetryHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test('recordFrontmatterEditSurface increments counter with bounded source label', async () => {
    recordFrontmatterEditSurface('mcp-write');
    recordFrontmatterEditSurface('mcp-write');
    recordFrontmatterEditSurface('file-watcher');
    recordFrontmatterEditSurface('source-mode');

    await harness.flush();

    const points = readCounterPoints(harness, 'ok.frontmatter.edit_surface_total');
    const bySource = new Map<string, number>();
    for (const p of points) {
      const source = String(p.attributes.source);
      bySource.set(source, (bySource.get(source) ?? 0) + p.value);
    }
    expect(bySource.get('mcp-write')).toBe(2);
    expect(bySource.get('file-watcher')).toBe(1);
    expect(bySource.get('source-mode')).toBe(1);
    // Verify cardinality is bounded — only the `source` label, no others
    for (const p of points) {
      expect(Object.keys(p.attributes).sort()).toEqual(['source']);
    }
  });
});
