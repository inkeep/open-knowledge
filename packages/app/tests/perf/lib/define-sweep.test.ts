import { describe, expect, test } from 'bun:test';
import { cartesian, defineSweep } from './define-sweep';
import type { ScenarioCtx } from './scenario';

interface FakeMetricsCtx {
  ctx: ScenarioCtx;
  __metrics: Record<string, number | string | boolean | null>;
}

function makeFakeCtx(): FakeMetricsCtx {
  const metrics: Record<string, number | string | boolean | null> = {};
  const ctx = {
    page: {} as ScenarioCtx['page'],
    context: {} as ScenarioCtx['context'],
    browser: {} as ScenarioCtx['browser'],
    cdp: {} as ScenarioCtx['cdp'],
    opts: {} as ScenarioCtx['opts'],
    recordMetric(key: string, value: number | string | boolean | null) {
      metrics[key] = value;
    },
    note(_line: string) {},
  } satisfies ScenarioCtx;
  return { ctx, __metrics: metrics };
}

describe('cartesian', () => {
  test('multi-axis Cartesian product cardinality and ordering', () => {
    const cells = cartesian({
      a: [1, 2, 3] as const,
      b: ['x', 'y'] as const,
      c: [true, false] as const,
    });
    expect(cells.length).toBe(12);
    expect(cells[0]).toEqual({ a: 1, b: 'x', c: true });
    expect(cells[11]).toEqual({ a: 3, b: 'y', c: false });
  });

  test('single-axis sweep produces N cells', () => {
    const cells = cartesian({ n: [1, 2, 3, 4] as const });
    expect(cells).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
  });

  test('zero-axis sweep produces a single empty cell', () => {
    const cells = cartesian({});
    expect(cells).toEqual([{}]);
  });
});

describe('defineSweep', () => {
  test('runs the scenario once per cell with the typed axes-values', async () => {
    const calls: Array<{ a: number; b: string }> = [];
    const sweep = defineSweep({
      name: 'sweep-multi',
      baselineKey: 'sweep-multi',
      axes: { a: [1, 2] as const, b: ['x', 'y'] as const },
      scenario: async (axesValues) => {
        calls.push({ ...axesValues });
        return { ok: true };
      },
    });
    const fake = makeFakeCtx();
    await sweep.run(fake.ctx);
    expect(calls.length).toBe(4);
    expect(fake.__metrics['sweep.sweep-multi.cells']).toBe(4);
    const payload = JSON.parse(String(fake.__metrics['sweep.sweep-multi.payload']));
    expect(payload.name).toBe('sweep-multi');
    expect(payload.baselineKey).toBe('sweep-multi');
    expect(payload.cells.length).toBe(4);
    expect(payload.cells[0].axesValues).toEqual({ a: 1, b: 'x' });
    expect(payload.cells[0].result).toEqual({ ok: true });
    expect(typeof payload.cells[0].durationMs).toBe('number');
  });

  test('per-cell error does NOT abort the sweep — captured in cell.errors[]', async () => {
    const sweep = defineSweep({
      name: 'sweep-err',
      baselineKey: 'sweep-err',
      axes: { n: [1, 2, 3] as const },
      scenario: async ({ n }) => {
        if (n === 2) throw new Error('cell-2-fault');
        return { value: n };
      },
    });
    const fake = makeFakeCtx();
    await sweep.run(fake.ctx);
    const payload = JSON.parse(String(fake.__metrics['sweep.sweep-err.payload']));
    expect(payload.cells.length).toBe(3);
    const errCell = payload.cells.find((c: { axesValues: { n: number } }) => c.axesValues.n === 2);
    expect(errCell?.errors?.[0]).toContain('cell-2-fault');
    const okCells = payload.cells.filter(
      (c: { axesValues: { n: number } }) => c.axesValues.n !== 2,
    );
    expect(okCells.length).toBe(2);
    for (const c of okCells) expect(c.result).toBeDefined();
  });

  test('returns a defineScenario-shaped definition with name + run', () => {
    const sweep = defineSweep({
      name: 'sweep-shape',
      baselineKey: 'sweep-shape',
      axes: { x: [1] as const },
      scenario: async () => ({}),
    });
    expect(sweep.name).toBe('sweep-shape');
    expect(typeof sweep.run).toBe('function');
  });
});
