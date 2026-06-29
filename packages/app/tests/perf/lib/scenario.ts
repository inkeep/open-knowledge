import type { Browser, BrowserContext, CDPSession, Page } from '@playwright/test';
import type { ProfilerRenderEvent } from '../../../src/lib/perf/types';
import type { TraceSummary } from './cdp-tracer';

export interface ScenarioOptions {
  target: string;
  outDir: string;
  headed: boolean;
  viewport?: { width: number; height: number };
  extra?: Record<string, unknown>;
}

export interface ScenarioCtx {
  page: Page;
  context: BrowserContext;
  browser: Browser;
  cdp: CDPSession;
  opts: Readonly<ScenarioOptions>;
  recordMetric(key: string, value: number | string | boolean | null): void;
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
  wallClockMs: number;
  trace: TraceSummary;
  marks: PerfMarkRecord[];
  onRender: ProfilerRenderEvent[];
  vitals: WebVitalRecord[];
  networkRequests: NetworkRequestRecord[];
  consoleErrors: string[];
  metrics: Record<string, number | string | boolean | null>;
  notes: string[];
}

export interface ScenarioDefinition {
  name: string;
  description?: string;
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
