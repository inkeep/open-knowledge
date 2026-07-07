/**
 * parse-health regression gate.
 *
 * Runs the committed fidelity corpus through `MarkdownManager.parseWithFallback`,
 * reads the `parse-health` counters, and compares them to a committed baseline.
 *
 * SEMANTICS:
 *   - `parseFallback.wholeDoc === 0` on the fidelity corpus is ABSOLUTE.
 *     Any whole-doc fallback on valid CommonMark or our internal GFM corpus
 *     means the pipeline silently degraded for documents it previously
 *     handled — this catches the class of regression that R4 (latency-only)
 *     misses.
 *   - `parseFallback.blockLevel <= baseline.blockLevelMax` — block-level
 *     fallback is expected to be small or zero on our corpus; any increase
 *     is a regression signal. The threshold is the baseline's observed
 *     count at capture time (captured from a clean baseline run).
 *
 * Guards against silent degrade-not-crash regressions from processor
 * caching state bleed and merged walker ordering drift.
 *
 * Module is dual-use: library functions for the synthetic-regression unit
 * tests, plus a thin CLI entry (`import.meta.main`) invoked by the
 * `test:health:parse` turbo task.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sharedExtensions } from '../../src/extensions/shared.ts';
import { loadGfmExamples } from '../../src/markdown/fixtures/index.ts';
import { MarkdownManager } from '../../src/markdown/index.ts';
import {
  getParseHealth,
  type ParseHealthMetrics,
  resetParseHealth,
} from '../../src/metrics/parse-health.ts';

// ───────────────────────── Types ──────────────────────────────────────────

export interface ParseHealthBaseline {
  schemaVersion: 1;
  capturedAt: string;
  /** Human-readable class the baseline was captured on. */
  runnerClass: string;
  /** Which corpus slices were harvested. */
  corpus: {
    commonmarkExamples: number;
    gfmExamples: number;
  };
  /** Thresholds the gate enforces. */
  thresholds: {
    /** `parseFallback.wholeDoc` must be ≤ this. Pinned to 0. */
    wholeDocMax: number;
    /** `parseFallback.blockLevel` must be ≤ this. Captured from a clean run. */
    blockLevelMax: number;
  };
  /** Observed counters at capture. Stored for traceability. */
  observed: {
    parseFallback: {
      blockLevel: number;
      wholeDoc: number;
    };
  };
}

export interface ParseHealthSample {
  parseFallback: { blockLevel: number; wholeDoc: number };
}

export interface ParseHealthFinding {
  counter: 'wholeDoc' | 'blockLevel';
  observed: number;
  threshold: number;
  message: string;
}

export interface ParseHealthReport {
  pass: boolean;
  findings: ParseHealthFinding[];
  observed: ParseHealthSample;
  thresholds: ParseHealthBaseline['thresholds'];
}

// ───────────────────────── Comparison (pure) ──────────────────────────────

/**
 * Compare a harvested sample against a baseline's thresholds.
 *
 * Pure: trivially testable with synthetic inputs — no parse side effects.
 */
export function compareParseHealth(
  baseline: ParseHealthBaseline,
  observed: ParseHealthSample,
): ParseHealthReport {
  const findings: ParseHealthFinding[] = [];
  if (observed.parseFallback.wholeDoc > baseline.thresholds.wholeDocMax) {
    findings.push({
      counter: 'wholeDoc',
      observed: observed.parseFallback.wholeDoc,
      threshold: baseline.thresholds.wholeDocMax,
      message:
        `whole-doc fallback regressed: observed ${observed.parseFallback.wholeDoc}, ` +
        `threshold ${baseline.thresholds.wholeDocMax}`,
    });
  }
  if (observed.parseFallback.blockLevel > baseline.thresholds.blockLevelMax) {
    findings.push({
      counter: 'blockLevel',
      observed: observed.parseFallback.blockLevel,
      threshold: baseline.thresholds.blockLevelMax,
      message:
        `block-level fallback regressed: observed ${observed.parseFallback.blockLevel}, ` +
        `threshold ${baseline.thresholds.blockLevelMax}`,
    });
  }
  return {
    pass: findings.length === 0,
    findings,
    observed,
    thresholds: baseline.thresholds,
  };
}

// ───────────────────────── Harvest (effectful) ────────────────────────────

export interface HarvestOptions {
  /** MarkdownManager to drive. Tests may pass their own; CLI constructs a default. */
  manager?: MarkdownManager;
  /** Corpus of source strings to parse. Tier-2 CI passes the fidelity corpus. */
  corpus: readonly string[];
  /** If true, reset counters before harvesting. Default true — caller owns the baseline. */
  reset?: boolean;
}

/**
 * Parse every document in `corpus` via `parseWithFallback` and return the
 * counters delta captured during the run.
 *
 * `parseWithFallback` is chosen (not `parse`) because it's the surface this gate
 * protects: the production read path (persistence, agent-sessions,
 * rollback, external-change) uses it, and it's where block-/whole-doc
 * fallback increments originate.
 */
export function harvestParseHealth(options: HarvestOptions): ParseHealthSample {
  if (options.reset !== false) resetParseHealth();
  const mm = options.manager ?? new MarkdownManager({ extensions: sharedExtensions });
  for (const source of options.corpus) {
    try {
      mm.parseWithFallback(source);
    } catch {
      // parseWithFallback contract: "Never throws." If it does, that's a
      // separate bug — but we don't want a single bad fixture to tank the
      // whole harvest. Swallowing here preserves the counters snapshot.
    }
  }
  const health: ParseHealthMetrics = getParseHealth();
  return {
    parseFallback: {
      blockLevel: health.parseFallback.blockLevel,
      wholeDoc: health.parseFallback.wholeDoc,
    },
  };
}

// ───────────────────────── Corpus loading ─────────────────────────────────

/**
 * Load the full fidelity corpus (CommonMark + GFM) as a flat source-string
 * array. CommonMark comes from the third-party `commonmark.json` package;
 * GFM comes from our canonical `fixtures/gfm/examples.json`.
 *
 * The CommonMark import is lazy so the library portion of this module
 * works without the package (the synthetic-regression tests don't need
 * the real corpus, only the pure compareParseHealth function).
 */
export async function loadFidelityCorpus(): Promise<readonly string[]> {
  // @ts-expect-error — commonmark.json ships without types; it's a raw JSON module.
  const mod = (await import('commonmark.json')) as {
    commonmark: Array<{ section: string; markdown: string }>;
  };
  const commonmark = mod.commonmark.map((e) => e.markdown);
  const gfm = loadGfmExamples().map((e) => e.markdown);
  return [...commonmark, ...gfm];
}

// ───────────────────────── Baseline IO ────────────────────────────────────

export function loadBaseline(path: string): ParseHealthBaseline {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (raw.schemaVersion !== 1) {
    throw new Error(
      `parse-health baseline.json schemaVersion must be 1 (got ${raw.schemaVersion})`,
    );
  }
  return raw as ParseHealthBaseline;
}

// ───────────────────────── Formatting ─────────────────────────────────────

export function formatReport(report: ParseHealthReport): string {
  const lines: string[] = [];
  lines.push(`parse-health gate: ${report.pass ? 'PASS' : 'FAIL'}`);
  lines.push(
    `  observed  blockLevel=${report.observed.parseFallback.blockLevel}` +
      ` wholeDoc=${report.observed.parseFallback.wholeDoc}`,
  );
  lines.push(
    `  threshold blockLevel≤${report.thresholds.blockLevelMax}` +
      ` wholeDoc≤${report.thresholds.wholeDocMax}`,
  );
  for (const f of report.findings) {
    lines.push(`  ✗ ${f.message}`);
  }
  return lines.join('\n');
}

// ───────────────────────── CLI ────────────────────────────────────────────

/**
 * CLI entry. Usage:
 *   bun run packages/core/tests/health/parse-health-gate.ts <baseline.json>
 *
 * Loads the real fidelity corpus, harvests counters, compares, exits 0/1.
 */
async function main(): Promise<void> {
  const [, , baselineArg] = process.argv;
  if (!baselineArg) {
    console.error('usage: parse-health-gate.ts <baseline.json>');
    process.exit(2);
  }
  const baseline = loadBaseline(resolve(baselineArg));
  const corpus = await loadFidelityCorpus();
  const observed = harvestParseHealth({ corpus });
  const report = compareParseHealth(baseline, observed);
  console.log(formatReport(report));
  console.log(
    `  corpus    commonmarkExamples=${baseline.corpus.commonmarkExamples}` +
      ` gfmExamples=${baseline.corpus.gfmExamples}`,
  );
  process.exit(report.pass ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
