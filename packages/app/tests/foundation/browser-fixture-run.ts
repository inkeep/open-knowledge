import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NESTED_RUN_DEADLINE_MS } from './nested-run-budget';

export const BROWSER_FIXTURE_ORDER_ENV = 'OK_BROWSER_FIXTURE_ORDER';
export const BROWSER_FIXTURE_CACHE_DIR_ENV = 'OK_BROWSER_FIXTURE_CACHE_DIR';

export type BrowserFixtureRequest = {
  readonly files: readonly string[];
  readonly ci?: string;
  readonly debugGc?: boolean;
  readonly deadlineMs?: number;
};

type BrowserFixtureTestStatus = 'passed' | 'failed' | 'skipped' | 'pending' | 'todo';

type BrowserFixtureTest = {
  readonly title: string;
  readonly status: BrowserFixtureTestStatus;
  readonly failureMessages: readonly string[];
};

export type BrowserFixtureFile = {
  readonly file: string;
  readonly status: string;
  readonly message: string;
  readonly tests: readonly BrowserFixtureTest[];
};

export type BrowserFixtureRun = {
  readonly exitCode: number | null;
  readonly files: readonly BrowserFixtureFile[] | null;
  readonly stdout: string;
  readonly stderr: string;
};

declare module 'vitest/browser' {
  interface BrowserCommands {
    runBrowserFixture: (request: BrowserFixtureRequest) => Promise<BrowserFixtureRun>;
  }
}

export const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FIXTURE_CONFIG = join(FIXTURE_DIR, 'vitest.browser-fixture.config.ts');
const VITEST_CLI = resolve(
  dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))),
  'vitest.mjs',
);
const FIXTURE_FILE = /^[\w-]+(?:\.[\w-]+)*\.fixture\.tsx?$/;

export function fixtureFilePaths(files: readonly string[]): string[] {
  if (files.length === 0 || files.some((file) => !FIXTURE_FILE.test(file))) {
    throw new Error(`runBrowserFixture takes fixture file names only, got ${files.join(', ')}`);
  }
  return files.map((file) => join(FIXTURE_DIR, file));
}

export function fixtureDeadlineMs(request: BrowserFixtureRequest): number {
  const { deadlineMs = NESTED_RUN_DEADLINE_MS } = request;
  if (!Number.isInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > NESTED_RUN_DEADLINE_MS) {
    throw new Error(
      `runBrowserFixture takes a deadline of 1 to ${NESTED_RUN_DEADLINE_MS} ms, got ${deadlineMs}`,
    );
  }
  return deadlineMs;
}

const UNFINISHED_RUN_OUTPUT_LINES = 30;

export function unfinishedRunMessage(
  files: readonly string[],
  deadlineMs: number,
  output: { readonly stdout: string; readonly stderr: string },
): string {
  const lastLines = `${output.stdout}\n${output.stderr}`
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-UNFINISHED_RUN_OUTPUT_LINES);
  return [
    `The nested browser fixture run of ${files.join(', ')} did not finish within ${deadlineMs} ms, so it was stopped. Its last output:`,
    ...(lastLines.length > 0 ? lastLines : ['(none)']),
  ].join('\n');
}

export function fixtureRunArguments(filePaths: readonly string[], reportPath: string): string[] {
  return [
    VITEST_CLI,
    'run',
    '--config',
    FIXTURE_CONFIG,
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${reportPath}`,
    ...filePaths,
  ];
}

export function fixtureEnv(
  request: BrowserFixtureRequest,
  inherited: NodeJS.ProcessEnv,
  cacheDir: string,
): NodeJS.ProcessEnv {
  const { CI: _ci, DEBUG: _debug, ...env } = inherited;
  return {
    ...env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    [BROWSER_FIXTURE_ORDER_ENV]: request.files.join(','),
    [BROWSER_FIXTURE_CACHE_DIR_ENV]: cacheDir,
    ...(request.ci === undefined ? {} : { CI: request.ci }),
    ...(request.debugGc ? { DEBUG: 'vitest:browser:gc' } : {}),
  };
}

type JsonAssertion = { title: string; status: BrowserFixtureTestStatus; failureMessages: string[] };
type JsonFile = {
  name: string;
  status: string;
  message: string;
  assertionResults: JsonAssertion[];
};

export function parseFixtureReport(text: string): BrowserFixtureFile[] {
  const report = JSON.parse(text) as { testResults: JsonFile[] };
  return report.testResults
    .map((file) => ({
      file: relative(FIXTURE_DIR, file.name).split(sep).join('/'),
      status: file.status,
      message: file.message,
      tests: file.assertionResults.map(({ title, status, failureMessages }) => ({
        title,
        status,
        failureMessages,
      })),
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
}
