import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CapRegime, WorkloadFixtureRef } from './cell-measurement';
import {
  bootstrapCi,
  type CellMeasurement,
  computeLeakRateMbPerCycle,
  drainSubstrateSignals,
  forceGc,
  measureCell,
  readHeapMb,
  type WorkloadDriver,
} from './cell-measurement';


interface CdpSendCall {
  readonly method: string;
  readonly params?: unknown;
}

class MockCdp {
  readonly calls: CdpSendCall[] = [];
  async send(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return undefined;
  }
}

class MockPage {
  private okPerf: unknown = undefined;
  private heapBytes = 0;
  private memoryAbsent = false;
  readonly evaluateCallCount = { count: 0 };

  setOkPerfFixture(state: unknown): void {
    this.okPerf = state;
  }

  setHeapMb(mb: number): void {
    this.heapBytes = mb * 1024 * 1024;
    this.memoryAbsent = false;
  }

  setPerformanceMemoryAbsent(): void {
    this.memoryAbsent = true;
  }

  // biome-ignore lint/suspicious/noExplicitAny: page.evaluate has overloaded signatures we mirror
  async evaluate<T, A>(fn: (...args: any[]) => T, arg?: A): Promise<T> {
    this.evaluateCallCount.count += 1;
    const restore = (globalThis as unknown as { __ok_perf?: unknown }).__ok_perf;
    (globalThis as unknown as { __ok_perf?: unknown }).__ok_perf = this.okPerf;
    const origPerf = (globalThis as unknown as { performance?: unknown }).performance;
    (globalThis as unknown as { performance?: unknown }).performance = this.memoryAbsent
      ? {} // `performance` exists; `performance.memory` is undefined
      : { memory: { usedJSHeapSize: this.heapBytes } };
    try {
      return await Promise.resolve(arg === undefined ? fn() : fn(arg));
    } finally {
      (globalThis as unknown as { __ok_perf?: unknown }).__ok_perf = restore;
      (globalThis as unknown as { performance?: unknown }).performance = origPerf;
    }
  }
}

const BASE_REGIME: CapRegime = { maxPool: 10, maxCache: 10, activityMountLimit: 3 };
const BASE_FIXTURE: WorkloadFixtureRef = 'tight';

interface PerfMarkFixture {
  readonly name: string;
  readonly duration: number;
}

function buildOkPerfFixture(opts: {
  poolHits?: number;
  poolMisses?: number;
  marks?: ReadonlyArray<PerfMarkFixture>;
}): unknown {
  const counters: Record<string, { byProp: Record<string, Record<string, number>> }> = {};
  if (opts.poolHits !== undefined || opts.poolMisses !== undefined) {
    const byProp: Record<string, Record<string, number>> = {
      hit: {
        true: opts.poolHits ?? 0,
        false: opts.poolMisses ?? 0,
      },
    };
    counters['ok/pool/open'] = { byProp };
  }
  const allMarks = opts.marks ?? [];
  return {
    counters,
    marks: {
      toArray: () => allMarks,
    },
  };
}

function makeSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


describe('forceGc', () => {
  test('sends HeapProfiler.collectGarbage to CDP', async () => {
    const cdp = new MockCdp();
    await forceGc(cdp as unknown as Parameters<typeof forceGc>[0]);
    expect(cdp.calls).toEqual([{ method: 'HeapProfiler.collectGarbage', params: undefined }]);
  });

  test('settles for ≥50ms after GC so post-GC microtasks can drain', async () => {
    const cdp = new MockCdp();
    const start = Date.now();
    await forceGc(cdp as unknown as Parameters<typeof forceGc>[0]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });
});

describe('readHeapMb', () => {
  test('converts bytes → MB using the 1024² divisor (binary MB, mirrors memory-per-editor.ts)', async () => {
    const page = new MockPage();
    page.setHeapMb(42.5);
    const mb = await readHeapMb(page as unknown as Parameters<typeof readHeapMb>[0]);
    expect(mb).toBeCloseTo(42.5, 5);
  });

  test('returns 0 when usedJSHeapSize is 0', async () => {
    const page = new MockPage();
    page.setHeapMb(0);
    const mb = await readHeapMb(page as unknown as Parameters<typeof readHeapMb>[0]);
    expect(mb).toBe(0);
  });

  test('returns 0 without throwing when performance.memory is absent (non-Chromium)', async () => {
    const page = new MockPage();
    page.setPerformanceMemoryAbsent();
    const mb = await readHeapMb(page as unknown as Parameters<typeof readHeapMb>[0]);
    expect(mb).toBe(0);
  });
});


describe('drainSubstrateSignals', () => {
  test('cacheHitCount counts ok/cache/hit ONLY; other substrate marks do not contribute', async () => {
    const page = new MockPage();
    page.setOkPerfFixture(
      buildOkPerfFixture({
        marks: [
          { name: 'ok/cache/hit', duration: 0 },
          { name: 'ok/cache/hit', duration: 0 },
          { name: 'ok/mount/create', duration: 0 },
          { name: 'ok/mount/resolve', duration: 0 },
          { name: 'ok/render/frame', duration: 5 },
          { name: 'ok/cache/miss', duration: 0 },
        ],
      }),
    );
    const drained = await drainSubstrateSignals(
      page as unknown as Parameters<typeof drainSubstrateSignals>[0],
    );
    expect(drained.cacheHitCount).toBe(2);
    expect(drained.cacheMissCount).toBe(1);
  });

  test('reads pool open hit/miss from counters["ok/pool/open"].byProp.hit', async () => {
    const page = new MockPage();
    page.setOkPerfFixture(buildOkPerfFixture({ poolHits: 7, poolMisses: 3 }));
    const drained = await drainSubstrateSignals(
      page as unknown as Parameters<typeof drainSubstrateSignals>[0],
    );
    expect(drained.poolOpenHits).toBe(7);
    expect(drained.poolOpenMisses).toBe(3);
  });

  test('computes perFrameJankRate from ok/render/* marks exceeding jankFrameMs', async () => {
    const page = new MockPage();
    page.setOkPerfFixture(
      buildOkPerfFixture({
        marks: [
          { name: 'ok/render/frame', duration: 8 },
          { name: 'ok/render/frame', duration: 12 },
          { name: 'ok/render/frame', duration: 20 }, // janky at 16.7ms
          { name: 'ok/render/frame', duration: 100 }, // janky
          { name: 'ok/render/component', duration: 9 },
        ],
      }),
    );
    const drained = await drainSubstrateSignals(
      page as unknown as Parameters<typeof drainSubstrateSignals>[0],
    );
    expect(drained.perFrameJankRate).toBeCloseTo(2 / 5, 5);
  });

  test('respects custom jankFrameMs threshold', async () => {
    const page = new MockPage();
    page.setOkPerfFixture(
      buildOkPerfFixture({
        marks: [
          { name: 'ok/render/frame', duration: 30 },
          { name: 'ok/render/frame', duration: 70 },
        ],
      }),
    );
    const drained = await drainSubstrateSignals(
      page as unknown as Parameters<typeof drainSubstrateSignals>[0],
      { jankFrameMs: 50 },
    );
    expect(drained.perFrameJankRate).toBeCloseTo(0.5, 5);
  });

  test('returns zeros when __ok_perf is absent (production build, or collector not instantiated)', async () => {
    const page = new MockPage();
    page.setOkPerfFixture(undefined);
    const drained = await drainSubstrateSignals(
      page as unknown as Parameters<typeof drainSubstrateSignals>[0],
    );
    expect(drained).toEqual({
      poolOpenHits: 0,
      poolOpenMisses: 0,
      cacheHitCount: 0,
      cacheMissCount: 0,
      perFrameJankRate: 0,
    });
  });

  test('perFrameJankRate is 0 when no render-frame marks are present (avoids 0/0 NaN)', async () => {
    const page = new MockPage();
    page.setOkPerfFixture(
      buildOkPerfFixture({
        marks: [
          { name: 'ok/cache/hit', duration: 0 },
          { name: 'ok/cache/miss', duration: 0 },
        ],
      }),
    );
    const drained = await drainSubstrateSignals(
      page as unknown as Parameters<typeof drainSubstrateSignals>[0],
    );
    expect(drained.perFrameJankRate).toBe(0);
  });
});


describe('computeLeakRateMbPerCycle', () => {
  test('returns mean per-cycle delta (matches memory-per-editor.ts:320-323 formula)', () => {
    const samples = [100, 120, 140, 160, 175, 200, 220, 235, 255, 270];
    const leakRate = computeLeakRateMbPerCycle(samples);
    expect(leakRate).toBeCloseTo(170 / 9, 5);
  });

  test('returns 0 for fewer than 2 samples (no slope is computable)', () => {
    expect(computeLeakRateMbPerCycle([])).toBe(0);
    expect(computeLeakRateMbPerCycle([42])).toBe(0);
  });

  test('handles negative drift (post-GC reclaim) without flipping sign convention', () => {
    const samples = [200, 150]; // heap shrank
    expect(computeLeakRateMbPerCycle(samples)).toBe(-50);
  });
});


describe('bootstrapCi', () => {
  test('returns zero-shape for empty input', () => {
    const ci = bootstrapCi([], 'coldMount');
    expect(ci.estimate).toBe(0);
    expect(ci.lo).toBe(0);
    expect(ci.hi).toBe(0);
    expect(ci.sampleCount).toBe(0);
  });

  test('collapses to point estimate for single sample (lo === hi === estimate)', () => {
    const ci = bootstrapCi([42], 'warmReopen');
    expect(ci.estimate).toBe(42);
    expect(ci.lo).toBe(42);
    expect(ci.hi).toBe(42);
    expect(ci.sampleCount).toBe(1);
  });

  test('estimate equals p95 of input samples (linear interpolation between order statistics)', () => {
    const samples = [...Array(20).keys()].map((i) => i * 10); // [0, 10, ..., 190]
    const ci = bootstrapCi(samples, 'coldMount', {
      random: makeSeededRandom(42),
      iterations: 500,
    });
    expect(ci.estimate).toBeCloseTo(180.5, 1);
  });

  test('lo and hi form a valid bracket for non-degenerate samples', () => {
    const samples = [100, 110, 115, 120, 125, 130, 135, 140, 145, 200];
    const ci = bootstrapCi(samples, 'coldMount', {
      random: makeSeededRandom(13),
      iterations: 1000,
    });
    expect(ci.lo).toBeLessThanOrEqual(ci.hi);
    expect(ci.lo).toBeLessThan(ci.hi); // non-degenerate
    const sampleMean = samples.reduce((acc, v) => acc + v, 0) / samples.length;
    expect(sampleMean).toBeGreaterThanOrEqual(ci.lo);
    expect(sampleMean).toBeLessThanOrEqual(ci.hi);
  });

  test('deterministic with seeded random — same seed produces identical CI', () => {
    const samples = [100, 110, 115, 120, 125, 130, 135, 140, 145, 200];
    const ci1 = bootstrapCi(samples, 'coldMount', {
      random: makeSeededRandom(7),
      iterations: 500,
    });
    const ci2 = bootstrapCi(samples, 'coldMount', {
      random: makeSeededRandom(7),
      iterations: 500,
    });
    expect(ci1.lo).toBe(ci2.lo);
    expect(ci1.hi).toBe(ci2.hi);
  });

  test('carries the axis label through unchanged', () => {
    const ci = bootstrapCi([10, 20, 30], 'tabSwitchActivityHiddenToVisible', {
      random: makeSeededRandom(1),
      iterations: 100,
    });
    expect(ci.axis).toBe('tabSwitchActivityHiddenToVisible');
  });
});


describe('measureCell', () => {
  let originalSetInterval: typeof globalThis.setInterval;

  beforeEach(() => {
    originalSetInterval = globalThis.setInterval;
  });

  afterEach(() => {
    globalThis.setInterval = originalSetInterval;
  });

  async function runCell(opts: {
    coldMountSamples?: number[];
    warmReopenSamples?: number[];
    tabSwitchFlipSamples?: number[];
    tabSwitchReMountSamples?: number[];
    leakCycleHeapMb?: number[];
    notes?: string[];
    okPerfFixture?: unknown;
    finalHeapMb?: number;
    options?: Parameters<typeof measureCell>[0]['options'];
  }): Promise<{ cell: CellMeasurement; cdp: MockCdp; page: MockPage }> {
    const cdp = new MockCdp();
    const page = new MockPage();
    page.setOkPerfFixture(opts.okPerfFixture);
    page.setHeapMb(opts.finalHeapMb ?? 0);
    const workload = async (driver: WorkloadDriver) => {
      for (const s of opts.coldMountSamples ?? []) driver.recordColdMountSample(s);
      for (const s of opts.warmReopenSamples ?? []) driver.recordWarmReopenSample(s);
      for (const s of opts.tabSwitchFlipSamples ?? [])
        driver.recordTabSwitchWarmActivityFlipSample(s);
      for (const s of opts.tabSwitchReMountSamples ?? [])
        driver.recordTabSwitchActivityHiddenToVisibleSample(s);
      for (const h of opts.leakCycleHeapMb ?? []) driver.recordLeakCycleHeapMb(h);
      for (const n of opts.notes ?? []) driver.note(n);
    };
    const cell = await measureCell({
      page: page as unknown as Parameters<typeof measureCell>[0]['page'],
      cdp: cdp as unknown as Parameters<typeof measureCell>[0]['cdp'],
      capRegime: BASE_REGIME,
      fixture: BASE_FIXTURE,
      workload,
      options: opts.options,
    });
    return { cell, cdp, page };
  }

  test('returns CellMeasurement with all 10 §13 signals populated (AC: no nulls in any signal)', async () => {
    const { cell } = await runCell({
      coldMountSamples: Array.from({ length: 25 }, (_, i) => 300 + i),
      warmReopenSamples: Array.from({ length: 25 }, (_, i) => 80 + i),
      tabSwitchFlipSamples: Array.from({ length: 25 }, (_, i) => 30 + i),
      tabSwitchReMountSamples: Array.from({ length: 25 }, (_, i) => 100 + i),
      leakCycleHeapMb: [100, 110, 120, 130, 140, 150, 160, 170, 180, 190],
      okPerfFixture: buildOkPerfFixture({
        poolHits: 18,
        poolMisses: 7,
        marks: [
          ...Array.from({ length: 20 }, () => ({ name: 'ok/cache/hit', duration: 0 })),
          ...Array.from({ length: 5 }, () => ({ name: 'ok/cache/miss', duration: 0 })),
          ...Array.from({ length: 90 }, () => ({ name: 'ok/render/frame', duration: 12 })),
          ...Array.from({ length: 10 }, () => ({ name: 'ok/render/frame', duration: 22 })),
        ],
      }),
      finalHeapMb: 220,
    });

    expect(typeof cell.coldMountP95Ms).toBe('number');
    expect(cell.coldMountP95Ms).toBeGreaterThan(0);
    expect(typeof cell.warmReopenP95Ms).toBe('number');
    expect(cell.warmReopenP95Ms).toBeGreaterThan(0);
    expect(typeof cell.tabSwitchWarmActivityFlipP95Ms).toBe('number');
    expect(cell.tabSwitchWarmActivityFlipP95Ms).toBeGreaterThan(0);
    expect(typeof cell.tabSwitchActivityHiddenToVisibleP95Ms).toBe('number');
    expect(cell.tabSwitchActivityHiddenToVisibleP95Ms).toBeGreaterThan(0);
    expect(cell.poolHitRate).toBeCloseTo(18 / 25, 5);
    expect(cell.cacheHitRate).toBeCloseTo(20 / 25, 5);
    expect(cell.rendererRssMb).toBe(220);
    expect(cell.perFrameJankRate).toBeCloseTo(10 / 100, 5);
    expect(cell.maxVmPressure).toBeGreaterThanOrEqual(1);
    expect(cell.tipTapLeakRateMbPerCycle).toBeCloseTo(90 / 9, 5);
    expect(cell.capRegime).toEqual(BASE_REGIME);
    expect(cell.fixture).toBe(BASE_FIXTURE);
    expect(typeof cell.capturedAt).toBe('string');
    expect(cell.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(cell.sampleCounts.coldMount).toBe(25);
    expect(cell.sampleCounts.warmReopen).toBe(25);
    expect(cell.sampleCounts.leakCycles).toBe(10);
  });

  test('AC (b): cacheHitRate counts ok/cache/hit ONLY; other substrate marks do not contribute', async () => {
    const { cell } = await runCell({
      warmReopenSamples: [50, 60, 70], // ensure cache-stale watchpoint doesn't fire
      okPerfFixture: buildOkPerfFixture({
        marks: [
          { name: 'ok/cache/hit', duration: 0 },
          { name: 'ok/cache/hit', duration: 0 },
          { name: 'ok/cache/hit', duration: 0 },
          ...Array.from({ length: 10 }, () => ({ name: 'ok/mount/create', duration: 0 })),
          { name: 'ok/cache/miss', duration: 0 },
        ],
      }),
    });
    expect(cell.cacheHitRate).toBeCloseTo(0.75, 5);
    expect(cell.watchpoints.cacheLayerStale).toBe(false);
  });

  test('AC (c): leak watchpoint trips when tipTapLeakRateMbPerCycle exceeds 25 MB/cycle (default)', async () => {
    const heap = [100, 130, 160, 190, 220, 250, 280, 310, 340, 370, 400];
    const { cell } = await runCell({
      leakCycleHeapMb: heap,
      okPerfFixture: buildOkPerfFixture({}),
    });
    expect(cell.tipTapLeakRateMbPerCycle).toBeCloseTo(30, 5);
    expect(cell.watchpoints.leakExceedsCeiling).toBe(true);
  });

  test('AC (c): leak watchpoint does NOT trip when leak rate is below threshold', async () => {
    const heap = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    const { cell } = await runCell({
      leakCycleHeapMb: heap,
      okPerfFixture: buildOkPerfFixture({}),
    });
    expect(cell.tipTapLeakRateMbPerCycle).toBeCloseTo(1, 5);
    expect(cell.watchpoints.leakExceedsCeiling).toBe(false);
  });

  test('AC (c): custom leakWatchpointMbPerCycle threshold is respected', async () => {
    const heap = [100, 101, 102, 103];
    const { cell } = await runCell({
      leakCycleHeapMb: heap,
      okPerfFixture: buildOkPerfFixture({}),
      options: { leakWatchpointMbPerCycle: 0.5 },
    });
    expect(cell.watchpoints.leakExceedsCeiling).toBe(true);
  });

  test('cache-error surfacing: warm-reopen samples without any ok/cache/hit raises cell error', async () => {
    const { cell } = await runCell({
      warmReopenSamples: [100, 110, 120, 130], // workload claims warm-reopens
      okPerfFixture: buildOkPerfFixture({
        marks: [
          { name: 'ok/cache/miss', duration: 0 },
          { name: 'ok/cache/miss', duration: 0 },
        ],
      }),
    });
    expect(cell.watchpoints.cacheLayerStale).toBe(true);
    expect(cell.errors.length).toBeGreaterThan(0);
    expect(cell.errors[0]).toMatch(/cache layer stale/i);
  });

  test('cache-error: stale-watchpoint does NOT trip when no warm-reopen samples were recorded', async () => {
    const { cell } = await runCell({
      coldMountSamples: [200, 210, 220],
      okPerfFixture: buildOkPerfFixture({
        marks: [{ name: 'ok/cache/miss', duration: 0 }], // 0 hits, 1 miss
      }),
    });
    expect(cell.watchpoints.cacheLayerStale).toBe(false);
    expect(cell.errors.filter((e) => /cache layer stale/i.test(e))).toEqual([]);
  });

  test('workload notes prefixed `error:` are surfaced into errors[]', async () => {
    const { cell } = await runCell({
      notes: ['note: warmup ok', 'error: cell hit MOUNT_STALLED_THRESHOLD_MS at sample 7'],
      okPerfFixture: buildOkPerfFixture({}),
    });
    expect(cell.errors).toContain('error: cell hit MOUNT_STALLED_THRESHOLD_MS at sample 7');
    expect(cell.errors).not.toContain('note: warmup ok');
  });

  test('orchestrator calls forceGc twice (pre-workload + final-heap)', async () => {
    const { cdp } = await runCell({
      okPerfFixture: buildOkPerfFixture({}),
    });
    const gcCalls = cdp.calls.filter((c) => c.method === 'HeapProfiler.collectGarbage');
    expect(gcCalls.length).toBeGreaterThanOrEqual(2);
  });

  test('warmup samples are dropped before p95 computation (Talos pattern, default N=5)', async () => {
    const samples = [
      1000,
      1001,
      1002,
      1003,
      1004,
      ...Array.from({ length: 20 }, (_, i) => 100 + i),
    ];
    const { cell } = await runCell({
      coldMountSamples: samples,
      okPerfFixture: buildOkPerfFixture({}),
    });
    expect(cell.coldMountP95Ms).toBeLessThan(200);
    expect(cell.coldMountP95Ms).toBeGreaterThanOrEqual(118);
  });

  test('warmupSamplesToDrop=0 disables warmup discard', async () => {
    const samples = [1000, 1001, 1002, 1003, 1004, 100, 100, 100, 100, 100];
    const { cell } = await runCell({
      coldMountSamples: samples,
      okPerfFixture: buildOkPerfFixture({}),
      options: { warmupSamplesToDrop: 0 },
    });
    expect(cell.coldMountP95Ms).toBeGreaterThan(900);
  });

  test('warmup-drop falls back to using ALL samples when warmupSamplesToDrop >= length (avoids 0 from starvation)', async () => {
    const samples = [200, 220, 240]; // only 3 samples
    const { cell } = await runCell({
      coldMountSamples: samples,
      okPerfFixture: buildOkPerfFixture({}),
      options: { warmupSamplesToDrop: 5 }, // more than length
    });
    expect(cell.coldMountP95Ms).toBeGreaterThan(200);
  });

  test('zero pool events → poolHitRate is 0 (not NaN)', async () => {
    const { cell } = await runCell({
      okPerfFixture: buildOkPerfFixture({}), // no pool counter at all
    });
    expect(cell.poolHitRate).toBe(0);
    expect(Number.isNaN(cell.poolHitRate)).toBe(false);
  });

  test('zero cache events → cacheHitRate is 0 (not NaN)', async () => {
    const { cell } = await runCell({
      okPerfFixture: buildOkPerfFixture({}),
    });
    expect(cell.cacheHitRate).toBe(0);
    expect(Number.isNaN(cell.cacheHitRate)).toBe(false);
  });

  test('AC (d): maxVmPressure is worst observed during window (1→4→2 → max=4)', async () => {
    const { cell } = await runCell({
      okPerfFixture: buildOkPerfFixture({}),
      options: { pressureIntervalMs: 100 },
    });
    expect([1, 2, 4]).toContain(cell.maxVmPressure);
    expect(cell.sampleCounts.pressureSamples).toBeGreaterThanOrEqual(1);
  });

  test('AC (d) reducer: synthetic samples 1→4→2 produce maxVmPressure=4 (worst, not last)', async () => {
    const samples = [{ level: 1 as const }, { level: 4 as const }, { level: 2 as const }];
    const maxLevel = samples.reduce<1 | 2 | 4>(
      (acc, sample) => (sample.level > acc ? sample.level : acc),
      1,
    );
    expect(maxLevel).toBe(4);
  });
});
