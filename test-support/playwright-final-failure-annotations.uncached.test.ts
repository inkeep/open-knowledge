import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, onTestFinished, test } from 'vitest';
import { spawnUnderOwnerLifeline } from './owner-lifeline';

const OK_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DESKTOP_ROOT = path.join(OK_ROOT, 'packages/desktop');
const PLAYWRIGHT_CLI = createRequire(path.join(DESKTOP_ROOT, 'package.json')).resolve(
  '@playwright/test/cli',
);
const FIXTURE_DIR = path.join(DESKTOP_ROOT, 'tests/support/fixtures/final-failure-annotations');
const RUN_TIMEOUT_MS = 120_000;
const CONFIGS = [
  'packages/app/playwright.config.ts',
  'packages/app/playwright.a11y.config.ts',
  'packages/desktop/playwright.config.ts',
  'packages/desktop/playwright.packaged.config.ts',
];

const CASES = [
  {
    title: 'fails then skips its retry',
    exit: 1,
    stats: {
      expected: 0,
      flaky: 1,
      skipped: 0,
    },
    statuses: ['failed', 'skipped'],
  },
  {
    title: 'fails then passes its retry',
    exit: 0,
    stats: {
      expected: 0,
      flaky: 1,
      skipped: 0,
    },
    statuses: ['failed', 'passed'],
  },
  {
    title: 'fails as expected',
    exit: 0,
    stats: {
      expected: 1,
      flaky: 0,
      skipped: 0,
    },
    statuses: ['failed'],
  },
  {
    title: 'skips from the start',
    exit: 0,
    stats: {
      expected: 0,
      flaky: 0,
      skipped: 1,
    },
    statuses: ['skipped'],
  },
  {
    title: 'changes its expectation without meeting either',
    exit: 1,
    stats: {
      expected: 0,
      flaky: 1,
      skipped: 0,
    },
    statuses: ['passed', 'failed', 'failed'],
  },
  {
    title: 'meets a changed failure expectation on retry',
    exit: 0,
    stats: {
      expected: 1,
      flaky: 0,
      skipped: 0,
    },
    statuses: ['failed', 'failed'],
  },
];

describe.each(CONFIGS)('%s CI retry verdict', (config) => {
  test.for(CASES)(
    '$title',
    { timeout: RUN_TIMEOUT_MS + 30_000 },
    async ({ title, exit, stats, statuses }, { signal }) => {
      const outputDir = mkdtempSync(path.join(tmpdir(), 'playwright-retry-verdict-'));
      onTestFinished(() => rmSync(outputDir, { recursive: true, force: true }));
      const fixtureConfig = path.join(outputDir, 'playwright.config.mts');
      const jsonReport = path.join(outputDir, 'results.json');
      writeFileSync(
        fixtureConfig,
        `import config from ${JSON.stringify(path.join(OK_ROOT, config))};
export default {
  ...config,
  testDir: ${JSON.stringify(FIXTURE_DIR)},
  testMatch: 'retry-outcomes.fixture-spec.ts',
  testIgnore: [],
  globalSetup: undefined,
  globalTeardown: undefined,
  webServer: undefined,
  projects: undefined,
  outputDir: ${JSON.stringify(path.join(outputDir, 'artifacts'))},
  globalTimeout: ${RUN_TIMEOUT_MS},
  workers: 1,
  use: {},
  reporter: [
    ...config.reporter.map(([name, options]) =>
      name === 'json' ? [name, { ...options, outputFile: ${JSON.stringify(jsonReport)} }] :
      name === 'html' ? [name, { ...options, outputFolder: ${JSON.stringify(path.join(outputDir, 'html'))} }] :
      [name, options]),
    ...(config.reporter.some(([name]) => name === 'json') ? [] : [['json', { outputFile: ${JSON.stringify(jsonReport)} }]]),
  ],
};
`,
      );
      const env: NodeJS.ProcessEnv = { CI: '1', FORCE_COLOR: '0' };
      for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR']) {
        env[name] = process.env[name];
      }
      env.GITHUB_WORKSPACE = OK_ROOT;
      const { child, commandResult } = spawnUnderOwnerLifeline(
        process.execPath,
        [PLAYWRIGHT_CLI, 'test', '--config', fixtureConfig, '--grep', title],
        { cwd: DESKTOP_ROOT, env },
      );
      const closed = once(child, 'close');
      const stop = () => child.stdin.end();
      signal.addEventListener('abort', stop, { once: true });
      onTestFinished(async () => {
        stop();
        await closed;
        signal.removeEventListener('abort', stop);
      });
      let output = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
      });
      await closed;
      const result = await commandResult;
      expect(existsSync(jsonReport), output).toBe(true);
      const report = JSON.parse(readFileSync(jsonReport, 'utf8'));
      expect(report.suites, output).toHaveLength(1);
      expect(report.suites[0].specs, output).toHaveLength(1);
      expect(report.suites[0].specs[0].title, output).toBe(title);
      expect(report.suites[0].specs[0].tests[0].results, output).toMatchObject(
        statuses.map((status) => ({ status })),
      );
      expect(report.stats, output).toMatchObject({ ...stats, unexpected: 0 });
      expect(result, output).toEqual({ code: exit, signal: null });
      if (exit === 1) {
        const properties = /^::error (.*?)::.*No attempt met its expected status/m.exec(
          output,
        )?.[1];
        expect(properties, output).toContain(title);
      }
    },
  );
});
