import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withForcedGc } from './gc.ts';
import type { FreshResults } from './regression-gate.ts';
import {
  ACCEPT_MISMATCH_FLAG,
  checkMethodologyMismatches,
  comparabilityBlockers,
  DataError,
  EXIT_DATA,
  EXIT_INCONCLUSIVE,
  EXIT_SOFTWARE,
  evaluateRegression,
  formatReport,
  loadBaseline,
  loadFreshResults,
} from './regression-gate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(HERE, 'baseline.json');

export function forcedGcPlumbingFailure(fresh: FreshResults): string | null {
  if (fresh.methodology?.gcBetweenRuns === true) return null;
  const reported =
    fresh.methodology === undefined
      ? 'no methodology block'
      : `gcBetweenRuns=${fresh.methodology.gcBetweenRuns}`;
  return (
    `the bench was spawned through withForcedGc but the capture reports ${reported}: either ` +
    '--expose-gc did not reach the worker or the run did not record what it ran under, so this ' +
    'capture was taken under a different allocation regime than the one it claims. Fix the ' +
    'plumbing before reading the deltas.'
  );
}

export class InconclusiveError extends Error {}

export interface ResultsEntry {
  f: string;
  mtimeMs: number;
}

export function resultsStalenessFailure(entries: ResultsEntry[], notBefore: number): string | null {
  if (entries.length === 0) {
    return `no results.*.json found in ${HERE}; the bench produced no capture, so there is nothing to grade.`;
  }
  const freshest = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (freshest.mtimeMs >= notBefore) return null;
  return (
    `the freshest results file (${freshest.f}) predates the bench spawn, so the bench wrote ` +
    'nothing and this run would have graded a leftover capture. markdown-bench.test.ts gates its ' +
    'whole describe on RUN_BENCH, so a propagation failure skips every test and still exits 0 - ' +
    'that is what this check catches.'
  );
}

function findFreshestResults(notBefore: number): string {
  const entries = readdirSync(HERE)
    .filter((f) => f.startsWith('results.') && f.endsWith('.json'))
    .map((f) => ({ f, mtimeMs: statSync(resolve(HERE, f)).mtimeMs }));
  const failure = resultsStalenessFailure(entries, notBefore);
  if (failure !== null) throw new InconclusiveError(failure);
  return resolve(HERE, [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)[0].f);
}

async function main(): Promise<void> {
  const accepted = process.argv.includes(ACCEPT_MISMATCH_FLAG);
  const spawnedAt = Date.now();
  const bench = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', resolve(HERE, 'markdown-bench.test.ts')],
    {
      env: withForcedGc({ ...process.env, RUN_BENCH: '1' }),
      stdio: 'inherit',
    },
  );
  if (bench.status !== 0) {
    console.error(`bench run failed with exit code ${bench.status ?? 'null'}`);
    process.exit(EXIT_SOFTWARE);
  }

  const freshPath = findFreshestResults(spawnedAt);
  const baseline = loadBaseline(BASELINE_PATH);
  const fresh = loadFreshResults(freshPath);

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

  const plumbingFailure = forcedGcPlumbingFailure(fresh);
  if (plumbingFailure !== null) {
    console.error(`[r4-gate] ${plumbingFailure}`);
    process.exit(EXIT_INCONCLUSIVE);
  }

  const warnings = checkMethodologyMismatches(baseline, fresh);
  for (const warning of warnings) {
    console.warn(`[r4-gate] ${warning.message}`);
  }

  const report = evaluateRegression(baseline, fresh);
  console.log(formatReport(report));
  console.log(`  baseline=${BASELINE_PATH}`);
  console.log(`  fresh   =${freshPath}`);
  const blockers = comparabilityBlockers(warnings);
  if (blockers.length > 0 && !accepted) {
    console.error(
      `[r4-gate] INCONCLUSIVE - ${blockers.length} warning(s) above say this run and the baseline ` +
        'are not comparable, so neither PASS nor FAIL is a verdict this data supports. ' +
        `Re-baseline, or pass ${ACCEPT_MISMATCH_FLAG} to read the deltas anyway.`,
    );
    process.exit(EXIT_INCONCLUSIVE);
  }
  process.exit(report.pass ? 0 : 1);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof InconclusiveError) {
      console.error(`[r4-gate] INCONCLUSIVE - ${error.message}`);
      process.exit(EXIT_INCONCLUSIVE);
    }
    if (error instanceof DataError) {
      console.error(`[r4-gate] ${error.message}`);
      process.exit(EXIT_DATA);
    }
    throw error;
  }
}
