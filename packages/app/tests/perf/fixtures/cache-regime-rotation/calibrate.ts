#!/usr/bin/env bun
/**
 * Engineer-local realism check for the cache-regime rotation fixtures.
 *
 * Reads dogfood traces the engineer captured from their own OK usage
 * and compares the size distribution + rotation distance against the
 * three fixtures' declared shapes. Prints a drift summary to stdout —
 * never writes trace data, derived data, or output files. The fixtures
 * remain defensible without this step (the parallel-design verdict-
 * robustness check across 3 shapes carries the transferability claim).
 * This script is a local affordance for the engineer to
 * cross-check the engineered shapes against their own usage before
 * committing the campaign cost; it is NOT part of the verdict gate.
 *
 * Local-only by architectural constraint: OK is fully self-hostable and
 * has no production-telemetry channel. Trace capture is the
 * engineer's responsibility; this script consumes whatever they have.
 *
 * Trace format (JSONL, one event per line):
 *   { "docName": "<string>", "contentBytes": <number>, "openedAt": <epoch-ms> }
 *
 * Trace path: $OK_DOGFOOD_TRACE_DIR (default $HOME/.ok/perf-traces/).
 *
 * Usage:
 *   bun run packages/app/tests/perf/fixtures/cache-regime-rotation/calibrate.ts
 *   bun run packages/app/tests/perf/fixtures/cache-regime-rotation/calibrate.ts --trace-dir <path>
 *   bun run packages/app/tests/perf/fixtures/cache-regime-rotation/calibrate.ts --fixture tight
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { asymmetricFixture } from './asymmetric';
import { broadFixture } from './broad';
import { tightFixture } from './tight';
import type { DocSpec, WorkloadFixture, WorkloadFixtureRef } from './types';
import { SIZE_ENVELOPES } from './types';

const DEFAULT_TRACE_SUBPATH = '.ok/perf-traces';
const SIZE_DRIFT_PCT_THRESHOLD = 15;
const DISTANCE_DRIFT_RATIO_THRESHOLD = 0.3;

interface TraceEvent {
  readonly docName: string;
  readonly contentBytes: number;
  readonly openedAt: number;
}

interface SizeDistribution {
  readonly small: number;
  readonly medium: number;
  readonly large: number;
}

interface RealismStats {
  readonly totalEvents: number;
  readonly distinctDocs: number;
  readonly sizeDistributionPct: SizeDistribution;
  /** Median # of distinct docs between repeat visits; null when no repeats observed. */
  readonly medianRotationDistance: number | null;
}

interface FixtureStats {
  readonly ref: WorkloadFixtureRef;
  readonly totalDocs: number;
  readonly sizeDistributionPct: SizeDistribution;
  readonly expectedRotationDistance: number;
}

export function classifyContentBytes(contentBytes: number): DocSpec['sizeClass'] {
  if (contentBytes < SIZE_ENVELOPES.small.maxBytes) return 'small';
  if (contentBytes < SIZE_ENVELOPES.medium.maxBytes) return 'medium';
  return 'large';
}

export function computeSizeDistributionPct(
  classes: ReadonlyArray<DocSpec['sizeClass']>,
): SizeDistribution {
  if (classes.length === 0) {
    return { small: 0, medium: 0, large: 0 };
  }
  let small = 0;
  let medium = 0;
  let large = 0;
  for (const c of classes) {
    if (c === 'small') small++;
    else if (c === 'medium') medium++;
    else large++;
  }
  const total = classes.length;
  return {
    small: (small / total) * 100,
    medium: (medium / total) * 100,
    large: (large / total) * 100,
  };
}

/**
 * Stack-distance variant: distinct docs touched between two consecutive
 * visits to the same doc. Median across all observed repeats provides
 * a robust central tendency for skewed (asymmetric) workloads.
 */
export function computeMedianRotationDistance(events: ReadonlyArray<TraceEvent>): number | null {
  const lastVisit = new Map<string, number>();
  const distances: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i] as TraceEvent;
    const prior = lastVisit.get(ev.docName);
    if (prior !== undefined) {
      const distinctBetween = new Set<string>();
      for (let j = prior + 1; j < i; j++) {
        const between = events[j] as TraceEvent;
        if (between.docName !== ev.docName) {
          distinctBetween.add(between.docName);
        }
      }
      distances.push(distinctBetween.size);
    }
    lastVisit.set(ev.docName, i);
  }
  if (distances.length === 0) return null;
  distances.sort((a, b) => a - b);
  const mid = Math.floor(distances.length / 2);
  if (distances.length % 2 === 0) {
    const lo = distances[mid - 1] as number;
    const hi = distances[mid] as number;
    return (lo + hi) / 2;
  }
  return distances[mid] as number;
}

export function loadTraces(traceDir: string): TraceEvent[] {
  if (!existsSync(traceDir) || !statSync(traceDir).isDirectory()) {
    return [];
  }
  const files = readdirSync(traceDir).filter((f) => f.endsWith('.jsonl'));
  const events: TraceEvent[] = [];
  for (const file of files) {
    const path = join(traceDir, file);
    const lines = readFileSync(path, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      // Truncated trace files (interrupted dogfood-capture sessions) can
      // produce malformed JSONL lines like `{"docName":"foo","cont`. A raw
      // JSON.parse error here would abort the whole calibration run with
      // a SyntaxError stack — the loader contract is silent-skip per the
      // JSDoc, so we honor that contract for both missing-field and parse-
      // failure shapes uniformly.
      let parsed: Partial<TraceEvent>;
      try {
        parsed = JSON.parse(trimmed) as Partial<TraceEvent>;
      } catch {
        continue;
      }
      if (
        typeof parsed.docName === 'string' &&
        typeof parsed.contentBytes === 'number' &&
        typeof parsed.openedAt === 'number'
      ) {
        events.push({
          docName: parsed.docName,
          contentBytes: parsed.contentBytes,
          openedAt: parsed.openedAt,
        });
      }
    }
  }
  events.sort((a, b) => a.openedAt - b.openedAt);
  return events;
}

export function summarizeTraces(events: ReadonlyArray<TraceEvent>): RealismStats {
  const classes = events.map((e) => classifyContentBytes(e.contentBytes));
  const distinct = new Set(events.map((e) => e.docName));
  return {
    totalEvents: events.length,
    distinctDocs: distinct.size,
    sizeDistributionPct: computeSizeDistributionPct(classes),
    medianRotationDistance: computeMedianRotationDistance(events),
  };
}

/**
 * Heuristic expected rotation distance for each pattern.
 *
 * `hot-pocket` revisits the working set; expected distance ≈ size - 1.
 * `random-eviction` samples without intentional reuse; expected
 * distance ≈ size / 2 (mean stack distance under uniform random).
 * Asymmetric biases heavily toward one doc, so its harness-side
 * expected distance ≈ small_count for the hot-doc revisits (visits to
 * the 5 small docs interleaved with the large).
 */
export function expectedRotationDistance(fixture: WorkloadFixture): number {
  const size = fixture.rotationDocs.length;
  if (fixture.ref === 'asymmetric') {
    return Math.max(0, fixture.rotationDocs.filter((d) => d.sizeClass === 'small').length);
  }
  if (fixture.rotationPattern === 'hot-pocket') {
    return Math.max(0, size - 1);
  }
  return Math.max(0, Math.floor(size / 2));
}

export function summarizeFixture(fixture: WorkloadFixture): FixtureStats {
  const classes = fixture.rotationDocs.map((d) => d.sizeClass);
  return {
    ref: fixture.ref,
    totalDocs: fixture.rotationDocs.length,
    sizeDistributionPct: computeSizeDistributionPct(classes),
    expectedRotationDistance: expectedRotationDistance(fixture),
  };
}

interface DriftLine {
  readonly label: string;
  readonly fixture: string;
  readonly trace: string;
  readonly drift: 'OK' | 'DRIFT';
}

function formatPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function maxSizeDriftPct(fixturePct: SizeDistribution, tracePct: SizeDistribution): number {
  const s = Math.abs(fixturePct.small - tracePct.small);
  const m = Math.abs(fixturePct.medium - tracePct.medium);
  const l = Math.abs(fixturePct.large - tracePct.large);
  return Math.max(s, m, l);
}

function distanceDriftRatio(fixtureDistance: number, traceDistance: number | null): number | null {
  if (traceDistance === null || traceDistance === 0) return null;
  return Math.abs(fixtureDistance - traceDistance) / traceDistance;
}

export function buildDriftLines(fixture: FixtureStats, trace: RealismStats): DriftLine[] {
  const sizeDrift = maxSizeDriftPct(fixture.sizeDistributionPct, trace.sizeDistributionPct);
  const distanceDrift = distanceDriftRatio(
    fixture.expectedRotationDistance,
    trace.medianRotationDistance,
  );
  return [
    {
      label: 'size mix (small/med/large)',
      fixture: `${formatPct(fixture.sizeDistributionPct.small)} / ${formatPct(fixture.sizeDistributionPct.medium)} / ${formatPct(fixture.sizeDistributionPct.large)}`,
      trace: `${formatPct(trace.sizeDistributionPct.small)} / ${formatPct(trace.sizeDistributionPct.medium)} / ${formatPct(trace.sizeDistributionPct.large)}`,
      drift: sizeDrift > SIZE_DRIFT_PCT_THRESHOLD ? 'DRIFT' : 'OK',
    },
    {
      label: 'rotation distance',
      fixture: String(fixture.expectedRotationDistance),
      trace:
        trace.medianRotationDistance === null
          ? '(no repeats)'
          : String(trace.medianRotationDistance),
      drift:
        distanceDrift !== null && distanceDrift > DISTANCE_DRIFT_RATIO_THRESHOLD ? 'DRIFT' : 'OK',
    },
  ];
}

function pickFixtures(filter: WorkloadFixtureRef | null): WorkloadFixture[] {
  const all: WorkloadFixture[] = [tightFixture, broadFixture, asymmetricFixture];
  if (filter === null) return all;
  return all.filter((f) => f.ref === filter);
}

function parseFixtureFilter(value: string | undefined): WorkloadFixtureRef | null {
  if (value === undefined) return null;
  if (value === 'tight' || value === 'broad' || value === 'asymmetric') return value;
  throw new Error(
    `[cache-regime-rotation/calibrate] --fixture must be one of tight|broad|asymmetric (got '${value}')`,
  );
}

interface CliArgs {
  readonly traceDir: string;
  readonly fixtureFilter: WorkloadFixtureRef | null;
}

function parseCliArgs(argv: ReadonlyArray<string>): CliArgs {
  let traceDir: string | null = null;
  let fixtureFilter: WorkloadFixtureRef | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--trace-dir') {
      traceDir = argv[++i] ?? null;
    } else if (arg === '--fixture') {
      fixtureFilter = parseFixtureFilter(argv[++i]);
    }
  }
  const envDir = process.env.OK_DOGFOOD_TRACE_DIR;
  const resolvedTraceDir = resolve(traceDir ?? envDir ?? join(homedir(), DEFAULT_TRACE_SUBPATH));
  return { traceDir: resolvedTraceDir, fixtureFilter };
}

function renderDriftLines(fixtureRef: WorkloadFixtureRef, lines: ReadonlyArray<DriftLine>): string {
  const header = `\n[${fixtureRef}]`;
  const rows = lines.map(
    (l) => `  ${l.drift.padEnd(5)} ${l.label.padEnd(30)} fixture=${l.fixture}  trace=${l.trace}`,
  );
  return [header, ...rows].join('\n');
}

export interface CalibrationReport {
  readonly traceDir: string;
  readonly traceTotalEvents: number;
  readonly traceDistinctDocs: number;
  readonly fixtures: ReadonlyArray<{
    readonly ref: WorkloadFixtureRef;
    readonly lines: ReadonlyArray<DriftLine>;
  }>;
}

export function buildCalibrationReport(
  traceEvents: ReadonlyArray<TraceEvent>,
  fixtures: ReadonlyArray<WorkloadFixture>,
  traceDir: string,
): CalibrationReport {
  const trace = summarizeTraces(traceEvents);
  return {
    traceDir,
    traceTotalEvents: trace.totalEvents,
    traceDistinctDocs: trace.distinctDocs,
    fixtures: fixtures.map((f) => ({
      ref: f.ref,
      lines: buildDriftLines(summarizeFixture(f), trace),
    })),
  };
}

function formatReport(report: CalibrationReport): string {
  const out: string[] = [];
  out.push(`Cache-regime-rotation realism check`);
  out.push(`Trace dir: ${report.traceDir}`);
  out.push(`Trace events: ${report.traceTotalEvents}  distinct docs: ${report.traceDistinctDocs}`);
  out.push('');
  out.push(
    `Drift thresholds: size ±${SIZE_DRIFT_PCT_THRESHOLD}%  distance ±${Math.round(DISTANCE_DRIFT_RATIO_THRESHOLD * 100)}%`,
  );
  for (const f of report.fixtures) {
    out.push(renderDriftLines(f.ref, f.lines));
  }
  out.push('');
  out.push('Output is aggregate-only — no raw trace data written. Redirect at your own risk;');
  out.push('keep redirected output gitignored.');
  return out.join('\n');
}

function main(): void {
  const args = parseCliArgs(process.argv.slice(2));
  const fixtures = pickFixtures(args.fixtureFilter);
  const events = loadTraces(args.traceDir);
  if (events.length === 0) {
    console.log(
      [
        `Cache-regime-rotation realism check`,
        `Trace dir: ${args.traceDir}`,
        '',
        `No traces found. The calibration step is optional; the fixtures stay`,
        `defensible via the parallel-design verdict-robustness check (D20).`,
        '',
        `To capture traces, log doc-open events as JSONL into ${args.traceDir}`,
        `with shape { docName, contentBytes, openedAt }.`,
      ].join('\n'),
    );
    return;
  }
  const report = buildCalibrationReport(events, fixtures, args.traceDir);
  console.log(formatReport(report));
}

if (import.meta.main) {
  main();
}
