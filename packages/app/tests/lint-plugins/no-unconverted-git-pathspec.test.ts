/** The `no-unconverted-git-pathspec` oxlint rule fixture test, per precedent #42. */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { NON_PATHSPEC_VERBS } from '../../../../lint-plugins/ok-rules/rules/no-unconverted-git-pathspec.mjs';
import {
  oxlintFixtureArgs,
  parseOxlintDiagnostics,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../../test-support/read-ok-rules-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/no-unconverted-git-pathspec.fixture.tsx';
const RULE_CODE = 'ok(no-unconverted-git-pathspec)';

function runFixture(): { status: number | null; output: string } {
  const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe('no-unconverted-git-pathspec oxlint rule', () => {
  test('fires on exactly 7 planted positives (and on no negative case)', () => {
    const { status, output } = runFixture();
    expect(status).not.toBe(0);
    const fires = parseOxlintDiagnostics(output).filter((d) => d.code === RULE_CODE);
    expect(fires.length).toBe(7);
  });

  test('its message names the fix and links this rule section of the README', () => {
    const [first] = parseOxlintDiagnostics(runFixture().output).filter((d) => d.code === RULE_CODE);
    expect(first?.message).toContain('pathspecArgs(paths)');
    expect(first?.message).toMatch(/https?:\/\/[^\s]+/);
    expect(first?.message).toContain('lint-plugins/ok-rules/README.md#no-unconverted-git-pathspec');
  });

  test('rule is registered, enabled, and scoped via its RULE_SCOPES entry', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-unconverted-git-pathspec');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-unconverted-git-pathspec');
    expect(readRuleScope(REPO_ROOT, 'no-unconverted-git-pathspec')).not.toEqual([]);
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, 'no-unconverted-git-pathspec');
    expect(scope).toContain(FIXTURE_REL);
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
    expect([...NON_PATHSPEC_VERBS].sort()).toEqual(['clone', 'hash-object', 'mv', 'worktree']);
  });
});
