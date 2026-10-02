import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-unwrapped-user-facing-string';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;
const BRANCHES = [
  ['toast', 'Unwrapped user-facing string in a toast argument', 'Wrap it with the Lingui'],
  ['jsx', 'Unwrapped user-facing string in JSX text', 'Wrap it with the Lingui'],
  ['attribute', 'Unwrapped user-facing string in a UI-facing attribute', 'Wrap it with the Lingui'],
  [
    'property',
    'Unwrapped user-facing string in a UI-facing object property',
    'Wrap it with the Lingui',
  ],
];

function branchOf(message) {
  return BRANCHES.find(([, marker]) => message.includes(marker))?.[0] ?? 'unknown';
}

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 15 unwrapped user-facing strings, each on its branch, by its own code', () => {
    const found = fires();
    expect(found.map((fire) => `${fire.position} ${branchOf(fire.message)}`)).toEqual([
      '23:3 toast',
      '24:3 toast',
      '29:16 jsx',
      '37:10 jsx',
      '47:23 attribute',
      '48:26 attribute',
      '49:16 attribute',
      '50:18 attribute',
      '61:14 property',
      '62:14 property',
      '63:20 property',
      '64:12 property',
      '65:20 property',
      '66:21 property',
      '73:36 property',
    ]);
    for (const fire of found) {
      const [, , fix] = BRANCHES.find(([name]) => name === branchOf(fire.message));
      expect(fire.message).toContain(fix);
      expect(fire.message).toMatch(/https?:\/\/[^\s]+/);
      expect(fire.message).toContain(DOCS);
    }
  });

  test('rule is registered, enabled, and scoped to the product surface', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`ok/${RULE}`);
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    expect(readRuleScope(REPO_ROOT, RULE).sort()).toEqual(
      [
        'packages/app/src/**/*.ts',
        'packages/app/src/**/*.tsx',
        'packages/desktop/src/**/*.ts',
        'packages/desktop/src/**/*.tsx',
        'packages/plugin/src/**/*.ts',
        'packages/plugin/src/**/*.tsx',
        '!packages/app/src/editor/**',
        '!packages/app/src/components/ui/**',
        '!packages/desktop/src/main/**',
        '!**/*.test.ts',
        '!**/*.test.tsx',
        '!**/*.dom.test.tsx',
        FIXTURE,
      ].sort(),
    );
  });
});
