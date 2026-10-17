import { appendFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page, TestInfo } from '@playwright/test';
import {
  browserScriptFile,
  E2E_COVERAGE_PATH,
  e2eCoverageDir,
  executedOffsets,
  recordableSource,
  type ScriptCoverage,
} from '../../../../src/build/e2e-coverage-contract.ts';
import type { WorkerServer } from '../fixtures.ts';
import { APP_PACKAGE_ROOT } from '../seed-key.ts';

export const COVERAGE_RECORD_SCHEMA = 'ok-e2e-coverage-record/1';
const OK_ROOT = join(APP_PACKAGE_ROOT, '..', '..');
const SERVER_CALL_TIMEOUT_MS = 10_000;

export interface CoverageRecord {
  readonly schema: typeof COVERAGE_RECORD_SCHEMA;
  readonly spec: string;
  readonly title: string;
  readonly retry: number;
  readonly status: string;
  readonly browser: readonly string[];
  readonly server: readonly string[] | null;
}

export interface E2eCoverage {
  watchPage(page: Page): Promise<void>;
  watchContext(context: BrowserContext): void;
  collectPage(page: Page): Promise<void>;
}

export const NO_COVERAGE: E2eCoverage = {
  watchPage: async () => {},
  watchContext: () => {},
  collectPage: async () => {},
};

export function browserCoverageFiles(
  scripts: readonly ScriptCoverage[],
  appDir: string,
  okRoot: string,
): string[] {
  const files = new Set<string>();
  for (const script of scripts) {
    if (executedOffsets(script).length === 0) continue;
    const file = browserScriptFile(script.url, appDir);
    const recorded = file === undefined ? undefined : recordableSource(file, okRoot);
    if (recorded !== undefined) files.add(recorded);
  }
  return [...files].sort();
}

export function coverageRecordLine(record: CoverageRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function specPath(testFile: string, okRoot: string = OK_ROOT): string {
  return relative(okRoot, testFile).split(sep).join('/');
}

class TestCoverage implements E2eCoverage {
  readonly browser = new Set<string>();
  private readonly sessions = new Map<Page, CDPSession>();

  async watchPage(page: Page): Promise<void> {
    if (this.sessions.has(page) || page.isClosed()) return;
    try {
      const session = await page.context().newCDPSession(page);
      await session.send('Profiler.enable');
      await session.send('Profiler.startPreciseCoverage', { callCount: false, detailed: false });
      this.sessions.set(page, session);
    } catch {
      return;
    }
    const close = page.close.bind(page);
    page.close = async (options) => {
      await this.collectPage(page);
      return close(options);
    };
  }

  watchContext(context: BrowserContext): void {
    context.on('page', (page) => {
      void this.watchPage(page);
    });
    const close = context.close.bind(context);
    context.close = async (options) => {
      await this.collectAll(context.pages());
      return close(options);
    };
  }

  async collectPage(page: Page): Promise<void> {
    const session = this.sessions.get(page);
    if (session === undefined) return;
    this.sessions.delete(page);
    try {
      const { result } = await session.send('Profiler.takePreciseCoverage');
      for (const file of browserCoverageFiles(result, APP_PACKAGE_ROOT, OK_ROOT))
        this.browser.add(file);
      await session.detach();
    } catch {
      return;
    }
  }

  async collectAll(pages: readonly Page[] = [...this.sessions.keys()]): Promise<void> {
    for (const page of pages) await this.collectPage(page);
  }
}

async function serverCoverage(baseURL: string, op: 'reset' | 'take'): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseURL}${E2E_COVERAGE_PATH}?op=${op}`, {
      method: 'POST',
      signal: AbortSignal.timeout(SERVER_CALL_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { files?: unknown };
    return Array.isArray(body.files)
      ? body.files.filter((file): file is string => typeof file === 'string')
      : null;
  } catch {
    return null;
  }
}

export async function recordingCoverage(
  { browser, workerServer }: { browser: Browser; workerServer: WorkerServer },
  use: (coverage: E2eCoverage) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  const dir = e2eCoverageDir(process.env);
  if (dir === undefined) {
    await use(NO_COVERAGE);
    return;
  }
  const coverage = new TestCoverage();
  const newContext = browser.newContext;
  browser.newContext = async (options) => {
    const context = await newContext.call(browser, options);
    coverage.watchContext(context);
    return context;
  };
  const reset = await serverCoverage(workerServer.baseURL, 'reset');
  try {
    await use(coverage);
  } finally {
    browser.newContext = newContext;
    await coverage.collectAll();
    const server = reset === null ? null : await serverCoverage(workerServer.baseURL, 'take');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, `coverage-${process.pid}.jsonl`),
      coverageRecordLine({
        schema: COVERAGE_RECORD_SCHEMA,
        spec: specPath(testInfo.file),
        title: testInfo.titlePath.slice(1).join(' > '),
        retry: testInfo.retry,
        status: testInfo.status ?? 'unknown',
        browser: [...coverage.browser].sort(),
        server,
      }),
    );
  }
}

export async function withoutCoverage(
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture contract
  {}: object,
  use: (coverage: E2eCoverage) => Promise<void>,
): Promise<void> {
  await use(NO_COVERAGE);
}

export const coverageFixture =
  e2eCoverageDir(process.env) === undefined ? withoutCoverage : recordingCoverage;
