import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-uninstall-forbidden-import';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;
const BRANCHES = [
  ['forbidden', 'Forbidden module in the uninstall entry', 'must connect to nothing'],
  ['dynamic', 'Dynamic import under src/uninstall', 'eager-load'],
];

function branchOf(message) {
  return BRANCHES.find(([, marker]) => message.includes(marker))?.[0] ?? 'unknown';
}

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 13 cases: 12 forbidden imports and 1 dynamic import, each on its branch, by its own code', () => {
    const found = fires();
    expect(found.map((fire) => `${fire.position} ${branchOf(fire.message)}`)).toEqual([
      '16:1 forbidden',
      '17:1 forbidden',
      '18:1 forbidden',
      '19:1 forbidden',
      '20:1 forbidden',
      '21:1 forbidden',
      '22:1 forbidden',
      '23:1 forbidden',
      '24:1 forbidden',
      '25:1 forbidden',
      '26:1 forbidden',
      '27:1 forbidden',
      '43:10 dynamic',
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
    expect(readRuleScope(REPO_ROOT, RULE)).not.toEqual([]);
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, RULE);
    expect(scope).toContain('packages/app/src/uninstall/**/*.ts');
    expect(scope).toContain('packages/app/src/uninstall/**/*.tsx');
    expect(scope).toContain('!packages/app/src/uninstall/**/*.test.ts');
    expect(scope).toContain('!packages/app/src/uninstall/**/*.test.tsx');
    expect(scope).toContain('!packages/app/src/uninstall/**/*.dom.test.tsx');
  });
});
