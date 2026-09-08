/**
 * Microcopy ellipsis convention — `microcopy-ellipsis` oxlint rule.
 *
 * Rule:  `lint-plugins/ok-rules/rules/microcopy-ellipsis.mjs`
 * Fixture: `lint-plugins/ok-rules/__fixtures__/microcopy-ellipsis.fixture.tsx`
 *
 * The codebase reserves U+2026 (`…`) for two surfaces only:
 *   1. macOS native menu items (`packages/desktop/src/main/menu.ts`)
 *   2. Truncation indicators
 *
 * Per precedent #42. The fixture pairs 2 positive cases (JSX text + JSX
 * attribute containing `…`) with 3 negative cases (clean text, clean
 * attribute, and `…` inside a non-UI attribute that the rule must skip);
 * the test asserts the rule fires exactly 2 times.
 *
 * Exact equality (`toBe(2)`) catches drift in both directions:
 *   - false-negative: a weakened pattern drops below 2 → fails
 *   - false-positive: a widened pattern fires on a clean case → above 2 → fails
 *
 * Test shape: real input → public
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
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/microcopy-ellipsis.fixture.tsx';

describe('microcopy-ellipsis oxlint rule', () => {
  test('fires on exactly 2 positive cases (and on no negative case)', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Microcopy: drop the trailing/g) ?? []).length;
    expect(fires).toBe(2);
    expect(output).toContain('drop the trailing');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#microcopy-ellipsis');
  });

  test('rule is registered, enabled, and deliberately unscoped', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('microcopy-ellipsis');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/microcopy-ellipsis');
  });
});
