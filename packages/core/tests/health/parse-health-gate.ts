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

export interface ParseHealthBaseline {
  schemaVersion: 1;
  capturedAt: string;
  runnerClass: string;
  corpus: {
    commonmarkExamples: number;
    gfmExamples: number;
  };
  thresholds: {
    wholeDocMax: number;
    blockLevelMax: number;
  };
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

export interface HarvestOptions {
  manager?: MarkdownManager;
  corpus: readonly string[];
  reset?: boolean;
}

export function harvestParseHealth(options: HarvestOptions): ParseHealthSample {
  if (options.reset !== false) resetParseHealth();
  const mm = options.manager ?? new MarkdownManager({ extensions: sharedExtensions });
  for (const source of options.corpus) {
    try {
      mm.parseWithFallback(source);
    } catch {}
  }
  const health: ParseHealthMetrics = getParseHealth();
  return {
    parseFallback: {
      blockLevel: health.parseFallback.blockLevel,
      wholeDoc: health.parseFallback.wholeDoc,
    },
  };
}

export async function loadFidelityCorpus(): Promise<readonly string[]> {
  // @ts-expect-error — commonmark.json ships without types; it's a raw JSON module.
  const mod = (await import('commonmark.json')) as {
    commonmark: Array<{ section: string; markdown: string }>;
  };
  const commonmark = mod.commonmark.map((e) => e.markdown);
  const gfm = loadGfmExamples().map((e) => e.markdown);
  return [...commonmark, ...gfm];
}

export function loadBaseline(path: string): ParseHealthBaseline {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (raw.schemaVersion !== 1) {
    throw new Error(
      `parse-health baseline.json schemaVersion must be 1 (got ${raw.schemaVersion})`,
    );
  }
  return raw as ParseHealthBaseline;
}

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
