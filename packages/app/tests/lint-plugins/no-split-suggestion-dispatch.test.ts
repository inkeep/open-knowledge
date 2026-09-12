/**
 * The `no-split-suggestion-dispatch` oxlint rule fixture test: one-transaction suggestion
 * insertion per precedent #58.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  oxlintFixtureArgs,
  readEnabledRuleIds,
  readRegisteredRuleNames,
} from '../../../../test-support/read-ok-rules-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/no-split-suggestion-dispatch.fixture.tsx';

describe('no-split-suggestion-dispatch oxlint rule', () => {
  test('fires on exactly 3 positive cases (and on no negative case)', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Split suggestion dispatch/g) ?? []).length;
    expect(fires).toBe(3);
    expect(output).toContain('Compose the delete and the insert into ONE chain');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-split-suggestion-dispatch');
  });

  test('rule is registered, enabled, and deliberately unscoped', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-split-suggestion-dispatch');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-split-suggestion-dispatch');
  });
});
