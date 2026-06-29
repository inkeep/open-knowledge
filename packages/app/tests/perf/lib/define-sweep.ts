import { defineScenario, type ScenarioCtx, type ScenarioDefinition } from './scenario';

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
      ctx.recordMetric(`sweep.${baselineKey}.cells`, cells.length);
      ctx.recordMetric(`sweep.${baselineKey}.payload`, JSON.stringify(output));
    },
  });
}
