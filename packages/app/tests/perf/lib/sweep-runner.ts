/**
 * 4-stage per-cap sweep runner for the cap-graduation campaign.
 *
 * The runner orchestrates the campaign that graduates MAX_POOL, MAX_CACHE,
 * and ACTIVITY_MOUNT_LIMIT from convention-derived (10/10/3) to empirically
 * defended values. Per-cap with cap-ordering — sequential MAX_POOL →
 * MAX_CACHE → ACTIVITY axes with prior-stage winners pinned, plus a final
 * boundary-class probe stage to verify silent-skip patterns don't recur at
 * deliberately-misaligned cap-vectors. Cheaper than a 3-D Cartesian sweep
 * (22 vs 108 cells/fixture) while preserving correctness coverage via the
 * boundary probes.
 *
 * Design architecture:
 *
 *   1. **The runner does not run cells itself.** It takes a `runCell`
 *      injection — Playwright + CDP + measureCell in production, a
 *      synthetic stand-in in unit tests. The runner owns stage ordering,
 *      cell construction, checkpointing, error containment, and
 *      aggregation. Decoupling cell mechanics from orchestration is what
 *      lets the runner be unit-testable without a live dev server.
 *
 *   2. **Each stage independently checkpoints via `withCheckpoint`.** A
 *      mid-sweep crash at hour 14 of 16 resumes from the last completed
 *      cell, NOT from input zero. Stages are sequential (winners pin
 *      forward) so each stage's checkpoint is its own file — Stage 2
 *      can't begin until Stage 1's winner is known.
 *
 *   3. **Per-cell errors do not abort the sweep.** A throwing `runCell`
 *      gets wrapped into a synthesized FAIL cell with `errors[]`
 *      populated; the campaign continues. The MOUNT_STALLED_THRESHOLD_MS
 *      timeout is implemented as an AbortSignal passed to `runCell` —
 *      production cells listen to it via CDP; unit-test cells can
 *      simulate by checking `signal.aborted`. If the signal fires before
 *      `runCell` resolves, the cell is recorded as FAIL: stuck-mount.
 *
 *   4. **The baseline cell is per-fixture and MEDIUM-cap.** A MAX_POOL=14
 *      MAX_CACHE=14 ACTIVITY=3 cell on the canonical 16 GB+ MacBook host
 *      measures the architectural floor without confounding from
 *      memory-pressure-induced latency that a higher cap regime would
 *      trip. Downstream cells are tagged `arch-bounded` (matching or
 *      better than floor) vs `cap-bounded` (worse than floor by more
 *      than tolerance) against this measurement.
 *
 *   5. **Aggregation is parallel-N-ready from day one.** `aggregateCampaign`
 *      accepts `SweepCellResult[]` from any number of producing
 *      machines — v1 ships N=1 but the contract doesn't constrain that.
 *      Future cap-tuning campaigns can shard cells across machines and
 *      feed them through the same aggregator.
 *
 * Verdict criteria:
 *
 *   - UX axes (latency p95): cold-mount, warm-reopen, tab-switch warm-flip
 *     (paint-only), tab-switch hidden→visible (re-mount; Electron-stack
 *     physics ceiling).
 *
 *   - Jank rate as the 5th UX axis (per-frame, percent).
 *
 *   - Memory-ceiling axis: renderer RSS + macOS vm_pressure; cell hits
 *     ceiling when either trips.
 *
 *   - Server-amplification axis: Hocuspocus process.memoryUsage(); scales
 *     with MAX_POOL and is invisible to the renderer.
 *
 *   - Cell classification: CHAMPION (all 5 UX Excellent + memory PASS +
 *     server PASS) → WIN (Good + ≥1 Excellent + memory/server PASS-or-WARN)
 *     → PASS (all Acceptable + memory/server PASS-or-WARN) → FAIL (any
 *     UX axis Poor OR memory FAIL OR server FAIL).
 */

import type { CapRegime, WorkloadFixtureRef } from '../fixtures/cache-regime-rotation/types';
import { findKnee } from './kneedle';
import { withCheckpoint } from './with-checkpoint';

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

// `CapRegime` and `WorkloadFixtureRef` are re-exported from the canonical
// types module so both the runner (orchestration) and the cell-measurement
// library (instrumentation) share a single source of truth. Adding new
// coupled caps lands in one place.
export type { CapRegime, WorkloadFixtureRef };

export interface HostClassFingerprint {
  readonly cpuModel: string;
  readonly totalRamGb: number;
  readonly osVersion: string;
  /** Canonical short identifier (e.g. "16gb-macbook-m1"). */
  readonly identifier: string;
}

export type SweepStage = 1 | 2 | 3 | 4;

export interface SweepCellInput {
  readonly capRegime: CapRegime;
  readonly workloadFixture: WorkloadFixtureRef;
  readonly hostClass: HostClassFingerprint;
  readonly cellIndex: number;
  readonly stage: SweepStage;
  readonly isBaseline: boolean;
}

export interface VerdictMeasurement {
  readonly coldMountP95Ms: number;
  readonly warmReopenP95Ms: number;
  readonly tabSwitchWarmActivityFlipP95Ms: number;
  readonly tabSwitchActivityHiddenToVisibleP95Ms: number;
  readonly poolHitRate: number;
  readonly cacheHitRate: number;
  readonly rendererRssMb: number;
  readonly serverMemMb: number;
  readonly perFrameJankRate: number;
  readonly maxVmPressure: 1 | 2 | 4;
  readonly tipTapLeakRateMbPerCycle: number;
}

export type UxAxisClass = 'Excellent' | 'Good' | 'Acceptable' | 'Poor';
export type ResourceVerdictClass = 'PASS' | 'WARN' | 'FAIL';

export interface SweepCellVerdict {
  readonly classification: 'CHAMPION' | 'WIN' | 'PASS' | 'FAIL';
  readonly archBound: 'arch-bounded' | 'cap-bounded';
  readonly memoryCeilingVerdict: ResourceVerdictClass;
  readonly serverAmplificationVerdict: ResourceVerdictClass;
  readonly trippedChannels: ReadonlyArray<'rss' | 'pressure' | 'server-mem'>;
  readonly axisVerdicts: {
    readonly coldMount: UxAxisClass;
    readonly warmReopen: UxAxisClass;
    readonly tabSwitchWarmActivityFlip: UxAxisClass;
    readonly tabSwitchActivityHiddenToVisible: UxAxisClass;
    readonly jankRate: UxAxisClass;
  };
}

export interface BootstrapConfidenceInterval {
  readonly lo: number;
  readonly hi: number;
  readonly estimate: number;
}

export interface CellError {
  readonly kind: 'stuck-mount' | 'thrown' | 'aborted';
  readonly message: string;
  readonly capturedAt: string;
}

export interface SweepCellResult {
  readonly cellInput: SweepCellInput;
  readonly measurement: VerdictMeasurement;
  readonly verdict: SweepCellVerdict;
  readonly bootstrapCi: BootstrapConfidenceInterval;
  readonly errors: ReadonlyArray<CellError>;
  readonly durationMs: number;
  readonly replicationSampleCount: number;
}

export interface BaselineCellResult {
  readonly fixture: WorkloadFixtureRef;
  readonly architecturalFloor: {
    readonly coldMountP95Ms: number;
    readonly warmReopenP95Ms: number;
    readonly tabSwitchWarmActivityFlipP95Ms: number;
    readonly tabSwitchActivityHiddenToVisibleP95Ms: number;
    readonly jankRatePct: number;
  };
  readonly capRegimeUsed: CapRegime;
  readonly capturedAt: string;
  readonly hostFingerprint: HostClassFingerprint;
}

export interface CampaignVerdict {
  readonly winningCapRegime: CapRegime;
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  readonly axisCoverage: ReadonlyMap<WorkloadFixtureRef, ReadonlyArray<SweepCellResult>>;
  readonly archFloors: ReadonlyMap<WorkloadFixtureRef, BaselineCellResult>;
  readonly winnersPerFixture: ReadonlyMap<WorkloadFixtureRef, CapRegime>;
  readonly verdictPerConstantMd: string;
  /**
   * Total count of cells with `errors[].length > 0` — surfaced so an
   * engineer reviewing the verdict can spot infrastructure flake (e.g.
   * Playwright cell timeouts contaminating measurement). Error cells are
   * excluded from kneedle winner detection so they don't bias the knee.
   */
  readonly erroredCellCount: number;
}

export interface VerdictCriteria {
  readonly ux: {
    readonly coldMountMs: { excellent: number; good: number; acceptable: number };
    readonly warmReopenMs: { excellent: number; good: number; acceptable: number };
    readonly tabSwitchWarmActivityFlipMs: { excellent: number; good: number; acceptable: number };
    readonly tabSwitchActivityHiddenToVisibleMs: {
      excellent: number;
      good: number;
      acceptable: number;
    };
    readonly perFrameJankRatePct: { excellent: number; good: number; acceptable: number };
  };
  readonly memoryCeiling: {
    readonly rendererRssWarnMb: number;
    readonly rendererRssBudgetMb: number;
    readonly pressureFailLevel: 2 | 4;
  };
  readonly serverAmplification: {
    readonly serverMemWarnMb: number;
    readonly serverMemBudgetMb: number;
  };
  /**
   * Arch-bounded tolerance: a cell within this multiplier of the per-axis
   * floor counts as "matching or exceeding" the floor (arch-bounded).
   * Default 1.10 — 10% tolerance accommodates replication noise without
   * masking real cap-induced regressions.
   */
  readonly archBoundedTolerance: number;
}

/**
 * Default verdict criteria for the canonical 16 GB+ MacBook host class.
 * Thresholds anchor in convergent HCI literature (Nielsen / Doherty /
 * Card+Moran+Newell) and Linear's published numbers as the architectural
 * peer. Tab-switch is split into two paths per Electron-stack physics —
 * warm-flip (paint-only, no DOM rebuild) and Activity hidden→visible
 * (re-mount; bound by Electron compositor cost).
 */
export const DEFAULT_VERDICT_CRITERIA_16GB_MACBOOK: VerdictCriteria = {
  ux: {
    coldMountMs: { excellent: 500, good: 1000, acceptable: 2500 },
    warmReopenMs: { excellent: 100, good: 200, acceptable: 400 },
    tabSwitchWarmActivityFlipMs: { excellent: 50, good: 100, acceptable: 200 },
    tabSwitchActivityHiddenToVisibleMs: { excellent: 120, good: 200, acceptable: 400 },
    perFrameJankRatePct: { excellent: 1, good: 3, acceptable: 5 },
  },
  memoryCeiling: {
    rendererRssWarnMb: 1500,
    rendererRssBudgetMb: 2000,
    pressureFailLevel: 2,
  },
  serverAmplification: {
    serverMemWarnMb: 1000,
    serverMemBudgetMb: 1500,
  },
  archBoundedTolerance: 1.1,
};

/** Stage 1 MAX_POOL axis. */
export const CAP_AXIS_MAX_POOL = [5, 10, 14, 20, 30, 50] as const;
/** Stage 2 MAX_CACHE axis. */
export const CAP_AXIS_MAX_CACHE = [5, 10, 14, 20, 30, 50] as const;
/** Stage 3 ACTIVITY_MOUNT_LIMIT axis. Floor=1 safe. */
export const CAP_AXIS_ACTIVITY = [1, 3, 5, 8] as const;

/**
 * MEDIUM cap-regime baseline cell — measures architectural floor without
 * memory-pressure confounding. NOT the highest cap; the highest cap is
 * most likely to TRIP the composite memory-ceiling signal, contaminating
 * the floor measurement.
 */
export const BASELINE_CAP_REGIME: CapRegime = {
  maxPool: 14,
  maxCache: 14,
  activityMountLimit: 3,
};

/**
 * Stage 4 boundary-class probes — deliberately-misaligned cap-vectors
 * that exercise the silent-skip failure mode:
 *   - MAX_POOL > MAX_CACHE: pool-warm docs miss V2 cache, pay editor
 *     reconstruction cost (loss of cache layer).
 *   - MAX_CACHE > MAX_POOL: orphan cache hits (cached editor with no
 *     warm provider; reconstruction cost masked at the cache layer).
 *   - ACTIVITY > MAX_CACHE: Activity-mounted editors without cache
 *     backing (V2 cache evicts before Activity demotion completes).
 */
export const BOUNDARY_PROBES: ReadonlyArray<CapRegime> = [
  { maxPool: 30, maxCache: 10, activityMountLimit: 3 },
  { maxPool: 50, maxCache: 5, activityMountLimit: 3 },
  { maxPool: 10, maxCache: 30, activityMountLimit: 3 },
  { maxPool: 5, maxCache: 50, activityMountLimit: 3 },
  { maxPool: 10, maxCache: 5, activityMountLimit: 8 },
  { maxPool: 14, maxCache: 3, activityMountLimit: 8 },
];

/** Default mount-stalled abort threshold (ms). */
export const DEFAULT_MOUNT_STALLED_MS = 30_000;

/**
 * Cell-execution callback. The runner passes a `SweepCellInput` and an
 * AbortSignal that fires when the mount-stalled threshold elapses. The
 * implementation drives the cell (Playwright + CDP + measureCell in
 * production; synthetic in unit tests) and returns a complete
 * `SweepCellResult` including replication CI.
 *
 * The runner does NOT throw on per-cell errors; it expects `runCell` to
 * either resolve with a FAIL-classified result or to reject — both
 * paths produce a recorded FAIL cell with `errors[]` populated. The
 * AbortSignal is informational; a production implementation should
 * cooperate with it and reject promptly when it fires.
 */
export type RunCellFn = (input: SweepCellInput, signal: AbortSignal) => Promise<SweepCellResult>;

export interface RunCampaignOptions {
  readonly fixtures: ReadonlyArray<{ readonly ref: WorkloadFixtureRef }>;
  readonly runCell: RunCellFn;
  readonly hostClass: HostClassFingerprint;
  readonly criteria?: VerdictCriteria;
  /**
   * Optional checkpoint directory. If provided, each stage's results are
   * persisted to `<dir>/sweep-cache-regime.<stage>-<fixture>.checkpoint.json`
   * so a mid-campaign crash resumes from the last completed cell.
   */
  readonly checkpointDir?: string;
  readonly mountStalledThresholdMs?: number;
}

/**
 * Run the full cap-graduation campaign: baseline + Stage 1 + Stage 2 +
 * Stage 3 + Stage 4 per fixture, then aggregate to a single CampaignVerdict.
 */
export async function runCapGraduationCampaign(
  options: RunCampaignOptions,
): Promise<CampaignVerdict> {
  const criteria = options.criteria ?? DEFAULT_VERDICT_CRITERIA_16GB_MACBOOK;
  const allCells: SweepCellResult[] = [];
  const baselines = new Map<WorkloadFixtureRef, BaselineCellResult>();

  for (const fixture of options.fixtures) {
    const baselineInput: SweepCellInput = {
      capRegime: BASELINE_CAP_REGIME,
      workloadFixture: fixture.ref,
      hostClass: options.hostClass,
      cellIndex: 0,
      stage: 1,
      isBaseline: true,
    };
    const baselineCells = await runStageWithCheckpoint(
      [baselineInput],
      options,
      criteria,
      undefined,
      `baseline-${fixture.ref}`,
    );
    const baselineCell = baselineCells[0] as SweepCellResult;
    // A baseline cell with errors produces an all-zero measurement floor via
    // makeEmptyMeasurement(). Pinning that floor as the architectural
    // reference would tag every subsequent stage cell `cap-bounded` against
    // a zeroed baseline — silently corrupting CampaignVerdict.archFloors so
    // the verdict markdown reports every cell cap-bounded even when the
    // configuration is genuinely close to the architectural floor.
    // Throw loud with the underlying error so the engineer can re-run the
    // baseline cell deterministically before the multi-hour stage 1-4
    // sweeps consume CI time.
    if (baselineCell.errors.length > 0) {
      const firstError = baselineCell.errors[0] as CellError;
      throw new Error(
        `cap-graduation: baseline cell for fixture '${fixture.ref}' failed (${firstError.kind}): ${firstError.message}. ` +
          `The architectural floor cannot be derived from a failed cell — every stage cell would tag against a zeroed floor. ` +
          `Re-run the baseline measurement before continuing.`,
      );
    }
    baselines.set(fixture.ref, toBaselineFloor(baselineCell, options.hostClass));

    const stage1Inputs: SweepCellInput[] = CAP_AXIS_MAX_POOL.map((maxPool, i) => ({
      capRegime: { maxPool, maxCache: maxPool, activityMountLimit: 3 },
      workloadFixture: fixture.ref,
      hostClass: options.hostClass,
      cellIndex: i,
      stage: 1,
      isBaseline: false,
    }));
    const stage1Cells = await runStageWithCheckpoint(
      stage1Inputs,
      options,
      criteria,
      baselines.get(fixture.ref),
      `stage1-${fixture.ref}`,
    );
    allCells.push(...stage1Cells);

    const stage1Winner = findStageWinner(
      stage1Cells,
      (c) => c.cellInput.capRegime.maxPool,
      (c) => c.measurement.warmReopenP95Ms,
      `stage1-${fixture.ref} (MAX_POOL axis)`,
    );

    const stage2Inputs: SweepCellInput[] = CAP_AXIS_MAX_CACHE.map((maxCache, i) => ({
      capRegime: { maxPool: stage1Winner, maxCache, activityMountLimit: 3 },
      workloadFixture: fixture.ref,
      hostClass: options.hostClass,
      cellIndex: i,
      stage: 2,
      isBaseline: false,
    }));
    const stage2Cells = await runStageWithCheckpoint(
      stage2Inputs,
      options,
      criteria,
      baselines.get(fixture.ref),
      `stage2-${fixture.ref}`,
    );
    allCells.push(...stage2Cells);

    const stage2Winner = findStageWinner(
      stage2Cells,
      (c) => c.cellInput.capRegime.maxCache,
      (c) => c.measurement.warmReopenP95Ms,
      `stage2-${fixture.ref} (MAX_CACHE axis)`,
    );

    const stage3Inputs: SweepCellInput[] = CAP_AXIS_ACTIVITY.map((activityMountLimit, i) => ({
      capRegime: { maxPool: stage1Winner, maxCache: stage2Winner, activityMountLimit },
      workloadFixture: fixture.ref,
      hostClass: options.hostClass,
      cellIndex: i,
      stage: 3,
      isBaseline: false,
    }));
    const stage3Cells = await runStageWithCheckpoint(
      stage3Inputs,
      options,
      criteria,
      baselines.get(fixture.ref),
      `stage3-${fixture.ref}`,
    );
    allCells.push(...stage3Cells);

    const stage4Inputs: SweepCellInput[] = BOUNDARY_PROBES.map((probe, i) => ({
      capRegime: probe,
      workloadFixture: fixture.ref,
      hostClass: options.hostClass,
      cellIndex: i,
      stage: 4,
      isBaseline: false,
    }));
    const stage4Cells = await runStageWithCheckpoint(
      stage4Inputs,
      options,
      criteria,
      baselines.get(fixture.ref),
      `stage4-${fixture.ref}`,
    );
    allCells.push(...stage4Cells);
  }

  return aggregateCampaign(allCells, baselines);
}

/**
 * Aggregate cell results from N machines into a single campaign verdict.
 * v1 ships with N=1; the contract accepts cells from any number of
 * machines so future cap-tuning campaigns can shard without re-designing
 * the aggregator.
 */
export function aggregateCampaign(
  cellResults: ReadonlyArray<SweepCellResult>,
  baselines: ReadonlyMap<WorkloadFixtureRef, BaselineCellResult>,
): CampaignVerdict {
  const byFixture = new Map<WorkloadFixtureRef, SweepCellResult[]>();
  for (const cell of cellResults) {
    if (cell.cellInput.isBaseline) continue;
    const list = byFixture.get(cell.cellInput.workloadFixture) ?? [];
    list.push(cell);
    byFixture.set(cell.cellInput.workloadFixture, list);
  }

  const winnersPerFixture = new Map<WorkloadFixtureRef, CapRegime>();
  for (const [fixture, cells] of byFixture) {
    const stage1 = cells.filter((c) => c.cellInput.stage === 1);
    const stage2 = cells.filter((c) => c.cellInput.stage === 2);
    const stage3 = cells.filter((c) => c.cellInput.stage === 3);

    const maxPoolWinner = findStageWinner(
      stage1,
      (c) => c.cellInput.capRegime.maxPool,
      (c) => c.measurement.warmReopenP95Ms,
      `aggregate stage1-${fixture} (MAX_POOL axis)`,
    );
    const maxCacheWinner = findStageWinner(
      stage2,
      (c) => c.cellInput.capRegime.maxCache,
      (c) => c.measurement.warmReopenP95Ms,
      `aggregate stage2-${fixture} (MAX_CACHE axis)`,
    );
    const activityWinner = findStageWinner(
      stage3,
      (c) => c.cellInput.capRegime.activityMountLimit,
      (c) => c.measurement.tabSwitchActivityHiddenToVisibleP95Ms,
      `aggregate stage3-${fixture} (ACTIVITY axis)`,
    );

    winnersPerFixture.set(fixture, {
      maxPool: maxPoolWinner,
      maxCache: maxCacheWinner,
      activityMountLimit: activityWinner,
    });
  }

  const winners = Array.from(winnersPerFixture.values());
  const confidence = computeCrossFixtureConfidence(winners);
  const winning = computeFinalCapRegime(winners);

  // Errored-cell count: non-baseline cells with errors[].length>0. Surfacing
  // this in the verdict lets reviewers spot infrastructure flake when an
  // unexpectedly high fraction of cells failed (kneedle already excludes
  // them so the cap-vector itself isn't biased).
  const erroredCellCount = cellResults.filter(
    (c) => !c.cellInput.isBaseline && c.errors.length > 0,
  ).length;

  const verdictPerConstantMd = generateVerdictMd({
    winning,
    confidence,
    winnersPerFixture,
    baselines,
    cellCount: cellResults.length,
    erroredCellCount,
  });

  return {
    winningCapRegime: winning,
    confidence,
    axisCoverage: byFixture,
    archFloors: baselines,
    winnersPerFixture,
    verdictPerConstantMd,
    erroredCellCount,
  };
}

/**
 * Classify one cell's measurement against the verdict criteria + a
 * per-fixture architectural baseline. Exported so the production runCell
 * can compute the verdict in the same place every consumer does.
 */
export function classifyCellVerdict(
  measurement: VerdictMeasurement,
  baseline: BaselineCellResult | undefined,
  criteria: VerdictCriteria = DEFAULT_VERDICT_CRITERIA_16GB_MACBOOK,
): SweepCellVerdict {
  const axisVerdicts = {
    coldMount: classifyLatencyAxis(measurement.coldMountP95Ms, criteria.ux.coldMountMs),
    warmReopen: classifyLatencyAxis(measurement.warmReopenP95Ms, criteria.ux.warmReopenMs),
    tabSwitchWarmActivityFlip: classifyLatencyAxis(
      measurement.tabSwitchWarmActivityFlipP95Ms,
      criteria.ux.tabSwitchWarmActivityFlipMs,
    ),
    tabSwitchActivityHiddenToVisible: classifyLatencyAxis(
      measurement.tabSwitchActivityHiddenToVisibleP95Ms,
      criteria.ux.tabSwitchActivityHiddenToVisibleMs,
    ),
    jankRate: classifyRateAxis(measurement.perFrameJankRate, criteria.ux.perFrameJankRatePct),
  } as const;

  const trippedChannels: Array<'rss' | 'pressure' | 'server-mem'> = [];
  if (measurement.rendererRssMb > criteria.memoryCeiling.rendererRssBudgetMb)
    trippedChannels.push('rss');
  if (measurement.maxVmPressure >= criteria.memoryCeiling.pressureFailLevel)
    trippedChannels.push('pressure');
  if (measurement.serverMemMb > criteria.serverAmplification.serverMemBudgetMb)
    trippedChannels.push('server-mem');

  const memoryCeilingVerdict: ResourceVerdictClass =
    trippedChannels.includes('rss') || trippedChannels.includes('pressure')
      ? 'FAIL'
      : measurement.rendererRssMb > criteria.memoryCeiling.rendererRssWarnMb
        ? 'WARN'
        : 'PASS';

  const serverAmplificationVerdict: ResourceVerdictClass = trippedChannels.includes('server-mem')
    ? 'FAIL'
    : measurement.serverMemMb > criteria.serverAmplification.serverMemWarnMb
      ? 'WARN'
      : 'PASS';

  const archBound = baseline
    ? tagAgainstBaseline(measurement, baseline, criteria.archBoundedTolerance)
    : 'cap-bounded';

  const classification = combineClassification(
    axisVerdicts,
    memoryCeilingVerdict,
    serverAmplificationVerdict,
  );

  return {
    classification,
    archBound,
    memoryCeilingVerdict,
    serverAmplificationVerdict,
    trippedChannels,
    axisVerdicts,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Stage orchestration — internal helpers
// ─────────────────────────────────────────────────────────────────────────

async function runStageWithCheckpoint(
  inputs: ReadonlyArray<SweepCellInput>,
  options: RunCampaignOptions,
  criteria: VerdictCriteria,
  baseline: BaselineCellResult | undefined,
  stageKey: string,
): Promise<ReadonlyArray<SweepCellResult>> {
  const operation = async (input: SweepCellInput): Promise<SweepCellResult> =>
    executeCell(input, options.runCell, criteria, baseline, options.mountStalledThresholdMs);

  if (options.checkpointDir === undefined) {
    const results: SweepCellResult[] = [];
    for (const input of inputs) {
      results.push(await operation(input));
    }
    return results;
  }

  return withCheckpoint(operation, inputs, {
    checkpointPath: `${options.checkpointDir}/sweep-cache-regime.${stageKey}.checkpoint.json`,
    keyOf: cellKey,
    flushAfterEach: true,
  });
}

function cellKey(input: SweepCellInput): string {
  const { capRegime, workloadFixture, stage, isBaseline, cellIndex } = input;
  const baselineMarker = isBaseline ? 'baseline-' : '';
  return (
    `${baselineMarker}${workloadFixture}.s${stage}.i${cellIndex}.` +
    `p${capRegime.maxPool}.c${capRegime.maxCache}.a${capRegime.activityMountLimit}`
  );
}

async function executeCell(
  input: SweepCellInput,
  runCell: RunCellFn,
  criteria: VerdictCriteria,
  baseline: BaselineCellResult | undefined,
  mountStalledThresholdMs: number = DEFAULT_MOUNT_STALLED_MS,
): Promise<SweepCellResult> {
  const controller = new AbortController();
  let timeoutFired = false;
  const timer = setTimeout(() => {
    timeoutFired = true;
    controller.abort();
  }, mountStalledThresholdMs);

  const startMs = performance.now();
  try {
    const result = await runCell(input, controller.signal);
    // Stuck-mount detection cannot rely on `runCell` throwing. Production
    // runCell implementations may respond to abort with an early
    // `if (signal.aborted) return;` (returning a partial-data result)
    // rather than a throw. If the abort fired while runCell was running,
    // the partial result cannot be trusted as a measurement — downgrade
    // to a stuck-mount FAIL so the campaign verdict isn't biased by
    // intermittently-stalling cap regimes.
    if (timeoutFired || controller.signal.aborted) {
      const durationMs = performance.now() - startMs;
      // Preserve the actual replication sample count from the resolved
      // result so a multi-hour-sweep engineer can distinguish "timed out
      // at replication 8 of 10" from "timed out before any sample landed"
      // — they imply different cap behavior (long-tail vs immediate-fail).
      return makeFailCell(
        input,
        baseline,
        criteria,
        'stuck-mount',
        durationMs,
        {
          kind: 'stuck-mount',
          message: `cell exceeded mount-stalled threshold (${mountStalledThresholdMs}ms) — runCell resolved after abort`,
          capturedAt: new Date().toISOString(),
        },
        result.replicationSampleCount,
      );
    }
    return result;
  } catch (err) {
    const durationMs = performance.now() - startMs;
    const underlyingMessage = err instanceof Error ? err.message : String(err);
    if (timeoutFired || controller.signal.aborted) {
      // Preserve the original error message — distinguishes "hung
      // indefinitely" (canonical stuck-mount) from "threw after timeout"
      // (the abort fired AND runCell crashed for an independent reason
      // like Playwright disconnect or CDP error). During multi-hour
      // sweeps, conflating these two failure modes sends the engineer
      // down the wrong debug path.
      return makeFailCell(input, baseline, criteria, 'stuck-mount', durationMs, {
        kind: 'stuck-mount',
        message: `cell exceeded mount-stalled threshold (${mountStalledThresholdMs}ms); runCell then threw: ${underlyingMessage}`,
        capturedAt: new Date().toISOString(),
      });
    }
    return makeFailCell(input, baseline, criteria, 'thrown', durationMs, {
      kind: 'thrown',
      message: underlyingMessage,
      capturedAt: new Date().toISOString(),
    });
  } finally {
    clearTimeout(timer);
  }
}

function makeFailCell(
  input: SweepCellInput,
  baseline: BaselineCellResult | undefined,
  criteria: VerdictCriteria,
  _reason: 'stuck-mount' | 'thrown',
  durationMs: number,
  error: CellError,
  // Optional — passed when downgrading a resolved-but-aborted result so the
  // diagnostic preserves "stuck at replication N of M" context. Defaults to
  // 0 for the thrown branch where runCell never returned a sample count.
  replicationSampleCount: number = 0,
): SweepCellResult {
  const measurement = makeEmptyMeasurement();
  const verdict: SweepCellVerdict = {
    classification: 'FAIL',
    archBound:
      baseline === undefined
        ? 'cap-bounded'
        : tagAgainstBaseline(measurement, baseline, criteria.archBoundedTolerance),
    memoryCeilingVerdict: 'FAIL',
    serverAmplificationVerdict: 'FAIL',
    trippedChannels: [],
    axisVerdicts: {
      coldMount: 'Poor',
      warmReopen: 'Poor',
      tabSwitchWarmActivityFlip: 'Poor',
      tabSwitchActivityHiddenToVisible: 'Poor',
      jankRate: 'Poor',
    },
  };
  return {
    cellInput: input,
    measurement,
    verdict,
    bootstrapCi: { lo: 0, hi: 0, estimate: 0 },
    errors: [error],
    durationMs,
    replicationSampleCount,
  };
}

function makeEmptyMeasurement(): VerdictMeasurement {
  return {
    coldMountP95Ms: 0,
    warmReopenP95Ms: 0,
    tabSwitchWarmActivityFlipP95Ms: 0,
    tabSwitchActivityHiddenToVisibleP95Ms: 0,
    poolHitRate: 0,
    cacheHitRate: 0,
    rendererRssMb: 0,
    serverMemMb: 0,
    perFrameJankRate: 0,
    maxVmPressure: 1,
    tipTapLeakRateMbPerCycle: 0,
  };
}

function toBaselineFloor(cell: SweepCellResult, host: HostClassFingerprint): BaselineCellResult {
  return {
    fixture: cell.cellInput.workloadFixture,
    architecturalFloor: {
      coldMountP95Ms: cell.measurement.coldMountP95Ms,
      warmReopenP95Ms: cell.measurement.warmReopenP95Ms,
      tabSwitchWarmActivityFlipP95Ms: cell.measurement.tabSwitchWarmActivityFlipP95Ms,
      tabSwitchActivityHiddenToVisibleP95Ms: cell.measurement.tabSwitchActivityHiddenToVisibleP95Ms,
      jankRatePct: cell.measurement.perFrameJankRate,
    },
    capRegimeUsed: cell.cellInput.capRegime,
    capturedAt: new Date().toISOString(),
    hostFingerprint: host,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Verdict classification helpers
// ─────────────────────────────────────────────────────────────────────────

type AxisCriteria = { excellent: number; good: number; acceptable: number };

function classifyLatencyAxis(value: number, criteria: AxisCriteria): UxAxisClass {
  if (value <= criteria.excellent) return 'Excellent';
  if (value <= criteria.good) return 'Good';
  if (value <= criteria.acceptable) return 'Acceptable';
  return 'Poor';
}

function classifyRateAxis(value: number, criteria: AxisCriteria): UxAxisClass {
  if (value < criteria.excellent) return 'Excellent';
  if (value < criteria.good) return 'Good';
  if (value < criteria.acceptable) return 'Acceptable';
  return 'Poor';
}

function combineClassification(
  axes: SweepCellVerdict['axisVerdicts'],
  memory: ResourceVerdictClass,
  server: ResourceVerdictClass,
): SweepCellVerdict['classification'] {
  const values: ReadonlyArray<UxAxisClass> = [
    axes.coldMount,
    axes.warmReopen,
    axes.tabSwitchWarmActivityFlip,
    axes.tabSwitchActivityHiddenToVisible,
    axes.jankRate,
  ];
  if (memory === 'FAIL' || server === 'FAIL') return 'FAIL';
  if (values.includes('Poor')) return 'FAIL';

  // After the early returns above, memory and server are narrowed to
  // 'PASS' | 'WARN'; the remaining classification keys off UX axes alone
  // (plus the PASS-required precondition for CHAMPION).
  const allExcellent = values.every((v) => v === 'Excellent');
  if (allExcellent && memory === 'PASS' && server === 'PASS') return 'CHAMPION';

  const allGoodOrBetter = values.every((v) => v === 'Excellent' || v === 'Good');
  const atLeastOneExcellent = values.includes('Excellent');
  if (allGoodOrBetter && atLeastOneExcellent) return 'WIN';

  return 'PASS';
}

function tagAgainstBaseline(
  measurement: VerdictMeasurement,
  baseline: BaselineCellResult,
  tolerance: number,
): 'arch-bounded' | 'cap-bounded' {
  // For latency: cell-bounded if any axis is meaningfully WORSE (higher)
  // than the baseline floor. For jank: same logic, rate is "lower better".
  const checks: Array<{ cell: number; floor: number }> = [
    { cell: measurement.coldMountP95Ms, floor: baseline.architecturalFloor.coldMountP95Ms },
    { cell: measurement.warmReopenP95Ms, floor: baseline.architecturalFloor.warmReopenP95Ms },
    {
      cell: measurement.tabSwitchWarmActivityFlipP95Ms,
      floor: baseline.architecturalFloor.tabSwitchWarmActivityFlipP95Ms,
    },
    {
      cell: measurement.tabSwitchActivityHiddenToVisibleP95Ms,
      floor: baseline.architecturalFloor.tabSwitchActivityHiddenToVisibleP95Ms,
    },
    { cell: measurement.perFrameJankRate, floor: baseline.architecturalFloor.jankRatePct },
  ];
  for (const { cell, floor } of checks) {
    // A zero floor means the baseline didn't observe that axis (synthetic
    // FAIL cell, etc.); skip — can't tell if cap is the limit.
    if (floor <= 0) continue;
    if (cell > floor * tolerance) return 'cap-bounded';
  }
  return 'arch-bounded';
}

// ─────────────────────────────────────────────────────────────────────────
// Winner detection + cross-fixture aggregation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Detect the per-stage winning cap value via Kneedle. Filters out cells
 * that recorded any error so all-zero measurements from synthesized FAIL
 * cells don't contaminate the curve — a flaky Playwright cell at MAX_POOL=14
 * and a real memory-ceiling FAIL at MAX_POOL=50 would otherwise both look
 * like (x, 0) points and bias the knee toward higher cap values.
 *
 * Throws when no error-free cells remain. Returning 0 in that case
 * propagates a value that isn't in any cap axis to downstream stages
 * (Stage 2 pinned to MAX_POOL=0 etc.) and produces pathological verdicts
 * like `{maxPool: 0, maxCache: 5, ...}`. Throwing lets the campaign
 * caller decide whether to abort or retry.
 */
function findStageWinner(
  cells: ReadonlyArray<SweepCellResult>,
  xOf: (c: SweepCellResult) => number,
  yOf: (c: SweepCellResult) => number,
  stageLabel = 'stage',
): number {
  const validCells = cells.filter((c) => c.errors.length === 0);
  if (validCells.length === 0) {
    throw new Error(
      `findStageWinner: no error-free cells in ${stageLabel} (input length=${cells.length}, all errored); rerun the stage or investigate the underlying failures before continuing.`,
    );
  }
  const curve = validCells.map((c) => ({ x: xOf(c), y: yOf(c) }));
  curve.sort((a, b) => a.x - b.x);
  // Kneedle's degenerate short-circuit (length<3) returns the first sorted
  // point's x — i.e., the smallest cap value — regardless of which cell
  // has better y. With ≥4 errored cells in a 6-cell stage, that produces
  // a winner determined by sort order rather than measurement and pins
  // a non-empirical cap into downstream stages. Below the kneedle
  // threshold we instead select the point with the best y directly —
  // a transparent, measurement-driven fallback.
  if (curve.length < 3) {
    // validCells.length >= 1 was asserted above; sort() preserves the array
    // identity, so curve[0] is defined. The reassignment in the loop accepts
    // any candidate with strictly better (lower) y, so the initial seed only
    // determines the tiebreak when all y values are equal.
    const seed = curve[0];
    if (!seed) {
      // Unreachable; satisfies the lint without a non-null assertion.
      throw new Error('findStageWinner: unexpected empty curve after non-empty filter');
    }
    let best = seed;
    for (const p of curve) {
      // Decreasing curve: smaller y is better; on tie, prefer smaller x
      // (consistent with the conservative-cap default).
      if (p.y < best.y || (p.y === best.y && p.x < best.x)) best = p;
    }
    return best.x;
  }
  const knee = findKnee(curve, { direction: 'decreasing' });
  return knee.x;
}

function computeCrossFixtureConfidence(
  winners: ReadonlyArray<CapRegime>,
): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (winners.length === 0) return 'LOW';
  if (winners.length === 1) return 'MEDIUM';

  const poolVals = winners.map((w) => w.maxPool);
  const cacheVals = winners.map((w) => w.maxCache);
  const activityVals = winners.map((w) => w.activityMountLimit);

  const allEqual =
    poolVals.every((v) => v === poolVals[0]) &&
    cacheVals.every((v) => v === cacheVals[0]) &&
    activityVals.every((v) => v === activityVals[0]);
  if (allEqual) return 'HIGH';

  // Within ±1 axis-step in CAP_AXIS_MAX_POOL/CACHE means winners differ by
  // at most one position in the axis grid. For MAX_POOL/MAX_CACHE the
  // largest 1-step gap is 50 → 30 (gap 20). For ACTIVITY it's 5 → 8 (gap 3).
  const adjacentInPool = isAdjacentInAxis(poolVals, CAP_AXIS_MAX_POOL);
  const adjacentInCache = isAdjacentInAxis(cacheVals, CAP_AXIS_MAX_CACHE);
  const adjacentInActivity = isAdjacentInAxis(activityVals, CAP_AXIS_ACTIVITY);
  if (adjacentInPool && adjacentInCache && adjacentInActivity) return 'MEDIUM';

  return 'LOW';
}

function isAdjacentInAxis(values: ReadonlyArray<number>, axis: ReadonlyArray<number>): boolean {
  if (values.length === 0) return true;
  const indices = values.map((v) => axis.indexOf(v));
  if (indices.some((i) => i < 0)) return false;
  const min = Math.min(...indices);
  const max = Math.max(...indices);
  return max - min <= 1;
}

function computeFinalCapRegime(winners: ReadonlyArray<CapRegime>): CapRegime {
  if (winners.length === 0) {
    return BASELINE_CAP_REGIME;
  }
  return {
    maxPool: medianInt(winners.map((w) => w.maxPool)),
    maxCache: medianInt(winners.map((w) => w.maxCache)),
    activityMountLimit: medianInt(winners.map((w) => w.activityMountLimit)),
  };
}

function medianInt(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  // Even count: pick the lower of the two middles for cap values (caps
  // are integers; we don't want a 14.5 cap regime). Lower bias is the
  // conservative choice for a memory-bound system.
  return sorted[mid - 1] as number;
}

function generateVerdictMd(params: {
  winning: CapRegime;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  winnersPerFixture: ReadonlyMap<WorkloadFixtureRef, CapRegime>;
  baselines: ReadonlyMap<WorkloadFixtureRef, BaselineCellResult>;
  cellCount: number;
  erroredCellCount: number;
}): string {
  const lines: string[] = [];
  lines.push('# Cap-regime sweep verdict');
  lines.push('');
  lines.push(
    `Winning cap-regime: MAX_POOL=${params.winning.maxPool} / ` +
      `MAX_CACHE=${params.winning.maxCache} / ACTIVITY_MOUNT_LIMIT=${params.winning.activityMountLimit}`,
  );
  lines.push(`Confidence: ${params.confidence}`);
  lines.push(`Cell count: ${params.cellCount}`);
  if (params.erroredCellCount > 0) {
    lines.push(
      `Errored cells: ${params.erroredCellCount} (excluded from kneedle winner detection; rerun the affected stages if the rate is high enough to suggest infrastructure flake).`,
    );
  }
  lines.push('');
  lines.push('## Per-fixture winners');
  for (const [fixture, winner] of params.winnersPerFixture) {
    lines.push(
      `- ${fixture}: MAX_POOL=${winner.maxPool} MAX_CACHE=${winner.maxCache} ` +
        `ACTIVITY=${winner.activityMountLimit}`,
    );
  }
  lines.push('');
  lines.push('## Architectural floors');
  for (const [fixture, floor] of params.baselines) {
    lines.push(
      `- ${fixture}: cold-mount p95 ${floor.architecturalFloor.coldMountP95Ms.toFixed(0)}ms, ` +
        `warm-reopen p95 ${floor.architecturalFloor.warmReopenP95Ms.toFixed(0)}ms, ` +
        `tab-switch flip p95 ${floor.architecturalFloor.tabSwitchWarmActivityFlipP95Ms.toFixed(0)}ms, ` +
        `tab-switch re-mount p95 ${floor.architecturalFloor.tabSwitchActivityHiddenToVisibleP95Ms.toFixed(0)}ms, ` +
        `jank ${floor.architecturalFloor.jankRatePct.toFixed(2)}%`,
    );
  }
  return lines.join('\n');
}
