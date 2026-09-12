/** The `no-loosely-typed-webcontents-ipc` oxlint rule fixture test, per precedent #42. */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  oxlintFixtureArgs,
  readEnabledRuleIds,
  readRegisteredRuleNames,
} from '../../../../test-support/read-ok-rules-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL =
  'lint-plugins/ok-rules/__fixtures__/no-loosely-typed-webcontents-ipc.fixture.tsx';

describe('no-loosely-typed-webcontents-ipc oxlint rule', () => {
  test('fires on exactly 6 banned primitives (and on no negative case)', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Direct electron IPC primitive/g) ?? []).length;
    expect(fires).toBe(6);
    expect(output).toContain('route through createInvoker');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-loosely-typed-webcontents-ipc');
  });

  test('rule is registered, enabled, and deliberately unscoped', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-loosely-typed-webcontents-ipc');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-loosely-typed-webcontents-ipc');
  });
});
