import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';
import { BRANCH_IDENTIFIER_RE } from '../rules/no-hand-rolled-branch-validation.mjs';
import { isInScope } from '../scope.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-hand-rolled-branch-validation';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 4 planted positives, by its own code, and on no negative case', () => {
    const found = fires();
    expect(found.map((fire) => fire.position)).toEqual(['29:33', '37:10', '42:10', '48:10']);
    for (const fire of found) {
      expect(fire.message).toContain('Hand-rolled branch-name validation');
      expect(fire.message).toContain('isValidBranchName');
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
    expect(readRuleScope(REPO_ROOT, RULE).sort()).toEqual(
      ['packages/server/src/**/*.ts', '!**/*.test.ts', '!**/*.test-helper.ts', FIXTURE].sort(),
    );
  });

  test('covers the guard it was promoted for, and neither definition site of the contract', () => {
    expect(isInScope(RULE, 'packages/server/src/http/history-routes.ts')).toBe(true);
    expect(isInScope(RULE, 'packages/core/src/schemas/api/share.ts')).toBe(false);
    expect(isInScope(RULE, 'docs/src/lib/share-splash.ts')).toBe(false);
    expect(isInScope(RULE, 'packages/server/src/http/history-routes.test.ts')).toBe(false);
  });

  test('matches the branch-identifier shapes the fixture depends on, and no more', () => {
    for (const name of [
      'branch',
      'branchName',
      'branchRef',
      'refName',
      'targetBranch',
      'currentBranch',
      'targetBranchName',
      'newBranchName',
    ]) {
      expect(BRANCH_IDENTIFIER_RE.test(name)).toBe(true);
    }
    for (const name of ['skillName', 'docName', 'branchless', 'rebranch', 'headRef']) {
      expect(BRANCH_IDENTIFIER_RE.test(name)).toBe(false);
    }
  });
});
