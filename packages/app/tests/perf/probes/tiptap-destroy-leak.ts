#!/usr/bin/env bun

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type CDPSession, chromium, type Page } from '@playwright/test';
import { computeLeakRateMbPerCycle, forceGc, readHeapMb } from '../lib/cell-measurement';
import { markerFor } from '../lib/doc-markers';


const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET = 'http://localhost:5173';
const DEFAULT_DOC = 'PROJECT';
const DEFAULT_CYCLES = 10;
const DEFAULT_TOP_N = 20;
const DEFAULT_OUT_DIR = resolve(
  HERE,
  '../../../../../specs/2026-05-10-cap-graduation-cache-regime/evidence',
);
const WAIT_CONTENT_MS = 60_000;
const HEAP_SNAPSHOT_TIMEOUT_MS = 120_000;
const PROBE_SCHEMA_VERSION = 1 as const;


export interface ProbeOptions {
  readonly target: string;
  readonly doc: string;
  readonly cycles: number;
  readonly outDir: string;
  readonly topN: number;
  readonly updateBaseline: boolean;
  readonly headed: boolean;
}

export interface ConstructorBucket {
  readonly name: string;
  readonly count: number;
  readonly selfSizeBytes: number;
}

export interface MemlabFindings {
  readonly available: boolean;
  readonly reason?: string;
  readonly hypothesizedLeakSource?: string;
  readonly detachedDomCount?: number;
  readonly unboundedGrowthClasses?: ReadonlyArray<string>;
}

export interface ProbeResult {
  readonly schemaVersion: typeof PROBE_SCHEMA_VERSION;
  readonly measuredAt: string;
  readonly target: string;
  readonly doc: string;
  readonly cycles: number;
  readonly cycleHeapsMb: ReadonlyArray<number>;
  readonly leakRateMbPerCycle: number;
  readonly topRetainedConstructors: ReadonlyArray<ConstructorBucket>;
  readonly memlabFindings: MemlabFindings;
  readonly errors: ReadonlyArray<string>;
  readonly hypothesizedFixPath: 'local' | 'fork-required' | 'undetermined';
  readonly hypothesizedFixNotes: string;
}


interface CdpHeapSnapshotChunkEvent {
  readonly chunk: string;
}

interface ParsedSnapshotMeta {
  readonly node_fields: ReadonlyArray<string>;
  readonly node_types: ReadonlyArray<string | ReadonlyArray<string>>;
}

interface ParsedSnapshot {
  readonly snapshot: { readonly meta: ParsedSnapshotMeta; readonly node_count: number };
  readonly nodes: ReadonlyArray<number>;
  readonly strings: ReadonlyArray<string>;
}

async function captureTopRetainedConstructors(
  cdp: CDPSession,
  topN: number,
): Promise<ConstructorBucket[]> {
  const chunks: string[] = [];
  const handler = (event: CdpHeapSnapshotChunkEvent): void => {
    chunks.push(event.chunk);
  };
  cdp.on('HeapProfiler.addHeapSnapshotChunk', handler);
  try {
    await Promise.race([
      cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `HeapProfiler.takeHeapSnapshot timed out after ${HEAP_SNAPSHOT_TIMEOUT_MS}ms`,
              ),
            ),
          HEAP_SNAPSHOT_TIMEOUT_MS,
        ),
      ),
    ]);
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', handler);
  }

  let parsed: ParsedSnapshot;
  try {
    parsed = JSON.parse(chunks.join('')) as ParsedSnapshot;
  } catch (err) {
    const byteCount = chunks.reduce((sum, c) => sum + c.length, 0);
    throw new Error(
      `captureTopRetainedConstructors: heap-snapshot JSON.parse failed (${chunks.length} chunks, ${byteCount} bytes total): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const fields = parsed.snapshot.meta.node_fields;
  const nameIdx = fields.indexOf('name');
  const sizeIdx = fields.indexOf('self_size');
  if (nameIdx === -1 || sizeIdx === -1) return [];
  const stride = fields.length;

  const bucketByName = new Map<string, { name: string; count: number; selfSizeBytes: number }>();
  const nodes = parsed.nodes;
  const strings = parsed.strings;
  for (let i = 0; i < nodes.length; i += stride) {
    const nameIndex = nodes[i + nameIdx] as number;
    const selfSize = nodes[i + sizeIdx] as number;
    const name = (strings[nameIndex] ?? '<unknown>') as string;
    let bucket = bucketByName.get(name);
    if (!bucket) {
      bucket = { name, count: 0, selfSizeBytes: 0 };
      bucketByName.set(name, bucket);
    }
    bucket.count += 1;
    bucket.selfSizeBytes += selfSize;
  }
  const sorted = Array.from(bucketByName.values()).sort(
    (a, b) => b.selfSizeBytes - a.selfSizeBytes,
  );
  return sorted.slice(0, topN);
}


async function tryMemlabEnrichment(): Promise<MemlabFindings> {
  try {
    const memlab = (await import('memlab').catch(() => null)) as {
      readonly findLeaks?: (args: unknown) => Promise<unknown>;
      readonly analyze?: (args: unknown) => Promise<unknown>;
    } | null;
    if (memlab === null) {
      return {
        available: false,
        reason: 'memlab module not loadable (devDependency missing or Puppeteer Chromium absent)',
      };
    }
    if (typeof memlab.analyze !== 'function' && typeof memlab.findLeaks !== 'function') {
      return {
        available: false,
        reason: 'memlab loaded but analyze/findLeaks API not present',
      };
    }
    return {
      available: true,
      hypothesizedLeakSource:
        'memlab loadable; run `npx memlab` separately for DetachedDOMElementAnalysis pass',
      detachedDomCount: undefined,
      unboundedGrowthClasses: undefined,
    };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}


async function waitForVisibleProseMirror(
  page: Page,
  doc: string,
  timeoutMs: number,
): Promise<void> {
  const marker = markerFor(doc);
  await page.waitForFunction(
    ({ needle, fallbackChars }: { needle: string | null; fallbackChars: number }) => {
      const nodes = document.querySelectorAll('.ProseMirror');
      for (const n of Array.from(nodes)) {
        const rect = (n as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const txt = n.textContent ?? '';
        if (needle && txt.includes(needle)) return true;
        if (!needle && txt.length >= fallbackChars) return true;
      }
      return false;
    },
    { needle: marker, fallbackChars: 200 },
    { timeout: timeoutMs },
  );
}

async function mountAndDestroyOnce(page: Page, target: string, doc: string): Promise<void> {
  await page.goto(`${target}/#/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.goto(`${target}/#/${encodeURIComponent(doc)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await waitForVisibleProseMirror(page, doc, WAIT_CONTENT_MS);
  await page.goto(`${target}/#/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
}


function classifyFixPath(topConstructors: ReadonlyArray<ConstructorBucket>): {
  path: 'local' | 'fork-required' | 'undetermined';
  notes: string;
} {
  if (topConstructors.length === 0) {
    return {
      path: 'undetermined',
      notes: 'No constructors captured (snapshot empty or parse failed); cannot classify.',
    };
  }
  const tiptapInternalSignals = [
    'Editor',
    'EditorView',
    'EditorState',
    'Plugin',
    'PluginKey',
    'NodeView',
    'YXmlFragment',
    'YUndoManager',
  ];
  const top10 = topConstructors.slice(0, 10);
  const tiptapMatches = top10.filter((b) =>
    tiptapInternalSignals.some((s) => b.name === s || b.name.endsWith(`/${s}`)),
  );
  const tiptapShare =
    tiptapMatches.reduce((sum, b) => sum + b.selfSizeBytes, 0) /
    Math.max(
      1,
      top10.reduce((sum, b) => sum + b.selfSizeBytes, 0),
    );

  if (tiptapShare > 0.5) {
    return {
      path: 'fork-required',
      notes: `${(tiptapShare * 100).toFixed(0)}% of top-10 retained bytes are TipTap/ProseMirror-internal constructors (${tiptapMatches.map((b) => b.name).join(', ')}). The destroy path at editor-cache.ts:526 already null-restores undoManager.restore — remaining leak is inside @tiptap/core or @tiptap/y-tiptap. Per SPEC §15 STOP_IF, surface to user before forking; record findings.`,
    };
  }

  return {
    path: 'undetermined',
    notes: `Top-10 retained constructors include ${top10
      .slice(0, 3)
      .map((b) => `${b.name} (${(b.selfSizeBytes / 1024 / 1024).toFixed(2)}MB)`)
      .join(
        ', ',
      )}. Engineer should inspect retained graph for OK-app vs TipTap-internal attribution before deciding fix path.`,
  };
}


export async function runProbe(options: ProbeOptions): Promise<ProbeResult> {
  const errors: string[] = [];
  let browser: Browser | null = null;
  let page: Page | null = null;
  let cdp: CDPSession | null = null;

  const cycleHeapsMb: number[] = [];
  let topRetainedConstructors: ConstructorBucket[] = [];

  try {
    browser = await chromium.launch({
      headless: !options.headed,
      args: ['--enable-precise-memory-info'],
    });
    const context = await browser.newContext();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    await cdp.send('HeapProfiler.enable');

    await page.goto(`${options.target}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await forceGc(cdp);

    for (let cycle = 0; cycle < options.cycles; cycle++) {
      try {
        await mountAndDestroyOnce(page, options.target, options.doc);
        await forceGc(cdp);
        const heap = await readHeapMb(page);
        cycleHeapsMb.push(heap);
      } catch (err) {
        errors.push(`cycle ${cycle}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      topRetainedConstructors = await captureTopRetainedConstructors(cdp, options.topN);
    } catch (err) {
      errors.push(`top-N constructor capture: ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    errors.push(`browser session: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
      }
    }
  }

  const leakRateMbPerCycle = computeLeakRateMbPerCycle(cycleHeapsMb);

  const memlabFindings = await tryMemlabEnrichment();
  const { path: hypothesizedFixPath, notes: hypothesizedFixNotes } =
    classifyFixPath(topRetainedConstructors);

  return {
    schemaVersion: PROBE_SCHEMA_VERSION,
    measuredAt: new Date().toISOString(),
    target: options.target,
    doc: options.doc,
    cycles: options.cycles,
    cycleHeapsMb,
    leakRateMbPerCycle,
    topRetainedConstructors,
    memlabFindings,
    errors,
    hypothesizedFixPath,
    hypothesizedFixNotes,
  };
}


interface CliArgs {
  readonly target: string;
  readonly doc: string;
  readonly cycles: number;
  readonly outDir: string;
  readonly topN: number;
  readonly updateBaseline: boolean;
  readonly headed: boolean;
}

export function parseCliArgs(argv: ReadonlyArray<string>): CliArgs {
  let target = DEFAULT_TARGET;
  let doc = DEFAULT_DOC;
  let cycles = DEFAULT_CYCLES;
  let outDir = DEFAULT_OUT_DIR;
  let topN = DEFAULT_TOP_N;
  let updateBaseline = false;
  let headed = false;

  for (const arg of argv) {
    if (arg.startsWith('--target=')) target = arg.slice('--target='.length);
    else if (arg.startsWith('--doc=')) doc = arg.slice('--doc='.length);
    else if (arg.startsWith('--cycles=')) {
      const n = Number.parseInt(arg.slice('--cycles='.length), 10);
      if (!Number.isFinite(n) || n < 2) {
        throw new Error(
          `--cycles must be an integer >=2 (need ≥2 samples for leak-rate); got "${arg}"`,
        );
      }
      cycles = n;
    } else if (arg.startsWith('--out-dir=')) outDir = arg.slice('--out-dir='.length);
    else if (arg.startsWith('--top-n=')) {
      const n = Number.parseInt(arg.slice('--top-n='.length), 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--top-n must be a positive integer; got "${arg}"`);
      }
      topN = n;
    } else if (arg === '--update-baseline') updateBaseline = true;
    else if (arg === '--headed') headed = true;
    else if (arg === '--help' || arg === '-h') {
      throw new Error('--help');
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }

  return { target, doc, cycles, outDir, topN, updateBaseline, headed };
}

function printUsage(): void {
  process.stdout.write(
    `\nTipTap destroy-leak probe — identifies post-destroy retention.\n\n` +
      `Usage: bun run probe:tiptap-leak [flags]\n\n` +
      `Flags:\n` +
      `  --target=<url>           Dev server URL (default: ${DEFAULT_TARGET})\n` +
      `  --doc=<name>             Doc to mount/destroy (default: ${DEFAULT_DOC})\n` +
      `  --cycles=<n>             Mount/destroy cycles, ≥2 (default: ${DEFAULT_CYCLES})\n` +
      `  --out-dir=<path>         Where to write results JSON (default: spec evidence dir)\n` +
      `  --top-n=<n>              Top-N retained constructors (default: ${DEFAULT_TOP_N})\n` +
      `  --update-baseline        Overwrite tiptap-leak-probe-baseline.json on success\n` +
      `  --headed                 Launch with visible browser (default: headless)\n` +
      `  --help, -h               Show this message\n\n` +
      `Prereq: dev server running at --target (cd packages/app && bun run dev).\n\n` +
      `STOP_IF: per cap-graduation-cache-regime SPEC §15, do NOT autonomously fork\n` +
      `@tiptap/core. Surface findings to the user when hypothesizedFixPath is\n` +
      `'fork-required' before applying any patches/@tiptap__core+*.patch.\n\n`,
  );
}

export function writeProbeResults(
  result: ProbeResult,
  outDir: string,
  updateBaseline: boolean,
): {
  resultsPath: string;
  baselinePath?: string;
} {
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  const stamp = result.measuredAt.replace(/[:.]/g, '-');
  const resultsPath = resolve(outDir, `tiptap-leak-probe-results-${stamp}.json`);
  writeFileSync(resultsPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  if (updateBaseline) {
    const observedCycles = result.cycleHeapsMb.length;
    const successRate = result.cycles > 0 ? observedCycles / result.cycles : 0;
    const MIN_SUCCESS_RATE = 0.5;
    if (successRate < MIN_SUCCESS_RATE) {
      throw new Error(
        `--update-baseline refused: only ${observedCycles}/${result.cycles} cycles ` +
          `succeeded (${(successRate * 100).toFixed(0)}%). Baseline would be derived ` +
          `from a degraded run; fix the underlying failure (see result.errors[]) and re-run.`,
      );
    }
    const baseline = {
      schemaVersion: PROBE_SCHEMA_VERSION,
      source:
        result.hypothesizedFixPath === 'fork-required'
          ? 'pre-fix-W14-fork-required'
          : result.leakRateMbPerCycle < 2
            ? 'post-fix-W14'
            : 'pre-fix-W14-local-tbd',
      leakRateMbPerCycle: result.leakRateMbPerCycle,
      acceptableMaxMbPerCycle: 5,
      measuredAt: result.measuredAt,
      target: result.target,
      doc: result.doc,
      cycles: result.cycles,
      observedCycles,
      successRate,
      hypothesizedFixPath: result.hypothesizedFixPath,
      hypothesizedFixNotes: result.hypothesizedFixNotes,
      topRetainedConstructorsTop5: result.topRetainedConstructors.slice(0, 5),
      notes:
        'Updated by `bun run probe:tiptap-leak --update-baseline`. Source field controls regression-test threshold activation. Baselines are only written when observedCycles/cycles >= 0.5 — a degraded run would otherwise label the run as clean by writing leakRateMbPerCycle=0.',
    };
    const baselinePath = resolve(outDir, 'tiptap-leak-probe-baseline.json');
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    return { resultsPath, baselinePath };
  }

  return { resultsPath };
}

if (import.meta.main) {
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof Error && err.message === '--help') {
      printUsage();
      process.exit(0);
    }
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    printUsage();
    process.exit(1);
  }

  process.stdout.write(
    `\nTipTap destroy-leak probe\n` +
      `  target: ${args.target}\n` +
      `  doc:    ${args.doc}\n` +
      `  cycles: ${args.cycles}\n` +
      `  outDir: ${args.outDir}\n` +
      `  headed: ${args.headed}\n\n`,
  );

  const result = await runProbe(args);

  process.stdout.write(`\n--- Probe results ---\n`);
  process.stdout.write(`  cycles completed:    ${result.cycleHeapsMb.length}/${result.cycles}\n`);
  process.stdout.write(`  leak rate:           ${result.leakRateMbPerCycle.toFixed(3)} MB/cycle\n`);
  process.stdout.write(`  fix-path hypothesis: ${result.hypothesizedFixPath}\n`);
  process.stdout.write(`  notes: ${result.hypothesizedFixNotes}\n\n`);

  process.stdout.write(`--- Top retained constructors (self_size) ---\n`);
  for (const b of result.topRetainedConstructors.slice(0, 20)) {
    process.stdout.write(
      `  ${b.name.padEnd(40, ' ')}  count=${String(b.count).padStart(6)}  ` +
        `selfMB=${(b.selfSizeBytes / 1024 / 1024).toFixed(2)}\n`,
    );
  }

  process.stdout.write(`\n--- memlab enrichment ---\n`);
  process.stdout.write(`  available: ${result.memlabFindings.available}\n`);
  if (result.memlabFindings.reason) {
    process.stdout.write(`  reason:    ${result.memlabFindings.reason}\n`);
  }
  if (result.memlabFindings.hypothesizedLeakSource) {
    process.stdout.write(`  hypothesis: ${result.memlabFindings.hypothesizedLeakSource}\n`);
  }

  if (result.errors.length > 0) {
    process.stdout.write(`\n--- Errors (non-fatal) ---\n`);
    for (const e of result.errors) {
      process.stdout.write(`  ${e}\n`);
    }
  }

  const written = writeProbeResults(result, args.outDir, args.updateBaseline);
  process.stdout.write(`\nResults JSON: ${written.resultsPath}\n`);
  if (written.baselinePath) {
    process.stdout.write(`Baseline updated: ${written.baselinePath}\n`);
  }

  if (result.hypothesizedFixPath === 'fork-required') {
    process.stdout.write(
      `\n⚠ STOP_IF triggered: hypothesizedFixPath = 'fork-required'.\n` +
        `Per cap-graduation-cache-regime SPEC §15, surface to user before\n` +
        `forking @tiptap/core. Record findings in evidence/tiptap-leak-probe-findings.md.\n\n`,
    );
  }

  process.exit(0);
}
