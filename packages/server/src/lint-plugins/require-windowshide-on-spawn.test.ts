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
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/require-windowshide-on-spawn.fixture.tsx';

describe('require-windowshide-on-spawn oxlint rule', () => {
  test('fires exactly 7 times — one per spawn that hides neither way', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;

    const fires = (output.match(/without a hidden Windows console/g) ?? []).length;
    expect(fires).toBe(7);

    expect(output).toContain('withHiddenWindowsConsole');
    expect(output).toContain('windowsHide: true');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#require-windowshide-on-spawn');
  });

  test('rule is registered, enabled, and scoped via its RULE_SCOPES entry', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('require-windowshide-on-spawn');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/require-windowshide-on-spawn');
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, 'require-windowshide-on-spawn');
    expect(scope.sort()).toEqual(
      [
        'packages/server/src/**/*.ts',
        'packages/cli/src/**/*.ts',
        'packages/desktop/src/**/*.ts',
        '!**/*.test.ts',
        '!**/*.test-helper.ts',
        'lint-plugins/ok-rules/__fixtures__/require-windowshide-on-spawn.fixture.tsx',
      ].sort(),
    );
  });
});
