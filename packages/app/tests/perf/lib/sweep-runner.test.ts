import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateCampaign,
  BASELINE_CAP_REGIME,
  BOUNDARY_PROBES,
  CAP_AXIS_ACTIVITY,
  CAP_AXIS_MAX_CACHE,
  CAP_AXIS_MAX_POOL,
  type CampaignVerdict,
  type CapRegime,
  classifyCellVerdict,
  DEFAULT_VERDICT_CRITERIA_16GB_MACBOOK,
  type HostClassFingerprint,
  type RunCellFn,
  runCapGraduationCampaign,
  type SweepCellInput,
  type SweepCellResult,
  type VerdictMeasurement,
  type WorkloadFixtureRef,
} from './sweep-runner';

const HOST: HostClassFingerprint = {
  cpuModel: 'Apple M2',
  totalRamGb: 16,
  osVersion: 'darwin-25.4.0',
  identifier: '16gb-macbook-m2',
};

function syntheticMeasurement(input: SweepCellInput): VerdictMeasurement {
  const { maxPool, maxCache, activityMountLimit } = input.capRegime;
  const poolPenalty = poolLatencyContribution(maxPool);
  const cachePenalty = cacheLatencyContribution(maxCache);
  const activityPenalty = activityLatencyContribution(activityMountLimit);

  return {
    coldMountP95Ms: 600 + poolPenalty,
    warmReopenP95Ms: 50 + poolPenalty + cachePenalty * 0.5,
    tabSwitchWarmActivityFlipP95Ms: 30 + activityPenalty * 0.4,
    tabSwitchActivityHiddenToVisibleP95Ms: 100 + activityPenalty,
    poolHitRate: Math.min(0.99, 0.4 + maxPool * 0.04),
    cacheHitRate: Math.min(0.99, 0.4 + maxCache * 0.04),
    rendererRssMb: 500 + maxCache * 35,
    serverMemMb: 200 + maxPool * 15,
    perFrameJankRate: 0.5,
    maxVmPressure: 1,
    tipTapLeakRateMbPerCycle: 17,
  };
}

function poolLatencyContribution(maxPool: number): number {
  if (maxPool <= 5) return 200;
  if (maxPool <= 10) return 100;
  if (maxPool <= 14) return 30;
  if (maxPool <= 20) return 25;
  if (maxPool <= 30) return 23;
  return 22;
}

function cacheLatencyContribution(maxCache: number): number {
  if (maxCache <= 5) return 180;
  if (maxCache <= 10) return 90;
  if (maxCache <= 14) return 25;
  if (maxCache <= 20) return 22;
  if (maxCache <= 30) return 20;
  return 19;
}

function activityLatencyContribution(activity: number): number {
  if (activity <= 1) return 80;
  if (activity <= 3) return 30;
  if (activity <= 5) return 28;
  return 27;
}

function makeSyntheticCell(input: SweepCellInput): SweepCellResult {
  const measurement = syntheticMeasurement(input);
  const verdict = classifyCellVerdict(
    measurement,
    undefined,
    DEFAULT_VERDICT_CRITERIA_16GB_MACBOOK,
  );
  return {
    cellInput: input,
    measurement,
    verdict,
    bootstrapCi: {
      lo: measurement.warmReopenP95Ms - 5,
      hi: measurement.warmReopenP95Ms + 5,
      estimate: measurement.warmReopenP95Ms,
    },
    errors: [],
    durationMs: 30000,
    replicationSampleCount: 20,
  };
}

function makeCapturingRunCell(): {
  runCell: RunCellFn;
  calls: SweepCellInput[];
} {
  const calls: SweepCellInput[] = [];
  const runCell: RunCellFn = async (input, _signal) => {
    calls.push(input);
    return makeSyntheticCell(input);
  };
  return { runCell, calls };
}

describe('runCapGraduationCampaign — stage orchestration', () => {
  test('produces baseline + 4 stages × 1 fixture; no errors', async () => {
    const { runCell, calls } = makeCapturingRunCell();
    const verdict = await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell,
      hostClass: HOST,
    });

    expect(calls.length).toBe(23);
    expect(verdict.confidence).toBeDefined();
    expect(verdict.archFloors.has('tight')).toBe(true);
    expect(verdict.winnersPerFixture.has('tight')).toBe(true);
  });

  test('three fixtures produce ~66 non-baseline cells total (3 × 22)', async () => {
    const { runCell, calls } = makeCapturingRunCell();
    await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }, { ref: 'broad' }, { ref: 'asymmetric' }],
      runCell,
      hostClass: HOST,
    });
    expect(calls.length).toBe(3 * 23); // 23 per fixture including baseline
    const nonBaselineCount = calls.filter((c) => !c.isBaseline).length;
    expect(nonBaselineCount).toBe(3 * 22); // 22 cells/fixture × 3 fixtures = 66
  });

  test('baseline cell uses MEDIUM cap regime, NOT highest', async () => {
    const { runCell, calls } = makeCapturingRunCell();
    await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell,
      hostClass: HOST,
    });
    const baseline = calls.find((c) => c.isBaseline);
    expect(baseline).toBeDefined();
    expect(baseline?.capRegime).toEqual(BASELINE_CAP_REGIME);
    expect(baseline?.capRegime.maxPool).toBe(14); // NOT 50
    expect(baseline?.capRegime.maxCache).toBe(14); // NOT 50
    expect(baseline?.capRegime.activityMountLimit).toBe(3); // NOT 8
  });

  test('Stage 1 sweeps MAX_POOL with MAX_CACHE=MAX_POOL and ACTIVITY=3', async () => {
    const { runCell, calls } = makeCapturingRunCell();
    await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell,
      hostClass: HOST,
    });
    const stage1 = calls.filter((c) => c.stage === 1 && !c.isBaseline);
    expect(stage1.length).toBe(CAP_AXIS_MAX_POOL.length);
    for (const cell of stage1) {
      expect(cell.capRegime.maxCache).toBe(cell.capRegime.maxPool); // ordering constraint
      expect(cell.capRegime.activityMountLimit).toBe(3); // ACTIVITY pinned
    }
    const poolValues = stage1.map((c) => c.capRegime.maxPool).sort((a, b) => a - b);
    expect(poolValues).toEqual([...CAP_AXIS_MAX_POOL].sort((a, b) => a - b));
  });

  test('Stage 2 pins MAX_POOL to stage1 winner (kneedle output)', async () => {
    const { runCell, calls } = makeCapturingRunCell();
    await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell,
      hostClass: HOST,
    });
    const stage2 = calls.filter((c) => c.stage === 2);
    expect(stage2.length).toBe(CAP_AXIS_MAX_CACHE.length);
    const stage2MaxPools = new Set(stage2.map((c) => c.capRegime.maxPool));
    expect(stage2MaxPools.size).toBe(1);
    for (const cell of stage2) {
      expect(cell.capRegime.activityMountLimit).toBe(3);
    }
    const winner = stage2[0]?.capRegime.maxPool;
    expect([10, 14, 20]).toContain(winner);
  });

  test('Stage 3 pins MAX_POOL and MAX_CACHE to prior winners', async () => {
    const { runCell, calls } = makeCapturingRunCell();
    await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell,
      hostClass: HOST,
    });
    const stage3 = calls.filter((c) => c.stage === 3);
    expect(stage3.length).toBe(CAP_AXIS_ACTIVITY.length);
    const stage3MaxPools = new Set(stage3.map((c) => c.capRegime.maxPool));
    const stage3MaxCaches = new Set(stage3.map((c) => c.capRegime.maxCache));
    expect(stage3MaxPools.size).toBe(1);
    expect(stage3MaxCaches.size).toBe(1);
    const activities = stage3.map((c) => c.capRegime.activityMountLimit).sort((a, b) => a - b);
    expect(activities).toEqual([...CAP_AXIS_ACTIVITY].sort((a, b) => a - b));
    expect(activities).toContain(1);
  });

  test('Stage 4 boundary probes test deliberately-misaligned cap-vectors', async () => {
    const { runCell, calls } = makeCapturingRunCell();
    await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell,
      hostClass: HOST,
    });
    const stage4 = calls.filter((c) => c.stage === 4);
    expect(stage4.length).toBe(BOUNDARY_PROBES.length);
    expect(stage4.length).toBe(6);
    const poolGreaterThanCache = stage4.some((c) => c.capRegime.maxPool > c.capRegime.maxCache);
    const cacheGreaterThanPool = stage4.some((c) => c.capRegime.maxCache > c.capRegime.maxPool);
    const activityGreaterThanCache = stage4.some(
      (c) => c.capRegime.activityMountLimit > c.capRegime.maxCache,
    );
    expect(poolGreaterThanCache).toBe(true);
    expect(cacheGreaterThanPool).toBe(true);
    expect(activityGreaterThanCache).toBe(true);
  });

  test('baseline-cell failure throws actionable error before any stage runs', async () => {
    let baselineCellCount = 0;
    let nonBaselineCellCount = 0;
    const failingBaselineRunCell: RunCellFn = async (input, _signal) => {
      if (input.isBaseline) {
        baselineCellCount += 1;
        throw new Error('synthetic baseline failure (Playwright disconnect)');
      }
      nonBaselineCellCount += 1;
      return makeSyntheticCell(input);
    };

    await expect(
      runCapGraduationCampaign({
        fixtures: [{ ref: 'tight' }],
        runCell: failingBaselineRunCell,
        hostClass: HOST,
      }),
    ).rejects.toThrow(/baseline cell for fixture 'tight' failed.*synthetic baseline failure/);

    expect(baselineCellCount).toBe(1);
    expect(nonBaselineCellCount).toBe(0);
  });

  test('per-cell errors do not abort the campaign', async () => {
    const calls: SweepCellInput[] = [];
    const failingRunCell: RunCellFn = async (input, _signal) => {
      calls.push(input);
      if (calls.length === 3) {
        throw new Error('synthetic cell failure');
      }
      return makeSyntheticCell(input);
    };
    const verdict = await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell: failingRunCell,
      hostClass: HOST,
    });
    expect(calls.length).toBe(23);
    const allCells = Array.from(verdict.axisCoverage.values()).flat();
    const failedCells = allCells.filter((c) => c.errors.length > 0);
    expect(failedCells.length).toBe(1);
    expect(failedCells[0]?.verdict.classification).toBe('FAIL');
    expect(failedCells[0]?.errors[0]?.kind).toBe('thrown');
  });

  test('mount-stalled timeout produces stuck-mount FAIL cell', async () => {
    const stallingRunCell: RunCellFn = async (input, signal) => {
      if (!input.isBaseline && input.stage === 1 && input.cellIndex === 0) {
        return new Promise<SweepCellResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by harness')), {
            once: true,
          });
        });
      }
      return makeSyntheticCell(input);
    };
    const verdict = await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell: stallingRunCell,
      hostClass: HOST,
      mountStalledThresholdMs: 50,
    });
    const allCells = Array.from(verdict.axisCoverage.values()).flat();
    const stuck = allCells.filter((c) => c.errors.some((e) => e.kind === 'stuck-mount'));
    expect(stuck.length).toBe(1);
    expect(stuck[0]?.verdict.classification).toBe('FAIL');
  });

  test('stuck-mount FAIL message includes underlying runCell error (no diagnostic loss)', async () => {
    const throwAfterAbortRunCell: RunCellFn = async (input, signal) => {
      if (!input.isBaseline && input.stage === 1 && input.cellIndex === 0) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('Playwright: target page closed unexpectedly');
      }
      return makeSyntheticCell(input);
    };
    const verdict = await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell: throwAfterAbortRunCell,
      hostClass: HOST,
      mountStalledThresholdMs: 50,
    });
    const allCells = Array.from(verdict.axisCoverage.values()).flat();
    const stuck = allCells.filter((c) => c.errors.some((e) => e.kind === 'stuck-mount'));
    expect(stuck.length).toBe(1);
    const msg = stuck[0]?.errors[0]?.message ?? '';
    expect(msg).toContain('cell exceeded mount-stalled threshold');
    expect(msg).toContain('runCell then threw');
    expect(msg).toContain('Playwright: target page closed unexpectedly');
  });

  test('runCell that resolves AFTER abort downgrades to stuck-mount FAIL', async () => {
    const partialResolveRunCell: RunCellFn = async (input, signal) => {
      if (!input.isBaseline && input.stage === 1 && input.cellIndex === 0) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return makeSyntheticCell(input);
      }
      return makeSyntheticCell(input);
    };
    const verdict = await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell: partialResolveRunCell,
      hostClass: HOST,
      mountStalledThresholdMs: 50,
    });
    const allCells = Array.from(verdict.axisCoverage.values()).flat();
    const stuck = allCells.filter((c) => c.errors.some((e) => e.kind === 'stuck-mount'));
    expect(stuck.length).toBe(1);
    expect(stuck[0]?.verdict.classification).toBe('FAIL');
    expect(stuck[0]?.errors[0]?.message).toContain('runCell resolved after abort');
  });
});

describe('runCapGraduationCampaign — checkpointing + resume', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'sweep-runner-test-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('per-cell error preserved across resume (AC e)', async () => {
    const callsRun1: SweepCellInput[] = [];
    const run1: RunCellFn = async (input, _signal) => {
      callsRun1.push(input);
      if (input.stage === 1 && input.cellIndex === 2 && !input.isBaseline) {
        throw new Error('first-run synthetic failure');
      }
      return makeSyntheticCell(input);
    };

    const verdict1 = await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell: run1,
      hostClass: HOST,
      checkpointDir: tmpDir,
    });
    const failed1 = Array.from(verdict1.axisCoverage.values())
      .flat()
      .filter((c) => c.errors.length > 0);
    expect(failed1.length).toBe(1);
    expect(failed1[0]?.errors[0]?.message).toBe('first-run synthetic failure');

    const callsRun2: SweepCellInput[] = [];
    const run2: RunCellFn = async (input, _signal) => {
      callsRun2.push(input);
      return makeSyntheticCell(input);
    };
    const verdict2 = await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell: run2,
      hostClass: HOST,
      checkpointDir: tmpDir,
    });
    expect(callsRun2.length).toBe(0);
    const failed2 = Array.from(verdict2.axisCoverage.values())
      .flat()
      .filter((c) => c.errors.length > 0);
    expect(failed2.length).toBe(1);
    expect(failed2[0]?.errors[0]?.message).toBe('first-run synthetic failure');
  });

  test('successful run with checkpointDir produces verdict-identical run on re-invocation', async () => {
    const { runCell: rc1 } = makeCapturingRunCell();
    const verdict1 = await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell: rc1,
      hostClass: HOST,
      checkpointDir: tmpDir,
    });
    const rc2Calls: SweepCellInput[] = [];
    const rc2: RunCellFn = async (input, _signal) => {
      rc2Calls.push(input);
      return makeSyntheticCell(input);
    };
    const verdict2 = await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell: rc2,
      hostClass: HOST,
      checkpointDir: tmpDir,
    });
    expect(rc2Calls.length).toBe(0); // all cells loaded from checkpoint
    expect(verdict2.winningCapRegime).toEqual(verdict1.winningCapRegime);
    expect(verdict2.confidence).toBe(verdict1.confidence);
  });
});

describe('aggregateCampaign — per-fixture winners + cross-fixture consistency', () => {
  test('all fixtures agree → HIGH confidence', () => {
    const cells: SweepCellResult[] = [];
    for (const fixture of ['tight', 'broad', 'asymmetric'] as const) {
      cells.push(...buildSyntheticFixtureCells(fixture));
    }
    const baselines = new Map<WorkloadFixtureRef, ReturnType<typeof buildBaseline>>([
      ['tight', buildBaseline('tight')],
      ['broad', buildBaseline('broad')],
      ['asymmetric', buildBaseline('asymmetric')],
    ]);
    const verdict = aggregateCampaign(cells, baselines);
    expect(verdict.confidence).toBe('HIGH');
    expect(verdict.winnersPerFixture.size).toBe(3);
    const tightWinner = verdict.winnersPerFixture.get('tight') as CapRegime;
    expect(verdict.winningCapRegime.maxPool).toBe(tightWinner.maxPool);
    expect(verdict.winningCapRegime.maxCache).toBe(tightWinner.maxCache);
  });

  test('empty inputs return a verdict at the baseline cap-regime with LOW confidence', () => {
    const verdict = aggregateCampaign([], new Map());
    expect(verdict.confidence).toBe('LOW');
    expect(verdict.winningCapRegime).toEqual(BASELINE_CAP_REGIME);
    expect(verdict.winnersPerFixture.size).toBe(0);
    expect(verdict.erroredCellCount).toBe(0);
  });

  test('errored cells are filtered from kneedle but counted in erroredCellCount', () => {
    const cells = buildSyntheticFixtureCells('tight');
    const erroredStage1 = makeSyntheticCell({
      capRegime: { maxPool: 50, maxCache: 50, activityMountLimit: 3 },
      workloadFixture: 'tight',
      hostClass: HOST,
      cellIndex: 99,
      stage: 1,
      isBaseline: false,
    });
    const erroredCell: SweepCellResult = {
      ...erroredStage1,
      measurement: {
        ...erroredStage1.measurement,
        coldMountP95Ms: 0,
        warmReopenP95Ms: 0,
        tabSwitchWarmActivityFlipP95Ms: 0,
        tabSwitchActivityHiddenToVisibleP95Ms: 0,
        perFrameJankRate: 0,
      },
      errors: [
        {
          kind: 'thrown',
          message: 'synthetic Playwright flake',
          capturedAt: new Date().toISOString(),
        },
      ],
    };
    const baselines = new Map<WorkloadFixtureRef, ReturnType<typeof buildBaseline>>([
      ['tight', buildBaseline('tight')],
    ]);
    const verdictWithoutFailure = aggregateCampaign(cells, baselines);
    const verdictWithFailure = aggregateCampaign([...cells, erroredCell], baselines);
    expect(verdictWithFailure.winningCapRegime.maxPool).toBe(
      verdictWithoutFailure.winningCapRegime.maxPool,
    );
    expect(verdictWithFailure.erroredCellCount).toBe(1);
    expect(verdictWithFailure.verdictPerConstantMd).toContain('Errored cells: 1');
  });

  test('degenerate stage (≤2 valid cells) selects best-y directly instead of kneedle short-circuit', () => {
    const cells = buildSyntheticFixtureCells('tight');
    const degraded = cells.map((c) => {
      if (c.cellInput.stage !== 1) return c;
      const maxPool = c.cellInput.capRegime.maxPool;
      if (maxPool === 30 || maxPool === 50) return c;
      return {
        ...c,
        errors: [
          {
            kind: 'thrown' as const,
            message: 'synthetic flake',
            capturedAt: new Date().toISOString(),
          },
        ],
      };
    });
    const baselines = new Map<WorkloadFixtureRef, ReturnType<typeof buildBaseline>>([
      ['tight', buildBaseline('tight')],
    ]);
    const verdict = aggregateCampaign(degraded, baselines);
    const stage1Valid = degraded
      .filter((c) => c.cellInput.stage === 1 && c.errors.length === 0)
      .map((c) => ({
        maxPool: c.cellInput.capRegime.maxPool,
        y: c.measurement.warmReopenP95Ms,
      }));
    const minY = Math.min(...stage1Valid.map((p) => p.y));
    const bestByY = stage1Valid.find((p) => p.y === minY);
    expect(bestByY).toBeDefined();
    if (!bestByY) return;
    expect(verdict.winningCapRegime.maxPool).toBe(bestByY.maxPool);
  });

  test('all-error stage in aggregateCampaign throws with stage label (no silent zero-winner)', () => {
    const cells = buildSyntheticFixtureCells('tight');
    const stage1FailedCells = cells.map((c) =>
      c.cellInput.stage === 1
        ? {
            ...c,
            errors: [
              {
                kind: 'thrown' as const,
                message: 'synthetic',
                capturedAt: new Date().toISOString(),
              },
            ],
          }
        : c,
    );
    const baselines = new Map<WorkloadFixtureRef, ReturnType<typeof buildBaseline>>([
      ['tight', buildBaseline('tight')],
    ]);
    expect(() => aggregateCampaign(stage1FailedCells, baselines)).toThrow(
      /no error-free cells in aggregate stage1-tight/,
    );
  });

  test('verdict markdown includes winning cap-regime + confidence', () => {
    const cells = buildSyntheticFixtureCells('tight');
    const baselines = new Map<WorkloadFixtureRef, ReturnType<typeof buildBaseline>>([
      ['tight', buildBaseline('tight')],
    ]);
    const verdict = aggregateCampaign(cells, baselines);
    expect(verdict.verdictPerConstantMd).toContain('MAX_POOL=');
    expect(verdict.verdictPerConstantMd).toContain('MAX_CACHE=');
    expect(verdict.verdictPerConstantMd).toContain('ACTIVITY_MOUNT_LIMIT=');
    expect(verdict.verdictPerConstantMd).toContain('Confidence:');
  });
});

describe('classifyCellVerdict — 3-axis aggregation per §13', () => {
  test('all 5 UX axes Excellent + memory PASS + server PASS → CHAMPION', () => {
    const m: VerdictMeasurement = {
      coldMountP95Ms: 200, // Excellent ≤500
      warmReopenP95Ms: 50, // Excellent ≤100
      tabSwitchWarmActivityFlipP95Ms: 30, // Excellent ≤50
      tabSwitchActivityHiddenToVisibleP95Ms: 80, // Excellent ≤120
      poolHitRate: 0.9,
      cacheHitRate: 0.9,
      rendererRssMb: 800, // PASS (under WARN 1500)
      serverMemMb: 500, // PASS (under WARN 1000)
      perFrameJankRate: 0.5, // Excellent <1%
      maxVmPressure: 1,
      tipTapLeakRateMbPerCycle: 5,
    };
    const v = classifyCellVerdict(m, undefined);
    expect(v.classification).toBe('CHAMPION');
    expect(v.memoryCeilingVerdict).toBe('PASS');
    expect(v.serverAmplificationVerdict).toBe('PASS');
  });

  test('any UX axis Poor → FAIL', () => {
    const m: VerdictMeasurement = {
      coldMountP95Ms: 5000, // Poor >2500
      warmReopenP95Ms: 50,
      tabSwitchWarmActivityFlipP95Ms: 30,
      tabSwitchActivityHiddenToVisibleP95Ms: 80,
      poolHitRate: 0.9,
      cacheHitRate: 0.9,
      rendererRssMb: 800,
      serverMemMb: 500,
      perFrameJankRate: 0.5,
      maxVmPressure: 1,
      tipTapLeakRateMbPerCycle: 5,
    };
    const v = classifyCellVerdict(m, undefined);
    expect(v.classification).toBe('FAIL');
    expect(v.axisVerdicts.coldMount).toBe('Poor');
  });

  test('memory FAIL (pressure level 2) → FAIL regardless of UX', () => {
    const m: VerdictMeasurement = {
      coldMountP95Ms: 200,
      warmReopenP95Ms: 50,
      tabSwitchWarmActivityFlipP95Ms: 30,
      tabSwitchActivityHiddenToVisibleP95Ms: 80,
      poolHitRate: 0.9,
      cacheHitRate: 0.9,
      rendererRssMb: 800,
      serverMemMb: 500,
      perFrameJankRate: 0.5,
      maxVmPressure: 2, // WARN — trips pressureFailLevel=2
      tipTapLeakRateMbPerCycle: 5,
    };
    const v = classifyCellVerdict(m, undefined);
    expect(v.classification).toBe('FAIL');
    expect(v.memoryCeilingVerdict).toBe('FAIL');
    expect(v.trippedChannels).toContain('pressure');
  });

  test('server-mem FAIL → FAIL', () => {
    const m: VerdictMeasurement = {
      coldMountP95Ms: 200,
      warmReopenP95Ms: 50,
      tabSwitchWarmActivityFlipP95Ms: 30,
      tabSwitchActivityHiddenToVisibleP95Ms: 80,
      poolHitRate: 0.9,
      cacheHitRate: 0.9,
      rendererRssMb: 800,
      serverMemMb: 2000, // FAIL (over 1500)
      perFrameJankRate: 0.5,
      maxVmPressure: 1,
      tipTapLeakRateMbPerCycle: 5,
    };
    const v = classifyCellVerdict(m, undefined);
    expect(v.classification).toBe('FAIL');
    expect(v.serverAmplificationVerdict).toBe('FAIL');
    expect(v.trippedChannels).toContain('server-mem');
  });

  test('all Good + at least 1 Excellent + memory PASS-or-WARN → WIN', () => {
    const m: VerdictMeasurement = {
      coldMountP95Ms: 800, // Good
      warmReopenP95Ms: 100, // Excellent
      tabSwitchWarmActivityFlipP95Ms: 80, // Good
      tabSwitchActivityHiddenToVisibleP95Ms: 150, // Good
      poolHitRate: 0.9,
      cacheHitRate: 0.9,
      rendererRssMb: 1600, // WARN (over 1500)
      serverMemMb: 500, // PASS
      perFrameJankRate: 2, // Good (<3)
      maxVmPressure: 1,
      tipTapLeakRateMbPerCycle: 10,
    };
    const v = classifyCellVerdict(m, undefined);
    expect(v.classification).toBe('WIN');
    expect(v.memoryCeilingVerdict).toBe('WARN');
  });

  test('all Acceptable → PASS', () => {
    const m: VerdictMeasurement = {
      coldMountP95Ms: 2000, // Acceptable
      warmReopenP95Ms: 350, // Acceptable
      tabSwitchWarmActivityFlipP95Ms: 180, // Acceptable
      tabSwitchActivityHiddenToVisibleP95Ms: 350, // Acceptable
      poolHitRate: 0.7,
      cacheHitRate: 0.7,
      rendererRssMb: 800,
      serverMemMb: 500,
      perFrameJankRate: 4, // Acceptable (<5)
      maxVmPressure: 1,
      tipTapLeakRateMbPerCycle: 12,
    };
    const v = classifyCellVerdict(m, undefined);
    expect(v.classification).toBe('PASS');
  });

  test('jank threshold is strict-less (< not ≤)', () => {
    const baseM: VerdictMeasurement = {
      coldMountP95Ms: 200,
      warmReopenP95Ms: 50,
      tabSwitchWarmActivityFlipP95Ms: 30,
      tabSwitchActivityHiddenToVisibleP95Ms: 80,
      poolHitRate: 0.9,
      cacheHitRate: 0.9,
      rendererRssMb: 800,
      serverMemMb: 500,
      perFrameJankRate: 1, // exactly the Excellent boundary — should NOT be Excellent
      maxVmPressure: 1,
      tipTapLeakRateMbPerCycle: 5,
    };
    const v = classifyCellVerdict(baseM, undefined);
    expect(v.axisVerdicts.jankRate).toBe('Good'); // 1 < 1 is false, so NOT Excellent
  });
});

describe('arch-bounded vs cap-bounded tagging (AC d, D18 LOCKED)', () => {
  function makeFloorBaseline(jankPct = 0.5): ReturnType<typeof buildBaseline> {
    return {
      fixture: 'tight',
      architecturalFloor: {
        coldMountP95Ms: 600,
        warmReopenP95Ms: 60,
        tabSwitchWarmActivityFlipP95Ms: 40,
        tabSwitchActivityHiddenToVisibleP95Ms: 130,
        jankRatePct: jankPct,
      },
      capRegimeUsed: BASELINE_CAP_REGIME,
      capturedAt: new Date().toISOString(),
      hostFingerprint: HOST,
    };
  }

  test('cell matching the floor → arch-bounded', () => {
    const baseline = makeFloorBaseline();
    const m: VerdictMeasurement = {
      coldMountP95Ms: 600,
      warmReopenP95Ms: 60,
      tabSwitchWarmActivityFlipP95Ms: 40,
      tabSwitchActivityHiddenToVisibleP95Ms: 130,
      poolHitRate: 0.9,
      cacheHitRate: 0.9,
      rendererRssMb: 800,
      serverMemMb: 500,
      perFrameJankRate: 0.5,
      maxVmPressure: 1,
      tipTapLeakRateMbPerCycle: 5,
    };
    const v = classifyCellVerdict(m, baseline);
    expect(v.archBound).toBe('arch-bounded');
  });

  test('cell exceeding (beating) the floor → arch-bounded', () => {
    const baseline = makeFloorBaseline();
    const m: VerdictMeasurement = {
      coldMountP95Ms: 500, // lower (better) than floor 600
      warmReopenP95Ms: 50, // better than 60
      tabSwitchWarmActivityFlipP95Ms: 30,
      tabSwitchActivityHiddenToVisibleP95Ms: 100,
      poolHitRate: 0.9,
      cacheHitRate: 0.9,
      rendererRssMb: 800,
      serverMemMb: 500,
      perFrameJankRate: 0.3,
      maxVmPressure: 1,
      tipTapLeakRateMbPerCycle: 5,
    };
    const v = classifyCellVerdict(m, baseline);
    expect(v.archBound).toBe('arch-bounded');
  });

  test('cell worse than floor by >10% on any UX axis → cap-bounded', () => {
    const baseline = makeFloorBaseline();
    const m: VerdictMeasurement = {
      coldMountP95Ms: 1200, // 2× the 600 floor → cap-bounded
      warmReopenP95Ms: 60,
      tabSwitchWarmActivityFlipP95Ms: 40,
      tabSwitchActivityHiddenToVisibleP95Ms: 130,
      poolHitRate: 0.9,
      cacheHitRate: 0.9,
      rendererRssMb: 800,
      serverMemMb: 500,
      perFrameJankRate: 0.5,
      maxVmPressure: 1,
      tipTapLeakRateMbPerCycle: 5,
    };
    const v = classifyCellVerdict(m, baseline);
    expect(v.archBound).toBe('cap-bounded');
  });

  test('no baseline → defaults to cap-bounded (cannot prove arch-floor)', () => {
    const m: VerdictMeasurement = {
      coldMountP95Ms: 500,
      warmReopenP95Ms: 50,
      tabSwitchWarmActivityFlipP95Ms: 30,
      tabSwitchActivityHiddenToVisibleP95Ms: 100,
      poolHitRate: 0.9,
      cacheHitRate: 0.9,
      rendererRssMb: 800,
      serverMemMb: 500,
      perFrameJankRate: 0.3,
      maxVmPressure: 1,
      tipTapLeakRateMbPerCycle: 5,
    };
    const v = classifyCellVerdict(m, undefined);
    expect(v.archBound).toBe('cap-bounded');
  });
});

function buildSyntheticFixtureCells(fixture: WorkloadFixtureRef): SweepCellResult[] {
  const cells: SweepCellResult[] = [];
  for (let i = 0; i < CAP_AXIS_MAX_POOL.length; i++) {
    const maxPool = CAP_AXIS_MAX_POOL[i] as number;
    cells.push(
      makeSyntheticCell({
        capRegime: { maxPool, maxCache: maxPool, activityMountLimit: 3 },
        workloadFixture: fixture,
        hostClass: HOST,
        cellIndex: i,
        stage: 1,
        isBaseline: false,
      }),
    );
  }
  for (let i = 0; i < CAP_AXIS_MAX_CACHE.length; i++) {
    const maxCache = CAP_AXIS_MAX_CACHE[i] as number;
    cells.push(
      makeSyntheticCell({
        capRegime: { maxPool: 14, maxCache, activityMountLimit: 3 },
        workloadFixture: fixture,
        hostClass: HOST,
        cellIndex: i,
        stage: 2,
        isBaseline: false,
      }),
    );
  }
  for (let i = 0; i < CAP_AXIS_ACTIVITY.length; i++) {
    const activityMountLimit = CAP_AXIS_ACTIVITY[i] as number;
    cells.push(
      makeSyntheticCell({
        capRegime: { maxPool: 14, maxCache: 14, activityMountLimit },
        workloadFixture: fixture,
        hostClass: HOST,
        cellIndex: i,
        stage: 3,
        isBaseline: false,
      }),
    );
  }
  for (let i = 0; i < BOUNDARY_PROBES.length; i++) {
    const probe = BOUNDARY_PROBES[i] as CapRegime;
    cells.push(
      makeSyntheticCell({
        capRegime: probe,
        workloadFixture: fixture,
        hostClass: HOST,
        cellIndex: i,
        stage: 4,
        isBaseline: false,
      }),
    );
  }
  return cells;
}

function buildBaseline(fixture: WorkloadFixtureRef) {
  return {
    fixture,
    architecturalFloor: {
      coldMountP95Ms: 600,
      warmReopenP95Ms: 60,
      tabSwitchWarmActivityFlipP95Ms: 40,
      tabSwitchActivityHiddenToVisibleP95Ms: 130,
      jankRatePct: 0.5,
    },
    capRegimeUsed: BASELINE_CAP_REGIME,
    capturedAt: new Date().toISOString(),
    hostFingerprint: HOST,
  };
}

const _typeImports: CampaignVerdict | undefined = undefined;
void _typeImports;
