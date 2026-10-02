import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';
import { isInScope } from '../scope.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'require-utf8-multipart-parser';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 3 direct busboy constructions, by its own code, and on no negative case', () => {
    const found = fires();
    expect(found.map((fire) => fire.position)).toEqual(['41:19', '47:19', '50:19']);
    for (const fire of found) {
      expect(fire.message).toContain('busboy constructed directly');
      expect(fire.message).toContain('createMultipartParser');
      expect(fire.message).toContain('packages/server/src/multipart.ts');
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
        '!**/*.test-helper.ts',
        '!packages/server/src/multipart.ts',
        FIXTURE,
      ].sort(),
    );
  });

  test('the scope table excludes the factory module and includes a sibling server module', () => {
    expect(isInScope(RULE, 'packages/server/src/multipart.ts')).toBe(false);
    expect(isInScope(RULE, 'packages/server/src/api-extension.ts')).toBe(true);
  });
});
