/**
 * IPC discipline enforcement — `no-loosely-typed-webcontents-ipc` oxlint rule.
 *
 * Rule:  `lint-plugins/ok-rules/rules/no-loosely-typed-webcontents-ipc.mjs`
 * Fixture: `lint-plugins/ok-rules/__fixtures__/no-loosely-typed-webcontents-ipc.fixture.tsx`
 *
 * Per precedent #42 (custom lint enforcement is oxlint JS-plugin rules) + precedent
 * #14 (IPC discipline). The fixture pairs 6 positive cases (one per banned
 * primitive) with 4 negative cases (adjacent methods on the same objects +
 * bare-function with the same name); the test asserts the rule fires
 * exactly 6 times.
 *
 * Exact equality (`toBe(6)`) catches drift in both directions:
 *   - false-negative: a weakened pattern drops below 6 → fails
 *   - false-positive: a widened pattern fires on a negative case → above 6 → fails
 *
 * Real input → public
 * interface (`oxlintFixtureArgs()` → `pnpm exec oxlint`) → observable outcome (diagnostic count).
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
