/**
 * TipTap destroy-leak regression test.
 *
 * Pins the documented per-cycle leak rate baseline so the harness watches
 * for regression even before the fix campaign re-runs. The test reads the
 * committed leak-probe baseline JSON
 * (updated by `bun run probe:tiptap-leak --update-baseline`) and applies
 * threshold-based assertions keyed on the baseline's `source` field:
 *
 *   - pre-fix posture; the absolute 5 MB/cycle regression threshold is
 *     RECORDED but NOT asserted (would always fail pre-fix). The test
 *     sanity-checks the baseline shape + ensures someone hasn't accidentally
 *     regressed the pre-fix measurement upward without re-running the probe.
 *   - post-fix posture; the absolute threshold ACTIVATES. The test asserts:
 *       * leakRateMbPerCycle <= 5 (CI failure threshold)
 *       * leakRateMbPerCycle <= 2 (stricter post-fix target)
 *
 * Why baseline-JSON-based instead of running the probe in this test:
 *   - The probe requires a running dev server at the target URL (engineer-
 *     local infrastructure). bun test runs in `bun run check` without a
 *     dev server, so an in-test probe execution would always SKIP — which
 *     is mock-tautological coverage.
 *   - Reading a committed baseline.json + asserting on it is the strongest
 *     CI-runnable contract: future regressions are detected when an
 *     engineer runs the probe and either (a) commits a regressed baseline
 *     by mistake (this test catches it), or (b) the probe surfaces a
 *     regression and the engineer must update the baseline + investigate.
 *
 * The probe + baseline + this test are designed as a 3-piece contract:
 *   1. Engineer runs `bun run probe:tiptap-leak --update-baseline` on
 *      canonical 16 GB+ MacBook hardware.
 *   2. Probe writes new baseline.json with measured leak rate + source
 *      field reflecting fix posture.
 *   3. This test in CI asserts the committed baseline against the thresholds.
 *
 * This test does NOT apply the fix autonomously, even when the probe
 * surfaces a fork-required source. The fix decision is the engineer's; this
 * test just enforces what the engineer commits.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeLeakRateMbPerCycle } from '../lib/cell-measurement';
import {
  type ProbeOptions,
  type ProbeResult,
  parseCliArgs,
  writeProbeResults,
} from './tiptap-destroy-leak';

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE is packages/app/tests/perf/probes; needs 5 `..` to reach the OK
// repo root (packages/app/tests/perf/probes → perf → tests → app → packages → repo-root).
const BASELINE_PATH = resolve(
  HERE,
  '../../../../../specs/2026-05-10-cap-graduation-cache-regime/evidence/tiptap-leak-probe-baseline.json',
);

/** CI failure threshold for post-fix posture. */
const POST_FIX_REGRESSION_THRESHOLD_MB_PER_CYCLE = 5;
/** Stricter post-fix target (TipTap fix should drop leak ~85%). */
const POST_FIX_TARGET_MB_PER_CYCLE = 2;
/** Pre-fix sanity ceiling — any baseline >50 MB/cycle is suspicious (pre-fix measurement was 17). */
const PRE_FIX_SANITY_CEILING_MB_PER_CYCLE = 50;

type BaselineSource =
  | 'pre-fix-M1'
  | 'pre-fix-W14-fork-required'
  | 'pre-fix-W14-local-tbd'
  | 'post-fix-W14';

interface BaselineFile {
  schemaVersion: number;
  source: BaselineSource;
  leakRateMbPerCycle: number;
  acceptableMaxMbPerCycle: number;
  measuredAt: string;
  measuredBy?: string;
  target?: string;
  doc?: string;
  cycles?: number;
  hypothesizedFixPath?: 'local' | 'fork-required' | 'undetermined';
  hypothesizedFixNotes?: string;
  topRetainedConstructorsTop5?: ReadonlyArray<{
    readonly name: string;
    readonly count: number;
    readonly selfSizeBytes: number;
  }> | null;
  notes?: string;
}

function readBaseline(): BaselineFile {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(
      `baseline file missing at ${BASELINE_PATH}; run \`bun run probe:tiptap-leak --update-baseline\` to populate, or restore the committed baseline.`,
    );
  }
  const raw = readFileSync(BASELINE_PATH, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `baseline file at ${BASELINE_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parsed as BaselineFile;
}

describe('tiptap-destroy-leak baseline shape', () => {
  test('baseline.json exists and is valid JSON', () => {
    const baseline = readBaseline();
    expect(baseline).toBeDefined();
    expect(typeof baseline).toBe('object');
  });

  test('baseline has schemaVersion 1', () => {
    const baseline = readBaseline();
    expect(baseline.schemaVersion).toBe(1);
  });

  test('baseline.source is one of the known posture tags', () => {
    const baseline = readBaseline();
    const validSources: BaselineSource[] = [
      'pre-fix-M1',
      'pre-fix-W14-fork-required',
      'pre-fix-W14-local-tbd',
      'post-fix-W14',
    ];
    expect(validSources).toContain(baseline.source);
  });

  test('baseline.leakRateMbPerCycle is a finite non-negative number', () => {
    const baseline = readBaseline();
    expect(typeof baseline.leakRateMbPerCycle).toBe('number');
    expect(Number.isFinite(baseline.leakRateMbPerCycle)).toBe(true);
    expect(baseline.leakRateMbPerCycle).toBeGreaterThanOrEqual(0);
  });

  test('baseline.acceptableMaxMbPerCycle reflects AC14.3 threshold', () => {
    const baseline = readBaseline();
    expect(baseline.acceptableMaxMbPerCycle).toBe(POST_FIX_REGRESSION_THRESHOLD_MB_PER_CYCLE);
  });

  test('baseline.measuredAt is parseable ISO-ish date', () => {
    const baseline = readBaseline();
    const d = new Date(baseline.measuredAt);
    expect(Number.isFinite(d.getTime())).toBe(true);
  });
});

describe('tiptap-destroy-leak regression assertions', () => {
  test('pre-fix baseline stays under sanity ceiling (catches accidental upward drift)', () => {
    const baseline = readBaseline();
    if (baseline.source === 'post-fix-W14') {
      // Post-fix posture; the post-fix-specific test below applies. Skip
      // this sanity check (would be redundant with the stricter assertions).
      return;
    }
    expect(baseline.leakRateMbPerCycle).toBeLessThanOrEqual(PRE_FIX_SANITY_CEILING_MB_PER_CYCLE);
  });

  test('post-fix posture meets AC14.3 + AC14.2 thresholds', () => {
    const baseline = readBaseline();
    if (baseline.source !== 'post-fix-W14') {
      // Pre-fix posture: absolute threshold not yet activatable;
      // baseline tracks the documented current measurement. The fix
      // landing flips source → post-fix-W14 + this assertion fires.
      return;
    }
    expect(baseline.leakRateMbPerCycle).toBeLessThanOrEqual(
      POST_FIX_REGRESSION_THRESHOLD_MB_PER_CYCLE,
    );
    expect(baseline.leakRateMbPerCycle).toBeLessThanOrEqual(POST_FIX_TARGET_MB_PER_CYCLE);
  });

  test('pre-fix-W14-fork-required posture documents the STOP_IF surfacing', () => {
    const baseline = readBaseline();
    if (baseline.source !== 'pre-fix-W14-fork-required') {
      return;
    }
    // When the probe identifies a fork-required leak source, the engineer
    // must surface to the user. The hypothesizedFixNotes
    // field captures the rationale; assert it's populated so the surfacing
    // isn't silently lost on baseline-update.
    expect(baseline.hypothesizedFixPath).toBe('fork-required');
    expect(baseline.hypothesizedFixNotes).toBeDefined();
    expect((baseline.hypothesizedFixNotes ?? '').length).toBeGreaterThan(20);
  });
});

describe('tiptap-destroy-leak probe CLI shape', () => {
  test('parseCliArgs accepts default args (no flags)', () => {
    const args = parseCliArgs([]);
    expect(args.target).toBe('http://localhost:5173');
    expect(args.doc).toBe('PROJECT');
    expect(args.cycles).toBe(10);
    expect(args.topN).toBe(20);
    expect(args.updateBaseline).toBe(false);
    expect(args.headed).toBe(false);
  });

  test('parseCliArgs accepts custom target + doc + cycles', () => {
    const args = parseCliArgs([
      '--target=http://localhost:9999',
      '--doc=README',
      '--cycles=5',
      '--top-n=10',
    ]);
    expect(args.target).toBe('http://localhost:9999');
    expect(args.doc).toBe('README');
    expect(args.cycles).toBe(5);
    expect(args.topN).toBe(10);
  });

  test('parseCliArgs accepts --update-baseline + --headed flags', () => {
    const args = parseCliArgs(['--update-baseline', '--headed']);
    expect(args.updateBaseline).toBe(true);
    expect(args.headed).toBe(true);
  });

  test('parseCliArgs rejects --cycles < 2 (need ≥2 samples for leak-rate)', () => {
    expect(() => parseCliArgs(['--cycles=1'])).toThrow(/cycles/);
    expect(() => parseCliArgs(['--cycles=0'])).toThrow(/cycles/);
  });

  test('parseCliArgs rejects --top-n < 1', () => {
    expect(() => parseCliArgs(['--top-n=0'])).toThrow(/top-n/);
  });

  test('parseCliArgs rejects unknown flags', () => {
    expect(() => parseCliArgs(['--bogus'])).toThrow(/unknown arg/);
  });

  test('parseCliArgs surfaces --help via thrown sentinel', () => {
    expect(() => parseCliArgs(['--help'])).toThrow(/--help/);
    expect(() => parseCliArgs(['-h'])).toThrow(/--help/);
  });

  test('leak-rate formula uses N-1 (regression: a prior probe divided by N and diverged from the library)', () => {
    // Fixed sequence: 5 post-cycle heap samples drifting linearly from
    // 100 → 140 MB. Interval count is 4 (N-1); per-cycle leak rate is
    // (140-100)/4 = 10 MB/cycle. A divide-by-N formula would emit
    // (140-100)/5 = 8 MB/cycle — that drift between probe and library
    // is the regression this test guards.
    const samples = [100, 110, 120, 130, 140];
    expect(computeLeakRateMbPerCycle(samples)).toBe(10);
    // Sanity-check that fewer than 2 samples short-circuits to 0 (matches
    // the probe's pre-condition; the inline guard was removed when the
    // probe started delegating to this function).
    expect(computeLeakRateMbPerCycle([])).toBe(0);
    expect(computeLeakRateMbPerCycle([42])).toBe(0);
  });

  test('writeProbeResults refuses --update-baseline on a degraded run', () => {
    // A run where most cycles failed produces an empty cycleHeapsMb, which
    // makes computeLeakRateMbPerCycle return 0. Writing that as a baseline
    // labelled 'post-fix-W14' would silently mask future regressions of
    // 5+ MB/cycle. The gate refuses if observedCycles/cycles < 0.5.
    const outDir = mkdtempSync(join(tmpdir(), 'tiptap-leak-baseline-degraded-'));
    try {
      const degraded: ProbeResult = {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        target: 'http://localhost:5173',
        doc: 'PROJECT',
        cycles: 10,
        cycleHeapsMb: [120], // only 1 of 10 cycles produced a sample
        leakRateMbPerCycle: 0,
        topRetainedConstructors: [],
        memlabFindings: { available: false },
        errors: ['cycle 1: browser crash'],
        hypothesizedFixPath: 'undetermined',
        hypothesizedFixNotes: '',
      };
      expect(() => writeProbeResults(degraded, outDir, true)).toThrow(/baseline refused/);
      // Refused baselines must not leave a baseline.json on disk — the
      // engineer sees the error AND the absence of a stale baseline.
      expect(existsSync(resolve(outDir, 'tiptap-leak-probe-baseline.json'))).toBe(false);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('writeProbeResults accepts --update-baseline at >=50% success rate', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'tiptap-leak-baseline-ok-'));
    try {
      const cycleHeaps = [100, 102, 104, 106, 108]; // 5 of 10 cycles ⇒ 50%
      const ok: ProbeResult = {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        target: 'http://localhost:5173',
        doc: 'PROJECT',
        cycles: 10,
        cycleHeapsMb: cycleHeaps,
        leakRateMbPerCycle: computeLeakRateMbPerCycle(cycleHeaps),
        topRetainedConstructors: [],
        memlabFindings: { available: false },
        errors: [],
        hypothesizedFixPath: 'undetermined',
        hypothesizedFixNotes: '',
      };
      const written = writeProbeResults(ok, outDir, true);
      expect(written.baselinePath).toBeDefined();
      if (!written.baselinePath) return;
      expect(existsSync(written.baselinePath)).toBe(true);
      const baseline = JSON.parse(readFileSync(written.baselinePath, 'utf8')) as {
        observedCycles: number;
        successRate: number;
      };
      expect(baseline.observedCycles).toBe(5);
      expect(baseline.successRate).toBe(0.5);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('ProbeOptions + ProbeResult types are exported (compile-time check)', () => {
    // This test exists so a structural change to the exported types fails
    // typecheck; the runtime expect is a no-op shape pin.
    const sample: ProbeOptions = {
      target: 'http://localhost:5173',
      doc: 'PROJECT',
      cycles: 10,
      outDir: '/tmp',
      topN: 20,
      updateBaseline: false,
      headed: false,
    };
    const result: ProbeResult = {
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      target: sample.target,
      doc: sample.doc,
      cycles: sample.cycles,
      cycleHeapsMb: [],
      leakRateMbPerCycle: 0,
      topRetainedConstructors: [],
      memlabFindings: { available: false },
      errors: [],
      hypothesizedFixPath: 'undetermined',
      hypothesizedFixNotes: '',
    };
    expect(result.schemaVersion).toBe(1);
    expect(sample.cycles).toBe(10);
  });
});
