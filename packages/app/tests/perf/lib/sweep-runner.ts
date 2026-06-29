import type { CapRegime, WorkloadFixtureRef } from '../fixtures/cache-regime-rotation/types';
import { findKnee } from './kneedle';
import { withCheckpoint } from './with-checkpoint';

export type { CapRegime, WorkloadFixtureRef };

export interface HostClassFingerprint {
  readonly cpuModel: string;
  readonly totalRamGb: number;
  readonly osVersion: string;
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
  readonly archBoundedTolerance: number;
}

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

export const CAP_AXIS_MAX_POOL = [5, 10, 14, 20, 30, 50] as const;
export const CAP_AXIS_MAX_CACHE = [5, 10, 14, 20, 30, 50] as const;
export const CAP_AXIS_ACTIVITY = [1, 3, 5, 8] as const;

export const BASELINE_CAP_REGIME: CapRegime = {
  maxPool: 14,
  maxCache: 14,
  activityMountLimit: 3,
};

export const BOUNDARY_PROBES: ReadonlyArray<CapRegime> = [
  { maxPool: 30, maxCache: 10, activityMountLimit: 3 },
  { maxPool: 50, maxCache: 5, activityMountLimit: 3 },
  { maxPool: 10, maxCache: 30, activityMountLimit: 3 },
  { maxPool: 5, maxCache: 50, activityMountLimit: 3 },
  { maxPool: 10, maxCache: 5, activityMountLimit: 8 },
  { maxPool: 14, maxCache: 3, activityMountLimit: 8 },
];

export const DEFAULT_MOUNT_STALLED_MS = 30_000;

export type RunCellFn = (input: SweepCellInput, signal: AbortSignal) => Promise<SweepCellResult>;

export interface RunCampaignOptions {
  readonly fixtures: ReadonlyArray<{ readonly ref: WorkloadFixtureRef }>;
  readonly runCell: RunCellFn;
  readonly hostClass: HostClassFingerprint;
  readonly criteria?: VerdictCriteria;
  readonly checkpointDir?: string;
  readonly mountStalledThresholdMs?: number;
}

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
    if (timeoutFired || controller.signal.aborted) {
      const durationMs = performance.now() - startMs;
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
    if (floor <= 0) continue;
    if (cell > floor * tolerance) return 'cap-bounded';
  }
  return 'arch-bounded';
}

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
  if (curve.length < 3) {
    const seed = curve[0];
    if (!seed) {
      throw new Error('findStageWinner: unexpected empty curve after non-empty filter');
    }
    let best = seed;
    for (const p of curve) {
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
