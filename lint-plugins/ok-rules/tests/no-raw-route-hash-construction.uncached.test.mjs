import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-raw-route-hash-construction';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 5 hand-built hashes, none on the read forms, by its own code, and on no negative case', () => {
    const found = fires();
    expect(found.map((fire) => fire.position)).toEqual([
      '17:19',
      '20:19',
      '23:19',
      '26:19',
      '33:14',
    ]);
    for (const fire of found) {
      expect(fire.message).toContain('Raw route-hash construction');
      expect(fire.message).toContain('hashFromDocName');
      expect(fire.message).toContain('hashFromFolderPath');
      expect(fire.message).toMatch(/https?:\/\/[^\s]+/);
      expect(fire.message).toContain(DOCS);
    }
  });

  test('rule is registered, enabled, and scoped with doc-hash.ts excluded', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`ok/${RULE}`);
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    expect(readRuleScope(REPO_ROOT, RULE).sort()).toEqual(
      [
        'packages/app/src/**/*.ts',
        'packages/app/src/**/*.tsx',
        '!packages/app/src/lib/doc-hash.ts',
        '!**/*.test.ts',
        '!**/*.test.tsx',
        FIXTURE,
      ].sort(),
    );
  });
});
