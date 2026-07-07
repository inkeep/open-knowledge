/**
 * regression-gate synthetic-regression tests.
 *
 * The gate fires when
 * an artificial slowdown is injected. Rather than run the full benchmark
 * harness with an injected delay (minutes-long), we exercise the gate's
 * comparison logic directly against synthesised fresh results — the gate
 * IS the comparison logic.
 *
 * These tests are deterministic, pure-logic, sub-millisecond, and live
 * next to the gate library. They validate:
 *   1. baseline identity ⇒ PASS
 *   2. within-threshold drift (≤ floor) ⇒ PASS
 *   3. beyond-threshold drift (> floor + variance) ⇒ FAIL with a row
 *      naming the offending (blockCount, op)
 *   4. missing block count in fresh ⇒ FAIL in `missingFresh`
 *   5. extra block count in fresh ⇒ reported but not fatal
 *   6. variance-term dominance on noisy baselines
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Baseline,
  evaluateRegression,
  type FreshResults,
  formatReport,
  loadBaseline,
  loadFreshResults,
} from './regression-gate.ts';

function makeBaseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    schemaVersion: 1,
    capturedAt: '2026-04-16T00:00:00.000Z',
    runnerClass: 'test-fixture',
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
    schemaVersion: 1,
    startedAt: '2026-04-16T01:00:00.000Z',
    finishedAt: '2026-04-16T01:05:00.000Z',
    methodology: { warmupIters: 10, measuredIters: 10, gcBetweenRuns: true },
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
    // baseline parse p99 at 1K = 100ms; floor = 10ms; variance term = 2×3 = 6ms
    // floor dominates (10 > 6). A fresh p99 of 109ms is inside the floor.
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
    // 1K parse: floor = 10ms, variance = 6ms ⇒ allowed = 10ms. Inject 15ms slowdown.
    const fresh = makeFresh();
    fresh.results[1].parseMs.p99 = 115;
    const report = evaluateRegression(baseline, fresh);
    expect(report.pass).toBe(false);
    const row = report.rows.find((r) => r.blockCount === 1000 && r.op === 'parseMs');
    expect(row?.regression).toBe(true);
    expect(row?.deltaMs).toBeCloseTo(15, 6);
    expect(row?.allowedDeltaMs).toBeCloseTo(10, 6);
    // All other rows clean — failure should be scoped, not global.
    const otherRegressions = report.rows.filter(
      (r) => r.regression && !(r.blockCount === 1000 && r.op === 'parseMs'),
    );
    expect(otherRegressions).toEqual([]);
  });

  test('variance term dominates on noisy baseline (2σ > floor)', () => {
    // If the baseline captured high stdev (noisy runner), 2σ > 10% floor ⇒
    // the gate tolerates more drift. Inject baseline with stdev=10ms at p99=100ms:
    //   floor = 10ms; 2σ = 20ms ⇒ allowed = 20ms.
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
    // 15ms slowdown is within 20ms allowance.
    expect(row?.regression).toBe(false);
  });

  test('missing block count in fresh ⇒ FAIL via missingFresh', () => {
    const baseline = makeBaseline();
    const fresh = makeFresh();
    // drop 1000 from fresh
    fresh.results = fresh.results.filter((r) => r.blockCount !== 1000);
    const report = evaluateRegression(baseline, fresh);
    expect(report.pass).toBe(false);
    expect(report.missingFresh).toEqual([1000]);
    // Rows only exist for matched block counts.
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
    // 30% slowdown at 100 parse; 40% at 1K serialize. Both must surface.
    fresh.results[0].parseMs.p99 = 13; // allowed = max(2*0.25, 1) = 1 ⇒ Δ=3 > 1
    fresh.results[1].serializeMs.p99 = 28; // allowed = max(2*0.8, 2) = 2 ⇒ Δ=8 > 2
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
    fresh.results[0].parseMs.p99 = 13; // injected regression
    const report = evaluateRegression(baseline, fresh);
    const text = formatReport(report);
    expect(text.startsWith('perf regression gate: FAIL')).toBe(true);
    expect(text).toContain('✗');
    expect(text).toContain('100');
    expect(text).toContain('parseMs');
  });
});

// ───────────────────────── Loader runtime validation ─────────────────────
//
// `NaN > anyFiniteNumber` evaluates to false, so a corrupted baseline would
// silently pass the gate. `loadBaseline` / `loadFreshResults` reject
// non-finite stats up front with a pointer at the offending key.

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

  test('loadBaseline accepts a valid baseline', () => {
    const path = writeTmp('baseline.json', makeBaseline());
    expect(() => loadBaseline(path)).not.toThrow();
  });

  test('loadFreshResults accepts a valid results file', () => {
    const path = writeTmp('results.json', makeFresh());
    expect(() => loadFreshResults(path)).not.toThrow();
  });
});
