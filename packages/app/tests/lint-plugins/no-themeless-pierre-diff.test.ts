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
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/no-themeless-pierre-diff.fixture.tsx';

describe('no-themeless-pierre-diff oxlint rule', () => {
  test('fires on exactly 7 positive cases (and on no negative case)', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/@pierre\/diffs render contract/g) ?? []).length;
    expect(fires).toBe(7);
    const themeFires = (output.match(/add `theme: okPierreTheme\(\)`/g) ?? []).length;
    const styleFires = (output.match(/does not set diffStyle: 'unified'/g) ?? []).length;
    expect(themeFires).toBe(5);
    expect(styleFires).toBe(2);
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-themeless-pierre-diff');
  });

  test('rule is registered, enabled, and scoped via its RULE_SCOPES entry', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-themeless-pierre-diff');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-themeless-pierre-diff');
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, 'no-themeless-pierre-diff');
    expect(scope.sort()).toEqual(
      [
        'packages/app/src/**/*.tsx',
        '!**/*.test.tsx',
        '!**/*.dom.test.tsx',
        '!**/*.test-helper.tsx',
        'lint-plugins/ok-rules/__fixtures__/no-themeless-pierre-diff.fixture.tsx',
      ].sort(),
    );
  });
});
