/**
 * Scenario contract for `packages/app/tests/perf/scenarios/*.ts`.
 *
 * Each scenario is a standalone module that default-exports the result of
 * `defineScenario({ name, run })`. The `profile.ts` CLI loads the module,
 * launches a dedicated Playwright Chromium (headless by default; opt into
 * headed via `--headed` or `OK_PERF_HEADED=1` for paint/GPU diagnosis where
 * the headless browser drops some events), attaches a CDP session +
 * tracing, and calls `scenario.run(ctx)`.
 *
 * The scenario's `run` function drives the browser to reproduce its symptom
 * and returns any symptom-specific fields it wants merged into the canonical
 * result (e.g. `{ warmSwitchMs: 1150 }`, `{ apiCallCount: 14 }`). The driver
 * then stitches in the generic bag (wall-clock, long tasks, paint events,
 * CDP trace aggregates, perf marks drained from `globalThis.__ok_perf`).
 *
 * No `@playwright/test` runner ceremony — retries, fixtures, and per-worker
 * isolation fight perf-measurement stability. The scenario
 * framework is deliberately a thin wrapper around Playwright's raw Browser/
 * Page APIs plus a CDP tracer.
 *
 * See `packages/app/tests/perf/README.md` for authoring guide.
 */

import type { Browser, BrowserContext, CDPSession, Page } from '@playwright/test';
import type { ProfilerRenderEvent } from '../../../src/lib/perf/types';
import type { TraceSummary } from './cdp-tracer';

// ─────────────────────────── Scenario-facing types ────────────────────────

export interface ScenarioOptions {
  /** Base URL of the live dev server. Default: `http://localhost:5173`. */
  target: string;
  /** Where to write `results/<scenario>.<timestamp>.json`. Default: repo-relative `results/`. */
  outDir: string;
  /**
   * Run headed Chromium. Default: false. Set via `--headed` flag or
   * `OK_PERF_HEADED=1` env. Headed is required for some paint/GPU events
   * but multi-cell sweeps that lose foreground focus get throttled.
   */
  headed: boolean;
  /** Override viewport (mostly for CI repro). Default: 1440×900. */
  viewport?: { width: number; height: number };
  /** Extra scenario-specific knobs forwarded to `run(ctx)`. */
  extra?: Record<string, unknown>;
}

export interface ScenarioCtx {
  page: Page;
  context: BrowserContext;
  browser: Browser;
  cdp: CDPSession;
  opts: Readonly<ScenarioOptions>;
  /**
   * Pushes arbitrary symptom-specific numbers into the final JSON result.
   * Merged under `result.metrics` after the canonical trace aggregate.
   */
  recordMetric(key: string, value: number | string | boolean | null): void;
  /**
   * Attaches notes (free-form strings) to the final JSON. Useful for
   * "the scenario ran but the big-doc wasn't available" hedges.
   */
  note(line: string): void;
}

export interface PerfMarkRecord {
  name: string;
  startTime: number;
  duration: number;
  track: string;
  properties?: Record<string, unknown>;
}

export interface WebVitalRecord {
  name: 'INP' | 'LCP' | 'CLS' | 'FCP' | 'TTFB';
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  delta: number;
  id: string;
}

export interface NetworkRequestRecord {
  url: string;
  method: string;
  status: number;
  resourceType: string;
  ms: number;
}

export interface ScenarioResultMetadata {
  bunVersion: string | null;
  nodeVersion: string;
  platform: string;
  commitSha: string | null;
  capturedAt: string;
  targetUrl: string;
  headed: boolean;
  viewport: { width: number; height: number };
}

export interface ScenarioResult {
  scenario: string;
  description?: string;
  metadata: ScenarioResultMetadata;
  /** Total wall-clock time from scenario start to end. */
  wallClockMs: number;
  /** CDP trace aggregates (long tasks, layout, style, script, paint). */
  trace: TraceSummary;
  /** Perf marks drained from `globalThis.__ok_perf.marks`. */
  marks: PerfMarkRecord[];
  /** React `<Profiler>` onRender events — marks filtered on `ok/render/` prefix. */
  onRender: ProfilerRenderEvent[];
  /** web-vitals drained from `globalThis.__ok_perf.vitals`. */
  vitals: WebVitalRecord[];
  /** Every HTTP request the page made during the scenario. */
  networkRequests: NetworkRequestRecord[];
  /** Console-level errors (non-fatal). */
  consoleErrors: string[];
  /** Scenario-specific extras (warmSwitchMs, apiCallCount, etc.). */
  metrics: Record<string, number | string | boolean | null>;
  /** Free-form notes (e.g. "PROJECT.md not found, scenario skipped body"). */
  notes: string[];
}

// ─────────────────────────── defineScenario contract ──────────────────────

export interface ScenarioDefinition {
  /** Matches the file's slug — referenced via `--scenario=<name>`. */
  name: string;
  description?: string;
  /**
   * Drive the browser. Return any metric keys the scenario wants merged in;
   * the driver already records wall-clock + trace aggregates + drained marks.
   */
  run(ctx: ScenarioCtx): Promise<void>;
}

export function defineScenario(def: ScenarioDefinition): ScenarioDefinition {
  if (!def.name || typeof def.name !== 'string') {
    throw new Error('defineScenario: `name` is required (string)');
  }
  if (typeof def.run !== 'function') {
    throw new Error(`defineScenario("${def.name}"): \`run\` must be a function`);
  }
  return def;
}
