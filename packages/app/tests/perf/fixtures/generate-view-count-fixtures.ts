#!/usr/bin/env bun
/**
 * Synthetic view-count fixture generator.
 *
 * Produces markdown fixtures whose measured PM-view count is within ±5% of
 * a target. Used by the cache-hit reparent latency curve scenario to
 * probe `VIEW_COUNT_CACHE_THRESHOLD` calibration without depending on
 * real-world docs that drift over time.
 *
 * Mark mix is ~75% InternalLink + ~25% WikiLink (matches
 * production ratio of 6 internalLinks : 2 wikilinks per
 * production docs). Both render as plain-DOM chips
 * so view-count cost
 * attribution is comparable to real docs.
 *
 * Usage:
 *   bun run tests/perf/fixtures/generate-view-count-fixtures.ts \
 *     --target-views 100 --out-dir tests/perf/fixtures/views-100
 *
 *   # Regenerate the canonical 5 buckets from scratch:
 *   bun run tests/perf/fixtures/generate-view-count-fixtures.ts --all
 *
 * The generator validates the output by parsing it through
 * MarkdownManager (core's pipeline) and counting `link`-marked text +
 * `wikiLink` nodes in the resulting PM JSON. Iteration converges on the
 * target via additive adjustment.
 *
 * Generator-vs-fixture pinning
 * ----------------------------
 * The committed fixtures under `views-{25,50,100,200,400}/` are
 * intentionally pinned at the generator state when they were last
 * regenerated. They are NOT regenerated on every test run — that would
 * defeat the cross-time reproducibility the measurement depends on.
 * If the generator's mark-mix ratio or convergence logic changes, the
 * committed fixtures will drift relative to fresh generator output —
 * that drift is BY DESIGN: the scenarios still consume the pinned
 * fixtures so prior measurements remain comparable. Any intentional
 * regeneration must be paired with re-baselining the measurement
 * against the new fixtures.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MarkdownManager, OK_DIR, sharedExtensions } from '@inkeep/open-knowledge-core';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Approximate total fixture byte target (~50 KB). */
const TARGET_BYTES = 50_000;

/** Tolerance for the actual-view-count vs target check. */
const TOLERANCE_RATIO = 0.05; // ±5%

/** Mix ratio — 75% internal links, 25% wikilinks. */
const INTERNAL_LINK_RATIO = 0.75;

/** Maximum iterations to converge on target. Generator backs off if exceeded. */
const MAX_ITERATIONS = 12;

/** Canonical view-count buckets when invoked with --all. */
const CANONICAL_TARGETS = [25, 50, 100, 200, 400] as const;

/** Output dir naming convention. */
const FIXTURE_DIR_PREFIX = 'views-';

// ---------------------------------------------------------------------------
// Filler content — short prose stanzas inserted between chips so the doc
// is not just a chip-dump. Length scales inversely with chip count to keep
// the total around TARGET_BYTES.
// ---------------------------------------------------------------------------

const PROSE_STANZAS = [
  'The architecture remains stable across iterations of the schema.',
  'Each layer publishes its constraints in writing for the next reader.',
  'Observers fire on every transaction whose origin is local.',
  'Cache admission gates fall through to pre-V2 destroy semantics.',
  'Synchronous reads remain the dominant cost on cold mount.',
  'Recovery flows funnel through one boundary so the UX stays coherent.',
  'Provider lifetime is bounded by the LRU cap on resident entries.',
  'Per-Activity scroll containers preserve scrollTop across visibility flips.',
  'Lazy serialize defers Markdown until the consumer actually subscribes.',
  'Forward compatibility is enforced by the schema-additive contract.',
];

function makeFiller(targetBytes: number): string {
  if (targetBytes <= 0) return '';
  const stanzas: string[] = [];
  let acc = 0;
  let i = 0;
  while (acc < targetBytes) {
    const s = PROSE_STANZAS[i % PROSE_STANZAS.length];
    stanzas.push(s);
    acc += s.length + 1;
    i++;
  }
  return stanzas.join('\n');
}

// ---------------------------------------------------------------------------
// Markdown construction
// ---------------------------------------------------------------------------

interface BuildArgs {
  /** Number of chips to emit (caller's planned chip count). */
  chips: number;
  /** Approximate total bytes for the entire fixture. */
  totalBytes: number;
}

function buildFixtureMarkdown(args: BuildArgs): string {
  const { chips, totalBytes } = args;
  const internalCount = Math.round(chips * INTERNAL_LINK_RATIO);

  // Build a flat sequence of chip markers (alternating-style — interleaved
  // so the mix is uniform across the doc rather than 75% then 25%).
  const chipSequence: string[] = [];
  for (let i = 0; i < chips; i++) {
    if (i < internalCount) {
      chipSequence.push(`[chip-${i + 1}](./page-${i + 1}.md)`);
    } else {
      chipSequence.push(`[[Chip ${i + 1}]]`);
    }
  }
  // Interleave by alternating the two slices (FY-shuffle would inflate the
  // generator surface and is not required — the measurement does not
  // care about chip ordering, only the count).
  const interleaved: string[] = [];
  let internalIdx = 0;
  let wikiIdx = internalCount;
  while (internalIdx < internalCount || wikiIdx < chips) {
    if (internalIdx < internalCount) interleaved.push(chipSequence[internalIdx++]);
    if (wikiIdx < chips) interleaved.push(chipSequence[wikiIdx++]);
  }

  // Approximate chip byte cost so filler fills the rest. Each chip is on its
  // own line embedded in a sentence; we estimate ~50 bytes per line including
  // surrounding prose.
  const chipBytes = interleaved.join(' ').length + interleaved.length * 5;
  const fillerBudget = Math.max(0, totalBytes - chipBytes);
  const fillerPerSection = chips > 0 ? Math.floor(fillerBudget / (chips + 1)) : fillerBudget;

  const sections: string[] = [];
  sections.push(makeFiller(fillerPerSection));
  for (const chip of interleaved) {
    sections.push(`See ${chip} for context.`);
    sections.push(makeFiller(fillerPerSection));
  }

  // Minimal frontmatter so the doc looks like a real OK page.
  return `---\ntitle: View Fixture (${chips} chips)\n---\n\n${sections
    .filter((s) => s.length > 0)
    .join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// PM-view counting
// ---------------------------------------------------------------------------

interface PmJson {
  type?: string;
  marks?: { type: string }[];
  content?: PmJson[];
}

function countViewsInPmJson(node: PmJson): number {
  let count = 0;
  if (node.type === 'wikiLink') count += 1;
  if (node.marks?.some((m) => m.type === 'link')) count += 1;
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      count += countViewsInPmJson(child as PmJson);
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Iteration loop — converge on the target
// ---------------------------------------------------------------------------

interface ConvergeResult {
  markdown: string;
  measuredViews: number;
  iterations: number;
  chips: number;
}

function convergeOnTarget(targetViews: number): ConvergeResult {
  const mgr = new MarkdownManager({ extensions: sharedExtensions });
  // Each chip registers approximately one PM view (one wikiLink node OR one
  // link-marked text). Start with chips = targetViews and adjust by the
  // delta until within tolerance.
  let chips = targetViews;
  let lastResult: ConvergeResult | null = null;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const md = buildFixtureMarkdown({ chips, totalBytes: TARGET_BYTES });
    const pm = mgr.parse(md) as unknown as PmJson;
    const measured = countViewsInPmJson(pm);
    const result: ConvergeResult = {
      markdown: md,
      measuredViews: measured,
      iterations: iter + 1,
      chips,
    };
    lastResult = result;
    const minOk = Math.floor(targetViews * (1 - TOLERANCE_RATIO));
    const maxOk = Math.ceil(targetViews * (1 + TOLERANCE_RATIO));
    if (measured >= minOk && measured <= maxOk) {
      return result;
    }
    // Adjust chips by the delta (one chip ≈ one view, so additive correction).
    const delta = targetViews - measured;
    chips += delta;
    if (chips < 0) chips = 0;
  }
  // Failed to converge — return the last attempt so the caller can decide.
  if (!lastResult) throw new Error('[gen-fixtures] convergence loop produced no result');
  return lastResult;
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

const OK_CONFIG_YML = `content:
  dir: .
  include:
    - "**/*.md"
  exclude: []
`;

function writeFixture(outDir: string, markdown: string): void {
  mkdirSync(resolve(outDir, OK_DIR), { recursive: true });
  writeFileSync(resolve(outDir, 'FIXTURE.md'), markdown);
  writeFileSync(resolve(outDir, OK_DIR, 'config.yml'), OK_CONFIG_YML);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  targetViews?: number;
  outDir?: string;
  all?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--target-views') out.targetViews = Number.parseInt(argv[++i] ?? '', 10);
    else if (a === '--out-dir') out.outDir = argv[++i];
  }
  return out;
}

export function generateFixture(targetViews: number, outDir: string): ConvergeResult {
  const result = convergeOnTarget(targetViews);
  writeFixture(outDir, result.markdown);
  return result;
}

function defaultOutDir(targetViews: number): string {
  const base = dirname(new URL(import.meta.url).pathname);
  return resolve(base, `${FIXTURE_DIR_PREFIX}${targetViews}`);
}

function logResult(targetViews: number, outDir: string, result: ConvergeResult): void {
  const minOk = Math.floor(targetViews * (1 - TOLERANCE_RATIO));
  const maxOk = Math.ceil(targetViews * (1 + TOLERANCE_RATIO));
  const ok = result.measuredViews >= minOk && result.measuredViews <= maxOk;
  // eslint-disable-next-line no-console
  console.log(
    `[gen-fixtures] target=${targetViews} measured=${result.measuredViews} chips=${result.chips} iters=${result.iterations} ok=${ok} → ${outDir}/FIXTURE.md`,
  );
  if (!ok) {
    // eslint-disable-next-line no-console
    console.warn(
      `[gen-fixtures] WARN: ${result.measuredViews} not within ±${TOLERANCE_RATIO * 100}% of ${targetViews} (range ${minOk}..${maxOk})`,
    );
  }
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.all) {
    for (const target of CANONICAL_TARGETS) {
      const outDir = defaultOutDir(target);
      const result = generateFixture(target, outDir);
      logResult(target, outDir, result);
    }
  } else {
    const targetViews = args.targetViews;
    const outDir = args.outDir ?? (targetViews ? defaultOutDir(targetViews) : null);
    if (typeof targetViews !== 'number' || !outDir) {
      // eslint-disable-next-line no-console
      console.error(
        'Usage: bun run generate-view-count-fixtures.ts --target-views <N> [--out-dir <path>]',
      );
      // eslint-disable-next-line no-console
      console.error('   or: bun run generate-view-count-fixtures.ts --all');
      process.exit(2);
    }
    const result = generateFixture(targetViews, outDir);
    logResult(targetViews, outDir, result);
  }
}
