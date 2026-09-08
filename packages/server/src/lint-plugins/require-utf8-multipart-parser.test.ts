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
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/require-utf8-multipart-parser.fixture.tsx';

describe('require-utf8-multipart-parser oxlint rule', () => {
  test('fires exactly 3 times — one per direct busboy construction', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;

    const fires = (output.match(/busboy constructed directly/g) ?? []).length;
    expect(fires).toBe(3);

    expect(output).toContain('createMultipartParser');
    expect(output).toContain('packages/server/src/multipart.ts');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#require-utf8-multipart-parser');
  });

  test('the factory module itself is exempt, so the sanctioned call passes', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs('packages/server/src/multipart.ts'), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain('ok(require-utf8-multipart-parser)');
    expect(output).not.toContain('busboy constructed directly');
  });

  test('rule is registered, enabled, and scoped via its RULE_SCOPES entry', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('require-utf8-multipart-parser');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/require-utf8-multipart-parser');
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, 'require-utf8-multipart-parser');
    expect(scope.sort()).toEqual(
      [
        '**/*.ts',
        '**/*.tsx',
        '**/*.mts',
        '!**/node_modules/**',
        '!**/dist/**',
        '!**/*.test.ts',
        '!**/*.test.tsx',
        '!**/*.test.mts',
        '!**/*.test-helper.ts',
        '!packages/server/src/multipart.ts',
        'lint-plugins/ok-rules/__fixtures__/require-utf8-multipart-parser.fixture.tsx',
      ].sort(),
    );
  });
});
