#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page, type Request, type Response } from '@playwright/test';
import type { PerfCollector, ProfilerRenderEvent } from '../../src/lib/perf/types';
import { traceEnd, traceStart } from './lib/cdp-tracer';
import type {
  NetworkRequestRecord,
  PerfMarkRecord,
  ScenarioCtx,
  ScenarioDefinition,
  ScenarioOptions,
  ScenarioResult,
  ScenarioResultMetadata,
  WebVitalRecord,
} from './lib/scenario';


const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET = 'http://localhost:5173';
const DEFAULT_OUT_DIR = resolve(HERE, 'results');
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };


interface CliArgs {
  scenario: string;
  target: string;
  outDir: string;
  headed: boolean;
  viewport: { width: number; height: number };
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let scenario = '';
  let target = DEFAULT_TARGET;
  let outDir = DEFAULT_OUT_DIR;
  let headed = process.env.OK_PERF_HEADED === '1';
  let viewport = DEFAULT_VIEWPORT;

  for (const raw of argv) {
    if (raw.startsWith('--scenario=')) scenario = raw.slice('--scenario='.length);
    else if (raw.startsWith('--target=')) target = raw.slice('--target='.length);
    else if (raw.startsWith('--out=')) outDir = resolve(raw.slice('--out='.length));
    else if (raw === '--headless') headed = false;
    else if (raw === '--headed') headed = true;
    else if (raw.startsWith('--viewport=')) {
      const v = raw.slice('--viewport='.length);
      const m = v.match(/^(\d+)x(\d+)$/i);
      if (!m) {
        usageAndExit(`invalid --viewport: "${v}" (expected WxH, e.g. 1440x900)`);
      }
      viewport = { width: Number(m[1]), height: Number(m[2]) };
    } else if (raw === '--help' || raw === '-h') {
      usageAndExit(null);
    } else if (raw.startsWith('--')) {
      usageAndExit(`unrecognized flag: "${raw}"`);
    }
  }

  if (!scenario) usageAndExit('missing required --scenario=<name>');
  return { scenario, target, outDir, headed, viewport };
}

function usageAndExit(err: string | null): never {
  const lines = [
    'Usage: bun run tests/perf/profile.ts --scenario=<name> [flags]',
    '',
    '  --scenario=<name>        Required. Loads ./scenarios/<name>.ts',
    '  --target=<url>           Base URL. Default: http://localhost:5173',
    '  --out=<dir>              Output dir. Default: ./results',
    '  --headed                 Launch with a visible browser window.',
    '                           Default: headless. Equivalent to',
    '                           OK_PERF_HEADED=1 in the environment.',
    '  --headless               Launch headless (the default).',
    '  --viewport=<WxH>         Viewport, e.g. 1920x1080. Default 1440x900',
    '',
    'Scenarios live at packages/app/tests/perf/scenarios/*.ts',
  ];
  if (err) {
    console.error(`[profile] ${err}\n`);
  }
  console.log(lines.join('\n'));
  process.exit(err ? 1 : 0);
}


async function loadScenario(name: string): Promise<ScenarioDefinition> {
  const path = resolve(HERE, 'scenarios', `${name}.ts`);
  let mod: { default?: unknown };
  try {
    mod = (await import(path)) as { default?: unknown };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[profile] failed to load scenario "${name}" at ${path}: ${msg}`);
    process.exit(1);
  }
  const scen = mod.default as ScenarioDefinition | undefined;
  if (!scen || typeof scen.run !== 'function') {
    console.error(`[profile] scenario "${name}" did not default-export a valid ScenarioDefinition`);
    process.exit(1);
  }
  return scen;
}


async function runScenario(args: CliArgs): Promise<void> {
  const scen = await loadScenario(args.scenario);

  const opts: ScenarioOptions = {
    target: args.target,
    outDir: args.outDir,
    headed: args.headed,
    viewport: args.viewport,
  };

  mkdirSync(args.outDir, { recursive: true });

  const metadata = buildMetadata(args);
  const metrics: Record<string, number | string | boolean | null> = {};
  const notes: string[] = [];
  const networkRequests: NetworkRequestRecord[] = [];
  const consoleErrors: string[] = [];

  let browser: Browser | null = null;
  let wallClockMs = 0;
  let result: ScenarioResult | undefined;
  let thrown: Error | null = null;

  const startAt = performance.now();
  try {
    browser = await chromium.launch({
      headless: !args.headed,
      args: ['--enable-precise-memory-info'],
    });
    const context = await browser.newContext({
      viewport: args.viewport,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    wireNetworkLogger(page, networkRequests);
    wireConsoleLogger(page, consoleErrors);

    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Performance.enable');

    const token = await traceStart(cdp);

    const ctx: ScenarioCtx = {
      page,
      context,
      browser,
      cdp,
      opts,
      recordMetric(key, value) {
        metrics[key] = value;
      },
      note(line) {
        notes.push(line);
      },
    };

    await scen.run(ctx);

    const trace = await traceEnd(token);
    wallClockMs = performance.now() - startAt;

    const { marks, onRender, vitals } = await drainCollector(page);

    result = {
      scenario: scen.name,
      description: scen.description,
      metadata,
      wallClockMs: round2(wallClockMs),
      trace,
      marks,
      onRender,
      vitals,
      networkRequests,
      consoleErrors,
      metrics,
      notes,
    };
  } catch (err) {
    thrown = err instanceof Error ? err : new Error(String(err));
    wallClockMs = performance.now() - startAt;
  } finally {
    try {
      await browser?.close();
    } catch {
    }
  }

  const outPath = resolve(
    args.outDir,
    `${args.scenario}.${metadata.capturedAt.replace(/[:.]/g, '-')}.json`,
  );
  const payload = result ?? {
    scenario: args.scenario,
    metadata,
    wallClockMs: round2(wallClockMs),
    error: thrown ? { message: thrown.message, stack: thrown.stack } : { message: 'unknown' },
    metrics,
    notes,
    networkRequests,
    consoleErrors,
  };
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`[profile] wrote ${outPath}`);

  if (thrown) {
    console.error(`[profile] scenario "${args.scenario}" threw: ${thrown.message}`);
    process.exit(2);
  }
}


function buildMetadata(args: CliArgs): ScenarioResultMetadata {
  return {
    bunVersion: (process.versions as Record<string, string>).bun ?? null,
    nodeVersion: process.versions.node,
    platform: `${platform()}-${process.arch} (${hostname()})`,
    commitSha: readGitSha(),
    capturedAt: new Date().toISOString(),
    targetUrl: args.target,
    headed: args.headed,
    viewport: args.viewport,
  };
}

function readGitSha(): string | null {
  try {
    const repoRoot = resolve(HERE, '../../../..');
    const head = readFileSync(resolve(repoRoot, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = head.slice(5);
      return readFileSync(resolve(repoRoot, '.git', refPath), 'utf8').trim();
    }
    return head;
  } catch {
    return null;
  }
}

function wireNetworkLogger(page: Page, out: NetworkRequestRecord[]): void {
  const pending = new Map<Request, number>();
  page.on('request', (req: Request) => {
    pending.set(req, performance.now());
  });
  page.on('response', (resp: Response) => {
    const req = resp.request();
    const startedAt = pending.get(req);
    pending.delete(req);
    const ms = startedAt !== undefined ? performance.now() - startedAt : 0;
    out.push({
      url: resp.url(),
      method: req.method(),
      status: resp.status(),
      resourceType: req.resourceType(),
      ms: round2(ms),
    });
  });
}

function wireConsoleLogger(page: Page, out: string[]): void {
  page.on('console', (msg) => {
    if (msg.type() === 'error') out.push(msg.text());
  });
  page.on('pageerror', (err) => {
    out.push(err.message);
  });
}

async function drainCollector(page: Page): Promise<{
  marks: PerfMarkRecord[];
  onRender: ProfilerRenderEvent[];
  vitals: WebVitalRecord[];
}> {
  try {
    const payload = await page.evaluate(() => {
      const g = globalThis as unknown as { __ok_perf?: PerfCollector };
      const c = g.__ok_perf;
      if (!c) return { marks: [], vitals: [] };
      return {
        marks: c.marks.toArray().map((m) => ({
          name: m.name,
          startTime: m.startTime,
          duration: m.duration,
          track: m.track,
          properties: m.properties,
        })),
        vitals: c.vitals.toArray().map((v) => ({
          name: v.name,
          value: v.value,
          rating: v.rating,
          delta: v.delta,
          id: v.id,
        })),
      };
    });
    const { marks, vitals } = payload;
    const onRender: ProfilerRenderEvent[] = [];
    for (const m of marks) {
      if (m.name.startsWith('ok/render/')) {
        const props = (m.properties ?? {}) as Record<string, unknown>;
        const phase =
          props.phase === 'update' || props.phase === 'nested-update' ? props.phase : 'mount';
        onRender.push({
          id: m.name.slice('ok/render/'.length),
          phase,
          actualDuration:
            typeof props.actualDuration === 'number' ? props.actualDuration : m.duration,
          baseDuration: typeof props.baseDuration === 'number' ? props.baseDuration : 0,
          startTime: m.startTime,
          commitTime:
            typeof props.commitTime === 'number' ? props.commitTime : m.startTime + m.duration,
        });
      }
    }
    return { marks: marks as PerfMarkRecord[], onRender, vitals: vitals as WebVitalRecord[] };
  } catch {
    return { marks: [], onRender: [], vitals: [] };
  }
}

function round2(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}


if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  runScenario(args).catch((err) => {
    console.error(`[profile] fatal: ${err?.message ?? err}`);
    process.exit(2);
  });
}
