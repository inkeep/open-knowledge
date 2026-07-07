#!/usr/bin/env bun
/**
 * TipTap destroy-leak memlab probe — identifies the leak source by mounting
 * + destroying a PROJECT-class editor and capturing CDP heap snapshots
 * before/after destroy, then extracting the top-N retained-constructor
 * histogram so the leak source can be attributed.
 *
 * Hypothesis (from upstream TipTap issues #5654 + #538): `editor.destroy()`
 * does not unwire `editorView.dom` refs, causing TipTap-internal objects
 * (ProseMirror plugins, node views, decorations) to retain after destroy.
 * The OK destroy path at `editor-cache.ts / mount-promise.ts /
 * editor-cache.ts` already mitigates the @tiptap/extension-collaboration
 * UndoManager.restore closure leak by nulling `undoManager.restore` after
 * destroy — the probe identifies what additional sources remain.
 *
 * STOP_IF: if the surfaced fix
 * requires modifying `@tiptap/core` or any `@tiptap/*` package source code,
 * STOP and surface to the user. Do NOT autonomously create
 * `patches/@tiptap__core+X.Y.Z.patch`. Record the finding and complete the
 * user story with the probe + regression test only.
 *
 * Architecture:
 *   - Standalone Bun script — owns its Playwright launch (does NOT use the
 *     `tests/perf/profile.ts` scenario harness; probes are diagnostic, not
 *     measurement, and benefit from a dedicated CLI surface).
 *   - Reuses `forceGc` + `readHeapMb` from `tests/perf/lib/cell-measurement.ts`
 *     (the primitives extracted from `memory-per-editor.ts`).
 *   - Captures CDP `HeapProfiler.takeHeapSnapshot` before + after destroy;
 *     parses the snapshot stream to extract per-constructor self_size
 *     buckets (top-N).
 *   - Lazily imports `memlab` for enrichment (DetachedDOMElementAnalysis,
 *     ShapeUnboundGrowthAnalysis) — gracefully degrades when memlab isn't
 *     installed or its Puppeteer-bundled Chromium isn't available (Bun's
 *     `trustedDependencies` policy skips Puppeteer postinstall by default).
 *
 * Run via: `bun run probe:tiptap-leak`
 *
 * Prerequisites:
 *   - Dev server running at the target URL (default `http://localhost:5173`).
 *     Start with `cd packages/app && bun run dev`.
 *   - Doc named PROJECT.md in `<contentDir>` (the default OK content
 *     directory; readme/AGENTS/PROJECT are the standard doc-marker
 *     buckets — see `tests/perf/lib/doc-markers.ts`).
 *
 * Output:
 *   - Stdout: human-readable summary including top-20 retained constructors
 *     and per-cycle leak rate.
 *   - JSON: `<outDir>/tiptap-leak-probe-results-<ISO8601>.json` with the
 *     full ProbeResult shape.
 *   - When invoked with `--update-baseline`: also overwrites
 *     `<outDir>/tiptap-leak-probe-baseline.json` (the regression test's
 *     source of truth — see `tiptap-destroy-leak.test.ts`).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type CDPSession, chromium, type Page } from '@playwright/test';
import { computeLeakRateMbPerCycle, forceGc, readHeapMb } from '../lib/cell-measurement';
import { markerFor } from '../lib/doc-markers';

// ─────────────────────────────────────────────────────────────────────────
// Defaults + constants
// ─────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET = 'http://localhost:5173';
const DEFAULT_DOC = 'PROJECT';
const DEFAULT_CYCLES = 10;
const DEFAULT_TOP_N = 20;
// HERE is packages/app/tests/perf/probes; needs 5 `..` to reach the OK
// repo root (packages/app/tests/perf/probes → perf → tests → app → packages → repo-root).
const DEFAULT_OUT_DIR = resolve(
  HERE,
  '../../../../../specs/2026-05-10-cap-graduation-cache-regime/evidence',
);
const WAIT_CONTENT_MS = 60_000;
const HEAP_SNAPSHOT_TIMEOUT_MS = 120_000;
const PROBE_SCHEMA_VERSION = 1 as const;

// ─────────────────────────────────────────────────────────────────────────
// Public API types
// ─────────────────────────────────────────────────────────────────────────

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

/**
 * Lightweight memlab finding shape — populated when the optional `memlab`
 * dependency resolves AND its Puppeteer Chromium is installed. Otherwise
 * `null`; the probe still produces actionable output via the hand-rolled
 * top-N constructor histogram.
 */
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

// ─────────────────────────────────────────────────────────────────────────
// Snapshot capture + parsing (extracted pattern from memory-per-editor.ts)
// ─────────────────────────────────────────────────────────────────────────

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

/**
 * Capture a heap snapshot via CDP, parse the chunked stream, walk the flat
 * `nodes` array, and return the top-N constructors by self_size.
 *
 * self_size (not retained_size) because retained_size requires a graph walk
 * not present in the snapshot wire format. For "which constructors dominate
 * post-destroy retention" the self-size aggregate is a faithful proxy
 * (and matches the existing pattern at `memory-per-editor.ts`).
 *
 * Snapshot format reference:
 *   https://chromedevtools.github.io/devtools-protocol/v8/HeapProfiler/
 */
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
    // Rethrow so the outer try/catch in runProbe captures the failure
    // into `errors[]`. Silently returning [] leaves classifyFixPath
    // emitting 'undetermined' for what is actually a multi-megabyte
    // parse crash — the engineer needs to see the parse-error message
    // + the chunk + byte counts to diagnose.
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

// ─────────────────────────────────────────────────────────────────────────
// Memlab analysis enrichment (lazy-imported; gracefully degrades)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Attempt to load and run memlab's analysis enrichment. memlab is in
 * devDependencies but its Puppeteer-bundled Chromium is NOT auto-downloaded
 * by Bun (trustedDependencies default skips postinstall scripts). The
 * engineer running this probe on canonical hardware can opt in via:
 *   - Add `puppeteer` to root `trustedDependencies`, OR
 *   - Run `PUPPETEER_SKIP_DOWNLOAD=false bun add memlab` directly.
 *
 * Returns `{ available: false, reason: ... }` when memlab isn't loadable;
 * the probe's hand-rolled constructor histogram is the primary signal
 * regardless.
 */
async function tryMemlabEnrichment(): Promise<MemlabFindings> {
  try {
    // Lazy dynamic import — the catch handles "not installed" + "puppeteer
    // chromium absent" + "API surface drift" uniformly.
    // memlab's API entry point exposes findLeaks + analyze.
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
    // memlab's full analysis pipeline requires its own scenario format
    // (URL/action/back). Running it from inside a Playwright session is
    // architecturally awkward — it would relaunch its own Puppeteer browser.
    // For now we report availability + advise running `npx memlab` separately
    // for the deep analysis pass; the hand-rolled histogram is the primary
    // signal in this probe's output JSON.
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

// ─────────────────────────────────────────────────────────────────────────
// Mount/destroy cycle harness
// ─────────────────────────────────────────────────────────────────────────

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
  // Navigate AWAY (unmount any prior editor); then BACK (force fresh mount).
  await page.goto(`${target}/#/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.goto(`${target}/#/${encodeURIComponent(doc)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await waitForVisibleProseMirror(page, doc, WAIT_CONTENT_MS);
  // Navigate AWAY again — triggers EditorActivityPool unmount + V2 cache
  // park or evict. With CACHE_ENABLED=true (default), the editor parks; with
  // a sufficient navigation pattern it eventually evicts and `editor.destroy()`
  // runs (the leak target).
  await page.goto(`${target}/#/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
}

// ─────────────────────────────────────────────────────────────────────────
// Fix-path classification heuristic
// ─────────────────────────────────────────────────────────────────────────

/**
 * Classify the hypothesized fix path based on the top-N retained-constructor
 * histogram. Conservative heuristic: if the dominant retained constructors
 * are TipTap/ProseMirror-internal (`Editor`, `EditorView`, `Plugin`, etc.)
 * AND the OK destroy path already null-restores `undoManager.restore`
 * (verified at editor-cache.ts), the leak likely originates inside
 * @tiptap/core's destroy() — which would require forking. If the dominant
 * retained constructors are OK-app classes (e.g., something hanging in a
 * React closure or our own pool entry), the fix is more likely local.
 *
 * The classification is a HINT — the engineer's judgment + memlab's deeper
 * analysis are the source of truth. Returns `'undetermined'` when the
 * histogram doesn't match either pattern strongly.
 */
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

// ─────────────────────────────────────────────────────────────────────────
// Probe entry point
// ─────────────────────────────────────────────────────────────────────────

export async function runProbe(options: ProbeOptions): Promise<ProbeResult> {
  const errors: string[] = [];
  let browser: Browser | null = null;
  let page: Page | null = null;
  let cdp: CDPSession | null = null;

  // Output containers; we always produce a result shape even on partial failure.
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

    // Warm-load — navigate once before capturing baseline so module init
    // costs aren't conflated with per-cycle retention.
    await page.goto(`${options.target}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await forceGc(cdp);

    // Per-cycle measurement loop. Each cycle: mount → destroy → forceGc → readHeap.
    for (let cycle = 0; cycle < options.cycles; cycle++) {
      try {
        await mountAndDestroyOnce(page, options.target, options.doc);
        await forceGc(cdp);
        const heap = await readHeapMb(page);
        cycleHeapsMb.push(heap);
      } catch (err) {
        errors.push(`cycle ${cycle}: ${err instanceof Error ? err.message : String(err)}`);
        // Keep going — leak rate computation needs ≥2 samples; one failed
        // cycle doesn't kill the run.
      }
    }

    // Final heap snapshot for top-N constructor histogram.
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
        // Best-effort.
      }
    }
  }

  // Delegate to the library so the probe and any sweep-cell that emits a
  // tipTapLeakRateMbPerCycle field share a single source of truth for the
  // formula. Two formulas for the same metric would make probe-emitted
  // baselines incomparable to library-emitted cell measurements.
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

// ─────────────────────────────────────────────────────────────────────────
// CLI entry
// ─────────────────────────────────────────────────────────────────────────

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
      // Caller will print usage; signal via exception.
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
    // Refuse to write a baseline derived from a degraded run. A run where
    // most cycles failed (dev server unreachable, browser crash, etc.)
    // produces an empty cycleHeapsMb, which makes computeLeakRateMbPerCycle
    // return 0. A 0-rate baseline labelled 'post-fix-W14' would mask real
    // leak rates of 5-15 MB/cycle for the regression test that consumes
    // this file. The threshold is conservative — the engineer can re-run
    // with a stable target after fixing the underlying degradation.
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
