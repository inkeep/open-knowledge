import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-raw-html-interactive-element';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 8 positive cases, by its own code, and on no negative case', () => {
    const found = fires();
    expect(found.map((fire) => fire.position)).toEqual([
      '22:10',
      '27:10',
      '32:10',
      '37:10',
      '42:10',
      '47:10',
      '55:5',
      '64:10',
    ]);
    for (const fire of found) {
      expect(fire.message).toContain('Raw HTML interactive primitive');
      expect(fire.message).toContain('use shadcn Button/Input/Textarea/Select');
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
        'packages/app/src/**/*.tsx',
        'packages/desktop/src/**/*.tsx',
        'packages/plugin/src/**/*.tsx',
        '!packages/app/src/editor/**',
        '!packages/app/src/components/ui/**',
        '!**/*.test.tsx',
        '!**/*.dom.test.tsx',
        '!**/*.test-helper.tsx',
        FIXTURE,
      ].sort(),
    );
  });
});
