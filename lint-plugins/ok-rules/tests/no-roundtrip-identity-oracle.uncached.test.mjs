import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-roundtrip-identity-oracle';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 10 byte-identity oracle assertions, by its own code, and on no negative case', () => {
    const found = fires();
    expect(found.map((fire) => fire.position)).toEqual([
      '38:3',
      '39:3',
      '40:3',
      '42:3',
      '43:3',
      '44:3',
      '46:15',
      '47:15',
      '49:15',
      '50:15',
    ]);
    for (const fire of found) {
      expect(fire.message).toContain('Byte-fidelity round-trip oracle in a public test');
      expect(fire.message).toContain('assert a fixed expected literal for a specific contract');
      expect(fire.message).toMatch(/https?:\/\/[^\s]+/);
      expect(fire.message).toContain(DOCS);
    }
  });

  test('rule is registered, enabled, and scoped to the public test surface', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`ok/${RULE}`);
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    expect(readRuleScope(REPO_ROOT, RULE).sort()).toEqual(
      [
        'packages/**/*.test.ts',
        'packages/**/*.test.tsx',
        'packages/**/*.e2e.ts',
        '!packages/md-conformance/**',
        '!packages/app/tests/fidelity/**',
        '!packages/core/src/markdown/**/*.test.ts',
        '!packages/core/src/bridge/**/*.test.ts',
        '!**/*.private.*',
        FIXTURE,
      ].sort(),
    );
  });
});
