/**
 * Orchestrator: run the bench harness, find the freshest results
 * file it wrote, and feed it to the regression gate against the
 * committed baseline.
 *
 * Used by the `test:perf:regression` npm script and the matching turbo
 * task. Fails non-zero on gate regression (propagates the CLI exit code).
 *
 * Kept as a thin wrapper — the real work is in:
 *   - `markdown-bench.test.ts` (measurement)
 *   - `regression-gate.ts` (comparison logic)
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateRegression,
  formatReport,
  loadBaseline,
  loadFreshResults,
} from './regression-gate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(HERE, 'baseline.json');

function findFreshestResults(): string {
  const entries = readdirSync(HERE)
    .filter((f) => f.startsWith('results.') && f.endsWith('.json'))
    .map((f) => ({ f, mtime: statSync(resolve(HERE, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (entries.length === 0) {
    throw new Error(`no results.*.json found in ${HERE}; did the bench run fail?`);
  }
  return resolve(HERE, entries[0].f);
}

async function main(): Promise<void> {
  // 1) run the bench
  const bench = spawnSync('bun', ['test', resolve(HERE, 'markdown-bench.test.ts')], {
    env: { ...process.env, RUN_BENCH: '1' },
    stdio: 'inherit',
  });
  if (bench.status !== 0) {
    console.error(`bench run failed with exit code ${bench.status ?? 'null'}`);
    process.exit(bench.status ?? 1);
  }

  // 2) gate against baseline
  const freshPath = findFreshestResults();
  const baseline = loadBaseline(BASELINE_PATH);
  const fresh = loadFreshResults(freshPath);

  // Soft warning on runner-class mismatch. The threshold formula
  // (`max(2σ, 10% × p99)`) absorbs some cross-runner variance but anchors
  // to p99 numbers measured on the baseline's hardware class; σ on shared
  // CI runners can be 5-20× larger than on the M-series calibration box
  // When the mismatch is real, operators
  // need the signal — but blocking the gate on it would be a step backward
  // until a CI-class baseline is captured.
  const freshRunnerClass =
    process.env.BENCH_RUNNER_CLASS ??
    (fresh.runner as { runnerClass?: string } | undefined)?.runnerClass ??
    'unknown';
  if (freshRunnerClass !== baseline.runnerClass) {
    console.warn(
      `[r4-gate] runner class mismatch: baseline="${baseline.runnerClass}" ` +
        `fresh="${freshRunnerClass}". p99 deltas may reflect hardware, not code.`,
    );
  }

  const report = evaluateRegression(baseline, fresh);
  console.log(formatReport(report));
  console.log(`  baseline=${BASELINE_PATH}`);
  console.log(`  fresh   =${freshPath}`);
  process.exit(report.pass ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
