/**
 * `defineSweep` — promotes the Cartesian-product sweep pattern
 * to a first-class harness primitive.
 *
 * Earlier campaigns hand-rolled
 * their axis-iteration boilerplate (~300 LOC each) — fan out over
 * `axes`, run a per-cell scenario, aggregate. This module collapses
 * that to one call:
 *
 *     export default defineSweep({
 *       name: 'sweep-pool-warm-back',
 *       baselineKey: 'sweep-pool-warm-back',
 *       axes: {
 *         maxPool: [3, 5, 8, 10] as const,
 *         fixture: ['tight', 'broad'] as const,
 *       },
 *       scenario: async ({ maxPool, fixture }, ctx) => {
 *         await ctx.page.evaluate((mp) => {
 *           window.__okPerfOverrides = { MAX_POOL: mp };
 *         }, maxPool);
 *         await runOneCell(ctx, fixture);
 *         return { fixture };
 *       },
 *     });
 *
 * Output schema:
 *   {
 *     name, baselineKey, axes,
 *     cells: [{ axesValues, result, durationMs, errors? }, ...]
 *   }
 *
 * Cell results are indexed in iteration order (Object.entries(axes) →
 * Cartesian product). A throwing per-cell scenario does NOT abort the
 * sweep — the error is captured in that cell's `errors[]` and the
 * sweep continues. Caller decides whether any error is fatal.
 *
 * Non-Cartesian patterns: if the campaign needs an
 * adaptive or skip-criterion sweep, opt out and use `defineScenario`
 * directly. This primitive shoulders the common case.
 */

import { defineScenario, type ScenarioCtx, type ScenarioDefinition } from './scenario';

/** A single cell's input — the (key → value) tuple for this point in the sweep. */
export type AxesValues<TAxes extends Record<string, readonly unknown[]>> = {
  [K in keyof TAxes]: TAxes[K][number];
};

export interface SweepCellResult<TAxes extends Record<string, readonly unknown[]>, TResult> {
  axesValues: AxesValues<TAxes>;
  result: TResult | undefined;
  durationMs: number;
  errors?: string[];
}

export interface SweepOutput<TAxes extends Record<string, readonly unknown[]>, TResult> {
  name: string;
  baselineKey: string;
  axes: TAxes;
  cells: Array<SweepCellResult<TAxes, TResult>>;
}

export interface DefineSweepOpts<TAxes extends Record<string, readonly unknown[]>, TResult> {
  name: string;
  description?: string;
  baselineKey: string;
  axes: TAxes;
  scenario: (axesValues: AxesValues<TAxes>, ctx: ScenarioCtx) => Promise<TResult>;
}

/**
 * Compute the Cartesian product of `axes`. Iteration order: outer = the
 * first axis declared; inner = the last. (e.g. axes={a:[1,2], b:[x,y]}
 * → [[1,x],[1,y],[2,x],[2,y]].)
 */
export function cartesian<TAxes extends Record<string, readonly unknown[]>>(
  axes: TAxes,
): Array<AxesValues<TAxes>> {
  const keys = Object.keys(axes) as Array<keyof TAxes>;
  if (keys.length === 0) return [{} as AxesValues<TAxes>];
  let cells: Array<Partial<AxesValues<TAxes>>> = [{}];
  for (const key of keys) {
    const values = axes[key];
    const next: Array<Partial<AxesValues<TAxes>>> = [];
    for (const cell of cells) {
      for (const v of values) {
        next.push({ ...cell, [key]: v });
      }
    }
    cells = next;
  }
  return cells as Array<AxesValues<TAxes>>;
}

export function defineSweep<TAxes extends Record<string, readonly unknown[]>, TResult>(
  opts: DefineSweepOpts<TAxes, TResult>,
): ScenarioDefinition {
  const { name, description, axes, baselineKey, scenario } = opts;
  return defineScenario({
    name,
    description: description ?? `Cartesian sweep over ${Object.keys(axes).length} axes (${name})`,
    async run(ctx: ScenarioCtx): Promise<void> {
      const cells: Array<SweepCellResult<TAxes, TResult>> = [];
      for (const axesValues of cartesian(axes)) {
        const startMs = performance.now();
        const errors: string[] = [];
        let result: TResult | undefined;
        try {
          result = await scenario(axesValues, ctx);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
        const durationMs = performance.now() - startMs;
        cells.push({
          axesValues,
          result,
          durationMs,
          ...(errors.length > 0 ? { errors } : {}),
        });
      }
      const output: SweepOutput<TAxes, TResult> = {
        name,
        baselineKey,
        axes,
        cells,
      };
      // Stash on the ctx.metrics record so the scenario driver picks
      // it up. Standard scenarios merge ctx.metrics into the result
      // JSON; we store one JSON-serialized blob keyed by baselineKey.
      ctx.recordMetric(`sweep.${baselineKey}.cells`, cells.length);
      ctx.recordMetric(`sweep.${baselineKey}.payload`, JSON.stringify(output));
    },
  });
}
