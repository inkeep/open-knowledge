#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MarkdownManager, OK_DIR, sharedExtensions } from '@inkeep/open-knowledge-core';


const TARGET_BYTES = 50_000;

const TOLERANCE_RATIO = 0.05; // ±5%

const INTERNAL_LINK_RATIO = 0.75;

const MAX_ITERATIONS = 12;

const CANONICAL_TARGETS = [25, 50, 100, 200, 400] as const;

const FIXTURE_DIR_PREFIX = 'views-';


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


interface BuildArgs {
  chips: number;
  totalBytes: number;
}

function buildFixtureMarkdown(args: BuildArgs): string {
  const { chips, totalBytes } = args;
  const internalCount = Math.round(chips * INTERNAL_LINK_RATIO);

  const chipSequence: string[] = [];
  for (let i = 0; i < chips; i++) {
    if (i < internalCount) {
      chipSequence.push(`[chip-${i + 1}](./page-${i + 1}.md)`);
    } else {
      chipSequence.push(`[[Chip ${i + 1}]]`);
    }
  }
  const interleaved: string[] = [];
  let internalIdx = 0;
  let wikiIdx = internalCount;
  while (internalIdx < internalCount || wikiIdx < chips) {
    if (internalIdx < internalCount) interleaved.push(chipSequence[internalIdx++]);
    if (wikiIdx < chips) interleaved.push(chipSequence[wikiIdx++]);
  }

  const chipBytes = interleaved.join(' ').length + interleaved.length * 5;
  const fillerBudget = Math.max(0, totalBytes - chipBytes);
  const fillerPerSection = chips > 0 ? Math.floor(fillerBudget / (chips + 1)) : fillerBudget;

  const sections: string[] = [];
  sections.push(makeFiller(fillerPerSection));
  for (const chip of interleaved) {
    sections.push(`See ${chip} for context.`);
    sections.push(makeFiller(fillerPerSection));
  }

  return `---\ntitle: View Fixture (${chips} chips)\n---\n\n${sections
    .filter((s) => s.length > 0)
    .join('\n\n')}\n`;
}


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


interface ConvergeResult {
  markdown: string;
  measuredViews: number;
  iterations: number;
  chips: number;
}

function convergeOnTarget(targetViews: number): ConvergeResult {
  const mgr = new MarkdownManager({ extensions: sharedExtensions });
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
    const delta = targetViews - measured;
    chips += delta;
    if (chips < 0) chips = 0;
  }
  if (!lastResult) throw new Error('[gen-fixtures] convergence loop produced no result');
  return lastResult;
}


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
