/** The `no-demoted-dialog-confirm` oxlint rule fixture test, per precedent #42. */

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
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/no-demoted-dialog-confirm.fixture.tsx';

describe('no-demoted-dialog-confirm oxlint rule', () => {
  test('fires on exactly 3 demoted dialog footers (and on no negative case)', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Demoted confirm in a dialog footer/g) ?? []).length;
    expect(fires).toBe(3);
    expect(output).toContain('Drop the variant prop');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-demoted-dialog-confirm');
  });

  test('rule is registered, enabled, and scoped to product chrome', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-demoted-dialog-confirm');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-demoted-dialog-confirm');
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, 'no-demoted-dialog-confirm');
    expect(scope.sort()).toEqual(
      [
        'packages/app/src/**/*.tsx',
        'packages/desktop/src/**/*.tsx',
        'packages/plugin/src/**/*.tsx',
        '!packages/app/src/components/ui/**',
        '!**/*.test.tsx',
        '!**/*.dom.test.tsx',
        'lint-plugins/ok-rules/__fixtures__/no-demoted-dialog-confirm.fixture.tsx',
      ].sort(),
    );
  });
});
