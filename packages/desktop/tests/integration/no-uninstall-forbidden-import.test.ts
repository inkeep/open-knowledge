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
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/no-uninstall-forbidden-import.fixture.tsx';

describe('no-uninstall-forbidden-import oxlint rule', () => {
  test('fires on exactly 13 cases (12 forbidden imports + 1 dynamic import), and on no negative case', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;

    const fires = (output.match(/ok\(no-uninstall-forbidden-import\)/g) ?? []).length;
    expect(fires).toBe(13);
    const forbidden = (output.match(/Forbidden module in the uninstall entry/g) ?? []).length;
    const dynamic = (output.match(/Dynamic import under src\/uninstall/g) ?? []).length;
    expect(forbidden).toBe(12);
    expect(dynamic).toBe(1);

    expect(output).toContain('must connect to nothing');
    expect(output).toContain('eager-load');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-uninstall-forbidden-import');
  });

  test('rule is registered, enabled, and scoped via its RULE_SCOPES entry', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-uninstall-forbidden-import');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-uninstall-forbidden-import');
    expect(readRuleScope(REPO_ROOT, 'no-uninstall-forbidden-import')).not.toEqual([]);
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, 'no-uninstall-forbidden-import');
    expect(scope).toContain('packages/app/src/uninstall/**/*.ts');
    expect(scope).toContain('packages/app/src/uninstall/**/*.tsx');
    expect(scope).toContain('!packages/app/src/uninstall/**/*.test.ts');
    expect(scope).toContain('!packages/app/src/uninstall/**/*.test.tsx');
    expect(scope).toContain('!packages/app/src/uninstall/**/*.dom.test.tsx');
  });
});
