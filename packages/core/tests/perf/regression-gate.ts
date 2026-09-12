import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Methodology {
  warmupIters: number;
  measuredIters: number;
  gcBetweenRuns: boolean;
}

interface OpStats {
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface Toolchain {
  runtime?: string;
  testRunner?: string;
}

interface FreshBlockResult {
  blockCount: number;
  docSizeChars: number;
  parseMs: OpStats;
  serializeMs: OpStats;
  roundTripMs: OpStats;
}

export interface FreshResults {
  schemaVersion: 2;
  startedAt: string;
  finishedAt: string;
  methodology: Methodology;
  toolchain: Toolchain;
  runner: Record<string, unknown>;
  results: FreshBlockResult[];
}

interface BaselineOpStats {
  p99: number;
  p99StdevMs: number;
  p50?: number;
  p95?: number;
}

interface BaselineBlockEntry {
  blockCount: number;
  docSizeChars: number;
  parseMs: BaselineOpStats;
  serializeMs: BaselineOpStats;
  roundTripMs: BaselineOpStats;
}

export interface Baseline {
  schemaVersion: 2;
  capturedAt: string;
  runnerClass: string;
  methodology?: Methodology;
  capturedUnder: Toolchain;
  targetToolchain?: Toolchain;
  calibrationRuns: number;
  threshold: {
    floorPct: number;
    varianceMultiplier: number;
  };
  results: BaselineBlockEntry[];
}

type OpName = 'parseMs' | 'serializeMs' | 'roundTripMs';

interface OpRegressionRow {
  blockCount: number;
  op: OpName;
  baselineP99: number;
  freshP99: number;
  deltaMs: number;
  allowedDeltaMs: number;
  regression: boolean;
  baselineP50?: number;
  baselineP95?: number;
  freshP50: number;
  freshP95: number;
}

interface RegressionReport {
  pass: boolean;
  rows: OpRegressionRow[];
  missingFresh: number[];
  extraFresh: number[];
}

const OP_NAMES: OpName[] = ['parseMs', 'serializeMs', 'roundTripMs'];

export function evaluateRegression(baseline: Baseline, fresh: FreshResults): RegressionReport {
  const freshByCount = new Map<number, FreshBlockResult>();
  for (const r of fresh.results) freshByCount.set(r.blockCount, r);

  const rows: OpRegressionRow[] = [];
  const missingFresh: number[] = [];

  for (const b of baseline.results) {
    const f = freshByCount.get(b.blockCount);
    if (!f) {
      missingFresh.push(b.blockCount);
      continue;
    }
    for (const op of OP_NAMES) {
      const baselineP99 = b[op].p99;
      const stdev = b[op].p99StdevMs;
      const freshP99 = f[op].p99;
      const deltaMs = freshP99 - baselineP99;
      const varianceTerm = baseline.threshold.varianceMultiplier * stdev;
      const floorTerm = baseline.threshold.floorPct * baselineP99;
      const allowedDeltaMs = Math.max(varianceTerm, floorTerm);
      rows.push({
        blockCount: b.blockCount,
        op,
        baselineP99,
        freshP99,
        deltaMs,
        allowedDeltaMs,
        regression: deltaMs > allowedDeltaMs,
        baselineP50: b[op].p50,
        baselineP95: b[op].p95,
        freshP50: f[op].p50,
        freshP95: f[op].p95,
      });
    }
  }

  const extraFresh: number[] = [];
  const baselineCounts = new Set(baseline.results.map((b) => b.blockCount));
  for (const r of fresh.results)
    if (!baselineCounts.has(r.blockCount)) extraFresh.push(r.blockCount);

  const pass = missingFresh.length === 0 && rows.every((r) => !r.regression);
  return { pass, rows, missingFresh, extraFresh };
}

function fmtOptionalMs(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${value.toFixed(2)}ms`;
}

export function formatReport(report: RegressionReport): string {
  const lines: string[] = [];
  lines.push(`perf regression gate: ${report.pass ? 'PASS' : 'FAIL'}`);
  if (report.missingFresh.length > 0) {
    lines.push(`  missing block counts in fresh run: ${report.missingFresh.join(', ')}`);
  }
  if (report.extraFresh.length > 0) {
    lines.push(`  extra block counts in fresh run (not tracked): ${report.extraFresh.join(', ')}`);
  }
  for (const row of report.rows) {
    const marker = row.regression ? '✗' : '✓';
    const deltaSign = row.deltaMs >= 0 ? '+' : '';
    const baselineTail =
      row.baselineP50 === undefined && row.baselineP95 === undefined
        ? ''
        : ` (baseline p50=${fmtOptionalMs(row.baselineP50)} p95=${fmtOptionalMs(row.baselineP95)})`;
    lines.push(
      `  ${marker} ${String(row.blockCount).padStart(5)} ${row.op.padEnd(12)}` +
        ` baseline=${row.baselineP99.toFixed(2)}ms` +
        ` fresh=${row.freshP99.toFixed(2)}ms` +
        ` Δ=${deltaSign}${row.deltaMs.toFixed(2)}ms` +
        ` allowed=${row.allowedDeltaMs.toFixed(2)}ms` +
        ` p50=${row.freshP50.toFixed(2)}ms p95=${row.freshP95.toFixed(2)}ms` +
        baselineTail,
    );
  }
  return lines.join('\n');
}

export function baselineResultsToolchain(baseline: Baseline): Toolchain {
  return baseline.capturedUnder;
}

function describeToolchain(toolchain: Toolchain): string {
  return `runtime=${toolchain.runtime ?? 'unknown'} testRunner=${toolchain.testRunner ?? 'unknown'}`;
}

export const EXIT_INCONCLUSIVE = 3;

export const EXIT_USAGE = 64;

export const EXIT_DATA = 65;

export const EXIT_SOFTWARE = 70;

export class DataError extends Error {}

export const ACCEPT_MISMATCH_FLAG = '--accept-methodology-mismatch';

export interface MethodologyWarning {
  kind: 'toolchain' | 'gc-regime' | 'iteration-count';
  blocking: boolean;
  message: string;
}

export function comparabilityBlockers(warnings: MethodologyWarning[]): MethodologyWarning[] {
  return warnings.filter((w) => w.blocking);
}

export function checkMethodologyMismatches(
  baseline: Baseline,
  fresh: FreshResults,
): MethodologyWarning[] {
  const warnings: MethodologyWarning[] = [];
  const baselineToolchain = baselineResultsToolchain(baseline);
  const freshToolchain = fresh.toolchain;
  if (
    baselineToolchain.runtime !== freshToolchain.runtime ||
    baselineToolchain.testRunner !== freshToolchain.testRunner
  ) {
    warnings.push({
      kind: 'toolchain',
      blocking: true,
      message:
        `toolchain mismatch: the committed baseline results were captured under ` +
        `${describeToolchain(baselineToolchain)}, this run used ` +
        `${describeToolchain(freshToolchain)}. A different engine or test runner ` +
        `changes the allocation and JIT regime, so the p99 deltas below are not ` +
        `attributable to code alone; re-baseline before trusting them.`,
    });
  }
  const b = baseline.methodology;
  const f = fresh.methodology;
  if (!b) return warnings;
  if (b.gcBetweenRuns !== f.gcBetweenRuns) {
    warnings.push({
      kind: 'gc-regime',
      blocking: true,
      message:
        `methodology mismatch: baseline gcBetweenRuns=${b.gcBetweenRuns} ` +
        `fresh gcBetweenRuns=${f.gcBetweenRuns}. Re-run with ` +
        `NODE_OPTIONS=--expose-gc to force GC, or re-baseline; the numbers ` +
        `below compare different allocation regimes.`,
    });
  }
  if (b.measuredIters !== f.measuredIters) {
    warnings.push({
      kind: 'iteration-count',
      blocking: false,
      message:
        `iteration-count mismatch: baseline measuredIters=${b.measuredIters} ` +
        `fresh measuredIters=${f.measuredIters}; p99 is a worst-of-N observation, ` +
        `so changing N changes what the number means.`,
    });
  }
  return warnings;
}

function readJson(file: string, path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new DataError(`${file}: cannot read ${path} (${(error as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new DataError(`${file}: ${path} is not valid JSON (${(error as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DataError(
      `${file}: ${path} must contain a JSON object (got ${JSON.stringify(parsed)})`,
    );
  }
  return parsed as Record<string, unknown>;
}

function assertStatsPresent(ctx: string, blockCount: number, opName: OpName, stats: unknown): void {
  if (typeof stats !== 'object' || stats === null || Array.isArray(stats)) {
    throw new DataError(
      `${ctx}: blockCount=${blockCount} is missing its ${opName} stats block (got ${JSON.stringify(stats)})`,
    );
  }
}

function assertFiniteStats(
  ctx: string,
  blockCount: number,
  opName: OpName,
  stats: BaselineOpStats,
): void {
  assertStatsPresent(ctx, blockCount, opName, stats);
  if (!Number.isFinite(stats.p99)) {
    throw new DataError(
      `${ctx}: blockCount=${blockCount} ${opName}.p99 is not finite (${stats.p99})`,
    );
  }
  if (!Number.isFinite(stats.p99StdevMs)) {
    throw new DataError(
      `${ctx}: blockCount=${blockCount} ${opName}.p99StdevMs is not finite (${stats.p99StdevMs})`,
    );
  }
  for (const key of ['p50', 'p95'] as const) {
    const value = stats[key];
    if (value !== undefined && !Number.isFinite(value)) {
      throw new DataError(
        `${ctx}: blockCount=${blockCount} ${opName}.${key} is not finite (${value})`,
      );
    }
  }
}

function assertFiniteOpStats(
  ctx: string,
  blockCount: number,
  opName: OpName,
  stats: OpStats,
): void {
  assertStatsPresent(ctx, blockCount, opName, stats);
  for (const key of ['mean', 'min', 'max', 'p50', 'p95', 'p99'] as const) {
    if (!Number.isFinite(stats[key])) {
      throw new DataError(
        `${ctx}: blockCount=${blockCount} ${opName}.${key} is not finite (${stats[key]})`,
      );
    }
  }
}

function assertFiniteEntryKeys(ctx: string, index: number, entry: unknown): void {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new DataError(
      `${ctx}: results[${index}] must be an object (got ${JSON.stringify(entry)})`,
    );
  }
  for (const key of ['blockCount', 'docSizeChars'] as const) {
    const value = (entry as Record<string, unknown>)[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new DataError(
        `${ctx}: results[${index}].${key} must be a finite number (got ${JSON.stringify(value)}). ` +
          (key === 'blockCount'
            ? 'blockCount is the key baseline rows are joined to fresh rows on, so a non-number ' +
              'matches nothing, renders every baseline row as missingFresh, and prints FAIL as ' +
              'though the run regressed.'
            : 'docSizeChars is provenance the comparator never reads, so a non-number changes no ' +
              'verdict; it means the capture that wrote this row is corrupt.'),
      );
    }
  }
}

function declaresToolchain(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (['runtime', 'testRunner'] as const).some((key) => {
      const declared = (value as Record<string, unknown>)[key];
      return typeof declared === 'string' && declared.length > 0;
    })
  );
}

function assertToolchain(file: string, field: string, value: unknown, why: string): void {
  if (!declaresToolchain(value)) {
    throw new DataError(
      `${file}: ${field} must be an object declaring runtime and/or testRunner (got ${JSON.stringify(value)}). ${why}`,
    );
  }
}

function assertThreshold(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DataError(
      `baseline.json: threshold must be an object (got ${JSON.stringify(value)})`,
    );
  }
  for (const field of ['floorPct', 'varianceMultiplier'] as const) {
    const n = (value as Record<string, unknown>)[field];
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new DataError(
        `baseline.json: threshold.${field} must be a finite number (got ${JSON.stringify(n)}). ` +
          'A missing term makes allowedDeltaMs NaN, and every `delta > NaN` comparison is false, so ' +
          'the gate prints PASS against an arbitrarily slower run.',
      );
    }
  }
}

export function loadBaseline(path: string): Baseline {
  const raw = readJson('baseline.json', path);
  if (raw.schemaVersion !== 2) {
    throw new DataError(
      `baseline.json schemaVersion must be 2 (got ${raw.schemaVersion}). Version 1 spelled the ` +
        'provenance of results[] as `toolchain`; version 2 splits it into `capturedUnder` (what ' +
        'the numbers were measured under, the only field the comparator reads) and ' +
        '`targetToolchain` (what a re-capture should target).',
    );
  }
  if (!Array.isArray(raw.results)) {
    throw new DataError('baseline.json: results must be an array');
  }
  assertToolchain(
    'baseline.json',
    'capturedUnder',
    raw.capturedUnder,
    'It is the only provenance field the comparator reads, and a missing or falsy value ' +
      'short-circuits the toolchain-mismatch arm rather than failing loudly, which returns the ' +
      'gate to rendering PASS on an incomparable pair.' +
      (raw.toolchain !== undefined
        ? ' This file still carries the version-1 `toolchain` key; rename it to capturedUnder rather than renumbering.'
        : ''),
  );
  if (raw.targetToolchain !== undefined) {
    assertToolchain(
      'baseline.json',
      'targetToolchain',
      raw.targetToolchain,
      'Omit the key entirely rather than declaring an empty one.',
    );
  }
  assertThreshold(raw.threshold);
  if (
    raw.targetToolchain !== undefined &&
    JSON.stringify(raw.capturedUnder) === JSON.stringify(raw.targetToolchain)
  ) {
    throw new DataError(
      'baseline.json: capturedUnder equals targetToolchain, which is the state a completed ' +
        're-baseline removes. Drop targetToolchain once the numbers are captured under it.',
    );
  }
  for (const [index, entry] of (raw.results as BaselineBlockEntry[]).entries()) {
    assertFiniteEntryKeys('baseline', index, entry);
    for (const op of OP_NAMES) {
      assertFiniteStats('baseline', entry.blockCount, op, entry[op]);
    }
  }
  return raw as unknown as Baseline;
}

export function loadFreshResults(path: string): FreshResults {
  const raw = readJson('results.json', path);
  if (raw.schemaVersion !== 2) {
    throw new DataError(
      `results.json schemaVersion must be 2 (got ${raw.schemaVersion}). ` +
        (declaresToolchain(raw.toolchain)
          ? 'This file already carries a version-2-shaped `toolchain`, so renumbering it to 2 ' +
            'preserves that provenance rather than discarding it. Re-run the bench only if you ' +
            'would rather discard the capture.'
          : 'It declares no `toolchain`, so it carries no provenance for the toolchain-mismatch ' +
            'arm to read. Re-run the bench to produce a version-2 capture rather than renumbering ' +
            'the file.'),
    );
  }
  if (!Array.isArray(raw.results)) {
    throw new DataError('results.json: results must be an array');
  }
  assertToolchain(
    'results.json',
    'toolchain',
    raw.toolchain,
    'Without it the toolchain-mismatch arm cannot fire, so a capture from a different runtime ' +
      'compares silently against the baseline.',
  );
  if (
    typeof raw.methodology !== 'object' ||
    raw.methodology === null ||
    Array.isArray(raw.methodology)
  ) {
    throw new DataError(
      `results.json: methodology must be an object recording what this run measured under (got ${JSON.stringify(raw.methodology)}). ` +
        'Without it the gcBetweenRuns and measuredIters arms cannot fire.',
    );
  }
  for (const [index, entry] of (raw.results as FreshBlockResult[]).entries()) {
    assertFiniteEntryKeys('results', index, entry);
    for (const op of OP_NAMES) {
      assertFiniteOpStats('results', entry.blockCount, op, entry[op]);
    }
  }
  return raw as unknown as FreshResults;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const accepted = argv.includes(ACCEPT_MISMATCH_FLAG);
  const [baselineArg, freshArg] = argv.filter((arg) => !arg.startsWith('--'));
  if (!baselineArg || !freshArg) {
    console.error(
      `usage: regression-gate.ts <baseline.json> <fresh-results.json> [${ACCEPT_MISMATCH_FLAG}]\n` +
        `  exit 0 no regression, 1 regression, ${EXIT_INCONCLUSIVE} the comparison is not valid, ` +
        `${EXIT_USAGE} bad invocation, ${EXIT_DATA} unreadable input`,
    );
    process.exit(EXIT_USAGE);
  }
  const baseline = loadBaseline(resolve(baselineArg));
  const fresh = loadFreshResults(resolve(freshArg));
  const warnings = checkMethodologyMismatches(baseline, fresh);
  for (const warning of warnings) {
    console.warn(warning.message);
  }
  const report = evaluateRegression(baseline, fresh);
  console.log(formatReport(report));
  const blockers = comparabilityBlockers(warnings);
  if (blockers.length > 0 && !accepted) {
    console.error(
      `perf regression gate: INCONCLUSIVE - ${blockers.length} warning(s) above say this run and ` +
        'the baseline are not comparable, so neither PASS nor FAIL is a verdict this data ' +
        `supports. Re-baseline, or pass ${ACCEPT_MISMATCH_FLAG} to read the deltas anyway.`,
    );
    process.exit(EXIT_INCONCLUSIVE);
  }
  process.exit(report.pass ? 0 : 1);
}

export function exitCodeForFailure(error: unknown): number | null {
  return error instanceof DataError ? EXIT_DATA : null;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const code = exitCodeForFailure(error);
    if (code === null) throw error;
    console.error((error as Error).message);
    process.exit(code);
  }
}
