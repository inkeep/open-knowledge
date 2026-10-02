import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'require-windowshide-on-spawn';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 7 spawns that hide neither way, by its own code, and on no negative case', () => {
    const found = fires();
    expect(found.map((fire) => fire.position)).toEqual([
      '35:19',
      '36:19',
      '37:19',
      '38:19',
      '39:19',
      '40:19',
      '41:19',
    ]);
    for (const fire of found) {
      expect(fire.message).toContain('child_process spawn without a hidden Windows console');
      expect(fire.message).toContain('withHiddenWindowsConsole');
      expect(fire.message).toContain('windowsHide: true');
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
        'packages/server/src/**/*.ts',
        'packages/cli/src/**/*.ts',
        'packages/desktop/src/**/*.ts',
        '!**/*.test.ts',
        '!**/*.test-helper.ts',
        FIXTURE,
      ].sort(),
    );
  });
});
