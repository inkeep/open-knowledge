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
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/no-raw-route-hash-construction.fixture.tsx';

describe('no-raw-route-hash-construction oxlint rule', () => {
  test('fires exactly 5 times — one per hand-built hash, none on the read forms', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;

    const fires = (output.match(/Raw route-hash construction/g) ?? []).length;
    expect(fires).toBe(5);

    expect(output).toContain('hashFromDocName');
    expect(output).toContain('hashFromFolderPath');
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-raw-route-hash-construction');
  });

  test('rule is registered, enabled, and scoped with doc-hash.ts excluded', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-raw-route-hash-construction');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-raw-route-hash-construction');
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, 'no-raw-route-hash-construction');
    expect(scope.sort()).toEqual(
      [
        'packages/app/src/**/*.ts',
        'packages/app/src/**/*.tsx',
        '!packages/app/src/lib/doc-hash.ts',
        '!**/*.test.ts',
        '!**/*.test.tsx',
        'lint-plugins/ok-rules/__fixtures__/no-raw-route-hash-construction.fixture.tsx',
      ].sort(),
    );
  });
});
