import { describe, expect, test } from 'vitest';
import {
  createDesktopProcessObservability,
  DESKTOP_PROCESS_SAMPLE_INTERVAL_MS,
  MAX_DESKTOP_PROCESS_SAMPLE_ROWS,
  MAX_DESKTOP_WINDOW_SAMPLE_ROWS,
  type ObservedBrowserWindow,
  type ProcessMetricLike,
} from './desktop-process-observability.ts';

interface TestWindow extends ObservedBrowserWindow {
  emit(event: 'closed' | 'show' | 'hide' | 'minimize' | 'restore'): void;
  setState(
    state: Partial<{
      destroyed: boolean;
      visible: boolean;
      minimized: boolean;
      crashed: boolean;
      loading: boolean;
      rendererPid: number;
    }>,
  ): void;
}

function makeWindow(input: {
  id: number;
  contentsId: number;
  rendererPid: number;
  visible?: boolean;
  minimized?: boolean;
  throwIdentityWhenDestroyed?: boolean;
}): TestWindow {
  const listeners = new Map<string, Array<() => void>>();
  let destroyed = false;
  let visible = input.visible ?? true;
  let minimized = input.minimized ?? false;
  let crashed = false;
  let loading = false;
  let rendererPid = input.rendererPid;
  const contents = {
    id: input.contentsId,
    getOSProcessId: () => rendererPid,
    isCrashed: () => crashed,
    isDestroyed: () => destroyed,
    isLoading: () => loading,
  };
  return {
    get id() {
      if (destroyed && input.throwIdentityWhenDestroyed === true) {
        throw new Error('window identity unavailable after close');
      }
      return input.id;
    },
    get webContents() {
      if (destroyed && input.throwIdentityWhenDestroyed === true) {
        throw new Error('webContents unavailable after close');
      }
      return contents;
    },
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => minimized,
    isFocused: () => visible && !minimized,
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit: (event) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    setState: (state) => {
      destroyed = state.destroyed ?? destroyed;
      visible = state.visible ?? visible;
      minimized = state.minimized ?? minimized;
      crashed = state.crashed ?? crashed;
      loading = state.loading ?? loading;
      rendererPid = state.rendererPid ?? rendererPid;
    },
  };
}

function processMetric(input: {
  pid: number;
  type: string;
  workingSetSize: number;
  name?: string;
}): ProcessMetricLike {
  return {
    pid: input.pid,
    type: input.type,
    name: input.name,
    serviceName: input.name === undefined ? undefined : 'node.mojom.NodeService',
    creationTime: 1_790_000_000_000 + input.pid,
    cpu: {
      percentCPUUsage: 12.5,
      cumulativeCPUUsage: 42,
      idleWakeupsPerSecond: 0,
    },
    memory: {
      workingSetSize: input.workingSetSize,
      peakWorkingSetSize: input.workingSetSize + 100,
      privateBytes: input.workingSetSize - 100,
    },
    sandboxed: true,
    integrityLevel: 'low',
  };
}

function harness() {
  let nowMs = Date.parse('2026-09-22T19:25:00.000Z');
  let metrics: ProcessMetricLike[] = [
    processMetric({ pid: 100, type: 'Browser', workingSetSize: 50_000 }),
    processMetric({ pid: 200, type: 'Tab', workingSetSize: 125_000 }),
  ];
  const windows: TestWindow[] = [
    makeWindow({
      id: 7,
      contentsId: 11,
      rendererPid: 200,
      throwIdentityWhenDestroyed: true,
    }),
  ];
  const info: Array<Record<string, unknown>> = [];
  const warn: Array<Record<string, unknown>> = [];
  const intervals: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const observability = createDesktopProcessObservability({
    now: () => new Date(nowMs),
    getAppMetrics: () => metrics,
    getAllWindows: () => windows,
    logger: {
      info: (payload) => info.push(payload),
      warn: (payload) => warn.push(payload),
    },
    setInterval: (callback, ms) => {
      const interval = { callback, ms, cleared: false };
      intervals.push(interval);
      return interval;
    },
    clearInterval: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  return {
    observability,
    info,
    warn,
    intervals,
    windows,
    setMetrics: (next: ProcessMetricLike[]) => {
      metrics = next;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('desktop process observability', () => {
  test('samples every app process and window once per minute from main-process dependencies', () => {
    const rig = harness();

    rig.observability.start();

    expect(DESKTOP_PROCESS_SAMPLE_INTERVAL_MS).toBe(60_000);
    expect(rig.intervals[0]?.ms).toBe(60_000);
    expect(rig.info[0]).toMatchObject({
      event: 'desktop-process-observability.sample',
      trigger: 'startup',
      capturedAt: '2026-09-22T19:25:00.000Z',
      processes: [
        {
          pid: 200,
          type: 'Tab',
          workingSetSizeKb: 125_000,
          privateBytesKb: 124_900,
        },
        { pid: 100, type: 'Browser', workingSetSizeKb: 50_000 },
      ],
      windows: [
        {
          windowId: 7,
          contentsId: 11,
          rendererPid: 200,
          state: 'alive',
          visible: true,
          minimized: false,
          focused: true,
        },
      ],
    });

    rig.advance(DESKTOP_PROCESS_SAMPLE_INTERVAL_MS);
    rig.intervals[0]?.callback();
    expect(rig.info[1]).toMatchObject({
      event: 'desktop-process-observability.sample',
      trigger: 'interval',
      capturedAt: '2026-09-22T19:26:00.000Z',
    });

    rig.advance(1_000);
    rig.observability.sampleNow('renderer-ready');
    expect(rig.info[2]).toMatchObject({
      event: 'desktop-process-observability.sample',
      trigger: 'renderer-ready',
      capturedAt: '2026-09-22T19:26:01.000Z',
    });
  });

  test('keeps the last pre-crash sample beside a live post-crash snapshot', () => {
    const rig = harness();
    rig.observability.start();
    rig.advance(5_000);
    rig.setMetrics([processMetric({ pid: 100, type: 'Browser', workingSetSize: 51_000 })]);

    const snapshot = rig.observability.snapshotForCrash({ contentsId: 11, rendererPid: null });

    expect(snapshot).toMatchObject({
      affectedRenderer: { contentsId: 11, rendererPid: 200 },
      lastSampleAgeMs: 5_000,
      lastSample: {
        capturedAt: '2026-09-22T19:25:00.000Z',
        processes: [{ pid: 200, type: 'Tab' }, { pid: 100 }],
      },
      liveSample: {
        capturedAt: '2026-09-22T19:25:05.000Z',
        processes: [{ pid: 100 }],
      },
    });
    expect(snapshot.liveSample?.processes).not.toContainEqual(
      expect.objectContaining({ pid: 200 }),
    );
  });

  test('records complete window lifecycle with the remaining live-window count', () => {
    const rig = harness();
    const window = rig.windows[0];
    if (!window) throw new Error('missing test window');

    rig.observability.observeWindow(window);
    window.setState({ visible: false, minimized: true });
    window.emit('hide');
    window.emit('minimize');
    window.setState({ visible: true, minimized: false });
    window.emit('show');
    window.emit('restore');
    window.setState({ destroyed: true });
    expect(() => window.emit('closed')).not.toThrow();

    const lifecycle = rig.info.filter(
      (line) => line.event === 'desktop-process-observability.window-lifecycle',
    );
    expect(lifecycle.map((line) => line.action)).toEqual([
      'created',
      'hidden',
      'minimized',
      'shown',
      'restored',
      'closed',
    ]);
    expect(lifecycle[0]).toMatchObject({
      windowId: 7,
      contentsId: 11,
      rendererPid: 200,
      liveWindowCount: 1,
    });
    expect(lifecycle.at(-1)).toMatchObject({ liveWindowCount: 0, state: 'destroyed' });
  });

  test('keeps crash handling alive when Electron refuses a process sample', () => {
    const rig = harness();
    rig.observability.start();
    rig.observability.stop();
    const failing = createDesktopProcessObservability({
      now: () => new Date('2026-09-22T19:25:30.000Z'),
      getAppMetrics: () => {
        throw new Error('metrics unavailable');
      },
      getAllWindows: () => rig.windows,
      logger: {
        info: (payload) => rig.info.push(payload),
        warn: (payload) => rig.warn.push(payload),
      },
      setInterval: () => 1,
      clearInterval: () => {},
    });

    failing.start();
    const snapshot = failing.snapshotForCrash({ contentsId: 11, rendererPid: 200 });

    expect(snapshot.lastSample).toBeNull();
    expect(snapshot.liveSample).toBeNull();
    expect(rig.warn).toContainEqual(
      expect.objectContaining({ event: 'desktop-process-observability.sample-failed' }),
    );
  });

  test('preserves the last renderer PID after the live contents becomes unavailable', () => {
    const rig = harness();
    const window = rig.windows[0];
    if (!window) throw new Error('missing test window');
    window.setState({ rendererPid: 0 });
    rig.observability.observeWindow(window);
    window.setState({ rendererPid: 200 });
    rig.observability.sampleNow('renderer-ready');
    window.setState({ destroyed: true });

    expect(() => window.emit('closed')).not.toThrow();

    const closed = rig.info.find(
      (line) =>
        line.event === 'desktop-process-observability.window-lifecycle' && line.action === 'closed',
    );
    expect(closed).toMatchObject({
      windowId: 7,
      contentsId: 11,
      rendererPid: 200,
      state: 'destroyed',
    });
  });

  test('distinguishes alive, loading, crashed and destroyed window states', () => {
    const rig = harness();
    const window = rig.windows[0];
    if (!window) throw new Error('missing test window');
    rig.observability.start();

    window.setState({ crashed: true, rendererPid: 0 });
    rig.observability.sampleNow('renderer-ready');
    window.setState({ loading: true, crashed: false });
    rig.observability.sampleNow('renderer-ready');
    window.setState({ loading: false });
    rig.observability.sampleNow('renderer-ready');
    window.setState({ crashed: true });
    rig.observability.sampleNow('renderer-ready');
    window.setState({ destroyed: true });
    rig.observability.sampleNow('renderer-ready');

    const samples = rig.info.filter(
      (line) => line.event === 'desktop-process-observability.sample',
    ) as Array<{ windows: Array<{ state: string; rendererPid: number | null }> }>;
    expect(samples[0]?.windows).toEqual([
      expect.objectContaining({ state: 'alive', rendererPid: 200 }),
    ]);
    expect(samples[1]?.windows).toEqual([
      expect.objectContaining({ state: 'crashed', rendererPid: 200 }),
    ]);
    expect(samples[2]?.windows).toEqual([
      expect.objectContaining({ state: 'loading', rendererPid: null }),
    ]);
    expect(samples[3]?.windows).toEqual([
      expect.objectContaining({ state: 'alive', rendererPid: null }),
    ]);
    expect(samples[4]?.windows).toEqual([
      expect.objectContaining({ state: 'crashed', rendererPid: null }),
    ]);
    expect(samples[5]?.windows).toEqual([]);
  });

  test('starts only one interval and floors clock rollback at a zero sample age', () => {
    const rig = harness();
    rig.observability.start();
    rig.observability.start();
    rig.advance(-5_000);

    const snapshot = rig.observability.snapshotForCrash();

    expect(rig.intervals).toHaveLength(1);
    expect(snapshot.lastSampleAgeMs).toBe(0);
  });

  test('bounds each log line while retaining counts and the highest-memory processes', () => {
    const rig = harness();
    rig.setMetrics(
      Array.from({ length: 40 }, (_, index) =>
        processMetric({
          pid: 1_000 + index,
          type: index === 0 ? 'Browser' : 'Tab',
          workingSetSize: 10_000 + Math.min(index, 38) * 1_000,
          name: 'process-name'.repeat(50),
        }),
      ),
    );
    for (let index = 0; index < 20; index += 1) {
      rig.windows.push(
        makeWindow({
          id: 100 + index,
          contentsId: 200 + index,
          rendererPid: 1_000 + index,
        }),
      );
    }
    rig.windows.reverse();

    rig.observability.start();

    const sample = rig.info[0] as {
      processCount: number;
      processesTruncated: number;
      processes: Array<{ pid: number }>;
      windowCount: number;
      windowsTruncated: number;
      windows: unknown[];
    };
    expect(sample.processCount).toBe(40);
    expect(sample.processesTruncated).toBe(40 - MAX_DESKTOP_PROCESS_SAMPLE_ROWS);
    expect(sample.processes).toHaveLength(MAX_DESKTOP_PROCESS_SAMPLE_ROWS);
    expect(sample.processes[0]?.pid).toBe(1_038);
    expect((sample.processes[0] as { name?: string }).name).toHaveLength(96);
    expect(sample.processes[0]).not.toHaveProperty('serviceName');
    expect(sample.windowCount).toBe(21);
    expect(sample.windowsTruncated).toBe(21 - MAX_DESKTOP_WINDOW_SAMPLE_ROWS);
    expect(sample.windows).toHaveLength(MAX_DESKTOP_WINDOW_SAMPLE_ROWS);
    expect((sample.windows[0] as { windowId?: number }).windowId).toBe(7);
    const sampleBytes = Buffer.byteLength(JSON.stringify(sample));
    const samplesPerDay = (24 * 60 * 60 * 1_000) / DESKTOP_PROCESS_SAMPLE_INTERVAL_MS;
    expect(Number.isInteger(samplesPerDay)).toBe(true);
    expect(sampleBytes).toBeLessThan(5 * 1_024);
    expect(sampleBytes * samplesPerDay).toBeLessThan(6 * 1024 * 1024);
  });

  test('stop is idempotent', () => {
    const rig = harness();
    rig.observability.start();

    rig.observability.stop();
    rig.observability.stop();

    expect(rig.intervals[0]?.cleared).toBe(true);
  });
});
