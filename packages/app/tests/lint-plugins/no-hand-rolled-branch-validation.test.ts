/** The `no-hand-rolled-branch-validation` oxlint rule fixture test, per precedent #42. */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { BRANCH_IDENTIFIER_RE } from '../../../../lint-plugins/ok-rules/rules/no-hand-rolled-branch-validation.mjs';
import { isInScope } from '../../../../lint-plugins/ok-rules/scope.mjs';
import {
  oxlintFixtureArgs,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../../test-support/read-ok-rules-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const RULE = 'no-hand-rolled-branch-validation';
const FIXTURE_REL =
  'lint-plugins/ok-rules/__fixtures__/no-hand-rolled-branch-validation.fixture.tsx';
const GUARD_REL = 'packages/server/src/http/history-routes.ts';

describe('no-hand-rolled-branch-validation oxlint rule', () => {
  test('fires on exactly 4 planted positives (and on no negative case)', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Hand-rolled branch-name validation/g) ?? []).length;
    expect(fires).toBe(4);
    expect(output).toContain('isValidBranchName');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-hand-rolled-branch-validation');
  });

  test('rule is registered, enabled, and scoped via its RULE_SCOPES entry', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain(RULE);
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain(`ok/${RULE}`);
    expect(readRuleScope(REPO_ROOT, RULE)).not.toEqual([]);
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    expect(readRuleScope(REPO_ROOT, RULE).sort()).toEqual(
      ['packages/server/src/**/*.ts', '!**/*.test.ts', '!**/*.test-helper.ts', FIXTURE_REL].sort(),
    );
  });

  test('covers the guard it was promoted for, and neither definition site of the contract', () => {
    expect(isInScope(RULE, GUARD_REL)).toBe(true);
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
