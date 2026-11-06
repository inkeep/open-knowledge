import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { withTempDir } from '../../temp-dir.test-helper.ts';
import { computeLeakRateMbPerCycle } from '../lib/cell-measurement.ts';
import { type ProbeResult, parseCliArgs, writeProbeResults } from './tiptap-destroy-leak.ts';

describe('tiptap-destroy-leak probe CLI shape', () => {
  test('parseCliArgs accepts default args (no flags)', () => {
    const args = parseCliArgs([]);
    expect(args.target).toBe('http://localhost:5173');
    expect(args.doc).toBe('perf-fixtures/big-doc');
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
    const samples = [100, 110, 120, 130, 140];
    expect(computeLeakRateMbPerCycle(samples)).toBe(10);
    expect(computeLeakRateMbPerCycle([])).toBe(0);
    expect(computeLeakRateMbPerCycle([42])).toBe(0);
  });

  test('writeProbeResults refuses --update-baseline on a degraded run', async () => {
    await withTempDir('tiptap-leak-baseline-degraded-', (outDir) => {
      const degraded: ProbeResult = {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        target: 'http://localhost:5173',
        doc: 'perf-fixtures/big-doc',
        cycles: 10,
        cycleHeapsMb: [120],
        leakRateMbPerCycle: 0,
        topRetainedConstructors: [],
        memlabFindings: { available: false },
        errors: ['cycle 1: browser crash'],
        hypothesizedFixPath: 'undetermined',
        hypothesizedFixNotes: '',
      };
      expect(() => writeProbeResults(degraded, outDir, true)).toThrow(/baseline refused/);
      expect(existsSync(resolve(outDir, 'tiptap-leak-probe-baseline.json'))).toBe(false);
    });
  });

  test('writeProbeResults accepts --update-baseline at >=50% success rate', async () => {
    await withTempDir('tiptap-leak-baseline-ok-', (outDir) => {
      const cycleHeaps = [100, 102, 104, 106, 108];
      const ok: ProbeResult = {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        target: 'http://localhost:5173',
        doc: 'perf-fixtures/big-doc',
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
    });
  });
});
