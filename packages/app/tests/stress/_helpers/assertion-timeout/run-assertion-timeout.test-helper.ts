import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { JSONReport, JSONReportTestResult } from '@playwright/test/reporter';
import { createNestedPlaywrightEnv } from '../port-ownership/nested-playwright-env.test-helper.ts';
import {
  runNestedPlaywright,
  specsOf,
} from '../port-ownership/nested-playwright-run.test-helper.ts';
import { APP_PACKAGE_ROOT } from '../server-process.ts';

const RUN_CONFIG = join(
  APP_PACKAGE_ROOT,
  'tests/stress/_helpers/assertion-timeout/assertion-timeout-run.config.ts',
);

export type ConfigurationMode = 'local' | 'ci';

export interface CaseResult {
  status: JSONReportTestResult['status'];
  message: string;
  annotations: { type: string; description?: string }[];
}

export interface AssertionTimeoutRun {
  exitCode: number | null;
  transcript: string;
  forbidOnly: boolean | undefined;
  cases: Map<string, CaseResult[]>;
}

function casesOf(report: JSONReport | undefined): Map<string, CaseResult[]> {
  const cases = new Map<string, CaseResult[]>();
  for (const spec of specsOf(report?.suites ?? [])) {
    const results = spec.tests.flatMap((t) =>
      t.results.map((result) => ({
        status: result.status,
        message: stripVTControlCharacters(result.error?.message ?? ''),
        annotations: result.annotations,
      })),
    );
    cases.set(spec.title, [...(cases.get(spec.title) ?? []), ...results]);
  }
  return cases;
}

export async function runAssertionTimeoutCases(
  mode: ConfigurationMode,
): Promise<AssertionTimeoutRun> {
  const { exitCode, transcript, report } = await runNestedPlaywright({
    args: ['--config', RUN_CONFIG],
    runDirPrefix: 'ok-assertion-timeout-',
    env: (runDir) => {
      const env = createNestedPlaywrightEnv({
        OK_ASSERTION_TIMEOUT_RUN_DIR: runDir,
        PLAYWRIGHT_HTML_OPEN: 'never',
      });
      if (mode === 'ci') env.CI = '1';
      else delete env.CI;
      return env;
    },
  });
  return {
    exitCode,
    transcript,
    forbidOnly: report?.config.forbidOnly,
    cases: casesOf(report),
  };
}
