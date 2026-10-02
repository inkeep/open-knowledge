import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'microcopy-ellipsis';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;
const BRANCHES = [
  ['text', 'Reserve U+2026 for macOS native menus', 'drop the trailing'],
  ['attribute', 'from this UI-facing attribute', 'drop the trailing'],
];

function branchOf(message) {
  return BRANCHES.find(([, marker]) => message.includes(marker))?.[0] ?? 'unknown';
}

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 2 positive cases, each on its branch, by its own code', () => {
    const found = fires();
    expect(found.map((fire) => `${fire.position} ${branchOf(fire.message)}`)).toEqual([
      '13:16 text',
      '17:29 attribute',
    ]);
    for (const fire of found) {
      const [, , fix] = BRANCHES.find(([name]) => name === branchOf(fire.message));
      expect(fire.message).toContain(fix);
      expect(fire.message).toMatch(/https?:\/\/[^\s]+/);
      expect(fire.message).toContain(DOCS);
    }
  });

  test('rule is registered, enabled, and deliberately unscoped', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`ok/${RULE}`);
  });
});
