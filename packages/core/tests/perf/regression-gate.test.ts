import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { withForcedGc } from './gc.ts';
import {
  ACCEPT_MISMATCH_FLAG,
  type Baseline,
  baselineResultsToolchain,
  checkMethodologyMismatches,
  comparabilityBlockers,
  DataError,
  EXIT_DATA,
  EXIT_INCONCLUSIVE,
  EXIT_USAGE,
  evaluateRegression,
  exitCodeForFailure,
  type FreshResults,
  formatReport,
  loadBaseline,
  loadFreshResults,
} from './regression-gate.ts';
import {
  forcedGcPlumbingFailure,
  InconclusiveError,
  resultsStalenessFailure,
} from './run-regression-gate.ts';

function makeBaseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    schemaVersion: 2,
    capturedAt: '2026-04-16T00:00:00.000Z',
    runnerClass: 'test-fixture',
    capturedUnder: { runtime: 'node@24.19.0', testRunner: 'vitest@4.1.10' },
    calibrationRuns: 5,
    threshold: { floorPct: 0.1, varianceMultiplier: 2 },
    results: [
      {
        blockCount: 100,
        docSizeChars: 20_000,
        parseMs: { p99: 10, p99StdevMs: 0.25 },
        serializeMs: { p99: 2, p99StdevMs: 0.1 },
        roundTripMs: { p99: 12, p99StdevMs: 0.3 },
      },
      {
        blockCount: 1000,
        docSizeChars: 200_000,
        parseMs: { p99: 100, p99StdevMs: 3 },
        serializeMs: { p99: 20, p99StdevMs: 0.8 },
        roundTripMs: { p99: 125, p99StdevMs: 4 },
      },
    ],
    ...overrides,
  };
}

function makeFresh(overrides: Partial<FreshResults> = {}): FreshResults {
  return {
    schemaVersion: 2,
    startedAt: '2026-04-16T01:00:00.000Z',
    finishedAt: '2026-04-16T01:05:00.000Z',
    methodology: { warmupIters: 10, measuredIters: 10, gcBetweenRuns: true },
    toolchain: { runtime: 'node@24.19.0', testRunner: 'vitest@4.1.10' },
    runner: {},
    results: [
      {
        blockCount: 100,
        docSizeChars: 20_000,
        parseMs: { mean: 9, min: 8, max: 10, p50: 9, p95: 10, p99: 10 },
        serializeMs: { mean: 1.8, min: 1.7, max: 2, p50: 1.8, p95: 2, p99: 2 },
        roundTripMs: { mean: 11, min: 10, max: 12, p50: 11, p95: 12, p99: 12 },
      },
      {
        blockCount: 1000,
        docSizeChars: 200_000,
        parseMs: { mean: 90, min: 85, max: 100, p50: 90, p95: 100, p99: 100 },
        serializeMs: { mean: 18, min: 16, max: 20, p50: 18, p95: 20, p99: 20 },
        roundTripMs: { mean: 110, min: 100, max: 125, p50: 110, p95: 125, p99: 125 },
      },
    ],
    ...overrides,
  };
}

describe('checkMethodologyMismatches', () => {
  const METHODOLOGY = { warmupIters: 10, measuredIters: 10, gcBetweenRuns: true };

  test('matching methodology produces no warnings', () => {
    const warnings = checkMethodologyMismatches(
      makeBaseline({ methodology: METHODOLOGY }),
      makeFresh({ methodology: METHODOLOGY }),
    );
    expect(warnings).toEqual([]);
  });

  test('a fresh run with GC disabled warns, and names the flag that re-enables it', () => {
    const warnings = checkMethodologyMismatches(
      makeBaseline({ methodology: METHODOLOGY }),
      makeFresh({ methodology: { ...METHODOLOGY, gcBetweenRuns: false } }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('gcBetweenRuns');
    expect(warnings[0].message).toContain('--expose-gc');
  });

  test('a different measured-iteration count warns', () => {
    const warnings = checkMethodologyMismatches(
      makeBaseline({ methodology: METHODOLOGY }),
      makeFresh({ methodology: { ...METHODOLOGY, measuredIters: 100 } }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('measuredIters');
  });

  test('both differing produces both warnings', () => {
    const warnings = checkMethodologyMismatches(
      makeBaseline({ methodology: METHODOLOGY }),
      makeFresh({ methodology: { warmupIters: 10, measuredIters: 20, gcBetweenRuns: false } }),
    );
    expect(warnings).toHaveLength(2);
  });

  test('a baseline without recorded methodology produces no warnings', () => {
    const warnings = checkMethodologyMismatches(
      makeBaseline(),
      makeFresh({ methodology: { ...METHODOLOGY, gcBetweenRuns: false } }),
    );
    expect(warnings).toEqual([]);
  });

  test('FreshResults.methodology is required at the type level', () => {
    // @ts-expect-error methodology is required on FreshResults; the silent no-warning path is unreachable
    const invalid: FreshResults = { ...makeFresh(), methodology: undefined };
    expect(invalid.methodology).toBeUndefined();
  });

  test('a baseline without a methodology block still compares, which is the surviving optional side', () => {
    const warnings = checkMethodologyMismatches(
      makeBaseline({ methodology: undefined }),
      makeFresh({ methodology: METHODOLOGY }),
    );
    expect(warnings).toEqual([]);
  });
});

describe('evaluateRegression (R4 synthetic gate)', () => {
  test('identity fresh run matches baseline ⇒ PASS', () => {
    const baseline = makeBaseline();
    const fresh = makeFresh();
    const report = evaluateRegression(baseline, fresh);
    expect(report.pass).toBe(true);
    expect(report.rows.every((r) => !r.regression)).toBe(true);
    expect(report.missingFresh).toEqual([]);
    expect(report.extraFresh).toEqual([]);
  });

  test('fresh run within 10% floor ⇒ PASS (floor dominates)', () => {
    const baseline = makeBaseline();
    const fresh = makeFresh();
    fresh.results[1].parseMs.p99 = 109;
    const report = evaluateRegression(baseline, fresh);
    expect(report.pass).toBe(true);
    const row = report.rows.find((r) => r.blockCount === 1000 && r.op === 'parseMs');
    expect(row?.regression).toBe(false);
    expect(row?.allowedDeltaMs).toBeCloseTo(10, 6);
  });

  test('fresh run beyond 10% floor ⇒ FAIL with offending row identified', () => {
    const baseline = makeBaseline();
    const fresh = makeFresh();
    fresh.results[1].parseMs.p99 = 115;
    const report = evaluateRegression(baseline, fresh);
    expect(report.pass).toBe(false);
    const row = report.rows.find((r) => r.blockCount === 1000 && r.op === 'parseMs');
    expect(row?.regression).toBe(true);
    expect(row?.deltaMs).toBeCloseTo(15, 6);
    expect(row?.allowedDeltaMs).toBeCloseTo(10, 6);
    const otherRegressions = report.rows.filter(
      (r) => r.regression && !(r.blockCount === 1000 && r.op === 'parseMs'),
    );
    expect(otherRegressions).toEqual([]);
  });

  test('variance term dominates on noisy baseline (2σ > floor)', () => {
    const baseline = makeBaseline({
      results: [
        {
          blockCount: 1000,
          docSizeChars: 200_000,
          parseMs: { p99: 100, p99StdevMs: 10 },
          serializeMs: { p99: 20, p99StdevMs: 0.8 },
          roundTripMs: { p99: 125, p99StdevMs: 4 },
        },
      ],
    });
    const fresh = makeFresh({
      results: [
        {
          blockCount: 1000,
          docSizeChars: 200_000,
          parseMs: { mean: 115, min: 110, max: 115, p50: 115, p95: 115, p99: 115 },
          serializeMs: { mean: 18, min: 16, max: 20, p50: 18, p95: 20, p99: 20 },
          roundTripMs: { mean: 110, min: 100, max: 125, p50: 110, p95: 125, p99: 125 },
        },
      ],
    });
    const report = evaluateRegression(baseline, fresh);
    expect(report.pass).toBe(true);
    const row = report.rows.find((r) => r.blockCount === 1000 && r.op === 'parseMs');
    expect(row?.allowedDeltaMs).toBeCloseTo(20, 6);
    expect(row?.regression).toBe(false);
  });

  test('missing block count in fresh ⇒ FAIL via missingFresh', () => {
    const baseline = makeBaseline();
    const fresh = makeFresh();
    fresh.results = fresh.results.filter((r) => r.blockCount !== 1000);
    const report = evaluateRegression(baseline, fresh);
    expect(report.pass).toBe(false);
    expect(report.missingFresh).toEqual([1000]);
    const blockCountsWithRows = new Set(report.rows.map((r) => r.blockCount));
    expect(blockCountsWithRows.has(100)).toBe(true);
    expect(blockCountsWithRows.has(1000)).toBe(false);
  });

  test('extra block count in fresh ⇒ reported but not fatal', () => {
    const baseline = makeBaseline();
    const fresh = makeFresh();
    fresh.results.push({
      blockCount: 5000,
      docSizeChars: 1_000_000,
      parseMs: { mean: 500, min: 480, max: 520, p50: 500, p95: 520, p99: 520 },
      serializeMs: { mean: 100, min: 90, max: 110, p50: 100, p95: 110, p99: 110 },
      roundTripMs: { mean: 620, min: 600, max: 650, p50: 620, p95: 650, p99: 650 },
    });
    const report = evaluateRegression(baseline, fresh);
    expect(report.pass).toBe(true);
    expect(report.extraFresh).toEqual([5000]);
  });

  test('regressions across multiple (blockCount, op) tuples are all reported', () => {
    const baseline = makeBaseline();
    const fresh = makeFresh();
    fresh.results[0].parseMs.p99 = 13;
    fresh.results[1].serializeMs.p99 = 28;
    const report = evaluateRegression(baseline, fresh);
    expect(report.pass).toBe(false);
    const regressed = report.rows
      .filter((r) => r.regression)
      .map((r) => `${r.blockCount}.${r.op}`)
      .sort();
    expect(regressed).toEqual(['100.parseMs', '1000.serializeMs']);
  });

  test('formatReport renders PASS/FAIL + per-row markers', () => {
    const baseline = makeBaseline();
    const fresh = makeFresh();
    fresh.results[0].parseMs.p99 = 13;
    const report = evaluateRegression(baseline, fresh);
    const text = formatReport(report);
    expect(text.startsWith('perf regression gate: FAIL')).toBe(true);
    expect(text).toContain('✗');
    expect(text).toContain('100');
    expect(text).toContain('parseMs');
  });
});

describe('loadBaseline / loadFreshResults finite-value validation', () => {
  function writeTmp(name: string, data: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'regression-gate-load-'));
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(data));
    return path;
  }

  test('loadBaseline rejects NaN p99', () => {
    const baseline = makeBaseline();
    baseline.results[0].parseMs.p99 = Number.NaN;
    const path = writeTmp('baseline.json', baseline);
    expect(() => loadBaseline(path)).toThrow(/parseMs\.p99 is not finite/);
  });

  test('loadBaseline rejects Infinity p99StdevMs', () => {
    const baseline = makeBaseline();
    baseline.results[1].serializeMs.p99StdevMs = Number.POSITIVE_INFINITY;
    const path = writeTmp('baseline.json', baseline);
    expect(() => loadBaseline(path)).toThrow(/serializeMs\.p99StdevMs is not finite/);
  });

  test('loadFreshResults rejects NaN p95', () => {
    const fresh = makeFresh();
    fresh.results[0].parseMs.p95 = Number.NaN;
    const path = writeTmp('results.json', fresh);
    expect(() => loadFreshResults(path)).toThrow(/parseMs\.p95 is not finite/);
  });

  test('RED: a string blockCount in the baseline is rejected rather than joining to nothing', () => {
    const baseline = makeBaseline();
    const path = writeTmp('baseline.json', {
      ...baseline,
      results: [{ ...baseline.results[0], blockCount: '100' }, baseline.results[1]],
    });
    expect(() => loadBaseline(path)).toThrow(DataError);
    expect(() => loadBaseline(path)).toThrow(
      /results\[0\]\.blockCount must be a finite number \(got "100"\)\. blockCount is the key baseline rows are joined to fresh rows on/,
    );
  });

  test('a string blockCount would otherwise have been reported as a regression, not as bad data', () => {
    const baseline = makeBaseline();
    const corrupt: Baseline = {
      ...baseline,
      results: [
        // @ts-expect-error blockCount is a number in the type; a hand-edited baseline.json can carry a string
        { ...baseline.results[0], blockCount: '100' },
        baseline.results[1],
      ],
    };
    const report = evaluateRegression(corrupt, makeFresh());
    expect(report.missingFresh).toEqual(['100']);
    expect(report.pass).toBe(false);
  });

  test('RED: a non-object results entry is rejected before anything dereferences it', () => {
    const baseline = makeBaseline();
    const bare = writeTmp('baseline.json', { ...baseline, results: [42, baseline.results[1]] });
    expect(() => loadBaseline(bare)).toThrow(DataError);
    expect(() => loadBaseline(bare)).toThrow(/results\[0\] must be an object \(got 42\)/);
    const nulled = writeTmp('baseline.json', { ...baseline, results: [null, baseline.results[1]] });
    expect(() => loadBaseline(nulled)).toThrow(DataError);
    expect(() => loadBaseline(nulled)).toThrow(/results\[0\] must be an object \(got null\)/);
    const arrayed = writeTmp('baseline.json', { ...baseline, results: [[], baseline.results[1]] });
    expect(() => loadBaseline(arrayed)).toThrow(DataError);
    expect(() => loadBaseline(arrayed)).toThrow(/results\[0\] must be an object \(got \[\]\)/);
  });

  test('RED: a docSizeChars that is not a number is rejected in both loaders', () => {
    const baseline = makeBaseline();
    const withStringSize = {
      ...baseline,
      results: [baseline.results[0], { ...baseline.results[1], docSizeChars: '200000' }],
    };
    expect(() => loadBaseline(writeTmp('baseline.json', withStringSize))).toThrow(
      /results\[1\]\.docSizeChars must be a finite number \(got "200000"\)\. docSizeChars is provenance the comparator never reads/,
    );
    const fresh = makeFresh();
    fresh.results[0].docSizeChars = Number.NaN;
    expect(() => loadFreshResults(writeTmp('results.json', fresh))).toThrow(
      /results\[0\]\.docSizeChars must be a finite number \(got null\)\. docSizeChars is provenance the comparator never reads/,
    );
  });

  test('loadBaseline accepts a valid baseline', () => {
    const path = writeTmp('baseline.json', makeBaseline());
    expect(() => loadBaseline(path)).not.toThrow();
  });

  test('loadFreshResults accepts a valid results file', () => {
    const path = writeTmp('results.json', makeFresh());
    expect(() => loadFreshResults(path)).not.toThrow();
  });
});

const PERF_DIR = import.meta.dirname;
const COMMITTED_BASELINE_PATH = join(PERF_DIR, 'baseline.json');

type OpKey = 'parseMs' | 'serializeMs' | 'roundTripMs';

function freshFromBaseline(
  baseline: Baseline,
  scale: Partial<Record<OpKey, number>> = {},
  overrides: Partial<FreshResults> = {},
): FreshResults {
  return {
    schemaVersion: 2,
    startedAt: '2026-09-04T00:00:00.000Z',
    finishedAt: '2026-09-04T00:10:00.000Z',
    methodology: { warmupIters: 10, measuredIters: 10, gcBetweenRuns: true },
    toolchain: { runtime: 'node@24.19.0', testRunner: 'vitest@4.1.10' },
    runner: {},
    results: baseline.results.map((entry) => {
      const op = (name: OpKey) => {
        const p99 = entry[name].p99 * (scale[name] ?? 1);
        return { mean: p99 * 0.8, min: p99 * 0.7, max: p99, p50: p99 * 0.8, p95: p99 * 0.95, p99 };
      };
      return {
        blockCount: entry.blockCount,
        docSizeChars: entry.docSizeChars,
        parseMs: op('parseMs'),
        serializeMs: op('serializeMs'),
        roundTripMs: op('roundTripMs'),
      };
    }),
    ...overrides,
  };
}

function regressedParseBlockCounts(baseline: Baseline, scale: number): number[] {
  return evaluateRegression(baseline, freshFromBaseline(baseline, { parseMs: scale }))
    .rows.filter((r) => r.op === 'parseMs' && r.regression)
    .map((r) => r.blockCount)
    .sort((a, b) => a - b);
}

describe('committed baseline.json as the gate substrate', () => {
  const baseline = loadBaseline(COMMITTED_BASELINE_PATH);

  test('the committed baseline loads and records the provenance of its results', () => {
    expect(baseline.results).toHaveLength(5);
    expect(baseline.capturedUnder).toEqual({ runtime: 'bun@1.3.11', testRunner: 'bun test' });
    expect(baseline.targetToolchain).toEqual({
      runtime: 'node@24.19.0',
      testRunner: 'vitest@4.1.10',
    });
    expect(baselineResultsToolchain(baseline)?.runtime).toBe('bun@1.3.11');
  });

  test('a fresh run identical to the committed baseline passes', () => {
    const report = evaluateRegression(baseline, freshFromBaseline(baseline));
    expect(report.pass).toBe(true);
    expect(report.missingFresh).toEqual([]);
    expect(report.rows.filter((r) => r.regression)).toEqual([]);
  });

  test('parse p99 raised 9% passes on 0 of the 5 parse rows', () => {
    const report = evaluateRegression(baseline, freshFromBaseline(baseline, { parseMs: 1.09 }));
    expect(report.pass).toBe(true);
    expect(regressedParseBlockCounts(baseline, 1.09)).toEqual([]);
  });

  test('parse p99 raised 11% fails on the 4 of 5 parse rows the 10% floor governs', () => {
    const report = evaluateRegression(baseline, freshFromBaseline(baseline, { parseMs: 1.11 }));
    expect(report.pass).toBe(false);
    expect(regressedParseBlockCounts(baseline, 1.11)).toEqual([1000, 5000, 10000, 20000]);
    const smallest = report.rows.find((r) => r.blockCount === 100 && r.op === 'parseMs');
    expect(smallest?.regression).toBe(false);
    expect(smallest?.allowedDeltaMs).toBeCloseTo(1.78, 6);
    expect(report.rows.filter((r) => r.op !== 'parseMs' && r.regression)).toEqual([]);
  });

  test('parse p99 raised 20% fails on all 5 parse rows, including the variance-governed one', () => {
    expect(regressedParseBlockCounts(baseline, 1.2)).toEqual([100, 1000, 5000, 10000, 20000]);
  });
});

describe('toolchain provenance warning', () => {
  const baseline = loadBaseline(COMMITTED_BASELINE_PATH);

  test('a node/vitest run against the bun-era committed results warns and names both toolchains', () => {
    const warnings = checkMethodologyMismatches(baseline, freshFromBaseline(baseline));
    const toolchainWarnings = warnings.filter((w) => w.kind === 'toolchain');
    expect(toolchainWarnings).toHaveLength(1);
    expect(toolchainWarnings[0].message).toContain('bun@1.3.11');
    expect(toolchainWarnings[0].message).toContain('bun test');
    expect(toolchainWarnings[0].message).toContain('node@24.19.0');
    expect(toolchainWarnings[0].message).toContain('vitest@4.1.10');
  });

  test('a fresh run under the same toolchain as the results produces no toolchain warning', () => {
    const fresh = freshFromBaseline(
      baseline,
      {},
      {
        toolchain: { runtime: 'bun@1.3.11', testRunner: 'bun test' },
      },
    );
    expect(checkMethodologyMismatches(baseline, fresh)).toEqual([]);
  });

  test('RED: a schemaVersion 1 baseline is rejected, because `toolchain` meant something else there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-baseline-schema-'));
    const path = join(dir, 'baseline.json');
    const legacy = { ...makeBaseline(), schemaVersion: 1 };
    writeFileSync(path, JSON.stringify(legacy));
    expect(() => loadBaseline(path)).toThrow(/schemaVersion must be 2/);
  });

  test('RED: targetToolchain without capturedUnder is rejected as unrecorded provenance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-baseline-schema-'));
    const path = join(dir, 'baseline.json');
    const { capturedUnder: _dropped, ...noProvenance } = makeBaseline();
    writeFileSync(
      path,
      JSON.stringify({
        ...noProvenance,
        targetToolchain: { runtime: 'node@24.19.0', testRunner: 'vitest@4.1.10' },
      }),
    );
    expect(() => loadBaseline(path)).toThrow(/capturedUnder must be an object declaring runtime/);
  });

  test('RED: the version-1 `toolchain` spelling under schemaVersion 2 is rejected, not silently accepted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-baseline-schema-'));
    const path = join(dir, 'baseline.json');
    const { capturedUnder, ...rest } = makeBaseline();
    writeFileSync(path, JSON.stringify({ ...rest, toolchain: capturedUnder }));
    expect(() => loadBaseline(path)).toThrow(/capturedUnder must be an object declaring runtime/);
    expect(() => loadBaseline(path)).toThrow(/version-1 `toolchain` key/);
  });

  test('RED: capturedUnder null is rejected the same way absence is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-baseline-schema-'));
    const path = join(dir, 'baseline.json');
    writeFileSync(path, JSON.stringify({ ...makeBaseline(), capturedUnder: null }));
    expect(() => loadBaseline(path)).toThrow(/capturedUnder must be an object declaring runtime/);
  });

  test('RED: a baseline with no provenance at all is rejected, so no run can be silently comparable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-baseline-schema-'));
    const path = join(dir, 'baseline.json');
    const { capturedUnder: _c, targetToolchain: _t, ...stripped } = makeBaseline();
    writeFileSync(path, JSON.stringify(stripped));
    expect(() => loadBaseline(path)).toThrow(/capturedUnder must be an object declaring runtime/);
  });

  for (const [label, value] of [
    ['an empty string', ''],
    ['false', false],
    ['zero', 0],
    ['an array', []],
    ['an empty object', {}],
    ['an object whose fields are empty strings', { runtime: '', testRunner: '' }],
  ] as const) {
    test(`RED: capturedUnder as ${label} is rejected, not carried through as silent provenance`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'perf-baseline-schema-'));
      const path = join(dir, 'baseline.json');
      writeFileSync(path, JSON.stringify({ ...makeBaseline(), capturedUnder: value }));
      expect(() => loadBaseline(path)).toThrow(/capturedUnder must be an object declaring runtime/);
    });
  }

  test('RED: a results file with no toolchain is rejected, so a foreign capture cannot compare silently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-fresh-schema-'));
    const path = join(dir, 'results.json');
    const { toolchain: _dropped, ...bare } = makeFresh();
    writeFileSync(path, JSON.stringify(bare));
    expect(() => loadFreshResults(path)).toThrow(/toolchain must be an object declaring runtime/);
  });

  test('RED: a version-1 results file is rejected on the VERSION, not on a field version 1 never had', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-fresh-schema-'));
    const path = join(dir, 'results.json');
    const { toolchain: _dropped, ...preToolchain } = makeFresh();
    writeFileSync(path, JSON.stringify({ ...preToolchain, schemaVersion: 1 }));
    expect(() => loadFreshResults(path)).toThrow(/results\.json schemaVersion must be 2/);
    expect(() => loadFreshResults(path)).toThrow(/declares no `toolchain`/);
    expect(() => loadFreshResults(path)).not.toThrow(/renumbering it to 2/);
  });

  test('a version-2 results file carrying toolchain loads, so the bump is not a blanket rejection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-fresh-schema-'));
    const path = join(dir, 'results.json');
    writeFileSync(path, JSON.stringify(makeFresh()));
    const loaded = loadFreshResults(path);
    expect(loaded.schemaVersion).toBe(2);
    expect(loaded.toolchain).toEqual({ runtime: 'node@24.19.0', testRunner: 'vitest@4.1.10' });
  });

  test('RED: a version-1 results file that already declares a toolchain is told to renumber, not to re-capture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-fresh-schema-'));
    const path = join(dir, 'results.json');
    writeFileSync(path, JSON.stringify({ ...makeFresh(), schemaVersion: 1 }));
    expect(() => loadFreshResults(path)).toThrow(/results\.json schemaVersion must be 2/);
    expect(() => loadFreshResults(path)).toThrow(/renumbering it to 2 preserves/);
    expect(() => loadFreshResults(path)).not.toThrow(/declares no `toolchain`/);
  });

  for (const [label, value] of [
    ['an empty object', {}],
    ['a bare string', 'node@24.19.0'],
    ['an array', []],
    ['null', null],
    ['an object whose fields are empty strings', { runtime: '', testRunner: '' }],
  ] as const) {
    test(`RED: a version-1 results file whose toolchain is ${label} is told to re-capture, not to renumber`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'perf-fresh-schema-'));
      const path = join(dir, 'results.json');
      writeFileSync(path, JSON.stringify({ ...makeFresh(), schemaVersion: 1, toolchain: value }));
      expect(() => loadFreshResults(path)).toThrow(/declares no `toolchain`/);
      expect(() => loadFreshResults(path)).not.toThrow(/renumbering it to 2/);
    });
  }

  test('FreshResults.schemaVersion is the literal 2 at the type level', () => {
    // @ts-expect-error schemaVersion is pinned to 2; a version-1 capture is not a FreshResults
    const invalid: FreshResults = { ...makeFresh(), schemaVersion: 1 };
    expect(invalid.schemaVersion).toBe(1);
  });

  test('RED: a results file with no methodology block is rejected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-fresh-schema-'));
    const path = join(dir, 'results.json');
    const { methodology: _dropped, ...bare } = makeFresh();
    writeFileSync(path, JSON.stringify(bare));
    expect(() => loadFreshResults(path)).toThrow(/methodology must be an object recording/);
  });

  for (const [label, threshold] of [
    ['an empty object', {}],
    ['a missing floorPct', { varianceMultiplier: 2 }],
    ['a non-finite varianceMultiplier', { floorPct: 0.1, varianceMultiplier: Number.NaN }],
  ] as const) {
    test(`RED: threshold with ${label} is rejected rather than computing an NaN allowance`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'perf-baseline-threshold-'));
      const path = join(dir, 'baseline.json');
      writeFileSync(path, JSON.stringify({ ...makeBaseline(), threshold }));
      expect(() => loadBaseline(path)).toThrow(
        /must be a finite number|threshold must be an object/,
      );
    });
  }

  test('NEGATIVE: a 50x slower run against a well-formed threshold still FAILS', () => {
    const baseline = loadBaseline(COMMITTED_BASELINE_PATH);
    const report = evaluateRegression(baseline, freshFromBaseline(baseline, { parseMs: 50 }));
    expect(report.pass).toBe(false);
  });

  test('RED: capturedUnder equal to targetToolchain is rejected as a finished re-baseline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-baseline-schema-'));
    const path = join(dir, 'baseline.json');
    const same = { runtime: 'node@24.19.0', testRunner: 'vitest@4.1.10' };
    writeFileSync(
      path,
      JSON.stringify(makeBaseline({ capturedUnder: same, targetToolchain: { ...same } })),
    );
    expect(() => loadBaseline(path)).toThrow(/capturedUnder equals targetToolchain/);
  });

  test('NEGATIVE: capturedUnder alone, and capturedUnder differing from targetToolchain, both load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-baseline-schema-'));
    const soloPath = join(dir, 'solo.json');
    writeFileSync(
      soloPath,
      JSON.stringify(makeBaseline({ capturedUnder: { runtime: 'node@24.19.0' } })),
    );
    expect(loadBaseline(soloPath).capturedUnder?.runtime).toBe('node@24.19.0');
    expect(loadBaseline(COMMITTED_BASELINE_PATH).capturedUnder?.runtime).toBe('bun@1.3.11');
  });

  test('a re-baselined file carries capturedUnder alone and warns only on a real change', () => {
    const rebaselined = makeBaseline({
      capturedUnder: { runtime: 'node@24.19.0', testRunner: 'vitest@4.1.10' },
    });
    expect(baselineResultsToolchain(rebaselined)?.runtime).toBe('node@24.19.0');
    expect(checkMethodologyMismatches(rebaselined, freshFromBaseline(rebaselined))).toEqual([]);
    const stale = freshFromBaseline(
      rebaselined,
      {},
      {
        toolchain: { runtime: 'node@22.0.0', testRunner: 'vitest@4.1.10' },
      },
    );
    expect(checkMethodologyMismatches(rebaselined, stale)).toHaveLength(1);
  });

  test('FreshResults.toolchain is required at the type level', () => {
    // @ts-expect-error toolchain is required on FreshResults; the silent no-warning path is unreachable
    const invalid: FreshResults = { ...freshFromBaseline(baseline), toolchain: undefined };
    expect(invalid.toolchain).toBeUndefined();
  });
});

describe('resultsStalenessFailure', () => {
  const SPAWNED_AT = 1_000_000;

  test('NEGATIVE: a capture written after the spawn is not stale', () => {
    expect(
      resultsStalenessFailure([{ f: 'results.1.json', mtimeMs: SPAWNED_AT + 1 }], SPAWNED_AT),
    ).toBeNull();
  });

  test('BOUNDARY: a capture written exactly at the spawn instant counts as this run', () => {
    expect(
      resultsStalenessFailure([{ f: 'results.1.json', mtimeMs: SPAWNED_AT }], SPAWNED_AT),
    ).toBeNull();
  });

  test('RED: a capture older than the spawn names RUN_BENCH as the propagation suspect', () => {
    const failure = resultsStalenessFailure(
      [{ f: 'results.old.json', mtimeMs: SPAWNED_AT - 1 }],
      SPAWNED_AT,
    );
    expect(failure).toMatch(/predates the bench spawn/);
    expect(failure).toMatch(/RUN_BENCH/);
  });

  test('RED: an empty directory names the missing capture rather than grading nothing', () => {
    expect(resultsStalenessFailure([], SPAWNED_AT)).toMatch(/no results\.\*\.json found/);
  });

  test('the freshest entry wins regardless of directory order, so a stale sibling cannot mask it', () => {
    const entries = [
      { f: 'results.old.json', mtimeMs: SPAWNED_AT - 5000 },
      { f: 'results.new.json', mtimeMs: SPAWNED_AT + 10 },
    ];
    expect(resultsStalenessFailure(entries, SPAWNED_AT)).toBeNull();
    expect(resultsStalenessFailure([...entries].reverse(), SPAWNED_AT)).toBeNull();
  });

  test('an InconclusiveError is what the orchestrator maps onto EXIT_INCONCLUSIVE', () => {
    expect(new InconclusiveError('x')).toBeInstanceOf(Error);
    expect(EXIT_INCONCLUSIVE).not.toBe(EXIT_DATA);
    expect(EXIT_INCONCLUSIVE).not.toBe(EXIT_USAGE);
    expect([EXIT_INCONCLUSIVE, EXIT_DATA, EXIT_USAGE]).not.toContain(1);
  });
});

describe('forcedGcPlumbingFailure', () => {
  const captured = (gcBetweenRuns: boolean | undefined) =>
    ({
      ...makeFresh(),
      methodology:
        gcBetweenRuns === undefined
          ? undefined
          : { warmupIters: 10, measuredIters: 10, gcBetweenRuns },
    }) as FreshResults;

  test('NEGATIVE: a capture that recorded forced GC is not a plumbing failure', () => {
    expect(forcedGcPlumbingFailure(captured(true))).toBeNull();
  });

  test('RED: a capture that recorded gcBetweenRuns=false names the plumbing', () => {
    expect(forcedGcPlumbingFailure(captured(false))).toMatch(
      /--expose-gc did not reach the worker/,
    );
  });

  test('RED: an ABSENT methodology block is a failure, not a silent pass', () => {
    expect(forcedGcPlumbingFailure(captured(undefined))).toMatch(/no methodology block/);
  });
});

describe('the standalone comparator CLI surfaces methodology warnings and refuses a verdict', () => {
  function runEntryPoint(
    script: string,
    extraArgs: string[] = [],
  ): { status: number | null; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'perf-entrypoint-'));
    const freshPath = join(dir, 'fresh.json');
    writeFileSync(
      freshPath,
      JSON.stringify(freshFromBaseline(loadBaseline(COMMITTED_BASELINE_PATH))),
    );
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', join(PERF_DIR, script), COMMITTED_BASELINE_PATH, freshPath, ...extraArgs],
      { cwd: join(PERF_DIR, '..', '..'), encoding: 'utf8', timeout: 30_000 },
    );
    if (result.error) {
      throw new Error(
        `spawn of ${script} failed (${result.signal ?? 'no signal'}): ${result.error.message}`,
      );
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  test('the standalone comparator CLI warns that the committed results are bun-era', () => {
    const { stderr } = runEntryPoint('regression-gate.ts');
    expect(stderr).toContain('toolchain mismatch');
    expect(stderr).toContain('bun@1.3.11');
  }, 60_000);

  test('RED: an unreadable baseline exits EXIT_DATA with the validator message, not a stack on 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-baddata-'));
    const badPath = join(dir, 'baseline.json');
    writeFileSync(badPath, JSON.stringify({ ...makeBaseline(), capturedUnder: {} }));
    const freshPath = join(dir, 'fresh.json');
    writeFileSync(
      freshPath,
      JSON.stringify(freshFromBaseline(loadBaseline(COMMITTED_BASELINE_PATH))),
    );
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', join(PERF_DIR, 'regression-gate.ts'), badPath, freshPath],
      { cwd: join(PERF_DIR, '..', '..'), encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(EXIT_DATA);
    expect(result.stderr).toContain('capturedUnder must be an object declaring runtime');
    expect(result.stderr).not.toMatch(/^\s+at /m);
  }, 60_000);

  function runComparator(baselinePath: string, freshPath: string) {
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', join(PERF_DIR, 'regression-gate.ts'), baselinePath, freshPath],
      { cwd: join(PERF_DIR, '..', '..'), encoding: 'utf8', timeout: 30_000 },
    );
    if (result.error) throw result.error;
    return result;
  }

  function badInputFixtures() {
    const dir = mkdtempSync(join(tmpdir(), 'perf-badinput-'));
    const freshPath = join(dir, 'fresh.json');
    writeFileSync(
      freshPath,
      JSON.stringify(freshFromBaseline(loadBaseline(COMMITTED_BASELINE_PATH))),
    );
    const write = (name: string, body: string) => {
      const p = join(dir, name);
      writeFileSync(p, body);
      return p;
    };
    const committed = JSON.parse(readFileSync(COMMITTED_BASELINE_PATH, 'utf8'));
    const missingStats = structuredClone(committed);
    delete missingStats.results[0].parseMs;
    return {
      freshPath,
      nonexistent: join(dir, 'never-written.json'),
      truncated: write('truncated.json', '{ "schemaVersion": 2, '),
      notAnObject: write('array.json', '[1, 2, 3]'),
      missingStats: write('nostats.json', JSON.stringify(missingStats)),
    };
  }

  test('RED: every unreadable-input shape exits EXIT_DATA with a named message and no stack', () => {
    const f = badInputFixtures();
    for (const [label, path, expected] of [
      ['a nonexistent path', f.nonexistent, /cannot read/],
      ['truncated JSON', f.truncated, /is not valid JSON/],
      ['a JSON array instead of an object', f.notAnObject, /must contain a JSON object/],
      ['a results row missing an op block', f.missingStats, /is missing its parseMs stats block/],
    ] as const) {
      const result = runComparator(path, f.freshPath);
      expect(result.status, `${label} should exit EXIT_DATA\n${result.stderr}`).toBe(EXIT_DATA);
      expect(result.stderr, `${label} should name the problem`).toMatch(expected);
      expect(result.stderr, `${label} should not dump a stack`).not.toMatch(/^\s+at /m);
    }
  }, 120_000);

  test('the failure classifier routes unreadable input to EXIT_DATA and rethrows everything else', () => {
    expect(exitCodeForFailure(new DataError('baseline.json: cannot read'))).toBe(EXIT_DATA);
    for (const internal of [
      new TypeError('an invariant inside the gate broke'),
      new RangeError('index out of bounds'),
      new Error('plain failure'),
    ]) {
      expect(
        exitCodeForFailure(internal),
        `${internal.constructor.name} is an internal fault: it must rethrow so its stack survives, ` +
          'not be reported to the operator as unreadable input',
      ).toBeNull();
    }
  });

  test('RED: an incomparable run exits INCONCLUSIVE rather than PASS/0', () => {
    const { status, stdout, stderr } = runEntryPoint('regression-gate.ts');
    expect(status).toBe(EXIT_INCONCLUSIVE);
    expect(stderr).toContain('INCONCLUSIVE');
    expect(stdout).toContain('perf regression gate');
  }, 60_000);

  test('NEGATIVE: the escape hatch restores the PASS verdict on the same inputs', () => {
    const { status, stderr } = runEntryPoint('regression-gate.ts', [ACCEPT_MISMATCH_FLAG]);
    expect(status).toBe(0);
    expect(stderr).toContain('toolchain mismatch');
    expect(stderr).not.toContain('INCONCLUSIVE');
  }, 60_000);

  test('NEGATIVE: a comparable run needs no escape hatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-comparable-'));
    const baseline = loadBaseline(COMMITTED_BASELINE_PATH);
    const baselinePath = join(dir, 'baseline.json');
    const freshPath = join(dir, 'fresh.json');
    const { targetToolchain: _dropped, ...rest } = baseline;
    writeFileSync(
      baselinePath,
      JSON.stringify({
        ...rest,
        capturedUnder: { runtime: 'node@24.19.0', testRunner: 'vitest@4.1.10' },
      }),
    );
    writeFileSync(freshPath, JSON.stringify(freshFromBaseline(baseline)));
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', join(PERF_DIR, 'regression-gate.ts'), baselinePath, freshPath],
      { cwd: join(PERF_DIR, '..', '..'), encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.stderr).not.toContain('INCONCLUSIVE');
    expect(result.status).toBe(0);
  }, 60_000);
});

describe('p50 and p95 are recorded alongside p99', () => {
  test('every row carries the fresh p50/p95 while the verdict stays on p99', () => {
    const baseline = makeBaseline();
    const fresh = makeFresh();
    const report = evaluateRegression(baseline, fresh);
    const row = report.rows.find((r) => r.blockCount === 1000 && r.op === 'parseMs');
    expect(row?.freshP50).toBe(90);
    expect(row?.freshP95).toBe(100);
    expect(row?.regression).toBe(false);
  });

  test('baseline p50/p95 are carried when the baseline records them and omitted when it does not', () => {
    const withPercentiles = makeBaseline({
      results: [
        {
          blockCount: 100,
          docSizeChars: 20_000,
          parseMs: { p99: 10, p99StdevMs: 0.25, p50: 8, p95: 9.5 },
          serializeMs: { p99: 2, p99StdevMs: 0.1 },
          roundTripMs: { p99: 12, p99StdevMs: 0.3 },
        },
      ],
    });
    const rows = evaluateRegression(withPercentiles, makeFresh()).rows;
    const parse = rows.find((r) => r.op === 'parseMs');
    expect(parse?.baselineP50).toBe(8);
    expect(parse?.baselineP95).toBe(9.5);
    const serialize = rows.find((r) => r.op === 'serializeMs');
    expect(serialize?.baselineP50).toBeUndefined();
    expect(serialize?.baselineP95).toBeUndefined();
  });

  test('formatReport prints the fresh percentiles and the baseline pair when recorded', () => {
    const withPercentiles = makeBaseline({
      results: [
        {
          blockCount: 100,
          docSizeChars: 20_000,
          parseMs: { p99: 10, p99StdevMs: 0.25, p50: 8, p95: 9.5 },
          serializeMs: { p99: 2, p99StdevMs: 0.1 },
          roundTripMs: { p99: 12, p99StdevMs: 0.3 },
        },
      ],
    });
    const text = formatReport(evaluateRegression(withPercentiles, makeFresh()));
    expect(text).toContain('p50=9.00ms p95=10.00ms');
    expect(text).toContain('(baseline p50=8.00ms p95=9.50ms)');
    const serializeLine = text.split('\n').find((line) => line.includes('serializeMs'));
    expect(serializeLine).toContain('p50=1.80ms p95=2.00ms');
    expect(serializeLine).not.toContain('baseline p50=');
  });

  test('a baseline recording a non-finite p50 is rejected at load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'regression-gate-percentiles-'));
    const path = join(dir, 'baseline.json');
    const baseline = makeBaseline();
    baseline.results[0].parseMs.p50 = Number.NaN;
    writeFileSync(path, JSON.stringify(baseline));
    expect(() => loadBaseline(path)).toThrow(/parseMs\.p50 is not finite/);
  });
});

describe('forced GC is the default bench invocation', () => {
  function probeGcInSpawnedNode(nodeArgs: string[]): string {
    const result = spawnSync(
      process.execPath,
      [
        ...nodeArgs,
        '--input-type=module',
        '-e',
        `import { gcAvailable } from ${JSON.stringify(join(PERF_DIR, 'gc.ts'))}; process.stdout.write(String(gcAvailable()));`,
      ],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 15_000 },
    );
    if (result.error) {
      throw new Error(
        `gc probe spawn failed (${result.signal ?? 'no signal'}): ${result.error.message}`,
      );
    }
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }

  test('a node process without --expose-gc reports no forced GC', () => {
    expect(probeGcInSpawnedNode([])).toBe('false');
  });

  test('a node process with --expose-gc reports forced GC', () => {
    expect(probeGcInSpawnedNode(['--expose-gc'])).toBe('true');
  });

  test('withForcedGc adds the flag, preserves existing NODE_OPTIONS, and is idempotent', () => {
    expect(withForcedGc({}).NODE_OPTIONS).toBe('--expose-gc');
    expect(withForcedGc({ NODE_OPTIONS: '--max-old-space-size=4096' }).NODE_OPTIONS).toBe(
      '--max-old-space-size=4096 --expose-gc',
    );
    expect(withForcedGc({ NODE_OPTIONS: '--expose-gc' }).NODE_OPTIONS).toBe('--expose-gc');
    expect(withForcedGc({ RUN_BENCH: '1' }).RUN_BENCH).toBe('1');
  });

  test('the core test:perf:bench script forces GC', () => {
    const pkg = JSON.parse(readFileSync(join(PERF_DIR, '..', '..', 'package.json'), 'utf8'));
    expect(pkg.scripts['test:perf:bench']).toContain('--expose-gc');
    expect(pkg.scripts['test:perf:bench']).toContain('RUN_BENCH=1');
  });

  test('the bench records the GC state it actually ran under', () => {
    const bench = readFileSync(join(PERF_DIR, 'markdown-bench.test.ts'), 'utf8');
    expect(bench).toContain('const GC_FORCED = gcAvailable();');
    expect(bench).toContain('gcBetweenRuns: GC_FORCED,');
  });

  test('the regression orchestrator spawns the bench with forced GC', () => {
    const orchestrator = readFileSync(join(PERF_DIR, 'run-regression-gate.ts'), 'utf8');
    expect(orchestrator).toContain("env: withForcedGc({ ...process.env, RUN_BENCH: '1' })");
  });

  test('a fresh run without forced GC is flagged against the committed baseline', () => {
    const baseline = loadBaseline(COMMITTED_BASELINE_PATH);
    const fresh = freshFromBaseline(
      baseline,
      {},
      {
        methodology: { warmupIters: 10, measuredIters: 10, gcBetweenRuns: false },
      },
    );
    const warnings = checkMethodologyMismatches(baseline, fresh);
    const gcWarnings = warnings.filter((w) => w.kind === 'gc-regime');
    expect(gcWarnings).toHaveLength(1);
    expect(gcWarnings[0].message).toContain('fresh gcBetweenRuns=false');
    expect(gcWarnings[0].message).toContain('--expose-gc');
    expect(comparabilityBlockers(warnings).length).toBeGreaterThan(0);
    expect(comparabilityBlockers(warnings)).toContain(gcWarnings[0]);
  });

  test('an iteration-count mismatch warns but is deliberately NOT a comparability blocker', () => {
    const baseline = loadBaseline(COMMITTED_BASELINE_PATH);
    const fresh = freshFromBaseline(
      baseline,
      {},
      {
        methodology: { warmupIters: 10, measuredIters: 40, gcBetweenRuns: true },
        toolchain: { runtime: 'bun@1.3.11', testRunner: 'bun test' },
      },
    );
    const warnings = checkMethodologyMismatches(baseline, fresh);
    expect(warnings.filter((w) => w.kind === 'iteration-count')).toHaveLength(1);
    expect(comparabilityBlockers(warnings)).toEqual([]);
  });
});

function opStats(
  mean: number,
  min: number,
  max: number,
  p50: number,
  p95: number,
  p99: number,
): { mean: number; min: number; max: number; p50: number; p95: number; p99: number } {
  return { mean, min, max, p50, p95, p99 };
}

const CALIBRATION_CAPTURE_1: FreshResults = {
  schemaVersion: 2,
  startedAt: '2026-09-04T12:20:15.610Z',
  finishedAt: '2026-09-04T12:24:39.000Z',
  methodology: { warmupIters: 10, measuredIters: 10, gcBetweenRuns: true },
  toolchain: { runtime: 'node@24.19.0', testRunner: 'vitest@4.1.10' },
  runner: { runnerClass: 'local-m-series-calibration' },
  results: [
    {
      blockCount: 100,
      docSizeChars: 20293,
      parseMs: opStats(22.78, 21.76, 23.34, 23.01, 23.34, 23.34),
      serializeMs: opStats(3.82, 3.24, 4.86, 3.81, 4.86, 4.86),
      roundTripMs: opStats(26.0, 25.03, 27.08, 26.02, 27.08, 27.08),
    },
    {
      blockCount: 1000,
      docSizeChars: 194243,
      parseMs: opStats(173.46, 168.62, 179.25, 174.62, 179.25, 179.25),
      serializeMs: opStats(28.55, 26.38, 30.84, 28.59, 30.84, 30.84),
      roundTripMs: opStats(198.17, 190.58, 206.49, 198.6, 206.49, 206.49),
    },
    {
      blockCount: 5000,
      docSizeChars: 952068,
      parseMs: opStats(858.23, 838.26, 882.04, 860.69, 882.04, 882.04),
      serializeMs: opStats(116.83, 109.4, 125.21, 115.74, 125.21, 125.21),
      roundTripMs: opStats(940.96, 909.94, 968.7, 938.71, 968.7, 968.7),
    },
    {
      blockCount: 10000,
      docSizeChars: 1902300,
      parseMs: opStats(1770.17, 1752.23, 1817.97, 1765.8, 1817.97, 1817.97),
      serializeMs: opStats(212.92, 206.64, 223.86, 210.3, 223.86, 223.86),
      roundTripMs: opStats(2000.19, 1973.64, 2023.4, 2003.95, 2023.4, 2023.4),
    },
    {
      blockCount: 20000,
      docSizeChars: 3837177,
      parseMs: opStats(4625.82, 4565.56, 4694.37, 4620.68, 4694.37, 4694.37),
      serializeMs: opStats(424.5, 411.92, 437.56, 420.32, 437.56, 437.56),
      roundTripMs: opStats(5223.79, 5095.89, 5302.72, 5240.68, 5302.72, 5302.72),
    },
  ],
};

const CALIBRATION_CAPTURE_2: FreshResults = {
  schemaVersion: 2,
  startedAt: '2026-09-04T12:24:49.393Z',
  finishedAt: '2026-09-04T12:29:25.000Z',
  methodology: { warmupIters: 10, measuredIters: 10, gcBetweenRuns: true },
  toolchain: { runtime: 'node@24.19.0', testRunner: 'vitest@4.1.10' },
  runner: { runnerClass: 'local-m-series-calibration' },
  results: [
    {
      blockCount: 100,
      docSizeChars: 20293,
      parseMs: opStats(22.68, 20.75, 24.44, 22.69, 24.44, 24.44),
      serializeMs: opStats(3.58, 3.0, 4.46, 3.55, 4.46, 4.46),
      roundTripMs: opStats(25.3, 23.82, 26.2, 25.83, 26.2, 26.2),
    },
    {
      blockCount: 1000,
      docSizeChars: 194243,
      parseMs: opStats(164.29, 157.63, 171.97, 164.2, 171.97, 171.97),
      serializeMs: opStats(26.52, 24.16, 28.38, 26.99, 28.38, 28.38),
      roundTripMs: opStats(191.85, 184.05, 199.62, 191.75, 199.62, 199.62),
    },
    {
      blockCount: 5000,
      docSizeChars: 952068,
      parseMs: opStats(838.32, 817.42, 899.96, 835.3, 899.96, 899.96),
      serializeMs: opStats(115.95, 110.76, 122.85, 114.27, 122.85, 122.85),
      roundTripMs: opStats(922.31, 884.99, 974.84, 927.15, 974.84, 974.84),
    },
    {
      blockCount: 10000,
      docSizeChars: 1902300,
      parseMs: opStats(1739.65, 1715.93, 1771.42, 1749.17, 1771.42, 1771.42),
      serializeMs: opStats(207.65, 200.59, 216.24, 206.62, 216.24, 216.24),
      roundTripMs: opStats(1975.12, 1937.2, 2152.98, 1960.42, 2152.98, 2152.98),
    },
    {
      blockCount: 20000,
      docSizeChars: 3837177,
      parseMs: opStats(5321.17, 5116.1, 5470.61, 5342.77, 5470.61, 5470.61),
      serializeMs: opStats(467.29, 452.19, 505.48, 462.36, 505.48, 505.48),
      roundTripMs: opStats(5589.69, 5458.21, 5788.72, 5585.02, 5788.72, 5788.72),
    },
  ],
};

const CONTENDED_FOUR_RUN_AGGREGATE: Baseline = {
  schemaVersion: 2,
  capturedAt: '2026-09-04T12:20:15.610Z',
  runnerClass: 'local-m-series-calibration',
  methodology: { warmupIters: 10, measuredIters: 10, gcBetweenRuns: true },
  capturedUnder: { runtime: 'node@24.19.0', testRunner: 'vitest@4.1.10' },
  calibrationRuns: 4,
  threshold: { floorPct: 0.1, varianceMultiplier: 2 },
  results: [
    {
      blockCount: 100,
      docSizeChars: 20293,
      parseMs: { p99: 37.45, p99StdevMs: 21.3 },
      serializeMs: { p99: 7.07, p99StdevMs: 3.99 },
      roundTripMs: { p99: 48.36, p99StdevMs: 36.61 },
    },
    {
      blockCount: 1000,
      docSizeChars: 194243,
      parseMs: { p99: 398.44, p99StdevMs: 280.31 },
      serializeMs: { p99: 47.92, p99StdevMs: 23.11 },
      roundTripMs: { p99: 365.25, p99StdevMs: 187.32 },
    },
    {
      blockCount: 5000,
      docSizeChars: 952068,
      parseMs: { p99: 1338.45, p99StdevMs: 581.95 },
      serializeMs: { p99: 217.89, p99StdevMs: 127.8 },
      roundTripMs: { p99: 1271.04, p99StdevMs: 356.18 },
    },
    {
      blockCount: 10000,
      docSizeChars: 1902300,
      parseMs: { p99: 3572.92, p99StdevMs: 2466.94 },
      serializeMs: { p99: 258.39, p99StdevMs: 71.11 },
      roundTripMs: { p99: 2220.6, p99StdevMs: 207.23 },
    },
    {
      blockCount: 20000,
      docSizeChars: 3837177,
      parseMs: { p99: 5167.96, p99StdevMs: 463.46 },
      serializeMs: { p99: 468.86, p99StdevMs: 33.64 },
      roundTripMs: { p99: 10325.58, p99StdevMs: 6599.79 },
    },
  ],
};

function sampleStdev(a: number, b: number): number {
  const mean = (a + b) / 2;
  return Math.sqrt((a - mean) ** 2 + (b - mean) ** 2);
}

function baselineFromCapturePair(first: FreshResults, second: FreshResults): Baseline {
  return {
    schemaVersion: 2,
    capturedAt: first.startedAt,
    runnerClass: 'local-m-series-calibration',
    methodology: { warmupIters: 10, measuredIters: 10, gcBetweenRuns: true },
    capturedUnder: { runtime: 'node@24.19.0', testRunner: 'vitest@4.1.10' },
    calibrationRuns: 2,
    threshold: { floorPct: 0.1, varianceMultiplier: 2 },
    results: first.results.map((row) => {
      const other = second.results.find((r) => r.blockCount === row.blockCount);
      if (!other) throw new Error(`capture pair disagrees on block count ${row.blockCount}`);
      const op = (name: 'parseMs' | 'serializeMs' | 'roundTripMs') => ({
        p99: row[name].p99,
        p99StdevMs: sampleStdev(row[name].p99, other[name].p99),
        p50: row[name].p50,
        p95: row[name].p95,
      });
      return {
        blockCount: row.blockCount,
        docSizeChars: row.docSizeChars,
        parseMs: op('parseMs'),
        serializeMs: op('serializeMs'),
        roundTripMs: op('roundTripMs'),
      };
    }),
  };
}

function scaleCapture(capture: FreshResults, scale: number): FreshResults {
  return {
    ...capture,
    results: capture.results.map((row) => ({
      ...row,
      parseMs: { ...row.parseMs, p99: row.parseMs.p99 * scale },
      serializeMs: { ...row.serializeMs, p99: row.serializeMs.p99 * scale },
      roundTripMs: { ...row.roundTripMs, p99: row.roundTripMs.p99 * scale },
    })),
  };
}

function uniformlyScaledFresh(baseline: Baseline, scale: number): FreshResults {
  return {
    schemaVersion: 2,
    startedAt: '2026-09-04T13:00:00.000Z',
    finishedAt: '2026-09-04T13:05:00.000Z',
    methodology: { warmupIters: 10, measuredIters: 10, gcBetweenRuns: true },
    toolchain: { runtime: 'node@24.19.0', testRunner: 'vitest@4.1.10' },
    runner: {},
    results: baseline.results.map((row) => {
      const op = (name: 'parseMs' | 'serializeMs' | 'roundTripMs') => {
        const p99 = row[name].p99 * scale;
        return { mean: p99, min: p99, max: p99, p50: p99, p95: p99, p99 };
      };
      return {
        blockCount: row.blockCount,
        docSizeChars: row.docSizeChars,
        parseMs: op('parseMs'),
        serializeMs: op('serializeMs'),
        roundTripMs: op('roundTripMs'),
      };
    }),
  };
}

function regressedRowCount(baseline: Baseline, fresh: FreshResults): number {
  return evaluateRegression(baseline, fresh).rows.filter((r) => r.regression).length;
}

describe('node-era calibration captures (R7 re-capture)', () => {
  const quietPairGate = baselineFromCapturePair(CALIBRATION_CAPTURE_1, CALIBRATION_CAPTURE_2);

  test('a gate built from calibration capture 1 does not fail on capture 2', () => {
    const report = evaluateRegression(quietPairGate, CALIBRATION_CAPTURE_2);
    expect(report.pass).toBe(true);
    expect(report.missingFresh).toEqual([]);
    expect(report.rows).toHaveLength(15);
    expect(report.rows.filter((r) => r.regression)).toEqual([]);
  });

  test('that same gate reds 7 of its 15 rows when capture 2 is raised 11 percent', () => {
    const report = evaluateRegression(quietPairGate, scaleCapture(CALIBRATION_CAPTURE_2, 1.11));
    expect(report.pass).toBe(false);
    expect(report.rows.filter((r) => r.regression)).toHaveLength(7);
  });

  test('that same gate reds all 15 rows when capture 2 is raised 30 percent', () => {
    expect(regressedRowCount(quietPairGate, scaleCapture(CALIBRATION_CAPTURE_2, 1.3))).toBe(15);
  });

  test('the captures record forced GC and the node toolchain', () => {
    for (const capture of [CALIBRATION_CAPTURE_1, CALIBRATION_CAPTURE_2]) {
      expect(capture.methodology?.gcBetweenRuns).toBe(true);
      expect(capture.toolchain).toEqual({ runtime: 'node@24.19.0', testRunner: 'vitest@4.1.10' });
    }
  });

  test('every capture row reports p95 equal to p99, so p99 at 10 iterations is the maximum', () => {
    for (const capture of [CALIBRATION_CAPTURE_1, CALIBRATION_CAPTURE_2]) {
      for (const row of capture.results) {
        for (const op of ['parseMs', 'serializeMs', 'roundTripMs'] as const) {
          expect(row[op].p95).toBe(row[op].p99);
          expect(row[op].p99).toBe(row[op].max);
        }
      }
    }
  });

  test('aggregating the contended four-run calibration produces a gate that cannot fire', () => {
    expect(
      regressedRowCount(
        CONTENDED_FOUR_RUN_AGGREGATE,
        uniformlyScaledFresh(CONTENDED_FOUR_RUN_AGGREGATE, 1.11),
      ),
    ).toBe(0);
    expect(
      regressedRowCount(
        CONTENDED_FOUR_RUN_AGGREGATE,
        uniformlyScaledFresh(CONTENDED_FOUR_RUN_AGGREGATE, 2),
      ),
    ).toBe(7);
    expect(
      regressedRowCount(
        CONTENDED_FOUR_RUN_AGGREGATE,
        uniformlyScaledFresh(CONTENDED_FOUR_RUN_AGGREGATE, 3),
      ),
    ).toBe(15);
  });

  test('the contended aggregate carries a variance band wider than the ten percent floor everywhere', () => {
    const bands = CONTENDED_FOUR_RUN_AGGREGATE.results.flatMap((row) =>
      (['parseMs', 'serializeMs', 'roundTripMs'] as const).map(
        (op) => (2 * row[op].p99StdevMs) / row[op].p99,
      ),
    );
    expect(bands).toHaveLength(15);
    expect(Math.min(...bands)).toBeGreaterThan(0.1);
    expect(Math.max(...bands)).toBeGreaterThan(1.5);
  });

  test('the committed baseline results are not replaced by this calibration', () => {
    const committed = loadBaseline(COMMITTED_BASELINE_PATH);
    const smallestParse = committed.results.find((r) => r.blockCount === 100)?.parseMs;
    expect(smallestParse).toEqual({ p99: 9.69, p99StdevMs: 0.89 });
    expect(committed.calibrationRuns).toBe(4);
    expect(committed.capturedAt).toBe('2026-04-16T08:28:01.616Z');
  });
});
