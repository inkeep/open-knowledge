/** The `playwright-prefer-to-have-count` oxlint rule fixture test, per precedent #42. */

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
