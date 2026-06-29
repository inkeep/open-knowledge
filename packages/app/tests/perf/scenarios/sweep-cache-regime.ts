
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { asymmetricFixture, broadFixture, tightFixture } from '../fixtures/cache-regime-rotation';
import type { WorkloadFixture } from '../fixtures/cache-regime-rotation/types';
import { type CellMeasurement, measureCell, type WorkloadDriver } from '../lib/cell-measurement';
import { defineScenario, type ScenarioCtx } from '../lib/scenario';
import {
  type BootstrapConfidenceInterval,
  type CampaignVerdict,
  classifyCellVerdict,
  type HostClassFingerprint,
  type RunCellFn,
  runCapGraduationCampaign,
  type SweepCellInput,
  type SweepCellResult,
  type SweepStage,
  type VerdictMeasurement,
  type WorkloadFixtureRef,
} from '../lib/sweep-runner';

export const SCENARIO_NAME = 'sweep-cache-regime';
export const BASELINE_KEY = 'sweep-cache-regime';
export const ALL_FIXTURES: ReadonlyArray<WorkloadFixtureRef> = ['tight', 'broad', 'asymmetric'];
export const ALL_STAGES: ReadonlyArray<SweepStage> = [1, 2, 3, 4];

const CELL_COUNT_PER_FIXTURE = 22;
const CELL_COUNT_DRIFT_TOLERANCE = 5;


export interface SweepRunOptions {
  readonly fixtures: ReadonlyArray<WorkloadFixtureRef>;
  readonly stages: ReadonlyArray<SweepStage>;
  readonly resume: boolean;
  readonly prodValidation: boolean;
}

export type SweepRunOptionsEnv = Readonly<Record<string, string | undefined>>;

export function parseSweepRunOptions(env: SweepRunOptionsEnv = process.env): SweepRunOptions {
  const rawFixture = (env.OK_SWEEP_FIXTURE ?? 'all').trim().toLowerCase();
  const fixtures: WorkloadFixtureRef[] =
    rawFixture === 'all' ? [...ALL_FIXTURES] : ALL_FIXTURES.filter((f) => f === rawFixture);
  if (fixtures.length === 0) {
    throw new Error(
      `OK_SWEEP_FIXTURE="${env.OK_SWEEP_FIXTURE}" — expected one of: tight, broad, asymmetric, all`,
    );
  }

  const rawStage = (env.OK_SWEEP_STAGE ?? 'all').trim().toLowerCase();
  const stages: SweepStage[] =
    rawStage === 'all' ? [...ALL_STAGES] : ALL_STAGES.filter((s) => String(s) === rawStage);
  if (stages.length === 0) {
    throw new Error(`OK_SWEEP_STAGE="${env.OK_SWEEP_STAGE}" — expected one of: 1, 2, 3, 4, all`);
  }

  return {
    fixtures,
    stages,
    resume: env.OK_SWEEP_RESUME === '1',
    prodValidation: env.OK_SWEEP_PROD_VALIDATION === '1',
  };
}

export function getFixtureByRef(ref: WorkloadFixtureRef): WorkloadFixture {
  switch (ref) {
    case 'tight':
      return tightFixture;
    case 'broad':
      return broadFixture;
    case 'asymmetric':
      return asymmetricFixture;
  }
}

function detectHostClass(): HostClassFingerprint {
  const cpu = process.env.OK_HOST_CPU ?? 'unknown';
  const totalRamGb = Number(process.env.OK_HOST_RAM_GB ?? 16);
  const osVersion = process.platform === 'darwin' ? 'darwin' : process.platform;
  return {
    cpuModel: cpu,
    totalRamGb: Number.isFinite(totalRamGb) ? totalRamGb : 16,
    osVersion,
    identifier: `${Number.isFinite(totalRamGb) ? totalRamGb : 16}gb-${osVersion}`,
  };
}


export interface BuildRunCellOptions {
  readonly browser: Browser;
  readonly baseTarget: string;
  readonly samplesPerCell?: number;
}

export function buildProductionRunCell(opts: BuildRunCellOptions): RunCellFn {
  const samplesPerCell = opts.samplesPerCell ?? 20;

  return async (input: SweepCellInput, signal: AbortSignal): Promise<SweepCellResult> => {
    const startMs = performance.now();
    const context = await opts.browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable').catch(() => undefined);

    await page.addInitScript(({ maxPool, maxCache, activityMountLimit }) => {
      const w = window as unknown as {
        __okPerfOverrides?: Record<string, number>;
      };
      const overrides = w.__okPerfOverrides ?? {};
      overrides.MAX_POOL = maxPool;
      overrides.MAX_CACHE = maxCache;
      overrides.ACTIVITY_MOUNT_LIMIT = activityMountLimit;
      w.__okPerfOverrides = overrides;
    }, input.capRegime);

    try {
      const fixture = getFixtureByRef(input.workloadFixture);

      const libMeasurement = await measureCell({
        page,
        cdp,
        capRegime: input.capRegime,
        fixture: input.workloadFixture,
        options: { warmupSamplesToDrop: Math.min(5, Math.floor(samplesPerCell / 4)) },
        workload: async (driver, p) => {
          await p.goto(opts.baseTarget, {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
          });
          if (signal.aborted) throw new Error('cell aborted before workload start');
          await driveWorkload(driver, p, fixture, samplesPerCell, signal);
        },
      });

      const measurement = toRunnerMeasurement(libMeasurement);
      const verdict = classifyCellVerdict(measurement, undefined);
      const bootstrapCi: BootstrapConfidenceInterval = {
        lo: measurement.warmReopenP95Ms,
        hi: measurement.warmReopenP95Ms,
        estimate: measurement.warmReopenP95Ms,
      };

      const errors = libMeasurement.errors.map((msg) => ({
        kind: 'thrown' as const,
        message: msg,
        capturedAt: libMeasurement.capturedAt,
      }));

      return {
        cellInput: input,
        measurement,
        verdict,
        bootstrapCi,
        errors,
        durationMs: performance.now() - startMs,
        replicationSampleCount:
          libMeasurement.sampleCounts.coldMount +
          libMeasurement.sampleCounts.warmReopen +
          libMeasurement.sampleCounts.tabSwitchWarmActivityFlip +
          libMeasurement.sampleCounts.tabSwitchActivityHiddenToVisible,
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  };
}

async function driveWorkload(
  driver: WorkloadDriver,
  page: Page,
  fixture: WorkloadFixture,
  samples: number,
  signal: AbortSignal,
): Promise<void> {
  const seen = new Set<string>();
  for (let i = 0; i < samples; i += 1) {
    if (signal.aborted) return;
    const visitIndex =
      fixture.rotationPattern === 'hot-pocket'
        ? i % fixture.rotationDocs.length
        : Math.min(i, fixture.rotationDocs.length - 1);
    const doc = fixture.rotationDocs[visitIndex];
    if (!doc) continue;

    const start = performance.now();
    await page.evaluate((docName: string) => {
      const open = (window as unknown as { __ok_open?: (n: string) => void }).__ok_open;
      if (typeof open === 'function') open(docName);
    }, doc.name);
    await page.waitForTimeout(200);
    const elapsedMs = performance.now() - start;

    if (seen.has(doc.name)) {
      driver.recordWarmReopenSample(elapsedMs);
    } else {
      driver.recordColdMountSample(elapsedMs);
      seen.add(doc.name);
    }
  }
}

function toRunnerMeasurement(m: CellMeasurement): VerdictMeasurement {
  return {
    coldMountP95Ms: m.coldMountP95Ms,
    warmReopenP95Ms: m.warmReopenP95Ms,
    tabSwitchWarmActivityFlipP95Ms: m.tabSwitchWarmActivityFlipP95Ms,
    tabSwitchActivityHiddenToVisibleP95Ms: m.tabSwitchActivityHiddenToVisibleP95Ms,
    poolHitRate: m.poolHitRate,
    cacheHitRate: m.cacheHitRate,
    rendererRssMb: m.rendererRssMb,
    serverMemMb: 0,
    perFrameJankRate: m.perFrameJankRate,
    maxVmPressure: m.maxVmPressure,
    tipTapLeakRateMbPerCycle: m.tipTapLeakRateMbPerCycle,
  };
}


export interface SweepCampaignOutcome {
  readonly campaign: CampaignVerdict;
  readonly cellResultsPath: string;
  readonly allCells: ReadonlyArray<SweepCellResult>;
}

export async function runSweepCampaign(
  ctx: ScenarioCtx,
  options: SweepRunOptions,
  runCell: RunCellFn,
): Promise<SweepCampaignOutcome> {
  const hostClass = detectHostClass();
  const fixtures = options.fixtures.map((ref) => ({ ref }));
  const checkpointDir = options.resume
    ? resolve(ctx.opts.outDir, 'sweep-cache-regime-checkpoints')
    : undefined;

  const campaign = await runCapGraduationCampaign({
    fixtures,
    runCell,
    hostClass,
    ...(checkpointDir !== undefined ? { checkpointDir } : {}),
  });

  const allCells: SweepCellResult[] = [];
  for (const list of campaign.axisCoverage.values()) {
    allCells.push(...list);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const cellResultsPath = resolve(ctx.opts.outDir, `cell-results-${timestamp}.json`);
  const payload = {
    schemaVersion: 1 as const,
    scenario: SCENARIO_NAME,
    baselineKey: BASELINE_KEY,
    capturedAt: new Date().toISOString(),
    hostClass,
    runOptions: options,
    winningCapRegime: campaign.winningCapRegime,
    confidence: campaign.confidence,
    winnersPerFixture: Object.fromEntries(campaign.winnersPerFixture),
    archFloors: Object.fromEntries(campaign.archFloors),
    verdictPerConstantMd: campaign.verdictPerConstantMd,
    cells: allCells,
  };
  writeFileSync(cellResultsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const expectedTotal = CELL_COUNT_PER_FIXTURE * options.fixtures.length;
  if (Math.abs(allCells.length - expectedTotal) > CELL_COUNT_DRIFT_TOLERANCE) {
    ctx.note(
      `sweep cell count drift: actual=${allCells.length}, expected≈${expectedTotal} (${options.fixtures.length} fixtures × ${CELL_COUNT_PER_FIXTURE}).`,
    );
  }

  ctx.recordMetric('sweep.cellCount', allCells.length);
  ctx.recordMetric('sweep.fixtureCount', options.fixtures.length);
  ctx.recordMetric('sweep.winningMaxPool', campaign.winningCapRegime.maxPool);
  ctx.recordMetric('sweep.winningMaxCache', campaign.winningCapRegime.maxCache);
  ctx.recordMetric('sweep.winningActivityMountLimit', campaign.winningCapRegime.activityMountLimit);
  ctx.recordMetric('sweep.confidence', campaign.confidence);
  ctx.recordMetric('sweep.cellResultsPath', cellResultsPath);

  if (options.prodValidation) {
    ctx.recordMetric('sweep.prodValidation', true);
    const target = ctx.opts.target;
    const looksLikeDevServer = /(localhost|127\.0\.0\.1|0\.0\.0\.0):5173(\b|\/|$)/.test(target);
    if (looksLikeDevServer) {
      ctx.note(
        `prod-validation flag set but --target="${target}" looks like the dev server; FR5 AC5.2 requires a 'bun run build'-served target. Re-run with --target=<prod-build-url>.`,
      );
    } else {
      ctx.note(
        `prod-validation sweep ran against --target="${target}" (FR5 AC5.2). Verdict cap-regime above must PASS-or-better on this target before landing the cap-value PR.`,
      );
    }
  }

  return { campaign, cellResultsPath, allCells };
}


export default defineScenario({
  name: SCENARIO_NAME,
  description:
    'Cap-graduation cache-regime 4-stage per-cap sweep (FW8a-extended). Engineer-local; not for CI.',
  async run(ctx: ScenarioCtx): Promise<void> {
    const options = parseSweepRunOptions();
    const runCell = buildProductionRunCell({
      browser: ctx.browser,
      baseTarget: ctx.opts.target,
    });
    await runSweepCampaign(ctx, options, runCell);
  },
});
