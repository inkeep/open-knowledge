/**
 * no-inline-tolerance-class — oxlint rule fixture test.
 *
 * Rule:  `lint-plugins/ok-rules/rules/no-inline-tolerance-class.mjs`
 * Fixture: `lint-plugins/ok-rules/__fixtures__/no-inline-tolerance-class.fixture.tsx`
 *
 * Per precedent #42 (custom lint enforcement is oxlint JS-plugin rules). Forbids a
 * public-mirrored test from writing a bridge tolerance-class catalog value
 * (`BRIDGE_TOLERANCE_CLASSES`) inline as a string literal. Importing the catalog
 * symbol into a public test is already blocked by `check-mirror-test-policy`
 * Check B (moat-import); this rule closes the complementary gap where a test
 * re-encodes a class value inline, bypassing the import check.
 *
 * Three guarantees, each its own test:
 *   1. Fires on exactly the planted positives (and on no negative) — the
 *      bidirectional `toBe(8)` count, plus the diagnostic-message contract.
 *   2. Scoped via its `RULE_SCOPES` entry to the public test surface rather than
 *      left unscoped, which would fire on the excluded clusters where the
 *      catalog legitimately lives.
 *   3. The matched fidelity classes plus the four universal text-encoding
 *      classes partition `BRIDGE_TOLERANCE_CLASSES` exactly — a class added to
 *      the catalog reddens here until it is classified into one bucket, so the
 *      guard can never silently cover a stale subset.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MATCHED_FIDELITY_CLASSES } from '../../../../lint-plugins/ok-rules/rules/no-inline-tolerance-class.mjs';
import {
  oxlintFixtureArgs,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../../test-support/read-ok-rules-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/no-inline-tolerance-class.fixture.tsx';
const CATALOG_SOURCE_ABS = join(REPO_ROOT, 'packages/core/src/bridge/normalize.ts');

describe('no-inline-tolerance-class oxlint rule', () => {
  test('fires on exactly 8 inline fidelity-class literals (and on no negative case)', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Inline bridge normalization-class value in a public test/g) ?? [])
      .length;
    expect(fires).toBe(8);
    expect(output).toContain('hard-coding a BRIDGE_TOLERANCE_CLASSES label');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-inline-tolerance-class');
  });

  test('rule is registered, enabled, and scoped to the public test surface', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-inline-tolerance-class');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-inline-tolerance-class');
  });

  test('matched fidelity set + universal-encoding set partition BRIDGE_TOLERANCE_CLASSES', () => {
    const UNIVERSAL_ENCODING = ['bom', 'crlf', 'trailing-whitespace', 'trailing-newline'];

    const catalogSrc = readFileSync(CATALOG_SOURCE_ABS, 'utf-8');
    const arrayBody = catalogSrc.match(/BRIDGE_TOLERANCE_CLASSES\s*=\s*\[([\s\S]*?)\]/)?.[1];
    expect(arrayBody).toBeDefined();
    const catalog = [...(arrayBody ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(catalog.length).toBeGreaterThan(0);

    const matched = [...MATCHED_FIDELITY_CLASSES].sort();

    expect(matched.filter((c) => UNIVERSAL_ENCODING.includes(c))).toEqual([]);
    const union = [...new Set([...matched, ...UNIVERSAL_ENCODING])].sort();
    expect(union).toEqual(catalog);
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, 'no-inline-tolerance-class');
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
        'lint-plugins/ok-rules/__fixtures__/no-inline-tolerance-class.fixture.tsx',
      ].sort(),
    );
  });
});
