/**
 * Composite per-cell measurement library for the cap-graduation sweep harness.
 *
 * A sweep cell exercises one cap-regime (MAX_POOL, MAX_CACHE, ACTIVITY_MOUNT_LIMIT)
 * against one workload fixture. The verdict for that cell is **composite** — it
 * sits across three structurally different signal axes (memory ceiling, server
 * amplification, UX) that must each be observed simultaneously. This module
 * owns the renderer-side half of that composite: heap, pressure, jank,
 * substrate hit/miss counters, and leak-rate. The server half (Hocuspocus
 * `process.memoryUsage()`) is captured separately and folded in by the
 * sweep runner.
 *
 * Key contracts:
 *
 *   - **cache-hit observability lives in the cache layer.** `ok/cache/hit`
 *     (editor-cache.ts) is the source of truth — fired from the cache layer
 *     itself at admission-decision time. The drain counts only that mark
 *     toward `cacheHitCount`; substrate marks from other namespaces do not
 *     contribute to the cache-hit rate even when correlated by `mountId`.
 *     The cache-layer-stale watchpoint trips on warm-reopen samples paired
 *     with zero `ok/cache/hit` traffic, catching the silent-regression case
 *     where the cache layer is bypassed entirely. (Mount-substrate-vs-cache-layer
 *     divergence is detectable by `mountId` correlation across namespaces;
 *     redundant per-namespace re-emission is unnecessary.)
 *
 *   - **Leak watchpoint is configurable but defaults to 25 MB/cycle.** The
 *     baseline measured 17 MB/cycle for PROJECT-class editors; the
 *     watchpoint at >25 catches regressions while accommodating measurement
 *     variance. The watchpoint is informational — it does NOT abort the cell.
 *
 *   - **Pressure is worst-case-during-window.** A cell that spent 9 seconds
 *     at NORMAL and 100ms at CRITICAL counts as CRITICAL — the spike is the
 *     load-bearing observation. `samplePressureDuring` from the macos-pressure
 *     module captures the reducer; this orchestrator just feeds the workload
 *     through it.
 *
 *   - **The orchestrator does not know the workload.** Cold mounts, warm
 *     reopens, tab switches, and leak cycles are all driven by the caller
 *     (sweep runner). This module receives latency samples + heap-cycle
 *     observations via a `WorkloadDriver` callback and orchestrates the
 *     surrounding GC + pressure + substrate-drain steps. This decoupling is
 *     what makes the library unit-testable without a live dev server.
 *
 * Architectural provenance:
 *   - `forceGc` and `readHeapMb` are direct extracts from
 *     `memory-per-editor.ts` (the per-editor retained-memory probe).
 *     They have lived as private helpers in that scenario; this
 *     module promotes them to shared substrate.
 *   - The drain pattern follows `sweep-pool-warm-back-canary.ts`:
 *     read `globalThis.__ok_perf` via `page.evaluate`, walk the counters
 *     and the marks ring, and synthesize per-cell summary numbers.
 *   - Pressure sampling routes through `samplePressureDuring` from
 *     `macos-pressure.ts` (sibling perf-lib primitive).
 */

import type { CDPSession, Page } from '@playwright/test';
import type { CapRegime, WorkloadFixtureRef } from '../fixtures/cache-regime-rotation/types';
import { bcaConfidenceInterval } from './bootstrap';
import { type PressureLevel, samplePressureDuring } from './macos-pressure';

// Re-export the canonical types so existing consumers (downstream sweep
// runner, sweep scenario, tests) continue to compile against the prior
// import surface. Adding new coupled caps or fixture refs lands in
// `../fixtures/cache-regime-rotation/types.ts` — a single edit picks up
// here and in `./sweep-runner.ts` automatically.
export type { CapRegime, WorkloadFixtureRef };

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

/**
 * Latency-sample axis identifier. The five UX sub-axes per the
 * verdict criteria are distinct because tab-switch splits into two paths
 * (paint-only Activity flip vs Activity-hidden→visible re-mount) per the
 * Electron-stack physics ceiling — and a cell can earn different verdicts
 * on each. p95s are computed per axis; bootstrap CIs are computed per axis.
 */
export type SampleAxis =
  | 'coldMount'
  | 'warmReopen'
  | 'tabSwitchWarmActivityFlip'
  | 'tabSwitchActivityHiddenToVisible';

/**
 * The cell's composite measurement. Every field is populated — pressure
 * defaults to 1 (NORMAL) on non-macOS hosts so the shape stays uniform,
 * rates default to 0 when their denominators are zero (e.g. a cell with
 * zero pool-open events), and percentile fields default to 0 when no
 * samples were recorded for that axis. Callers consume `watchpoints` and
 * `errors` to distinguish "0 means no traffic" from "0 means broken
 * instrumentation."
 */
export interface CellMeasurement {
  readonly capRegime: CapRegime;
  readonly fixture: WorkloadFixtureRef;
  // UX axes — p95 per the verdict thresholds.
  readonly coldMountP95Ms: number;
  readonly warmReopenP95Ms: number;
  readonly tabSwitchWarmActivityFlipP95Ms: number;
  readonly tabSwitchActivityHiddenToVisibleP95Ms: number;
  // Substrate-derived rates.
  /** ok/pool/open `hit:true` / (hit:true + hit:false). Range [0,1]. 0 when no events. */
  readonly poolHitRate: number;
  /** ok/cache/hit count / (ok/cache/hit + ok/cache/miss). Cache-layer mark only. */
  readonly cacheHitRate: number;
  // Memory-ceiling axis (renderer side).
  /** performance.memory.usedJSHeapSize captured after a final GC at cell end. */
  readonly rendererRssMb: number;
  /** Fraction of frames in the window whose duration exceeded `jankFrameMs`. */
  readonly perFrameJankRate: number;
  /** Worst-case macOS vm_pressure level observed during the cell window. */
  readonly maxVmPressure: PressureLevel;
  /** Mean MB/cycle delta across the leak loop. Baseline ≈ 17 MB/cycle. */
  readonly tipTapLeakRateMbPerCycle: number;
  // Watchpoints + errors — observability into "silent" regression modes.
  readonly watchpoints: {
    /** tipTapLeakRateMbPerCycle exceeded the leakWatchpointMbPerCycle threshold. */
    readonly leakExceedsCeiling: boolean;
    /** Warm-reopen samples were recorded but ok/cache/hit count was zero. */
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
  /**
   * Drop the first N samples per axis before computing p95. Mirrors Mozilla
   * Talos' warmup-discard pattern: early samples are biased by JIT warmup,
   * page-load animation, and one-time GC; the steady-state p95 is what the
   * cell's UX verdict actually depends on.
   */
  readonly warmupSamplesToDrop?: number;
  /** Polling cadence for vm_pressure sampling during the workload window. */
  readonly pressureIntervalMs?: number;
  /**
   * MB/cycle threshold above which `watchpoints.leakExceedsCeiling` trips.
   * Default 25: the PROJECT baseline measured 17 MB/cycle; 25 catches
   * regressions while accommodating measurement variance.
   */
  readonly leakWatchpointMbPerCycle?: number;
  /**
   * Frame-duration threshold (ms) at which a frame counts as janky. Default
   * 16.7 (60 fps). Substrate marks under `ok/render/*` whose `duration`
   * exceeds this count toward `perFrameJankRate`.
   */
  readonly jankFrameMs?: number;
}

/**
 * Recording surface the workload uses to feed measureCell. The orchestrator
 * controls the surrounding GC + pressure + drain; the workload controls the
 * actual navigation + cache exercise that produces samples.
 */
export interface WorkloadDriver {
  recordColdMountSample(elapsedMs: number): void;
  recordWarmReopenSample(elapsedMs: number): void;
  recordTabSwitchWarmActivityFlipSample(elapsedMs: number): void;
  recordTabSwitchActivityHiddenToVisibleSample(elapsedMs: number): void;
  /**
   * Push one observation from the leak-cycle loop. Caller should call this
   * AFTER `forceGc` so the value reflects retained heap, not allocation
   * peak.
   */
  recordLeakCycleHeapMb(heapMb: number): void;
  /** Free-form note. Strings prefixed `error:` are also surfaced in errors[]. */
  note(line: string): void;
}

export interface MeasureCellInput {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly capRegime: CapRegime;
  readonly fixture: WorkloadFixtureRef;
  readonly options?: MeasureCellOptions;
  /**
   * The cell program. Drives navigation; pushes latency + heap-cycle samples
   * into the driver. cell-measurement orchestrates GC, pressure sampling,
   * and substrate drain around this callback.
   */
  readonly workload: (driver: WorkloadDriver, page: Page, cdp: CDPSession) => Promise<void>;
}

export interface DrainedSubstrateSignals {
  readonly poolOpenHits: number;
  readonly poolOpenMisses: number;
  /** Marks named `ok/cache/hit` ONLY — the cache-layer mark is the source of truth. */
  readonly cacheHitCount: number;
  readonly cacheMissCount: number;
  readonly perFrameJankRate: number;
}

export interface BootstrapConfidenceInterval {
  readonly axis: SampleAxis;
  /**
   * Point estimate — p95 of the input samples after warmup drop. This is
   * the verdict statistic (per the verdict criteria); the [lo, hi] BCa
   * bracket below is the BCa CI on the arithmetic mean of the same
   * samples (BCa applies cleanly to smooth statistics; for the order
   * statistic p95 the percentile bootstrap is appropriate but BCa-on-p95
   * needs a different acceleration term — out of scope here).
   */
  readonly estimate: number;
  /** Lower BCa CI bound (on the bootstrap mean of input samples). */
  readonly lo: number;
  /** Upper BCa CI bound (on the bootstrap mean of input samples). */
  readonly hi: number;
  readonly sampleCount: number;
  /**
   * Alpha used to compute lo/hi (two-sided). e.g. 0.05 → 95% CI ([2.5%, 97.5%]).
   */
  readonly alpha: number;
  /** Number of bootstrap resamples drawn. */
  readonly iterations: number;
}

export interface BootstrapCiOptions {
  /** Two-sided alpha. Default 0.05 → 95% CI. */
  readonly alpha?: number;
  /** Number of bootstrap resamples. Default 2000. */
  readonly iterations?: number;
  /**
   * Optional deterministic random source (for tests). Returns a uniform
   * float in [0, 1). Defaults to `Math.random`.
   */
  readonly random?: () => number;
}

// ─────────────────────────────────────────────────────────────────────────
// Primitives — extracted from memory-per-editor.ts
// ─────────────────────────────────────────────────────────────────────────

/**
 * Trigger CDP's HeapProfiler.collectGarbage and wait briefly so any
 * post-GC scheduled work (finalizers, microtask drains) can settle before
 * the caller reads heap.
 *
 * Why the 50ms tail wait: collectGarbage returns when the GC completes,
 * but V8 schedules some post-GC bookkeeping (e.g. weak-ref finalizers,
 * IncrementalMarking::Stop callbacks) into the microtask queue. Without
 * the settle, a subsequent readHeapMb can observe still-decaying state.
 * 50ms is empirically sufficient and matches the memory-per-editor.ts
 * provenance.
 */
export async function forceGc(cdp: CDPSession): Promise<void> {
  await cdp.send('HeapProfiler.collectGarbage');
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Read the current renderer JS-heap size via `performance.memory.usedJSHeapSize`.
 *
 * `performance.memory` is a Chromium-specific extension exposed when the
 * renderer is launched with `--enable-precise-memory-info`. It's a coarse
 * but stable signal — sufficient for cap-regime sweeps where the question
 * is "did this cell cross the budget" not "what's the millibyte breakdown."
 *
 * Returns 0 if the API is unavailable (non-Chromium browser, flag missing).
 * Callers that need to distinguish "0 means small heap" from "0 means API
 * absent" should layer their own probe; for cap-regime cells, the API is
 * always available on the canonical Playwright Chromium build.
 */
export async function readHeapMb(page: Page): Promise<number> {
  const bytes = await page.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return m?.usedJSHeapSize ?? 0;
  });
  return bytes / (1024 * 1024);
}

// ─────────────────────────────────────────────────────────────────────────
// Substrate drain
// ─────────────────────────────────────────────────────────────────────────

/**
 * Drain composite-rate signals from the page's `globalThis.__ok_perf`
 * collector.
 *
 * Reads counters at `ok/pool/open` (hit/miss subcounters), counts marks
 * named exactly `ok/cache/hit` and `ok/cache/miss`, and computes a
 * per-frame jank rate from marks under the `ok/render/*` namespace whose
 * `duration` exceeds the jank-frame threshold.
 *
 * Returns zeros across the board if `__ok_perf` is absent (production
 * build, or a renderer whose collector hasn't been instantiated). Callers
 * distinguish "no traffic" from "no collector" via their own checks
 * (e.g. measureCell raises `cacheLayerStale` when warm-reopen samples are
 * recorded but `cacheHitCount` is zero).
 *
 * Why ok/cache/hit ONLY: the cache layer is the source of truth for
 * cache-hit observability — fired from `editor-cache.ts` at admission-
 * decision time. Marks from other substrate namespaces correlate to the
 * same logical event via `mountId`; counting them toward `cacheHitCount`
 * would double-count. Divergence detection between cache-layer and
 * mount-substrate events is captured by `mountId` correlation across
 * namespaces, not by per-namespace re-emission.
 */
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
      // Other substrate marks (mount-substrate, render-substrate) are NOT
      // counted toward cacheHitCount — the cache-layer mark above is the
      // sole source of truth. See JSDoc for the mountId correlation.
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

// ─────────────────────────────────────────────────────────────────────────
// Leak rate
// ─────────────────────────────────────────────────────────────────────────

/**
 * Compute the mean MB/cycle leak rate from a heap-MB sequence taken at
 * cycle boundaries (post-GC).
 *
 * Formula: `(last - first) / (N - 1)` — total drift divided by the
 * interval count between N post-cycle samples. Returns 0 for sequences
 * shorter than two cycles (no slope is computable).
 *
 * The sibling probe in `tests/perf/probes/tiptap-destroy-leak.ts` uses
 * the same formula so leak rates emitted by either path are directly
 * comparable across campaigns. (An earlier draft of memory-per-editor.ts
 * divided by N instead of N-1; that under-reports by ~10% at N=10 and
 * isn't the convention this library follows.)
 *
 * Why mean drift and not regression slope: the leak shape per TipTap
 * issues #5654/#538 is approximately linear over the first ~10 cycles;
 * a least-squares slope would gate on noise dominance. The 2-point mean
 * is robust to single-sample outliers and keeps comparability across
 * campaigns.
 */
export function computeLeakRateMbPerCycle(heapMbSamples: ReadonlyArray<number>): number {
  if (heapMbSamples.length < 2) return 0;
  const first = heapMbSamples[0] as number;
  const last = heapMbSamples[heapMbSamples.length - 1] as number;
  return (last - first) / (heapMbSamples.length - 1);
}

// ─────────────────────────────────────────────────────────────────────────
// Bootstrap CI (percentile bootstrap for p95)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Percentile-bootstrap confidence interval for the p95 of a sample array.
 *
 * Algorithm (Efron 1979 percentile bootstrap):
 *   1. Compute the point estimate: p95 of the input samples (linear
 *      interpolation between order statistics).
 *   2. Resample N times with replacement (default 2000 iterations).
 *   3. Compute the p95 of each resample → bootstrap distribution.
 *   4. Return the BCa-corrected [alpha/2, 1 - alpha/2] quantiles of that
 *      distribution as the CI bounds — bias correction + jackknife
 *      acceleration (Mozilla Talos pattern, arXiv 2511.19794 2025).
 *
 * The CI is BCa-corrected (computed by `bcaConfidenceInterval` in
 * `./bootstrap.ts`). The arithmetic mean is the bootstrap statistic
 * (BCa's jackknife acceleration is well-defined for smooth statistics
 * like the mean; order-statistic acceleration for p95 directly is
 * non-trivial and not in scope for cell-internal CIs). The `estimate`
 * field reports the p95 of the raw samples — that's the metric a
 * reviewer cares about when reading a verdict — but the [lo, hi] bracket
 * is derived from BCa-on-mean, the algorithm the spec specifies. Future
 * harnesses requiring p95 confidence bounds directly can swap to a
 * BCa-on-p95 variant in `./bootstrap.ts` without touching the wrapper.
 *
 * Returns `{ estimate: 0, lo: 0, hi: 0 }` for empty input. For single
 * samples, the CI collapses to the point estimate (lo === hi === estimate).
 */
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

  // BCa CI bracket from the substrate primitive in ./bootstrap.ts. The
  // BCa entry takes per-tail alpha; cell-measurement's `alpha` semantic is
  // the same convention (alpha=0.05 → 95% CI → 0.025 per tail).
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

/**
 * Compute the q-th percentile (q ∈ [0, 100]) of a sample array via linear
 * interpolation between order statistics (NumPy "linear" method). Returns
 * 0 for empty input.
 */
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

// ─────────────────────────────────────────────────────────────────────────
// measureCell — the orchestrator
// ─────────────────────────────────────────────────────────────────────────

/**
 * Drive one sweep cell through its workload program and capture the
 * composite measurement vector.
 *
 * Orchestration sequence:
 *   1. Force GC (drops carry-over state from any previous cell).
 *   2. Open pressure-sampling window via samplePressureDuring (1 Hz).
 *   3. Hand control to the workload callback, which navigates the page
 *      and pushes latency + heap-cycle samples into the driver.
 *   4. Close pressure window; record maxVmPressure.
 *   5. Drain `__ok_perf` for pool / cache / jank rates.
 *   6. Compute p95 per UX axis (after dropping warmup samples).
 *   7. Compute leak rate from heap-cycle observations.
 *   8. Force GC + read final heap → rendererRssMb.
 *   9. Stamp watchpoints + errors → return CellMeasurement.
 *
 * The orchestrator does NOT abort on workload error — exceptions thrown
 * by the workload propagate to the caller. Per-cell errors that the
 * workload wants to surface without aborting should be recorded via
 * `driver.note('error: ...')`; the orchestrator collects `error:`-prefixed
 * notes into the returned `errors[]`. This mirrors the sweep harness's
 * "per-cell errors don't abort sweep" semantics (define-sweep.ts).
 */
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

/**
 * Drop the first N entries from a sample array. Returns the original array
 * unchanged when N >= length so the warmup-discard never starves the
 * percentile of all input — a degraded p95 from raw samples is more
 * informative than a 0.
 */
function dropWarmup<T>(samples: ReadonlyArray<T>, n: number): T[] {
  if (n <= 0) return [...samples];
  if (n >= samples.length) return [...samples];
  return samples.slice(n);
}
