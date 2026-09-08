/**
 * no-roundtrip-identity-oracle — oxlint rule fixture test.
 *
 * Rule:  `lint-plugins/ok-rules/rules/no-roundtrip-identity-oracle.mjs`
 * Fixture: `lint-plugins/ok-rules/__fixtures__/no-roundtrip-identity-oracle.fixture.tsx`
 *
 * Per precedent #42 (custom lint enforcement is oxlint JS-plugin rules). Forbids the
 * byte-fidelity round-trip oracle — `serialize(parse(x))` (or the
 * MarkdownManager method form) asserted equal to the same input `x` — in
 * public-mirrored tests, so a new public test can't reintroduce the engine's
 * byte-identity correctness oracle that the engine fidelity suite owns
 * privately.
 *
 * The fixture pairs 10 positive cases (the identity oracle through toBe /
 * toEqual / toStrictEqual and `===`, in both bare `serialize(parse(...))` and
 * MarkdownManager method forms) with 7 negative cases (a fixed-literal contract
 * assertion, the `normalizeBridge(a) === normalizeBridge(b)` Bridge-invariant
 * contract from precedent #38, the `!==` normalizing-construct detector, the
 * helper-wrapped and two-statement round-trip forms, and a two-different-manager
 * comparison). Exact-equality (`toBe(10)`) catches both false-negative
 * regressions (a weakened pattern drops below 10) and false-positive widenings
 * (a negative starts firing, rising above 10).
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
