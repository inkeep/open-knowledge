import { describe, expect, test } from 'bun:test';
import {
  aggregateTrace,
  type CdpTraceEvent,
  capturePerfMetricsWindow,
  computePerfMetricsDelta,
  enablePerformanceMetrics,
  getPerfMetricsSnapshot,
  LONG_TASK_THRESHOLD_MS,
  type MinimalCdpClient,
  TRACE_CATEGORIES,
} from './cdp-tracer';

function mockCdp(snapshots: Array<Record<string, number>>): {
  client: MinimalCdpClient;
  enableCalls: number;
  getMetricsCalls: number;
} {
  let enableCalls = 0;
  let getMetricsCalls = 0;
  const client: MinimalCdpClient = {
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    async send(method: string, _params?: unknown): Promise<any> {
      if (method === 'Performance.enable') {
        enableCalls += 1;
        return {};
      }
      if (method === 'Performance.getMetrics') {
        const snap = snapshots[getMetricsCalls] ?? {};
        getMetricsCalls += 1;
        return {
          metrics: Object.entries(snap).map(([name, value]) => ({ name, value })),
        };
      }
      throw new Error(`unexpected CDP method ${method}`);
    },
  };
  return {
    client,
    get enableCalls() {
      return enableCalls;
    },
    get getMetricsCalls() {
      return getMetricsCalls;
    },
  };
}

function ev(
  name: string,
  cat: string,
  durUs: number,
  extra: Partial<CdpTraceEvent> = {},
): CdpTraceEvent {
  return {
    name,
    cat,
    ts: 0,
    ph: 'X',
    dur: durUs,
    ...extra,
  };
}

describe('aggregateTrace', () => {
  test('empty input → zeroed summary', () => {
    const s = aggregateTrace([]);
    expect(s.eventCount).toBe(0);
    expect(s.longTaskCount).toBe(0);
    expect(s.longestTaskMs).toBe(0);
    expect(s.taskDurationMs).toBe(0);
    expect(s.styleMs).toBe(0);
    expect(s.layoutMs).toBe(0);
    expect(s.scriptMs).toBe(0);
    expect(s.paintEvents).toBe(0);
    expect(s.lastLcpMs).toBeNull();
    expect(s.cumulativeLayoutShift).toBe(0);
  });

  test('RunTask events ≥ 50ms count as long tasks; taskDurationMs sums all', () => {
    const events: CdpTraceEvent[] = [
      ev('RunTask', 'disabled-by-default-devtools.timeline', 30_000),
      ev('RunTask', 'disabled-by-default-devtools.timeline', 60_000),
      ev('RunTask', 'disabled-by-default-devtools.timeline', 150_000),
    ];
    const s = aggregateTrace(events);
    expect(s.longTaskCount).toBe(2);
    expect(s.longestTaskMs).toBe(150);
    expect(s.taskDurationMs).toBe(240);
  });

  test('LONG_TASK_THRESHOLD_MS is the 50ms inclusive boundary', () => {
    const events: CdpTraceEvent[] = [
      ev('RunTask', 'disabled-by-default-devtools.timeline', LONG_TASK_THRESHOLD_MS * 1000),
      ev(
        'RunTask',
        'disabled-by-default-devtools.timeline',
        (LONG_TASK_THRESHOLD_MS - 0.01) * 1000,
      ),
    ];
    const s = aggregateTrace(events);
    expect(s.longTaskCount).toBe(1);
  });

  test('ThreadControllerImpl::RunTask treated as RunTask equivalent', () => {
    const events: CdpTraceEvent[] = [
      ev('ThreadControllerImpl::RunTask', 'disabled-by-default-devtools.timeline', 100_000),
    ];
    const s = aggregateTrace(events);
    expect(s.longTaskCount).toBe(1);
    expect(s.longestTaskMs).toBe(100);
  });

  test('UpdateLayoutTree and RecalcStyle contribute to styleMs', () => {
    const events: CdpTraceEvent[] = [
      ev('UpdateLayoutTree', 'blink', 200_000), // 200ms
      ev('RecalcStyle', 'blink', 50_000), // 50ms
    ];
    const s = aggregateTrace(events);
    expect(s.styleMs).toBe(250);
  });

  test('Layout events contribute to layoutMs', () => {
    const events: CdpTraceEvent[] = [
      ev('Layout', 'blink', 400_000),
      ev('Layout', 'blink', 100_000),
    ];
    const s = aggregateTrace(events);
    expect(s.layoutMs).toBe(500);
  });

  test('Script-execution family contributes to scriptMs', () => {
    const events: CdpTraceEvent[] = [
      ev('EvaluateScript', 'v8', 200_000),
      ev('FunctionCall', 'v8', 100_000),
      ev('v8.compile', 'v8', 50_000),
      ev('V8.Execute', 'v8', 10_000),
    ];
    const s = aggregateTrace(events);
    expect(s.scriptMs).toBe(360);
  });

  test('Paint events count, do not sum duration', () => {
    const events: CdpTraceEvent[] = [
      ev('Paint', 'blink', 1000),
      ev('PaintImage', 'blink', 2000),
      ev('CompositeLayers', 'cc', 5000),
    ];
    const s = aggregateTrace(events);
    expect(s.paintEvents).toBe(3);
  });

  test('user-timing marks counted via cat:blink.user_timing', () => {
    const events: CdpTraceEvent[] = [
      ev('ok/nav/hash-change', 'blink.user_timing', 0),
      ev('ok/render/editor-area', 'blink.user_timing', 0),
      ev('ok/sync/resolve', 'blink.user_timing,other', 0),
    ];
    const s = aggregateTrace(events);
    expect(s.userTimingMarkCount).toBe(3);
  });

  test('LargestContentfulPaint tracks lastLcpMs from ts', () => {
    const events: CdpTraceEvent[] = [
      { name: 'largestContentfulPaint::Candidate', cat: 'loading', ts: 1_200_000, ph: 'I' },
      { name: 'LargestContentfulPaint', cat: 'loading', ts: 3_400_000, ph: 'I' },
    ];
    const s = aggregateTrace(events);
    expect(s.lastLcpMs).toBe(3400);
  });

  test('LayoutShift accumulates args.data.score into cumulativeLayoutShift', () => {
    const events: CdpTraceEvent[] = [
      { name: 'LayoutShift', cat: 'loading', ts: 0, ph: 'I', args: { data: { score: 0.125 } } },
      { name: 'LayoutShift', cat: 'loading', ts: 0, ph: 'I', args: { data: { score: 0.0625 } } },
    ];
    const s = aggregateTrace(events);
    expect(s.cumulativeLayoutShift).toBeCloseTo(0.1875, 4);
  });

  test('malformed events skipped without throwing', () => {
    const events = [
      { name: undefined, cat: 'x', ts: 0, ph: 'X', dur: 100 } as unknown as CdpTraceEvent,
      ev('RunTask', 'disabled-by-default-devtools.timeline', Number.NaN),
      ev('RunTask', 'disabled-by-default-devtools.timeline', Number.POSITIVE_INFINITY),
      ev('RunTask', 'disabled-by-default-devtools.timeline', 200_000),
    ];
    const s = aggregateTrace(events);
    expect(s.longTaskCount).toBe(1);
    expect(s.longestTaskMs).toBe(200);
  });

  test('eventCount reflects total including events we did not aggregate', () => {
    const events: CdpTraceEvent[] = [
      ev('UnrelatedEvent', 'metadata', 0),
      ev('Layout', 'blink', 10_000),
    ];
    const s = aggregateTrace(events);
    expect(s.eventCount).toBe(2);
    expect(s.layoutMs).toBe(10);
  });

  test('TRACE_CATEGORIES contains blink.user_timing + devtools.timeline', () => {
    expect(TRACE_CATEGORIES).toContain('blink.user_timing');
    expect(TRACE_CATEGORIES).toContain('devtools.timeline');
    expect(TRACE_CATEGORIES).toContain('disabled-by-default-devtools.timeline');
  });
});

describe('Performance.getMetrics window helpers', () => {
  test('enablePerformanceMetrics calls Performance.enable once', async () => {
    const m = mockCdp([]);
    await enablePerformanceMetrics(m.client);
    expect(m.enableCalls).toBe(1);
  });

  test('getPerfMetricsSnapshot returns a Map keyed by metric name', async () => {
    const m = mockCdp([
      { LayoutDuration: 1.5, RecalcStyleDuration: 0.5, ScriptDuration: 2.0, TaskDuration: 4.0 },
    ]);
    const snap = await getPerfMetricsSnapshot(m.client);
    expect(snap.get('LayoutDuration')).toBe(1.5);
    expect(snap.get('RecalcStyleDuration')).toBe(0.5);
    expect(snap.get('ScriptDuration')).toBe(2.0);
    expect(snap.get('TaskDuration')).toBe(4.0);
  });

  test('computePerfMetricsDelta converts seconds to ms and returns 4 axes', () => {
    const start = new Map([
      ['LayoutDuration', 1.0],
      ['RecalcStyleDuration', 0.1],
      ['ScriptDuration', 2.0],
      ['TaskDuration', 3.5],
    ]);
    const end = new Map([
      ['LayoutDuration', 1.5],
      ['RecalcStyleDuration', 0.6],
      ['ScriptDuration', 4.0],
      ['TaskDuration', 7.0],
    ]);
    const delta = computePerfMetricsDelta(start, end);
    expect(delta.layoutMs).toBe(500);
    expect(delta.recalcStyleMs).toBe(500);
    expect(delta.scriptMs).toBe(2000);
    expect(delta.taskMs).toBe(3500);
  });

  test('computePerfMetricsDelta clamps negative deltas to zero', () => {
    const start = new Map([['LayoutDuration', 5.0]]);
    const end = new Map([['LayoutDuration', 3.0]]); // page reload simulation
    const delta = computePerfMetricsDelta(start, end);
    expect(delta.layoutMs).toBe(0);
  });

  test('computePerfMetricsDelta returns 0 for missing metrics', () => {
    const empty = new Map<string, number>();
    const delta = computePerfMetricsDelta(empty, empty);
    expect(delta.layoutMs).toBe(0);
    expect(delta.recalcStyleMs).toBe(0);
    expect(delta.scriptMs).toBe(0);
    expect(delta.taskMs).toBe(0);
  });

  test('capturePerfMetricsWindow brackets fn() with start + end snapshots', async () => {
    const m = mockCdp([
      { LayoutDuration: 1.0, RecalcStyleDuration: 0.1, ScriptDuration: 2.0, TaskDuration: 3.0 },
      { LayoutDuration: 1.5, RecalcStyleDuration: 0.3, ScriptDuration: 4.0, TaskDuration: 6.0 },
    ]);
    const { result, deltas } = await capturePerfMetricsWindow(m.client, async () => 'work-result');
    expect(result).toBe('work-result');
    expect(deltas.layoutMs).toBe(500);
    expect(deltas.recalcStyleMs).toBe(200);
    expect(deltas.scriptMs).toBe(2000);
    expect(deltas.taskMs).toBe(3000);
    expect(m.getMetricsCalls).toBe(2);
  });

  test('capturePerfMetricsWindow rethrows on fn rejection but attaches deltas to err', async () => {
    const m = mockCdp([{ LayoutDuration: 1.0 }, { LayoutDuration: 1.5 }]);
    const err = await capturePerfMetricsWindow(m.client, async () => {
      throw new Error('boom');
    }).catch((e: Error & { perfMetricsDeltas?: { layoutMs: number } }) => e);
    expect(err.message).toBe('boom');
    expect(err.perfMetricsDeltas?.layoutMs).toBe(500);
    expect(m.getMetricsCalls).toBe(2);
  });

  test('capturePerfMetricsWindow snapshot count is exactly 2 even on resolution', async () => {
    const m = mockCdp([{ LayoutDuration: 0 }, { LayoutDuration: 0 }]);
    await capturePerfMetricsWindow(m.client, async () => 42);
    expect(m.getMetricsCalls).toBe(2); // not 1, not 3
  });
});
