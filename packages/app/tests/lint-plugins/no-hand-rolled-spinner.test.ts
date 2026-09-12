/** The `no-hand-rolled-spinner` oxlint rule fixture test, per precedent #42. */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  oxlintFixtureArgs,
  parseOxlintDiagnostics,
  readEnabledRuleIds,
  readRegisteredRuleNames,
} from '../../../../test-support/read-ok-rules-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/no-hand-rolled-spinner.fixture.tsx';

function checkFixture(): string {
  const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  return `${result.stdout}\n${result.stderr}`;
}

describe('no-hand-rolled-spinner oxlint rule', () => {
  test('fires on exactly 5 hand-rolled spins (and on no negative case)', () => {
    const output = checkFixture();
    const fires = parseOxlintDiagnostics(output).filter(
      (d) => d.code === 'ok(no-hand-rolled-spinner)',
    );
    expect(fires.length).toBe(5);
    expect(output).toContain('Hand-rolled loading spinner');
    expect(output).toContain('@/components/ui/spinner');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-hand-rolled-spinner');
  });

  test('rule is registered, enabled, and deliberately unscoped', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-hand-rolled-spinner');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-hand-rolled-spinner');
  });

  test('the word boundary admits a suffixed variant but not a longer token', () => {
    const lines = parseOxlintDiagnostics(checkFixture())
      .filter((d) => d.code === 'ok(no-hand-rolled-spinner)')
      .map((d) => d.labels?.[0]?.span?.line)
      .filter((n): n is number => typeof n === 'number');

    const source = readFileSync(join(REPO_ROOT, FIXTURE_REL), 'utf-8').split('\n');
    const flagged = lines.map((n) => source[n - 1]).join('\n');

    expect(flagged).toContain('animate-spin-slow');
    expect(flagged).not.toContain('animate-spinner');
  });
});
