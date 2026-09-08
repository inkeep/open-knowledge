/**
 * 1-way theme contract — `no-resolved-value-theme-source` oxlint rule.
 *
 * Rule:  `lint-plugins/ok-rules/rules/no-resolved-value-theme-source.mjs`
 * Fixture: `lint-plugins/ok-rules/__fixtures__/no-resolved-value-theme-source.fixture.tsx`
 *
 * Per precedent #42, oxlint rules are the canonical custom-enforcement
 * mechanism. This test mirrors the shape codified in precedent #42's
 * authoring template: shell out to `pnpm exec oxlint` on a fixture file
 * with deliberate violations + clean usage; assert exact diagnostic count.
 *
 * Exact-equality assertion (`toBe(3)`) catches BOTH directions of drift:
 *   - false-negative: a weakened pattern that no longer fires on a positive
 *     case → count drops below 3 → test fails
 *   - false-positive: a widened pattern that fires on one of the fixture's
 *     4 negative cases → count rises above 3 → test fails
 *
 * The latter is the asymmetric-coverage property `toBeGreaterThanOrEqual`
 * lacks; it's why fixture design pairs positive cases with negative ones.
 *
 * Pattern C test: real input → public
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
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/no-resolved-value-theme-source.fixture.tsx';

describe('1-way theme contract — no-resolved-value-theme-source oxlint rule', () => {
  test('fires on exactly 3 positive cases (and on no negative case)', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/1-way theme contract:/g) ?? []).length;
    expect(fires).toBe(3);
    expect(output).toContain('pass the unresolved CRDT value');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-resolved-value-theme-source');
  });

  test('rule is registered, enabled, and deliberately unscoped', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-resolved-value-theme-source');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-resolved-value-theme-source');
  });
});
