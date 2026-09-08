/**
 * playwright-prefer-to-have-count — oxlint rule fixture test.
 *
 * Rule:  `lint-plugins/ok-rules/rules/playwright-prefer-to-have-count.mjs`
 * Fixture: `lint-plugins/ok-rules/__fixtures__/playwright-prefer-to-have-count.fixture.tsx`
 *
 * Per precedent #42 (custom lint enforcement is oxlint JS-plugin rules). Bans the
 * one-shot `expect(await locator.count())` snapshot read in the browser
 * e2e suites — the no-retry assertion shape behind hidden flakes — in
 * favor of the web-first auto-retrying
 * `await expect(locator).toHaveCount(n)`. Upstream precedent:
 * eslint-plugin-playwright `prefer-to-have-count`.
 *
 * The fixture pairs 3 positive cases (one-shot reads through different
 * matchers — the rule must fire) with 5 negative cases (toHaveCount,
 * expect.poll, bare count read, different awaited method, two-statement
 * read-then-assert — rule must NOT fire). Exact-equality (`toBe(3)`)
 * catches both false-negative regressions (weakened pattern drops below 3)
 * and false-positive widenings (above 3).
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  oxlintFixtureArgs,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../../test-support/read-ok-rules-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL =
  'lint-plugins/ok-rules/__fixtures__/playwright-prefer-to-have-count.fixture.tsx';

describe('playwright-prefer-to-have-count oxlint rule', () => {
  test('fires on exactly 3 one-shot count reads (and on no negative case)', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/One-shot count read never retries/g) ?? []).length;
    expect(fires).toBe(3);
    expect(output).toContain('use the web-first `await expect(locator).toHaveCount(n)`');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#playwright-prefer-to-have-count');
  });

  test('rule is registered, enabled, and scoped to the e2e suites', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('playwright-prefer-to-have-count');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/playwright-prefer-to-have-count');
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, 'playwright-prefer-to-have-count');
    expect(scope.sort()).toEqual(
      [
        'packages/app/tests/stress/**/*.e2e.ts',
        'packages/app/tests/visual/**/*.e2e.ts',
        'packages/app/tests/a11y/**/*.e2e.ts',
        'lint-plugins/ok-rules/__fixtures__/playwright-prefer-to-have-count.fixture.tsx',
      ].sort(),
    );
  });
});
