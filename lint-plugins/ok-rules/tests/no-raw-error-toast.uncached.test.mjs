import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-raw-error-toast';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 25 raw-error toast arguments, by its own code, and on no negative case', () => {
    const found = fires();
    expect(found.map((fire) => fire.position)).toEqual([
      '27:15',
      '28:15',
      '29:15',
      '30:15',
      '31:15',
      '32:15',
      '33:15',
      '34:15',
      '35:15',
      '36:15',
      '37:17',
      '38:14',
      '39:9',
      '40:17',
      '41:17',
      '42:17',
      '43:58',
      '44:64',
      '45:21',
      '46:22',
      '47:15',
      '48:15',
      '49:15',
      '50:15',
      '51:60',
    ]);
    for (const fire of found) {
      expect(fire.message).toContain('Raw error text in a toast');
      expect(fire.message).toContain('Map the failure to a reason');
      expect(fire.message).toMatch(/https?:\/\/[^\s]+/);
      expect(fire.message).toContain(DOCS);
    }
  });

  test('rule is registered and enabled', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`ok/${RULE}`);
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    expect(readRuleScope(REPO_ROOT, RULE).sort()).toEqual(
      [
        'packages/app/src/**/*.ts',
        'packages/app/src/**/*.tsx',
        '!**/*.test.ts',
        '!**/*.test.tsx',
        '!**/*.dom.test.tsx',
        '!**/*.test-helper.ts',
        '!**/*.test-helper.tsx',
        FIXTURE,
      ].sort(),
    );
  });
});
