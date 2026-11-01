import { Buffer } from 'node:buffer';
import { stdout } from 'node:process';
import type { FullConfig, TestCase, TestResult } from '@playwright/test/reporter';
import { describe, expect, test, vi } from 'vitest';
import { SETUP_NON_RESULT_ANNOTATION } from '../stress/_helpers/setup-non-result.ts';
import SetupNonResultReporter from '../stress/_helpers/setup-non-result-reporter.ts';

const ROOT_DIR = '/synthetic-project';
const SUMMARY_PREFIX = `[${SETUP_NON_RESULT_ANNOTATION}] summary `;

interface Attempt {
  status: TestResult['status'];
  declared?: string;
}

interface ScenarioTest {
  title: string;
  attempts: readonly Attempt[];
}

interface Scenario {
  tests: readonly ScenarioTest[];
  runErrors?: number;
}

function playwrightOutcome(results: readonly TestResult[]): ReturnType<TestCase['outcome']> {
  const failed = results.filter(({ status }) => status !== 'passed' && status !== 'skipped');
  const passed = results.filter(({ status }) => status === 'passed');
  if (failed.length === 0) return passed.length === 0 ? 'skipped' : 'expected';
  return passed.length === 0 ? 'unexpected' : 'flaky';
}

function syntheticTestCase(title: string, line: number, results: TestResult[]): TestCase {
  const testCase: Pick<TestCase, 'title' | 'location' | 'results' | 'outcome'> = {
    title,
    location: { file: `${ROOT_DIR}/tests/stress/synthetic.e2e.ts`, line, column: 1 },
    results,
    outcome: () => playwrightOutcome(results),
  };
  return testCase as TestCase;
}

function syntheticResult({ status, declared }: Attempt, retry: number): TestResult {
  const result: Pick<TestResult, 'status' | 'retry' | 'annotations'> = {
    status,
    retry,
    annotations:
      declared === undefined ? [] : [{ type: SETUP_NON_RESULT_ANNOTATION, description: declared }],
  };
  return result as TestResult;
}

function reporterOutput({ tests, runErrors = 0 }: Scenario): string[] {
  const reporter = new SetupNonResultReporter();
  const config: Pick<FullConfig, 'rootDir'> = { rootDir: ROOT_DIR };
  reporter.onBegin(config as FullConfig);
  tests.forEach(({ title, attempts }, index) => {
    const results: TestResult[] = [];
    const testCase = syntheticTestCase(title, index + 1, results);
    attempts.forEach((attempt, retry) => {
      const result = syntheticResult(attempt, retry);
      results.push(result);
      reporter.onTestEnd(testCase, result);
    });
  });
  for (let error = 0; error < runErrors; error += 1) reporter.onError();
  const writes: string[] = [];
  const write = vi.spyOn(stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  try {
    reporter.onEnd();
  } finally {
    write.mockRestore();
  }
  return writes.join('').split('\n');
}

function summaryLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith(SUMMARY_PREFIX));
}

function summary(scenario: Scenario): unknown {
  const lines = summaryLines(reporterOutput(scenario));
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0].slice(SUMMARY_PREFIX.length));
}

const BOOT_REASON = 'worker server did not report ready before its boot bound';
const RETRY_BOOT_REASON = 'worker server exited before it reported ready';

describe('SetupNonResultReporter summary', () => {
  test('a declared boot failure alone is the only failure the summary counts', () => {
    expect(
      summary({
        tests: [
          { title: 'boot', attempts: [{ status: 'failed', declared: BOOT_REASON }] },
          { title: 'passing neighbour', attempts: [{ status: 'passed' }] },
        ],
      }),
    ).toEqual({ declaredUnexpected: 1, unexpected: 1, runErrors: 0, reasons: [BOOT_REASON] });
  });

  test('a declared boot beside an undeclared assertion failure counts both failures', () => {
    expect(
      summary({
        tests: [
          { title: 'boot', attempts: [{ status: 'failed', declared: BOOT_REASON }] },
          { title: 'assertion', attempts: [{ status: 'failed' }] },
        ],
      }),
    ).toEqual({ declaredUnexpected: 1, unexpected: 2, runErrors: 0, reasons: [BOOT_REASON] });
  });

  test('a boot retried with every attempt declared counts each attempt as declared', () => {
    expect(
      summary({
        tests: [
          {
            title: 'boot',
            attempts: [
              { status: 'timedOut', declared: BOOT_REASON },
              { status: 'failed', declared: RETRY_BOOT_REASON },
            ],
          },
        ],
      }),
    ).toEqual({
      declaredUnexpected: 2,
      unexpected: 2,
      runErrors: 0,
      reasons: [BOOT_REASON, RETRY_BOOT_REASON],
    });
  });

  test('a declared first attempt followed by a failed attempt whose body ran is not all declared', () => {
    expect(
      summary({
        tests: [
          {
            title: 'boot then assertion',
            attempts: [{ status: 'failed', declared: BOOT_REASON }, { status: 'failed' }],
          },
        ],
      }),
    ).toEqual({ declaredUnexpected: 1, unexpected: 2, runErrors: 0, reasons: [BOOT_REASON] });
  });

  test('a declared attempt that recovers on retry counts only the declared failed attempt', () => {
    expect(
      summary({
        tests: [
          {
            title: 'boot then pass',
            attempts: [{ status: 'failed', declared: BOOT_REASON }, { status: 'passed' }],
          },
        ],
      }),
    ).toEqual({ declaredUnexpected: 1, unexpected: 1, runErrors: 0, reasons: [BOOT_REASON] });
  });

  test('a run-level error is counted beside a declared boot failure', () => {
    expect(
      summary({
        tests: [{ title: 'boot', attempts: [{ status: 'failed', declared: BOOT_REASON }] }],
        runErrors: 1,
      }),
    ).toEqual({ declaredUnexpected: 1, unexpected: 1, runErrors: 1, reasons: [BOOT_REASON] });
  });

  test("each declared reason line follows its own test's entry, not only the summary", () => {
    const lines = reporterOutput({
      tests: [
        { title: 'passing neighbour', attempts: [{ status: 'passed' }] },
        {
          title: 'boot',
          attempts: [{ status: 'failed', declared: `${BOOT_REASON}\nsecond line` }],
        },
      ],
    });
    const tag = `[${SETUP_NON_RESULT_ANNOTATION}]`;
    const entry = lines.findIndex((line) => line.startsWith(tag) && line.includes(' › boot;'));
    expect(entry, `no entry line names the boot test; lines:\n${lines.join('\n')}`).not.toBe(-1);
    expect(lines.slice(entry + 1, entry + 3)).toEqual([
      `${tag}     ${BOOT_REASON}`,
      `${tag}     second line`,
    ]);
  });

  test('a run with no declared non-result writes no summary', () => {
    expect(
      summaryLines(
        reporterOutput({ tests: [{ title: 'assertion', attempts: [{ status: 'failed' }] }] }),
      ),
    ).toEqual([]);
  });
});
