/**
 * Cap-graduation cache-regime sweep scenario.
 *
 * This is the substrate's `defineSweep` first real integration test.
 * The worldmodel-discovered
 * `sweep-pool-warm-back-canary.ts` canary stays in place as a minimal
 * substrate smoke; this scenario generalizes that pattern into the full
 * 4-stage per-cap campaign across three workload fixtures (tight +
 * broad + asymmetric) — the first end-to-end consumer of the substrate
 * primitives.
 *
 * Architecture:
 *
 *   1. **Why `defineScenario`, not `defineSweep`.** The campaign is
 *      per-cap with cap-ordering — Stage 2 inputs pin Stage 1's winner
 *      and Stage 3 pins both prior winners. The substrate's `defineSweep`
 *      exposes only the Cartesian-product shape; its documented opt-out
 *      (`define-sweep.ts`) routes non-Cartesian shapes through
 *      `defineScenario` directly. We compose `runCapGraduationCampaign`
 *      from the sweep-runner module, which owns the per-cap stage logic.
 *
 *   2. **Engineer-local only.** The full campaign wall-time is ~11 hours
 *      across 3 fixtures; GitHub-hosted macOS runners are 10× cost
 *      and Linux can't observe `vm_pressure`. CI runs only the
 *      `*.smoke.test.ts` sibling; the production scenario is invoked via
 *      `bun run sweep:cache-regime` on a 16 GB+ MacBook canonical host.
 *
 *   3. **Production cell driver opens a fresh BrowserContext per cell.**
 *      Carryover state (pool entries, V2 cache, IDB warmth) from a prior
 *      cap regime would mask the next cell's cold-mount measurement.
 *      The cost is ~50-100ms of context-creation overhead per cell —
 *      acceptable against the ~30s cell budget.
 *
 *   4. **CLI is env-var-driven.** The substrate's `profile.ts` exposes a
 *      fixed flag set; custom flags route through `OK_SWEEP_*` env vars
 *      to keep the substrate clean. Pattern matches the precedent at
 *      `scenarios/memory-per-editor.ts` (which reads `OK_PERF_M1_*`).
 *
 * CLI surface (env vars; profile.ts passes process.env through):
 *
 *   - `OK_SWEEP_FIXTURE`  = `tight | broad | asymmetric | all` (default `all`)
 *   - `OK_SWEEP_STAGE`    = `1 | 2 | 3 | 4 | all` (default `all`; reserved
 *                            for future per-stage runs — always runs the
 *                            full per-cap progression because Stage 2 + 3
 *                            depend on Stage 1's winner)
 *   - `OK_SWEEP_RESUME`   = `1` to enable withCheckpoint resume on the
 *                            stage-keyed checkpoint files
 *   - `OK_SWEEP_PROD_VALIDATION` = `1` to add a verdict-cap-regime
 *                                   validation cell against the configured
 *                                   target (assumed to be a production
 *                                   build)
 *
 * Invocation:
 *
 *     bun run sweep:cache-regime
 *
 *     # Per-fixture run for fast iteration on harness changes:
 *     OK_SWEEP_FIXTURE=tight bun run sweep:cache-regime
 *
 *     # Prod-validation against a `bun run build` output:
 *     OK_SWEEP_PROD_VALIDATION=1 bun run sweep:cache-regime --target=...
 *
 * Outputs:
 *
 *   - `<outDir>/cell-results-<ISO8601>.json` — the canonical
 *     SweepCellResult[] + campaign verdict.
 *   - `<outDir>/sweep-cache-regime.<timestamp>.json` — the standard
 *     scenario result envelope (recordMetric output from `profile.ts`).
 *
 * Cell count (per fixture):
 *
 *   - 1 baseline (MEDIUM cap regime) — runs but is
 *     excluded from `axisCoverage`; its measurement is stored
 *     separately as the architectural floor.
 *   - 6 Stage 1 (MAX_POOL axis)
 *   - 6 Stage 2 (MAX_CACHE axis)
 *   - 4 Stage 3 (ACTIVITY_MOUNT_LIMIT axis)
 *   - 6 Stage 4 (boundary probes)
 *   = 23 cells executed per fixture; 22 in `axisCoverage`
 *     (`outcome.allCells.length`).
 *
 * Across all 3 fixtures: 69 executed, 66 in `axisCoverage`. The post-run
 * drift check uses the `axisCoverage` count (22 per fixture, the
 * canonical campaign-output count).
 */

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

/**
 * Per-fixture cell count expected in `outcome.allCells` (the runner's
 * `axisCoverage` view, which excludes the baseline cell). 6 + 6 + 4 + 6
 * across Stages 1-4. Drift outside ±tolerance fires `ctx.note` so a
 * silent change to the stage axes is surfaced without aborting the run.
 */
const CELL_COUNT_PER_FIXTURE = 22;
const CELL_COUNT_DRIFT_TOLERANCE = 5;

// ─────────────────────────────────────────────────────────────────────────
// Env-var CLI surface
// ─────────────────────────────────────────────────────────────────────────

export interface SweepRunOptions {
  readonly fixtures: ReadonlyArray<WorkloadFixtureRef>;
  readonly stages: ReadonlyArray<SweepStage>;
  readonly resume: boolean;
  readonly prodValidation: boolean;
}

/**
 * Parse OK_SWEEP_* env vars into a typed SweepRunOptions.
 *
 * Mirrors the env-driven config pattern at
 * `scenarios/memory-per-editor.ts` (`OK_PERF_M1_*`). Substrate
 * `profile.ts` has a fixed CLI surface; scenario-specific knobs route
 * through env vars to keep the substrate clean.
 *
 * Throws when an explicit value falls outside the recognized set — silent
 * fallback would mask typos and ship the wrong campaign.
 */
/**
 * Env-var bag accepted by `parseSweepRunOptions`. Stays narrow to the keys
 * the parser reads — using `NodeJS.ProcessEnv` would couple the API to
 * `@types/node`'s readonly NODE_ENV field and require every test to spread
 * a stub env in.
 */
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

/** Resolve a fixture-ref to its concrete WorkloadFixture object. */
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

/**
 * Best-effort host fingerprint from process.env. Engineer-attested values
 * via OK_HOST_CPU + OK_HOST_RAM_GB; defaults to "unknown" + 16 so the
 * record still has a shape on un-configured hosts. The canonical host
 * spec for verdict-PR review comes from the engineer's PR body — this
 * fingerprint is a breadcrumb, not the source of truth.
 */
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

// ─────────────────────────────────────────────────────────────────────────
// Production runCell — drives one cell against a real browser
// ─────────────────────────────────────────────────────────────────────────

export interface BuildRunCellOptions {
  readonly browser: Browser;
  readonly baseTarget: string;
  /**
   * Number of doc-visits the production workload performs per cell. The
   * sweep runner separately replicates cells; this is the per-cell
   * sample count fed into measureCell's p95 + CI computation. Default 20
   * matches Mozilla Talos' replication-with-warmup-discard pattern.
   */
  readonly samplesPerCell?: number;
}

/**
 * Construct the production runCell that drives one sweep cell against a
 * real Playwright browser. Each invocation:
 *
 *   1. Opens a fresh BrowserContext (no state carryover from prior cell).
 *   2. Sets `window.__okPerfOverrides` via addInitScript so the editor
 *      pool/cache init observes the cap regime under test.
 *   3. Navigates to the configured target.
 *   4. Drives the fixture's rotation pattern, pushing latency samples
 *      into the WorkloadDriver via cell-measurement's orchestrator.
 *   5. Closes the context, returns a complete SweepCellResult.
 *
 * The AbortSignal arg is wired to the runner's MOUNT_STALLED_THRESHOLD_MS
 * — a cell that exceeds the threshold gets aborted and recorded as a
 * stuck-mount FAIL by the runner. The production runCell cooperates by
 * checking `signal.aborted` between visits.
 *
 * Per-cell BCa CI: uses a point-CI (lo = hi = estimate) since
 * measureCell rolls samples up to p95 before returning. measureCell
 * can later be extended to expose raw samples for accurate per-cell
 * percentile-bootstrap CIs without changing this signature.
 */
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

    // Cap overrides must arrive BEFORE the renderer reads them at editor-
    // cache + provider-pool module-init time. addInitScript runs on every
    // navigation in this context, which means our subsequent page.goto
    // sees the caps applied.
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

/**
 * Drive the production workload — visit each rotation doc; cold-mount on
 * first visit, warm-reopen on subsequent visits. Hot-pocket fixtures
 * cycle the rotation set; broad fixtures sample sequentially without
 * intentional revisits.
 *
 * The substrate's `window.__ok_open` is the dev-mode hook that triggers
 * doc selection from the renderer. Production cells do not navigate
 * between docs via URL — the SPA stays mounted and switches docs in-place,
 * which is the warm-reopen path under test.
 */
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

/**
 * Translate cell-measurement.ts's rich `CellMeasurement` (with watchpoints +
 * errors + sampleCounts) into the sweep-runner's tighter `VerdictMeasurement`
 * shape (the 11 fields the verdict classifier consumes).
 *
 * `serverMemMb` defaults to 0 here: the renderer-side per-cell measurement
 * doesn't scrape the server. The production scenario layers a separate
 * fetch of the Hocuspocus `/__ok_perf/server-memory` route and replaces
 * the 0 with the captured snapshot at aggregation time. For the smoke-test
 * code path (no installed perf-measurement route) the 0 passes through to
 * the verdict — the `serverAmplificationVerdict` PASS classification at 0
 * MB is correct for the test scenario (no Y.Doc state on the smoke server)
 * but does NOT generalize to a real campaign run.
 */
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

// ─────────────────────────────────────────────────────────────────────────
// Campaign driver — composes the production runCell + sweep-runner
// ─────────────────────────────────────────────────────────────────────────

export interface SweepCampaignOutcome {
  readonly campaign: CampaignVerdict;
  readonly cellResultsPath: string;
  readonly allCells: ReadonlyArray<SweepCellResult>;
}

/**
 * Run the full cap-graduation campaign and write the canonical
 * cell-results-<timestamp>.json to ctx.opts.outDir.
 *
 * Composable: production invocation wires `buildProductionRunCell`; the
 * smoke test wires a synthetic runCell. Both paths flow through the
 * same sweep-runner pipeline so the smoke test exercises the same
 * orchestration code paths as production.
 */
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
    // Vite's dev server binds to localhost AND the loopback IP forms. An
    // engineer targeting --target=http://127.0.0.1:5173 would otherwise
    // bypass the prod-validation gate. 0.0.0.0 catches the `--host`
    // case where the dev server accepts any-iface.
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

// ─────────────────────────────────────────────────────────────────────────
// ScenarioDefinition default export
// ─────────────────────────────────────────────────────────────────────────

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
