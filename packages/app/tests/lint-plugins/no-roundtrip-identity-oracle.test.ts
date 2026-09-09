/**
 * The `no-roundtrip-identity-oracle` oxlint rule fixture test, per precedent #42; its negative
 * cases include the `normalizeBridge(a) === normalizeBridge(b)` contract from precedent #38.
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
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/no-roundtrip-identity-oracle.fixture.tsx';

describe('no-roundtrip-identity-oracle oxlint rule', () => {
  test('fires on exactly 10 byte-identity oracle assertions (and on no negative case)', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Byte-fidelity round-trip oracle in a public test/g) ?? []).length;
    expect(fires).toBe(10);
    expect(output).toContain('assert a fixed expected literal for a specific contract');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-roundtrip-identity-oracle');
  });

  test('rule is registered, enabled, and scoped to the public test surface', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-roundtrip-identity-oracle');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-roundtrip-identity-oracle');
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, 'no-roundtrip-identity-oracle');
    expect(scope.sort()).toEqual(
      [
        'packages/**/*.test.ts',
        'packages/**/*.test.tsx',
        'packages/**/*.e2e.ts',
        '!packages/md-conformance/**',
        '!packages/app/tests/fidelity/**',
        '!packages/core/src/markdown/**/*.test.ts',
        '!packages/core/src/bridge/**/*.test.ts',
        '!**/*.private.*',
        'lint-plugins/ok-rules/__fixtures__/no-roundtrip-identity-oracle.fixture.tsx',
      ].sort(),
    );
  });
});
