#!/usr/bin/env -S npx tsx
/**
 * `tsx tests/perf/sweep-measure.ts --target=<url>` — project-scope Fix-all
 * sweep measurement.
 *
 * Drives the real Problems panel against a live server and reports the five
 * numbers the shipping configuration's success metrics turn on: panel-open
 * time, full-sweep duration, successful-fix count, capacity-refusal count,
 * and main-thread blocked time. The bash orchestrator (`scripts/measure-sweep.sh`)
 * boots the server against a scratch copy of a fixture, invokes this, and
 * compares the numbers to their targets.
 *
 * Standalone entry — no `@playwright/test` runner (its retries/fixtures fight
 * measurement stability). Mirrors `tests/perf/profile.ts`, but purpose-built
 * for one long sweep rather than the perf-baseline scenario matrix: it skips
 * the CDP trace (a 2,000-request sweep produces a multi-hundred-MB trace that
 * measures nothing here) and keeps only the long-task observer.
 *
 * The result is a single machine-parseable stdout line — `SWEEP_RESULT <json>`
 * — so the orchestrator can parse it without a results file. Every human-facing
 * progress line goes to stderr, keeping stdout a clean channel.
 *
 * CLI:
 *   --target=<url>     Base URL of the live server. Required.
 *   --nav-doc=<name>   Extension-less docName to open first (any doc works —
 *                      project scope audits the whole content dir). Falls back
 *                      to OK_SWEEP_DOC, then to the app root.
 *   --sweep-timeout=<ms>  Max wait for the sweep to finish. Default 300000.
 *
 * Exit codes:
 *   0  measurement completed (SWEEP_RESULT written)
 *   1  usage error
 *   2  the run threw before a result could be formed
 */

import { pathToFileURL } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';
import { installLongtaskObserver, readLongtasks } from './lib/longtask-observer.ts';

const DEFAULT_SWEEP_TIMEOUT_MS = 300_000;
const VIEWPORT = { width: 1440, height: 900 };
// The sr-only sweep live region ("Fixing N of M files") is the one signal that
// is present for the whole sweep and gone the instant it ends. The Auto-fix
// button's own progress label uses the short "Fixing N/M" form, so matching the
// long "of M files" phrasing targets the live region alone.
const FIXING_REGION_RE = /Fixing\s+\d+\s+of\s+(\d+)\s+files/;

interface Args {
  target: string;
  navDoc: string | null;
  sweepTimeoutMs: number;
}

function parseArgs(argv: readonly string[]): Args {
  let target = '';
  let navDoc = process.env.OK_SWEEP_DOC ?? null;
  let sweepTimeoutMs = DEFAULT_SWEEP_TIMEOUT_MS;
  for (const raw of argv) {
    if (raw.startsWith('--target=')) target = raw.slice('--target='.length);
    else if (raw.startsWith('--nav-doc=')) navDoc = raw.slice('--nav-doc='.length) || null;
    else if (raw.startsWith('--sweep-timeout=')) {
      const n = Number(raw.slice('--sweep-timeout='.length));
      if (Number.isFinite(n) && n > 0) sweepTimeoutMs = n;
    } else if (raw === '-h' || raw === '--help') {
      usageAndExit(null);
    } else if (raw.startsWith('--')) {
      usageAndExit(`unrecognized flag: "${raw}"`);
    }
  }
  if (!target) usageAndExit('missing required --target=<url>');
  return { target, navDoc, sweepTimeoutMs };
}

function usageAndExit(err: string | null): never {
  const lines = [
    'Usage: tsx tests/perf/sweep-measure.ts --target=<url> [flags]',
    '',
    '  --target=<url>        Required. Base URL of a live OK server.',
    '  --nav-doc=<name>      Doc to open first (default: $OK_SWEEP_DOC or app root).',
    '  --sweep-timeout=<ms>  Max wait for the sweep. Default 300000.',
  ];
  if (err) process.stderr.write(`[sweep-measure] ${err}\n\n`);
  process.stderr.write(`${lines.join('\n')}\n`);
  process.exit(err ? 1 : 0);
}

function log(line: string): void {
  process.stderr.write(`[sweep-measure] ${line}\n`);
}

/** Encode a docName for the hash route without escaping its path separators. */
function encodeDocRoute(docName: string): string {
  return docName.split('/').map(encodeURIComponent).join('/');
}

interface LintFixTally {
  success: number;
  capacity503: number;
  otherFail: number;
}

interface SweepResult {
  target: string;
  navDoc: string | null;
  appReadyMs: number;
  panelOpenColdMs: number;
  panelOpenWarmMs: number;
  fixableFileCount: number;
  sweepDurationMs: number;
  sweepCompleted: boolean;
  lintFixSuccess: number;
  lintFix503: number;
  lintFixOtherFail: number;
  filesFailedTerminal: number;
  mainThreadBlockedMs: number;
  mainThreadBlockedPct: number;
  longtaskCount: number;
  consoleErrorCount: number;
  notes: string[];
}

async function openProblemsProjectScope(page: Page, notes: string[]): Promise<number> {
  await page.locator('#tab-problems').click();
  // Wait for the panel body (a list or the empty state) so the scope toggle exists.
  await page
    .locator('ul[aria-label="Problems"]')
    .or(page.getByText('No problems found'))
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });

  // Panel-open cost is the render of the enumerated plane after the audit
  // resolves — measure click → summary populated. The first activation also
  // pays the cold audit walk, so it is reported separately from the warm
  // re-activation below (which is render-bound and comparable to the spec's
  // collapse-by-default number).
  const cold = await timeProjectScopeActivation(page);
  notes.push(`panel-open cold (incl. cold audit): ${cold}ms`);
  return cold;
}

/** Click into project scope and time until the audit summary renders. */
async function timeProjectScopeActivation(page: Page): Promise<number> {
  const summary = page.getByTestId('problems-audit-summary');
  const t0 = Date.now();
  await page.getByTestId('panel-scope-project').click();
  // The summary text is empty until `audit.status === 'loaded'`; a populated
  // error/warning count is the "plane rendered" signal.
  await summary.filter({ hasText: /\d+\s+(error|warning)/ }).waitFor({ timeout: 120_000 });
  return Date.now() - t0;
}

async function run(args: Args): Promise<SweepResult> {
  const notes: string[] = [];
  const tally: LintFixTally = { success: 0, capacity503: 0, otherFail: 0 };
  let consoleErrorCount = 0;

  const browser: Browser = await chromium.launch({
    headless: process.env.OK_PERF_HEADED !== '1',
    args: ['--enable-precise-memory-info'],
  });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();

    // Long-task observer must be installed before the first navigation so
    // `buffered: true` back-fills tasks that land during load.
    await installLongtaskObserver(page);

    page.on('response', (resp) => {
      if (!resp.url().includes('/api/lint/fix')) return;
      const s = resp.status();
      if (s >= 200 && s < 300) tally.success += 1;
      else if (s === 503) tally.capacity503 += 1;
      else tally.otherFail += 1;
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrorCount += 1;
    });
    page.on('pageerror', () => {
      consoleErrorCount += 1;
    });

    // Navigate. Opening a doc gives the right rail (and its Problems tab); the
    // project-scope audit is independent of which doc is open.
    const url = args.navDoc ? `${args.target}/#/${encodeDocRoute(args.navDoc)}` : `${args.target}/`;
    log(`navigating to ${url}`);
    const readyStart = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.locator('#tab-problems').waitFor({ state: 'visible', timeout: 120_000 });
    const appReadyMs = Date.now() - readyStart;
    log(`app ready in ${appReadyMs}ms`);

    const panelOpenColdMs = await openProblemsProjectScope(page, notes);
    log(`panel open (cold) ${panelOpenColdMs}ms`);

    // Warm re-activation: leave project scope, return, and re-time. The audit
    // snapshot is cached across scope flips, so this isolates the render cost.
    await page.getByTestId('panel-scope-doc').click();
    await page.waitForTimeout(300);
    const panelOpenWarmMs = await timeProjectScopeActivation(page);
    log(`panel open (warm) ${panelOpenWarmMs}ms`);

    const autoFix = page.getByTestId('problems-auto-fix');
    await autoFix.waitFor({ state: 'visible', timeout: 30_000 });
    if (await autoFix.isDisabled()) {
      notes.push('Auto-fix button disabled — no fixable files; sweep skipped.');
      log('Auto-fix disabled; nothing to sweep');
      return buildResult(args, {
        appReadyMs,
        panelOpenColdMs,
        panelOpenWarmMs,
        fixableFileCount: 0,
        sweepDurationMs: 0,
        sweepCompleted: true,
        tally,
        mainThreadBlockedMs: 0,
        mainThreadBlockedPct: 0,
        longtaskCount: 0,
        consoleErrorCount,
        notes,
      });
    }

    // Drive the sweep. Time the window in the page's own performance timeline so
    // long tasks (same timeline) can be attributed to it.
    const fixingRegion = page.locator('[role="status"]').filter({ hasText: FIXING_REGION_RE });
    const sweepStartPerf = await page.evaluate(() => performance.now());
    await autoFix.click();

    let fixableFileCount = 0;
    let sweepCompleted = true;
    try {
      await fixingRegion.first().waitFor({ state: 'attached', timeout: 30_000 });
      const text = (await fixingRegion.first().textContent()) ?? '';
      const m = text.match(FIXING_REGION_RE);
      if (m) fixableFileCount = Number(m[1]);
      log(`sweep started: ${fixableFileCount} fixable files`);
      await fixingRegion.first().waitFor({ state: 'detached', timeout: args.sweepTimeoutMs });
    } catch (err) {
      sweepCompleted = false;
      notes.push(
        `sweep did not complete within ${args.sweepTimeoutMs}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
      log(`WARN: sweep incomplete — ${err instanceof Error ? err.message : String(err)}`);
    }
    const sweepEndPerf = await page.evaluate(() => performance.now());
    const sweepDurationMs = Math.round(sweepEndPerf - sweepStartPerf);
    log(`sweep window ${sweepDurationMs}ms (completed=${sweepCompleted})`);

    // Long tasks that fell inside the sweep window are the main-thread blocking.
    const longtasks = await readLongtasks(page);
    const inWindow = longtasks.filter(
      (t) => t.startTime >= sweepStartPerf && t.startTime <= sweepEndPerf,
    );
    const mainThreadBlockedMs = Math.round(inWindow.reduce((sum, t) => sum + t.duration, 0));
    const mainThreadBlockedPct =
      sweepDurationMs > 0 ? round2((mainThreadBlockedMs / sweepDurationMs) * 100) : 0;

    if (fixableFileCount === 0 && tally.success > 0) {
      // The region flicked past too fast to sample (tiny fixtures); the count of
      // distinct successful fixes is then the best available denominator.
      fixableFileCount = tally.success + Math.max(0, tally.otherFail);
      notes.push('fixableFileCount inferred from successful fixes (region not sampled)');
    }
    const filesFailedTerminal = Math.max(0, fixableFileCount - tally.success);

    return buildResult(args, {
      appReadyMs,
      panelOpenColdMs,
      panelOpenWarmMs,
      fixableFileCount,
      sweepDurationMs,
      sweepCompleted,
      tally,
      mainThreadBlockedMs,
      mainThreadBlockedPct,
      longtaskCount: inWindow.length,
      consoleErrorCount,
      notes,
      filesFailedTerminal,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

function buildResult(
  args: Args,
  parts: {
    appReadyMs: number;
    panelOpenColdMs: number;
    panelOpenWarmMs: number;
    fixableFileCount: number;
    sweepDurationMs: number;
    sweepCompleted: boolean;
    tally: LintFixTally;
    mainThreadBlockedMs: number;
    mainThreadBlockedPct: number;
    longtaskCount: number;
    consoleErrorCount: number;
    notes: string[];
    filesFailedTerminal?: number;
  },
): SweepResult {
  return {
    target: args.target,
    navDoc: args.navDoc,
    appReadyMs: parts.appReadyMs,
    panelOpenColdMs: parts.panelOpenColdMs,
    panelOpenWarmMs: parts.panelOpenWarmMs,
    fixableFileCount: parts.fixableFileCount,
    sweepDurationMs: parts.sweepDurationMs,
    sweepCompleted: parts.sweepCompleted,
    lintFixSuccess: parts.tally.success,
    lintFix503: parts.tally.capacity503,
    lintFixOtherFail: parts.tally.otherFail,
    filesFailedTerminal:
      parts.filesFailedTerminal ?? Math.max(0, parts.fixableFileCount - parts.tally.success),
    mainThreadBlockedMs: parts.mainThreadBlockedMs,
    mainThreadBlockedPct: parts.mainThreadBlockedPct,
    longtaskCount: parts.longtaskCount,
    consoleErrorCount: parts.consoleErrorCount,
    notes: parts.notes,
  };
}

function round2(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  run(args)
    .then((result) => {
      process.stdout.write(`SWEEP_RESULT ${JSON.stringify(result)}\n`);
      process.exit(0);
    })
    .catch((err) => {
      log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exit(2);
    });
}

export { encodeDocRoute, parseArgs, type SweepResult };
