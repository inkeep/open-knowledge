import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  __resetServerWorkloadTelemetryForTests,
  installServerWorkloadGauges,
  registerAgentSessionCountsProvider,
  registerBridgeDirtyProbe,
  registerConnectionCountsProvider,
  registerLoadedDocsProvider,
  registerPersistenceQueueDepthProvider,
} from './server-workload-telemetry.ts';

const DOCS_METRIC = 'ok.server.docs.loaded';
const QUEUE_METRIC = 'ok.persistence.queue.depth';
const BACKLOG_METRIC = 'ok.bridge.drain_backlog';
const CONNECTIONS_METRIC = 'ok.ws.connections.active';
const SESSIONS_ACTIVE_METRIC = 'ok.sessions.active';
const SESSIONS_LIMIT_METRIC = 'ok.sessions.limit';

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
      const un4 = registerConnectionCountsProvider(() => ({ websocket: 1, direct: 2 }));
      const un5 = registerAgentSessionCountsProvider(() => ({ active: 0, limit: 256 }));
      un1();
      un2();
      un3();
      un4();
      un5();
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

  test('ok.ws.connections.active reports both bounded kind labels and drops unregistered providers', async () => {
    const un = registerConnectionCountsProvider(() => ({ websocket: 3, direct: 5 }));
    registerConnectionCountsProvider(() => ({ websocket: 1, direct: 0 }));
    let points = await collect(CONNECTIONS_METRIC);
    let byKind = new Map(points.map((p) => [p.attributes.kind, p.value]));
    expect([...byKind.keys()].sort()).toEqual(['direct', 'websocket']);
    expect(byKind.get('websocket')).toBe(4);
    expect(byKind.get('direct')).toBe(5);

    un();
    points = await collect(CONNECTIONS_METRIC);
    byKind = new Map(points.map((p) => [p.attributes.kind, p.value]));
    expect(byKind.get('websocket')).toBe(1);
    expect(byKind.get('direct')).toBe(0);
  });

  test('ok.sessions.active and ok.sessions.limit track occupancy against the cap', async () => {
    let active = 2;
    registerAgentSessionCountsProvider(() => ({ active, limit: 256 }));
    let activePoints = await collect(SESSIONS_ACTIVE_METRIC);
    let limitPoints = await collect(SESSIONS_LIMIT_METRIC);
    expect(activePoints[0].value).toBe(2);
    expect(limitPoints[0].value).toBe(256);

    // A cap stall surfaces as active pinned at limit.
    active = 256;
    activePoints = await collect(SESSIONS_ACTIVE_METRIC);
    limitPoints = await collect(SESSIONS_LIMIT_METRIC);
    expect(activePoints[0].value).toBe(256);
    expect(activePoints[0].value).toBe(limitPoints[0].value);
  });

  test('a throwing session provider is skipped for both session gauges', async () => {
    registerAgentSessionCountsProvider(() => {
      throw new Error('torn down');
    });
    registerAgentSessionCountsProvider(() => ({ active: 7, limit: 256 }));
    const activePoints = await collect(SESSIONS_ACTIVE_METRIC);
    const limitPoints = await collect(SESSIONS_LIMIT_METRIC);
    expect(activePoints[0].value).toBe(7);
    expect(limitPoints[0].value).toBe(256);
  });
});
