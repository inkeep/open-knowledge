import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  __resetServerWorkloadTelemetryForTests,
  installServerWorkloadGauges,
  registerBridgeDirtyProbe,
  registerLoadedDocsProvider,
  registerPersistenceQueueDepthProvider,
} from './server-workload-telemetry.ts';

const DOCS_METRIC = 'ok.server.docs.loaded';
const QUEUE_METRIC = 'ok.persistence.queue.depth';
const BACKLOG_METRIC = 'ok.bridge.drain_backlog';

describe('server workload telemetry — no-op meter (OTel disabled)', () => {
  test('install and register/unregister are safe with the default no-op meter', () => {
    metrics.disable();
    __resetServerWorkloadTelemetryForTests();
    expect(() => {
      installServerWorkloadGauges();
      installServerWorkloadGauges();
      const un1 = registerLoadedDocsProvider(() => 3);
      const un2 = registerPersistenceQueueDepthProvider(() => ({
        branchDeferred: 0,
        quiescenceDeferred: 0,
      }));
      const un3 = registerBridgeDirtyProbe(() => false);
      un1();
      un2();
      un3();
    }).not.toThrow();
    __resetServerWorkloadTelemetryForTests();
  });
});

describe('server workload telemetry — registered meter', () => {
  let exporter: InMemoryMetricExporter;
  let reader: PeriodicExportingMetricReader;
  let provider: MeterProvider;

  beforeAll(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
  });

  beforeEach(() => {
    __resetServerWorkloadTelemetryForTests();
    installServerWorkloadGauges();
  });

  afterAll(async () => {
    await provider.shutdown();
    metrics.disable();
    __resetServerWorkloadTelemetryForTests();
  });

  async function collect(
    metricName: string,
  ): Promise<Array<{ value: number; attributes: Record<string, unknown> }>> {
    exporter.reset();
    await reader.forceFlush();
    const out: Array<{ value: number; attributes: Record<string, unknown> }> = [];
    for (const rm of exporter.getMetrics()) {
      for (const sm of rm.scopeMetrics) {
        for (const metric of sm.metrics) {
          if (metric.descriptor.name !== metricName) continue;
          for (const dp of metric.dataPoints as Array<DataPoint<number>>) {
            out.push({ value: dp.value, attributes: dp.attributes });
          }
        }
      }
    }
    return out;
  }

  test('ok.server.docs.loaded sums registered providers and drops unregistered ones', async () => {
    const un1 = registerLoadedDocsProvider(() => 4);
    const un2 = registerLoadedDocsProvider(() => 2);
    let points = await collect(DOCS_METRIC);
    expect(points).toHaveLength(1);
    expect(points[0].value).toBe(6);

    un2();
    points = await collect(DOCS_METRIC);
    expect(points[0].value).toBe(4);
    un1();
    points = await collect(DOCS_METRIC);
    expect(points[0].value).toBe(0);
  });

  test('ok.persistence.queue.depth reports both bounded queue labels', async () => {
    registerPersistenceQueueDepthProvider(() => ({ branchDeferred: 3, quiescenceDeferred: 1 }));
    const points = await collect(QUEUE_METRIC);
    const byQueue = new Map(points.map((p) => [p.attributes.queue, p.value]));
    expect([...byQueue.keys()].sort()).toEqual(['branch_deferred', 'quiescence_deferred']);
    expect(byQueue.get('branch_deferred')).toBe(3);
    expect(byQueue.get('quiescence_deferred')).toBe(1);
  });

  test('ok.bridge.drain_backlog counts only probes reporting dirty', async () => {
    let dirtyA = false;
    registerBridgeDirtyProbe(() => dirtyA);
    registerBridgeDirtyProbe(() => true);
    let points = await collect(BACKLOG_METRIC);
    expect(points[0].value).toBe(1);

    dirtyA = true;
    points = await collect(BACKLOG_METRIC);
    expect(points[0].value).toBe(2);
  });

  test('a throwing provider is skipped without poisoning the remaining sum', async () => {
    registerLoadedDocsProvider(() => {
      throw new Error('torn down');
    });
    registerLoadedDocsProvider(() => 5);
    const points = await collect(DOCS_METRIC);
    expect(points[0].value).toBe(5);
  });
});
