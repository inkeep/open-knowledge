import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-blocking-error-box';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 3 showErrorBox member calls, by its own code, and on no negative case', () => {
    const fires = lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
    expect(fires.map((fire) => fire.position)).toEqual(['12:3', '13:3', '14:3']);
    for (const fire of fires) {
      expect(fire.message).toContain('Blocking error box');
      expect(fire.message).toContain('showErrorDialog');
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
      ['packages/desktop/src/**/*.ts', '!**/*.test.ts', '!**/*.test-helper.ts', FIXTURE].sort(),
    );
  });
});
