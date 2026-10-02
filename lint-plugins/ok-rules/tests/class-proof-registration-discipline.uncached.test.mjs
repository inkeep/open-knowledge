import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'class-proof-registration-discipline';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;
const BRANCHES = [
  [
    'missing',
    'Class-proof registration missing `predicate` or `proof` option',
    'Provide all three of `{ enumerate, predicate, proof }`',
  ],
  [
    'location',
    'Class-proof registered outside the canonical dir',
    'packages/md-conformance/src/class-proofs/proofs/<name>.ts',
  ],
];

function branchOf(message) {
  return BRANCHES.find(([, marker]) => message.includes(marker))?.[0] ?? 'unknown';
}

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 3 positive cases: 2 missing-args and 1 outside-canonical, each on its branch, by its own code', () => {
    const found = fires();
    expect(found.map((fire) => `${fire.position} ${branchOf(fire.message)}`)).toEqual([
      '32:41 missing',
      '38:37 missing',
      '46:43 location',
    ]);
    for (const fire of found) {
      const [, , fix] = BRANCHES.find(([name]) => name === branchOf(fire.message));
      expect(fire.message).toContain(fix);
      expect(fire.message).toMatch(/https?:\/\/[^\s]+/);
      expect(fire.message).toContain(DOCS);
    }
  });

  test('rule is registered, enabled, and scoped via its RULE_SCOPES entry', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`ok/${RULE}`);
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    expect(readRuleScope(REPO_ROOT, RULE).sort()).toEqual(
      [
        '**/*.ts',
        '**/*.tsx',
        '**/*.mts',
        '!**/node_modules/**',
        '!**/dist/**',
        '!**/*.test.ts',
        '!**/*.test.tsx',
        '!**/*.test.mts',
        '!packages/md-conformance/src/class-proofs/proofs/**',
        FIXTURE,
      ].sort(),
    );
  });
});
