/**
 * `no-unportaled-editor-content` oxlint rule test.
 *
 * Rule:  `lint-plugins/ok-rules/rules/no-unportaled-editor-content.mjs`
 * Fixture: `lint-plugins/ok-rules/__fixtures__/no-unportaled-editor-content.fixture.tsx`
 *
 * Per precedent #42 (custom lint enforcement is oxlint JS-plugin rules). The
 * fixture pairs 3 positive cases (bare/paired/nested `<EditorContent />`)
 * with 3 negative cases (canonical portaled site with inline suppression,
 * `<PureEditorContent />` sibling, bare import). The test asserts the
 * rule fires exactly 3 times.
 *
 * Exact equality (`toBe(3)`) catches drift in both directions:
 *   - false-negative: a weakened pattern drops below 3 → fails
 *   - false-positive: a widened pattern fires on a negative case → above 3 → fails
 *
 * real input → public
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
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/no-unportaled-editor-content.fixture.tsx';

describe('no-unportaled-editor-content oxlint rule', () => {
  test('fires on exactly 3 positive cases (and on no negative case)', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Portal-only: render <EditorContent/g) ?? []).length;
    expect(fires).toBe(3);
    expect(output).toContain('render <EditorContent />');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-unportaled-editor-content');
  });

  test('rule is registered, enabled, and deliberately unscoped', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-unportaled-editor-content');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-unportaled-editor-content');
  });
});
