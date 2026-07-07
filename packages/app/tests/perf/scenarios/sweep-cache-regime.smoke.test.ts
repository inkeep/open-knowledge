/**
 * Smoke test for the sweep-cache-regime scenario — the first
 * `defineSweep`-class integration test.
 *
 * Scope: exercises the scenario's harness composition end-to-end with
 * a synthetic runCell (no live dev server). Asserts the canonical
 * SweepCellResult shape conforms to the verdict contract; pins
 * the MAX_POOL=5 cell that the scenario calls out specifically.
 *
 * What this test deliberately does NOT cover (engineer-local only):
 *
 *   - Real Playwright/CDP cell execution — requires a live dev server.
 *   - The full ~66-cell campaign wall-time — sweep methodology is
 *     measured on canonical 16 GB+ MacBook hardware, not under CI.
 *   - TipTap leak rate against the baseline — a separate
 *     regression test pins that.
 *
 * The synthetic runCell exercises the same orchestration pipeline as
 * production: each cell flows through the sweep-runner's stage logic,
 * baseline tagging, withCheckpoint (when enabled), and the
 * aggregateCampaign cross-fixture winner selection.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ScenarioCtx, ScenarioOptions } from '../lib/scenario';
import type {
  HostClassFingerprint,
  RunCellFn,
  SweepCellInput,
  SweepCellResult,
  VerdictMeasurement,
} from '../lib/sweep-runner';
import { classifyCellVerdict, runCapGraduationCampaign } from '../lib/sweep-runner';
import scenario, {
  ALL_FIXTURES,
  ALL_STAGES,
  BASELINE_KEY,
  buildProductionRunCell,
  getFixtureByRef,
  parseSweepRunOptions,
  runSweepCampaign,
  SCENARIO_NAME,
} from './sweep-cache-regime';

// ─────────────────────────────────────────────────────────────────────────
// Helpers — synthetic measurement + runCell + ctx
// ─────────────────────────────────────────────────────────────────────────

/**
 * Synthesize a plausible per-cell measurement for the given cap regime.
 *
 * The shape is deterministic in the cap regime so the smoke test's
 * assertions about verdict classification and the MAX_POOL=5
 * cell stay stable across runs. Latency falls as cap rises (cache hit
 * rate goes up) until it plateaus around MAX_POOL=20 — mimics the
 * Pareto-knee shape expected from the campaign.
 */
function synthesizeMeasurement(capRegime: SweepCellInput['capRegime']): VerdictMeasurement {
  const poolHeadroom = Math.min(capRegime.maxPool, 20);
  const cacheHeadroom = Math.min(capRegime.maxCache, 20);
  const warmReopen = Math.max(50, 400 - poolHeadroom * 12);
  const tabSwitchFlip = Math.max(20, 100 - cacheHeadroom * 4);
  return {
    coldMountP95Ms: Math.max(300, 1100 - poolHeadroom * 30),
    warmReopenP95Ms: warmReopen,
    tabSwitchWarmActivityFlipP95Ms: tabSwitchFlip,
    tabSwitchActivityHiddenToVisibleP95Ms: Math.max(80, 240 - cacheHeadroom * 5),
    poolHitRate: poolHeadroom / 20,
    cacheHitRate: cacheHeadroom / 20,
    rendererRssMb: 600 + capRegime.maxCache * 8,
    serverMemMb: 400 + capRegime.maxPool * 12,
    perFrameJankRate: 0.5,
    maxVmPressure: 1,
    tipTapLeakRateMbPerCycle: 17,
  };
}

function syntheticRunCell(): RunCellFn {
  return async (input: SweepCellInput): Promise<SweepCellResult> => {
    const measurement = synthesizeMeasurement(input.capRegime);
    return {
      cellInput: input,
      measurement,
      verdict: classifyCellVerdict(measurement, undefined),
      bootstrapCi: {
        lo: measurement.warmReopenP95Ms - 5,
        hi: measurement.warmReopenP95Ms + 5,
        estimate: measurement.warmReopenP95Ms,
      },
      errors: [],
      durationMs: 1,
      replicationSampleCount: 1,
    };
  };
}

function buildSmokeCtx(outDir: string): {
  ctx: ScenarioCtx;
  metrics: Record<string, number | string | boolean | null>;
  notes: string[];
} {
  const metrics: Record<string, number | string | boolean | null> = {};
  const notes: string[] = [];
  const opts: ScenarioOptions = {
    target: 'http://localhost:5173',
    outDir,
    headed: false,
    viewport: { width: 1440, height: 900 },
  };
  // The smoke test exercises only the scenario's pure-data + sweep-runner
  // composition. Page/CDP/Browser are never touched by the synthetic
  // runCell, so casting an undefined-shaped ctx is safe here.
  const ctx = {
    page: undefined as never,
    context: undefined as never,
    browser: undefined as never,
    cdp: undefined as never,
    opts,
    recordMetric(key: string, value: number | string | boolean | null) {
      metrics[key] = value;
    },
    note(line: string) {
      notes.push(line);
    },
  } satisfies ScenarioCtx;
  return { ctx, metrics, notes };
}

const SMOKE_HOST: HostClassFingerprint = {
  cpuModel: 'apple-m-series-smoke',
  totalRamGb: 16,
  osVersion: 'darwin',
  identifier: 'smoke-16gb-darwin',
};

// ─────────────────────────────────────────────────────────────────────────
// Exports + parseSweepRunOptions
// ─────────────────────────────────────────────────────────────────────────

describe('sweep-cache-regime scenario — module exports', () => {
  it('default-exports a ScenarioDefinition with the canonical name', () => {
    expect(scenario.name).toBe(SCENARIO_NAME);
    expect(scenario.name).toBe('sweep-cache-regime');
    expect(BASELINE_KEY).toBe('sweep-cache-regime');
    expect(typeof scenario.run).toBe('function');
    expect(scenario.description).toBeTruthy();
  });

  it('declares the canonical fixture + stage axes', () => {
    expect(ALL_FIXTURES).toEqual(['tight', 'broad', 'asymmetric']);
    expect(ALL_STAGES).toEqual([1, 2, 3, 4]);
  });

  it('getFixtureByRef returns each canonical fixture with rotationDocs populated', () => {
    for (const ref of ALL_FIXTURES) {
      const f = getFixtureByRef(ref);
      expect(f.ref).toBe(ref);
      expect(f.rotationDocs.length).toBeGreaterThan(0);
      expect(f.vault.length).toBeGreaterThan(0);
    }
  });

  it('exports the production runCell builder', () => {
    expect(typeof buildProductionRunCell).toBe('function');
  });
});

describe('parseSweepRunOptions', () => {
  it('defaults to all fixtures + all stages when env unset', () => {
    const options = parseSweepRunOptions({});
    expect(options.fixtures).toEqual(['tight', 'broad', 'asymmetric']);
    expect(options.stages).toEqual([1, 2, 3, 4]);
    expect(options.resume).toBe(false);
    expect(options.prodValidation).toBe(false);
  });

  it('parses a single fixture override', () => {
    const options = parseSweepRunOptions({ OK_SWEEP_FIXTURE: 'tight' });
    expect(options.fixtures).toEqual(['tight']);
  });

  it('honors the all-keyword for fixtures', () => {
    const options = parseSweepRunOptions({ OK_SWEEP_FIXTURE: 'ALL' });
    expect(options.fixtures).toEqual(['tight', 'broad', 'asymmetric']);
  });

  it('rejects an unknown fixture token', () => {
    expect(() => parseSweepRunOptions({ OK_SWEEP_FIXTURE: 'huge' })).toThrow(
      /tight, broad, asymmetric, all/,
    );
  });

  it('parses a single stage override', () => {
    const options = parseSweepRunOptions({ OK_SWEEP_STAGE: '2' });
    expect(options.stages).toEqual([2]);
  });

  it('rejects an unknown stage token', () => {
    expect(() => parseSweepRunOptions({ OK_SWEEP_STAGE: '7' })).toThrow(/1, 2, 3, 4, all/);
  });

  it('parses resume + prod-validation flags', () => {
    const options = parseSweepRunOptions({
      OK_SWEEP_RESUME: '1',
      OK_SWEEP_PROD_VALIDATION: '1',
    });
    expect(options.resume).toBe(true);
    expect(options.prodValidation).toBe(true);
  });

  it('treats non-"1" values as falsy for boolean flags', () => {
    const options = parseSweepRunOptions({
      OK_SWEEP_RESUME: 'true',
      OK_SWEEP_PROD_VALIDATION: 'yes',
    });
    expect(options.resume).toBe(false);
    expect(options.prodValidation).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// End-to-end with synthetic runCell
// ─────────────────────────────────────────────────────────────────────────

describe('sweep-cache-regime scenario — end-to-end smoke (synthetic runCell)', () => {
  it('produces a well-formed Stage-1 MAX_POOL=5 SweepCellResult for the tight fixture', async () => {
    const campaign = await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell: syntheticRunCell(),
      hostClass: SMOKE_HOST,
    });

    const tightCells = campaign.axisCoverage.get('tight') ?? [];
    expect(tightCells.length).toBeGreaterThan(0);

    const stage1 = tightCells.filter((c) => c.cellInput.stage === 1);
    expect(stage1.length).toBe(6);
    const cell = stage1.find((c) => c.cellInput.capRegime.maxPool === 5);
    expect(cell).toBeDefined();
    if (!cell) return;

    expect(cell.cellInput.capRegime).toEqual({
      maxPool: 5,
      maxCache: 5,
      activityMountLimit: 3,
    });
    expect(cell.cellInput.workloadFixture).toBe('tight');
    expect(cell.cellInput.stage).toBe(1);
    expect(cell.cellInput.isBaseline).toBe(false);

    expect(cell.measurement.coldMountP95Ms).toBeGreaterThan(0);
    expect(cell.measurement.warmReopenP95Ms).toBeGreaterThan(0);
    expect(['CHAMPION', 'WIN', 'PASS', 'FAIL']).toContain(cell.verdict.classification);
    expect(['arch-bounded', 'cap-bounded']).toContain(cell.verdict.archBound);
    expect(['PASS', 'WARN', 'FAIL']).toContain(cell.verdict.memoryCeilingVerdict);
    expect(['PASS', 'WARN', 'FAIL']).toContain(cell.verdict.serverAmplificationVerdict);

    expect(cell.bootstrapCi).toBeDefined();
    expect(cell.bootstrapCi.estimate).toBeGreaterThanOrEqual(0);
    expect(cell.bootstrapCi.lo).toBeLessThanOrEqual(cell.bootstrapCi.estimate);
    expect(cell.bootstrapCi.hi).toBeGreaterThanOrEqual(cell.bootstrapCi.estimate);
    expect(cell.replicationSampleCount).toBeGreaterThanOrEqual(1);
    expect(cell.errors.length).toBe(0);
  });

  it('aggregates a single-fixture campaign verdict with all per-cap stages present', async () => {
    const campaign = await runCapGraduationCampaign({
      fixtures: [{ ref: 'tight' }],
      runCell: syntheticRunCell(),
      hostClass: SMOKE_HOST,
    });

    const cells = campaign.axisCoverage.get('tight') ?? [];
    const byStage = new Map<number, number>();
    for (const cell of cells) {
      byStage.set(cell.cellInput.stage, (byStage.get(cell.cellInput.stage) ?? 0) + 1);
    }
    expect(byStage.get(1)).toBe(6);
    expect(byStage.get(2)).toBe(6);
    expect(byStage.get(3)).toBe(4);
    expect(byStage.get(4)).toBe(6);
    expect(cells.length).toBe(22);

    expect(campaign.winningCapRegime).toBeDefined();
    expect(campaign.winningCapRegime.maxPool).toBeGreaterThan(0);
    expect(campaign.winningCapRegime.maxCache).toBeGreaterThan(0);
    expect(campaign.winningCapRegime.activityMountLimit).toBeGreaterThan(0);
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(campaign.confidence);

    const tightFloor = campaign.archFloors.get('tight');
    expect(tightFloor).toBeDefined();
    expect(tightFloor?.capRegimeUsed).toEqual({
      maxPool: 14,
      maxCache: 14,
      activityMountLimit: 3,
    });
  });

  it('runSweepCampaign writes a cell-results JSON to ctx.opts.outDir and records summary metrics', async () => {
    const outDir = mkdtempSync(resolve(tmpdir(), 'sweep-cache-regime-smoke-'));
    try {
      const { ctx, metrics } = buildSmokeCtx(outDir);
      const outcome = await runSweepCampaign(
        ctx,
        {
          fixtures: ['tight'],
          stages: [1, 2, 3, 4],
          resume: false,
          prodValidation: false,
        },
        syntheticRunCell(),
      );

      expect(outcome.allCells.length).toBe(22);
      expect(outcome.cellResultsPath.startsWith(outDir)).toBe(true);

      const written = JSON.parse(readFileSync(outcome.cellResultsPath, 'utf8')) as {
        schemaVersion: number;
        scenario: string;
        baselineKey: string;
        cells: ReadonlyArray<{ cellInput: { capRegime: { maxPool: number } } }>;
      };
      expect(written.schemaVersion).toBe(1);
      expect(written.scenario).toBe('sweep-cache-regime');
      expect(written.baselineKey).toBe('sweep-cache-regime');
      expect(written.cells.length).toBe(22);

      expect(metrics['sweep.cellCount']).toBe(22);
      expect(metrics['sweep.fixtureCount']).toBe(1);
      expect(typeof metrics['sweep.winningMaxPool']).toBe('number');
      expect(metrics['sweep.cellResultsPath']).toBe(outcome.cellResultsPath);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('thrown runCell on a single cell preserves count via runner synthesis path (no drift note)', async () => {
    const outDir = mkdtempSync(resolve(tmpdir(), 'sweep-cache-regime-drift-'));
    try {
      // Per the runner's contract, a thrown runCell still produces a
      // synthesized FAIL cell with errors[] populated — the campaign's
      // per-fixture cell count stays at the canonical 22. Throwing only
      // on the first cell of Stage 1 leaves the rest of the stage
      // error-free, so findStageWinner has valid cells to pick from
      // and the campaign completes. The all-cells-fail case is covered
      // by the next test (the runner refuses to continue on a zero-valid
      // -cell stage; that's intentional, not a regression).
      const { ctx, notes } = buildSmokeCtx(outDir);
      const outcome = await runSweepCampaign(
        ctx,
        {
          fixtures: ['tight'],
          stages: [1, 2, 3, 4],
          resume: false,
          prodValidation: false,
        },
        async (input: SweepCellInput, signal: AbortSignal): Promise<SweepCellResult> => {
          // Throw on Stage 1's first axis-coverage cell (cellIndex 0) while
          // leaving the baseline cell + every other stage cell error-free.
          // This produces exactly one synthesized FAIL cell in allCells,
          // so findStageWinner still has 5 valid Stage-1 cells to pick a
          // winner from and the campaign completes.
          if (!input.isBaseline && input.stage === 1 && input.cellIndex === 0) {
            throw new Error(`synthetic throw for stage1 cellIndex=${input.cellIndex}`);
          }
          return syntheticRunCell()(input, signal);
        },
      );
      expect(outcome.allCells.length).toBe(22);
      expect(outcome.allCells.some((c) => c.errors.length > 0)).toBe(true);
      expect(notes.filter((n) => n.startsWith('sweep cell count drift'))).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('all-cells-fail in a stage aborts the campaign with an actionable error (no silent zero-winner)', async () => {
    const outDir = mkdtempSync(resolve(tmpdir(), 'sweep-cache-regime-all-fail-'));
    try {
      // When EVERY cell in Stage 1 fails (baseline still succeeds — otherwise
      // the runner's baseline-cell-failure guard would fire earlier),
      // findStageWinner has no valid cells to feed kneedle. The prior
      // implementation returned 0 (which isn't in any cap axis), Stage 2
      // then ran with maxPool=0, and the final verdict emitted a
      // pathological {maxPool: 0, ...} regime. The runner must now abort
      // with a clear stage label so the engineer investigates rather than
      // seeing a phantom verdict.
      const { ctx } = buildSmokeCtx(outDir);
      let caught: Error | null = null;
      try {
        await runSweepCampaign(
          ctx,
          {
            fixtures: ['tight'],
            stages: [1, 2, 3, 4],
            resume: false,
            prodValidation: false,
          },
          async (input: SweepCellInput, signal: AbortSignal): Promise<SweepCellResult> => {
            if (!input.isBaseline && input.stage === 1) {
              throw new Error(`synthetic throw for stage1 cellIndex=${input.cellIndex}`);
            }
            return syntheticRunCell()(input, signal);
          },
        );
      } catch (err) {
        caught = err instanceof Error ? err : new Error(String(err));
      }
      expect(caught).not.toBeNull();
      expect(caught?.message).toMatch(/no error-free cells in stage1/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('baseline-cell failure aborts the campaign before any stage runs (loud, not silent)', async () => {
    const outDir = mkdtempSync(resolve(tmpdir(), 'sweep-cache-regime-baseline-fail-'));
    try {
      // Sibling pin to the all-cells-fail test above. When the baseline
      // cell itself fails, the arch-floor cannot be derived, so the
      // runner refuses to proceed — every downstream cell would otherwise
      // tag `cap-bounded` against a zeroed floor and silently corrupt
      // CampaignVerdict.archFloors. Without this pin, a regression that
      // restored the silent-zero-floor path could slip through under the
      // existing all-stage1-fail test (which exercises a different error
      // surface). See lib/sweep-runner.ts baseline guard.
      const { ctx } = buildSmokeCtx(outDir);
      let nonBaselineCellCount = 0;
      let caught: Error | null = null;
      try {
        await runSweepCampaign(
          ctx,
          {
            fixtures: ['tight'],
            stages: [1, 2, 3, 4],
            resume: false,
            prodValidation: false,
          },
          async (input: SweepCellInput, signal: AbortSignal): Promise<SweepCellResult> => {
            if (input.isBaseline) {
              throw new Error('synthetic baseline failure (Playwright disconnect)');
            }
            nonBaselineCellCount += 1;
            return syntheticRunCell()(input, signal);
          },
        );
      } catch (err) {
        caught = err instanceof Error ? err : new Error(String(err));
      }
      expect(caught).not.toBeNull();
      expect(caught?.message).toMatch(/baseline cell for fixture 'tight' failed/);
      // No stage cells ran — the throw fires before stage1 inputs are
      // constructed.
      expect(nonBaselineCellCount).toBe(0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('prod-validation against a dev-server target surfaces an actionable warning note', async () => {
    const outDir = mkdtempSync(resolve(tmpdir(), 'sweep-cache-regime-prod-dev-'));
    try {
      const { ctx, metrics, notes } = buildSmokeCtx(outDir);
      await runSweepCampaign(
        ctx,
        {
          fixtures: ['tight'],
          stages: [1, 2, 3, 4],
          resume: false,
          prodValidation: true,
        },
        syntheticRunCell(),
      );
      expect(metrics['sweep.prodValidation']).toBe(true);
      const prodNotes = notes.filter((n) => n.includes('prod-validation'));
      expect(prodNotes.length).toBe(1);
      expect(prodNotes[0]).toContain('looks like the dev server');
      expect(prodNotes[0]).toContain('localhost:5173');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('prod-validation flags the loopback-IP dev-server forms (127.0.0.1, 0.0.0.0)', async () => {
    // Vite's dev server binds to both `localhost` and the loopback IP forms.
    // A previous version of the dev-server-detection regex only matched
    // `localhost:5173`, leaving `http://127.0.0.1:5173` and
    // `http://0.0.0.0:5173` as silent prod-validation bypasses.
    for (const target of ['http://127.0.0.1:5173', 'http://0.0.0.0:5173/']) {
      const outDir = mkdtempSync(resolve(tmpdir(), 'sweep-cache-regime-prod-ip-'));
      try {
        const { ctx, notes } = buildSmokeCtx(outDir);
        (ctx.opts as { target: string }).target = target;
        await runSweepCampaign(
          ctx,
          {
            fixtures: ['tight'],
            stages: [1, 2, 3, 4],
            resume: false,
            prodValidation: true,
          },
          syntheticRunCell(),
        );
        const prodNotes = notes.filter((n) => n.includes('prod-validation'));
        expect(prodNotes.length).toBe(1);
        expect(prodNotes[0]).toContain('looks like the dev server');
        expect(prodNotes[0]).toContain(target);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    }
  });

  it('prod-validation against a non-dev target surfaces a confirmation note', async () => {
    const outDir = mkdtempSync(resolve(tmpdir(), 'sweep-cache-regime-prod-real-'));
    try {
      const { ctx, metrics, notes } = buildSmokeCtx(outDir);
      (ctx.opts as { target: string }).target = 'http://prod-build.localtest:5174';
      await runSweepCampaign(
        ctx,
        {
          fixtures: ['tight'],
          stages: [1, 2, 3, 4],
          resume: false,
          prodValidation: true,
        },
        syntheticRunCell(),
      );
      expect(metrics['sweep.prodValidation']).toBe(true);
      const prodNotes = notes.filter((n) => n.includes('prod-validation'));
      expect(prodNotes.length).toBe(1);
      expect(prodNotes[0]).toContain('prod-build.localtest:5174');
      expect(prodNotes[0]).not.toContain('looks like the dev server');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
