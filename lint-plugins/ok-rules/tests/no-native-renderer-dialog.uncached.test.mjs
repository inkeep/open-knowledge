import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-native-renderer-dialog';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 10 global dialog calls, by its own code, and on no negative case', () => {
    const found = fires();
    expect(found.map((fire) => fire.position)).toEqual([
      '8:3',
      '9:3',
      '10:3',
      '11:3',
      '12:3',
      '13:3',
      '14:3',
      '15:3',
      '16:3',
      '17:8',
    ]);
    for (const fire of found) {
      expect(fire.message).toContain('Native browser dialog in the renderer');
      expect(fire.message).toContain('Use `AlertDialog`');
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
        'packages/plugin/src/**/*.ts',
        'packages/plugin/src/**/*.tsx',
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
