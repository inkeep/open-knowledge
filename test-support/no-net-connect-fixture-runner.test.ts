import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { NetConnectBlockedError } from './no-net-connect';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE_CONFIG = fileURLToPath(
  new URL('./fixtures/no-net-connect/vitest.no-net-connect-fixture.config.ts', import.meta.url),
);
const VITEST_PACKAGE_DIR = dirname(fileURLToPath(import.meta.resolve('vitest/package.json')));
const VITEST_CLI = resolve(VITEST_PACKAGE_DIR, 'vitest.mjs');
const FIXTURE_TIMEOUT_MS = 20_000;

type AssertionStatus = 'passed' | 'failed' | 'skipped' | 'pending' | 'todo';

type AssertionResult = {
  fullName: string;
  status: AssertionStatus;
  failureMessages: string[];
};

type TestFileResult = {
  status: AssertionStatus;
  message: string;
  assertionResults: AssertionResult[];
};

type VitestJsonReport = {
  success: boolean;
  testResults: TestFileResult[];
};

type FixtureResult = {
  exitCode: number | string | null;
  killed: boolean;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type FixtureRun = {
  env?: Record<string, string>;
  reporter?: 'json' | 'default';
};

function runFixture(testNamePattern: string, run: FixtureRun = {}): Promise<FixtureResult> {
  return new Promise((resolveResult) => {
    execFile(
      process.execPath,
      [
        VITEST_CLI,
        'run',
        '--config',
        FIXTURE_CONFIG,
        '--testNamePattern',
        testNamePattern,
        `--reporter=${run.reporter ?? 'json'}`,
        '--no-color',
      ],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          OK_FIXTURE_COLLECTION_BLOCK: '',
          ...run.env,
        },
        timeout: FIXTURE_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        resolveResult({
          exitCode: error?.code ?? 0,
          killed: error?.killed ?? false,
          signal: error?.signal ?? null,
          stdout,
          stderr,
        });
      },
    );
  });
}

function assertLaunched(
  result: FixtureResult,
): asserts result is FixtureResult & { exitCode: number } {
  if (result.killed && result.signal === 'SIGTERM') {
    throw new Error(
      `Vitest fixture exceeded the ${FIXTURE_TIMEOUT_MS} ms per-run budget and was killed; ` +
        `this is a runner budget, not a guard regression.\n${result.stderr}`,
    );
  }
  expect(result.killed, result.stderr).toBe(false);
  expect(result.signal, result.stderr).toBeNull();
  if (typeof result.exitCode !== 'number') {
    throw new Error(`Vitest fixture failed to launch: ${result.exitCode}\n${result.stderr}`);
  }
}

function parseReport(result: FixtureResult): VitestJsonReport {
  assertLaunched(result);
  try {
    return JSON.parse(result.stdout) as VitestJsonReport;
  } catch (error) {
    throw new Error(`Vitest fixture returned invalid JSON\n${result.stdout}\n${result.stderr}`, {
      cause: error,
    });
  }
}

function assertionFor(report: VitestJsonReport, fullName: string): AssertionResult {
  const assertion = report.testResults[0]?.assertionResults.find(
    (result) => result.fullName === fullName,
  );
  if (assertion === undefined) throw new Error(`Missing fixture assertion: ${fullName}`);
  return assertion;
}

function expectedBlockedFailure(hostname: string, scopeName: string): string {
  return new NetConnectBlockedError(hostname, scopeName).toString();
}

describe('no-net-connect lifecycle fixture', () => {
  test('swallowed undeclared forbidden fetch exits with its NetConnectBlockedError', async () => {
    const fullName = 'swallowed undeclared forbidden fetch fails';
    const result = await runFixture(fullName);
    const report = parseReport(result);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(report.success).toBe(false);
    const assertion = assertionFor(report, fullName);
    expect(assertion.status).toBe('failed');
    expect(assertion.failureMessages).toHaveLength(1);
    expect(assertion.failureMessages[0]).toContain(
      expectedBlockedFailure('undeclared.invalid', fullName),
    );
  });

  test('mismatched hostname reports the unexpected block and unused expectation', async () => {
    const fullName = 'mismatched hostname expectation fails';
    const result = await runFixture(fullName);
    const report = parseReport(result);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(report.success).toBe(false);
    const assertion = assertionFor(report, fullName);
    expect(assertion.status).toBe('failed');
    const failures = assertion.failureMessages.join('\n');
    expect(failures).toContain(expectedBlockedFailure('actual.invalid', fullName));
    expect(failures).toContain(
      `Error: Expected network blocks did not occur in ${fullName}: expected.invalid`,
    );
  });

  test('ordinary assertion and swallowed block both surface', async () => {
    const fullName = 'ordinary assertion and swallowed forbidden fetch both surface';
    const result = await runFixture(fullName);
    const report = parseReport(result);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(report.success).toBe(false);
    const assertion = assertionFor(report, fullName);
    expect(assertion.status).toBe('failed');
    const failures = assertion.failureMessages.join('\n');
    expect(failures).toContain(expectedBlockedFailure('combined-failure.invalid', fullName));
    expect(failures).toContain('ordinary-actual');
    expect(failures).toContain('ordinary-expected');
  });

  test('unused hostname expectation fails its owning assertion', async () => {
    const fullName = 'unused hostname expectation fails';
    const result = await runFixture(fullName);
    const report = parseReport(result);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(report.success).toBe(false);
    const assertion = assertionFor(report, fullName);
    expect(assertion.status).toBe('failed');
    expect(assertion.failureMessages).toHaveLength(1);
    expect(assertion.failureMessages[0]).toContain(
      `Expected network blocks did not occur in ${fullName}: unused.invalid`,
    );
  });

  test('suite setup swallowed block fails the suite result', async () => {
    const result = await runFixture('suite setup swallowed block fails');
    const report = parseReport(result);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(report.success).toBe(false);
    const fileResult = report.testResults[0];
    expect(fileResult?.status).toBe('failed');
    expect(fileResult?.message).toBe(
      new NetConnectBlockedError('suite-setup.invalid', '<suite hooks>').message,
    );
    expect(
      assertionFor(report, 'suite setup swallowed block fails suite body completes').status,
    ).toBe('passed');
  });

  test('a collection-time block is reported alongside a suite-hook block', async () => {
    const result = await runFixture('suite setup swallowed block fails', {
      env: { OK_FIXTURE_COLLECTION_BLOCK: '1' },
      reporter: 'default',
    });
    assertLaunched(result);
    expect(result.exitCode, result.stderr).toBe(1);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain(
      new NetConnectBlockedError('suite-setup.invalid', '<suite hooks>').message,
    );
    expect(output).toContain(
      new NetConnectBlockedError('collection-time.invalid', '<outside a test>').message,
    );
  });

  test('suite teardown swallowed block fails the suite result', async () => {
    const result = await runFixture('suite teardown swallowed block fails');
    const report = parseReport(result);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(report.success).toBe(false);
    const fileResult = report.testResults[0];
    expect(fileResult?.status).toBe('failed');
    expect(fileResult?.message).toBe(
      new NetConnectBlockedError('suite-teardown.invalid', '<suite hooks>').message,
    );
    expect(
      assertionFor(report, 'suite teardown swallowed block fails suite body completes').status,
    ).toBe('passed');
  });

  test('suite hook declaration cannot authorize a sibling suite block', async () => {
    const suiteName = 'suite hook declarations cannot authorize sibling suite blocks';
    const result = await runFixture(suiteName);
    const report = parseReport(result);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(report.success).toBe(false);
    const fileResult = report.testResults[0];
    expect(fileResult?.status).toBe('failed');
    expect(fileResult?.message).toBe(
      new NetConnectBlockedError('cross-suite.invalid', '<suite hooks>').message,
    );
    expect(
      assertionFor(report, `${suiteName} declaration sibling declaration rejection body passes`)
        .status,
    ).toBe('passed');
    expect(
      assertionFor(report, `${suiteName} blocking sibling swallowed block body passes`).status,
    ).toBe('passed');
  });

  test('a block landing after its scope drained is reported on stderr, not enforced', async () => {
    const suiteName = 'a block that lands after its scope drained is reported, not enforced';
    const result = await runFixture(suiteName);
    assertLaunched(result);
    expect(result.exitCode, result.stderr).toBe(0);
    const report = parseReport(result);
    expect(report.success).toBe(true);
    const scopeName = `${suiteName} > schedules a forbidden fetch that lands after it returns`;
    expect(result.stderr).toContain(`Blocked a request to "orphan.invalid" for "${scopeName}"`);
    expect(result.stderr).toContain('Reported, not enforced');
    const lateScope = `${suiteName} > schedules a late declaration that cannot re-open its scope`;
    expect(result.stderr).toContain(
      `Declared a block for "late-declaration.invalid" for "${lateScope}"`,
    );
    expect(result.stderr).toContain(
      `Blocked a request to "late-declaration.invalid" for "${lateScope}"`,
    );
    expect(result.stderr).not.toContain(
      new NetConnectBlockedError('orphan.invalid', scopeName).message,
    );
  });

  test.each(['declared exact hostname block passes', 'unrelated console error passes'])(
    '%s exits with a passing assertion',
    async (fullName) => {
      const result = await runFixture(fullName);
      const report = parseReport(result);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).not.toContain('[no-net-connect]');
      expect(report.success).toBe(true);
      expect(assertionFor(report, fullName).status).toBe('passed');
    },
  );

  test('concurrent exact hostname expectations both pass', async () => {
    const suiteName = 'concurrent siblings isolate exact hostname expectations';
    const result = await runFixture(suiteName);
    const report = parseReport(result);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(report.success).toBe(true);
    expect(assertionFor(report, `${suiteName} alpha request`).status).toBe('passed');
    expect(assertionFor(report, `${suiteName} beta request`).status).toBe('passed');
  });

  test('concurrent unexpected block fails only its owning test', async () => {
    const suiteName = 'concurrent unexpected block stays with its owning test';
    const offenderName = `${suiteName} offender swallows its unexpected block`;
    const innocentName = `${suiteName} innocent sibling passes`;
    const result = await runFixture(suiteName);
    const report = parseReport(result);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(report.success).toBe(false);
    const offender = assertionFor(report, offenderName);
    expect(offender.status).toBe('failed');
    expect(offender.failureMessages).toHaveLength(1);
    expect(offender.failureMessages[0]).toContain(
      expectedBlockedFailure(
        'concurrent-offender.invalid',
        `${suiteName} > offender swallows its unexpected block`,
      ),
    );
    const innocent = assertionFor(report, innocentName);
    expect(innocent.status).toBe('passed');
    expect(innocent.failureMessages).toEqual([]);
  });
});
