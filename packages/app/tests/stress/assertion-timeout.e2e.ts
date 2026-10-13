import { expect, test } from '@playwright/test';
import {
  ASSERTION_ELAPSED_ANNOTATION,
  MET_CASE,
  UNMET_CASE,
} from './_helpers/assertion-timeout/cases.ts';
import {
  type ConfigurationMode,
  runAssertionTimeoutCases,
} from './_helpers/assertion-timeout/run-assertion-timeout.test-helper.ts';

const ASSERTION_TIMEOUT_MS = 15_000;

test.describe.configure({ retries: 0 });

async function expectDefaultAssertionTimeout(mode: ConfigurationMode): Promise<void> {
  const run = await runAssertionTimeoutCases(mode);
  const context = `nested ${mode} run exited ${run.exitCode}:\n${run.transcript}`;

  expect(run.forbidOnly, context).toBe(mode === 'ci');
  expect(
    run.cases.get(MET_CASE)?.map((r) => r.status),
    context,
  ).toEqual(['passed']);

  const unmet = run.cases.get(UNMET_CASE) ?? [];
  expect(
    unmet.map((r) => r.status),
    context,
  ).toEqual(['failed']);
  const [failure] = unmet;
  expect(failure.message, context).toContain('toBeVisible() failed');
  expect(failure.message, context).toContain(`Timeout: ${ASSERTION_TIMEOUT_MS}ms`);

  const elapsed = Number(
    failure.annotations.find((a) => a.type === ASSERTION_ELAPSED_ANNOTATION)?.description,
  );
  test.info().annotations.push({
    type: `ok:unmet-assertion-elapsed-ms:${mode}`,
    description: String(elapsed),
  });
  expect(elapsed, context).toBeGreaterThanOrEqual(ASSERTION_TIMEOUT_MS);
}

test('locally an unmet web-first assertion fails at the 15 s default while a met one passes', () =>
  expectDefaultAssertionTimeout('local'));

test('under CI an unmet web-first assertion fails at the 15 s default while a met one passes', () =>
  expectDefaultAssertionTimeout('ci'));
