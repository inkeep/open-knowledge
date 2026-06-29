import type { CDPSession, Page } from '@playwright/test';
import type { CapRegime, WorkloadFixtureRef } from '../fixtures/cache-regime-rotation/types';
import { bcaConfidenceInterval } from './bootstrap';
import { type PressureLevel, samplePressureDuring } from './macos-pressure';

export type { CapRegime, WorkloadFixtureRef };

export type SampleAxis =
  | 'coldMount'
  | 'warmReopen'
  | 'tabSwitchWarmActivityFlip'
  | 'tabSwitchActivityHiddenToVisible';

export interface CellMeasurement {
  readonly capRegime: CapRegime;
  readonly fixture: WorkloadFixtureRef;
  readonly coldMountP95Ms: number;
  readonly warmReopenP95Ms: number;
  readonly tabSwitchWarmActivityFlipP95Ms: number;
  readonly tabSwitchActivityHiddenToVisibleP95Ms: number;
  readonly poolHitRate: number;
  readonly cacheHitRate: number;
  readonly rendererRssMb: number;
  readonly perFrameJankRate: number;
  readonly maxVmPressure: PressureLevel;
  readonly tipTapLeakRateMbPerCycle: number;
  readonly watchpoints: {
    readonly leakExceedsCeiling: boolean;
    readonly cacheLayerStale: boolean;
  };
  readonly errors: ReadonlyArray<string>;
  readonly capturedAt: string;
  readonly sampleCounts: {
    readonly coldMount: number;
    readonly warmReopen: number;
    readonly tabSwitchWarmActivityFlip: number;
    readonly tabSwitchActivityHiddenToVisible: number;
    readonly leakCycles: number;
    readonly pressureSamples: number;
  };
}

export interface MeasureCellOptions {
  readonly warmupSamplesToDrop?: number;
  readonly pressureIntervalMs?: number;
  readonly leakWatchpointMbPerCycle?: number;
  readonly jankFrameMs?: number;
}

export interface WorkloadDriver {
  recordColdMountSample(elapsedMs: number): void;
  recordWarmReopenSample(elapsedMs: number): void;
  recordTabSwitchWarmActivityFlipSample(elapsedMs: number): void;
  recordTabSwitchActivityHiddenToVisibleSample(elapsedMs: number): void;
  recordLeakCycleHeapMb(heapMb: number): void;
  note(line: string): void;
}

export interface MeasureCellInput {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly capRegime: CapRegime;
  readonly fixture: WorkloadFixtureRef;
  readonly options?: MeasureCellOptions;
  readonly workload: (driver: WorkloadDriver, page: Page, cdp: CDPSession) => Promise<void>;
}

export interface DrainedSubstrateSignals {
  readonly poolOpenHits: number;
  readonly poolOpenMisses: number;
  readonly cacheHitCount: number;
  readonly cacheMissCount: number;
  readonly perFrameJankRate: number;
}

export interface BootstrapConfidenceInterval {
  readonly axis: SampleAxis;
  readonly estimate: number;
  readonly lo: number;
  readonly hi: number;
  readonly sampleCount: number;
  readonly alpha: number;
  readonly iterations: number;
}

export interface BootstrapCiOptions {
  readonly alpha?: number;
  readonly iterations?: number;
  readonly random?: () => number;
}

export async function forceGc(cdp: CDPSession): Promise<void> {
  await cdp.send('HeapProfiler.collectGarbage');
  await new Promise((resolve) => setTimeout(resolve, 50));
}

export async function readHeapMb(page: Page): Promise<number> {
  const bytes = await page.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return m?.usedJSHeapSize ?? 0;
  });
  return bytes / (1024 * 1024);
}

export async function drainSubstrateSignals(
  page: Page,
  options?: { jankFrameMs?: number },
): Promise<DrainedSubstrateSignals> {
  const jankFrameMs = options?.jankFrameMs ?? 16.7;
  return await page.evaluate((threshold: number) => {
    interface PerfMarkShape {
      readonly name: string;
      readonly duration: number;
      readonly track?: string;
    }
    interface CollectorShape {
      readonly counters?: Record<
        string,
        { readonly byProp?: Record<string, Record<string, number>> }
      >;
      readonly marks?: {
        readonly toArray?: () => ReadonlyArray<PerfMarkShape>;
      };
    }
    const collector = (globalThis as unknown as { __ok_perf?: CollectorShape }).__ok_perf;
    if (!collector) {
      return {
        poolOpenHits: 0,
        poolOpenMisses: 0,
        cacheHitCount: 0,
        cacheMissCount: 0,
        perFrameJankRate: 0,
      };
    }

    const openCounter = collector.counters?.['ok/pool/open'];
    const poolOpenHits = Number(openCounter?.byProp?.hit?.true ?? 0);
    const poolOpenMisses = Number(openCounter?.byProp?.hit?.false ?? 0);

    const marks = collector.marks?.toArray?.() ?? [];
    let cacheHitCount = 0;
    let cacheMissCount = 0;
    let renderFrameCount = 0;
    let jankFrameCount = 0;
    for (const m of marks) {
      if (m.name === 'ok/cache/hit') {
        cacheHitCount += 1;
        continue;
      }
      if (m.name === 'ok/cache/miss') {
        cacheMissCount += 1;
        continue;
      }
      if (typeof m.name === 'string' && m.name.startsWith('ok/render/')) {
        renderFrameCount += 1;
        if (typeof m.duration === 'number' && m.duration > threshold) {
          jankFrameCount += 1;
        }
      }
    }
    const perFrameJankRate = renderFrameCount > 0 ? jankFrameCount / renderFrameCount : 0;

    return {
      poolOpenHits,
      poolOpenMisses,
      cacheHitCount,
      cacheMissCount,
      perFrameJankRate,
    };
  }, jankFrameMs);
}

export function computeLeakRateMbPerCycle(heapMbSamples: ReadonlyArray<number>): number {
  if (heapMbSamples.length < 2) return 0;
  const first = heapMbSamples[0] as number;
  const last = heapMbSamples[heapMbSamples.length - 1] as number;
  return (last - first) / (heapMbSamples.length - 1);
}

export function bootstrapCi(
  samples: ReadonlyArray<number>,
  axis: SampleAxis,
  options?: BootstrapCiOptions,
): BootstrapConfidenceInterval {
  const alpha = options?.alpha ?? 0.05;
  const iterations = options?.iterations ?? 2000;
  const random = options?.random ?? Math.random;

  if (samples.length === 0) {
    return {
      axis,
      estimate: 0,
      lo: 0,
      hi: 0,
      sampleCount: 0,
      alpha,
      iterations,
    };
  }

  const estimate = percentile(samples, 95);
  if (samples.length === 1) {
    return {
      axis,
      estimate,
      lo: estimate,
      hi: estimate,
      sampleCount: 1,
      alpha,
      iterations,
    };
  }

  const bca = bcaConfidenceInterval(samples, alpha / 2, {
    bootstrapCount: iterations,
    rng: random,
  });

  return {
    axis,
    estimate,
    lo: bca.lo,
    hi: bca.hi,
    sampleCount: samples.length,
    alpha,
    iterations,
  };
}

function percentile(samples: ReadonlyArray<number>, q: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] as number;
  const rank = (q / 100) * (sorted.length - 1);
  const lowerIdx = Math.floor(rank);
  const upperIdx = Math.ceil(rank);
  if (lowerIdx === upperIdx) return sorted[lowerIdx] as number;
  const fraction = rank - lowerIdx;
  const lower = sorted[lowerIdx] as number;
  const upper = sorted[upperIdx] as number;
  return lower + (upper - lower) * fraction;
}

export async function measureCell(input: MeasureCellInput): Promise<CellMeasurement> {
  const { page, cdp, capRegime, fixture, workload } = input;
  const options = input.options ?? {};
  const warmupSamplesToDrop = options.warmupSamplesToDrop ?? 5;
  const pressureIntervalMs = options.pressureIntervalMs ?? 1000;
  const leakWatchpointMbPerCycle = options.leakWatchpointMbPerCycle ?? 25;
  const jankFrameMs = options.jankFrameMs ?? 16.7;

  const coldMountSamples: number[] = [];
  const warmReopenSamples: number[] = [];
  const tabSwitchFlipSamples: number[] = [];
  const tabSwitchReMountSamples: number[] = [];
  const leakCycleHeapSamples: number[] = [];
  const notes: string[] = [];

  const driver: WorkloadDriver = {
    recordColdMountSample(elapsedMs: number) {
      if (Number.isFinite(elapsedMs)) coldMountSamples.push(elapsedMs);
    },
    recordWarmReopenSample(elapsedMs: number) {
      if (Number.isFinite(elapsedMs)) warmReopenSamples.push(elapsedMs);
    },
    recordTabSwitchWarmActivityFlipSample(elapsedMs: number) {
      if (Number.isFinite(elapsedMs)) tabSwitchFlipSamples.push(elapsedMs);
    },
    recordTabSwitchActivityHiddenToVisibleSample(elapsedMs: number) {
      if (Number.isFinite(elapsedMs)) tabSwitchReMountSamples.push(elapsedMs);
    },
    recordLeakCycleHeapMb(heapMb: number) {
      if (Number.isFinite(heapMb)) leakCycleHeapSamples.push(heapMb);
    },
    note(line: string) {
      notes.push(line);
    },
  };

  await forceGc(cdp);

  const pressureWindow = await samplePressureDuring(
    { intervalMs: pressureIntervalMs },
    async () => {
      await workload(driver, page, cdp);
    },
  );

  const drained = await drainSubstrateSignals(page, { jankFrameMs });

  const coldMountP95Ms = percentile(dropWarmup(coldMountSamples, warmupSamplesToDrop), 95);
  const warmReopenP95Ms = percentile(dropWarmup(warmReopenSamples, warmupSamplesToDrop), 95);
  const tabSwitchWarmActivityFlipP95Ms = percentile(
    dropWarmup(tabSwitchFlipSamples, warmupSamplesToDrop),
    95,
  );
  const tabSwitchActivityHiddenToVisibleP95Ms = percentile(
    dropWarmup(tabSwitchReMountSamples, warmupSamplesToDrop),
    95,
  );

  const totalPoolEvents = drained.poolOpenHits + drained.poolOpenMisses;
  const poolHitRate = totalPoolEvents > 0 ? drained.poolOpenHits / totalPoolEvents : 0;
  const totalCacheEvents = drained.cacheHitCount + drained.cacheMissCount;
  const cacheHitRate = totalCacheEvents > 0 ? drained.cacheHitCount / totalCacheEvents : 0;

  const tipTapLeakRateMbPerCycle = computeLeakRateMbPerCycle(leakCycleHeapSamples);

  await forceGc(cdp);
  const rendererRssMb = await readHeapMb(page);

  const cacheLayerStale = warmReopenSamples.length > 0 && drained.cacheHitCount === 0;
  const leakExceedsCeiling = tipTapLeakRateMbPerCycle > leakWatchpointMbPerCycle;

  const errors: string[] = [];
  for (const line of notes) {
    if (line.startsWith('error:')) errors.push(line);
  }
  if (cacheLayerStale) {
    errors.push(
      'error: cache layer stale — warm-reopen samples were recorded but ok/cache/hit count is zero (silent cache-layer regression?)',
    );
  }

  return {
    capRegime,
    fixture,
    coldMountP95Ms,
    warmReopenP95Ms,
    tabSwitchWarmActivityFlipP95Ms,
    tabSwitchActivityHiddenToVisibleP95Ms,
    poolHitRate,
    cacheHitRate,
    rendererRssMb,
    perFrameJankRate: drained.perFrameJankRate,
    maxVmPressure: pressureWindow.maxLevel,
    tipTapLeakRateMbPerCycle,
    watchpoints: {
      leakExceedsCeiling,
      cacheLayerStale,
    },
    errors,
    capturedAt: new Date().toISOString(),
    sampleCounts: {
      coldMount: coldMountSamples.length,
      warmReopen: warmReopenSamples.length,
      tabSwitchWarmActivityFlip: tabSwitchFlipSamples.length,
      tabSwitchActivityHiddenToVisible: tabSwitchReMountSamples.length,
      leakCycles: leakCycleHeapSamples.length,
      pressureSamples: pressureWindow.samples.length,
    },
  };
}

function dropWarmup<T>(samples: ReadonlyArray<T>, n: number): T[] {
  if (n <= 0) return [...samples];
  if (n >= samples.length) return [...samples];
  return samples.slice(n);
}
