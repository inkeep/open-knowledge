import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  lintOkRulesFixture,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../test-support/read-ok-rules-config.test-helper.ts';
import { NON_PATHSPEC_VERBS } from '../rules/no-unconverted-git-pathspec.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RULE = 'no-unconverted-git-pathspec';
const CODE = `ok(${RULE})`;
const FIXTURE = `lint-plugins/ok-rules/__fixtures__/${RULE}.fixture.tsx`;
const DOCS = `lint-plugins/ok-rules/README.md#${RULE}`;

function fires() {
  return lintOkRulesFixture(FIXTURE).filter((d) => d.code === CODE);
}

describe(`${RULE} oxlint rule`, () => {
  test('fires at exactly its 7 planted positives, by its own code, and on no negative case', () => {
    const found = fires();
    expect(found.map((fire) => fire.position)).toEqual([
      '44:17',
      '46:23',
      '48:9',
      '50:17',
      '52:24',
      '54:17',
      '58:5',
    ]);
    for (const fire of found) {
      expect(fire.message).toContain("Hand-written `'--'` in a git argv");
      expect(fire.message).toContain('pathspecArgs(paths)');
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
    expect(scope).toContain(FIXTURE);
    for (const included of [
      'packages/core/src/**/*.ts',
      'packages/server/src/**/*.ts',
      'packages/cli/src/**/*.ts',
      'packages/desktop/src/**/*.ts',
    ]) {
      expect(scope).toContain(included);
    }
    for (const excluded of [
      '!packages/core/src/git-pathspec.ts',
      '!**/*.test.ts',
      '!**/*.test-helper.ts',
    ]) {
      expect(scope).toContain(excluded);
    }
  });

  test('exempts every verb whose "--" operands are not pathspecs, and nothing else', () => {
    expect([...NON_PATHSPEC_VERBS].sort()).toEqual([
      'clone',
      'hash-object',
      'mv',
      'update-index',
      'worktree',
    ]);
  });
});
