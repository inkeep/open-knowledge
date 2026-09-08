import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  oxlintFixtureArgs,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const FIXTURE_REL =
  'lint-plugins/ok-rules/__fixtures__/path-conditional-map-driven-origin.fixture.tsx';

describe('path-conditional-map-driven-origin oxlint rule', () => {
  test('fires on exactly 7 positive cases (and on no negative case)', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Observer-side transact call missing sanctioned origin/g) ?? [])
      .length;
    expect(fires).toBe(7);
    expect(output).toContain('Pass `OBSERVER_SYNC_ORIGIN` as the second argument');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#path-conditional-map-driven-origin');
  });

  test('rule is registered, enabled, and scoped via its RULE_SCOPES entry', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(
      'path-conditional-map-driven-origin',
    );
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/path-conditional-map-driven-origin');
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, 'path-conditional-map-driven-origin');
    expect(scope.sort()).toEqual(
      [
        'packages/server/src/server-observers.ts',
        'lint-plugins/ok-rules/__fixtures__/path-conditional-map-driven-origin.fixture.tsx',
      ].sort(),
    );
  });
});
