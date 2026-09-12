/** The `no-unwrapped-user-facing-string` oxlint rule fixture test, per precedent #42. */

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
  'lint-plugins/ok-rules/__fixtures__/no-unwrapped-user-facing-string.fixture.tsx';

function checkFixture(): string {
  const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  return `${result.stdout}\n${result.stderr}`;
}

function countMatches(output: string, pattern: RegExp): number {
  return (output.match(pattern) ?? []).length;
}

describe('no-unwrapped-user-facing-string oxlint rule', () => {
  test('fires on exactly 15 unwrapped user-facing strings (and on no negative case)', () => {
    expect(countMatches(checkFixture(), /Unwrapped user-facing string/g)).toBe(15);
  });

  test('each branch carries its own share of the count', () => {
    const output = checkFixture();
    expect(countMatches(output, /Unwrapped user-facing string in a toast argument/g)).toBe(2);
    expect(countMatches(output, /Unwrapped user-facing string in JSX text/g)).toBe(2);
    expect(countMatches(output, /Unwrapped user-facing string in a UI-facing attribute/g)).toBe(4);
    expect(
      countMatches(output, /Unwrapped user-facing string in a UI-facing object property/g),
    ).toBe(7);
  });

  test('the diagnostic names the fix and links this rule section of the docs', () => {
    const output = checkFixture();
    expect(output).toContain('Wrap it with the Lingui');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-unwrapped-user-facing-string');
  });

  test('rule is registered, enabled, and scoped to the product surface', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-unwrapped-user-facing-string');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-unwrapped-user-facing-string');
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, 'no-unwrapped-user-facing-string');
    expect(scope.sort()).toEqual(
      [
        'packages/app/src/**/*.ts',
        'packages/app/src/**/*.tsx',
        'packages/desktop/src/**/*.ts',
        'packages/desktop/src/**/*.tsx',
        'packages/plugin/src/**/*.ts',
        'packages/plugin/src/**/*.tsx',
        '!packages/app/src/editor/**',
        '!packages/app/src/components/ui/**',
        '!packages/desktop/src/main/**',
        '!**/*.test.ts',
        '!**/*.test.tsx',
        '!**/*.dom.test.tsx',
        'lint-plugins/ok-rules/__fixtures__/no-unwrapped-user-facing-string.fixture.tsx',
      ].sort(),
    );
  });
});
