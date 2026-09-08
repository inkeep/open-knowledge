/**
 * no-demoted-dialog-confirm — oxlint rule fixture test.
 *
 * Rule:  `lint-plugins/ok-rules/rules/no-demoted-dialog-confirm.mjs`
 * Fixture: `lint-plugins/ok-rules/__fixtures__/no-demoted-dialog-confirm.fixture.tsx`
 *
 * Per precedent #42 (custom lint enforcement is oxlint JS-plugin rules). Forbids a
 * dialog footer whose confirm sits on `secondary`, whose near-invisible fill
 * loses the emphasis contest with the `outline` dismiss standing beside it.
 * `ghost`, `link` and `link-muted` are flat at rest too but are not plausible
 * footer confirms; the rule's README section records why the pattern stays narrow.
 *
 * The fixture pairs 3 positive cases (the reported shape, the same inversion
 * with the dismiss wrapped in `DialogClose asChild`, and the
 * `AlertDialogFooter` sibling) with 4 negative cases (the canonical
 * variant-omitted confirm, a `destructive` confirm, a `secondary` button
 * outside any footer, and an inline-suppressed tertiary control).
 * Exact-equality (`toBe(3)`) catches both false-negative regressions (a
 * weakened pattern drops below 3) and false-positive widenings (a negative
 * starts firing, rising above 3).
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  oxlintFixtureArgs,
  readEnabledRuleIds,
  readRegisteredRuleNames,
  readRuleScope,
} from '../../../../test-support/read-ok-rules-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'lint-plugins/ok-rules/__fixtures__/no-demoted-dialog-confirm.fixture.tsx';

describe('no-demoted-dialog-confirm oxlint rule', () => {
  test('fires on exactly 3 demoted dialog footers (and on no negative case)', () => {
    const result = spawnSync('pnpm', oxlintFixtureArgs(FIXTURE_REL), {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Demoted confirm in a dialog footer/g) ?? []).length;
    expect(fires).toBe(3);
    expect(output).toContain('Drop the variant prop');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#no-demoted-dialog-confirm');
  });

  test('rule is registered, enabled, and scoped to product chrome', async () => {
    expect(await readRegisteredRuleNames(REPO_ROOT)).toContain('no-demoted-dialog-confirm');
    expect(await readEnabledRuleIds(REPO_ROOT)).toContain('ok/no-demoted-dialog-confirm');
  });

  test('its scope table still carries every include and exclude the rule depends on', () => {
    const scope = readRuleScope(REPO_ROOT, 'no-demoted-dialog-confirm');
    expect(scope.sort()).toEqual(
      [
        'packages/app/src/**/*.tsx',
        'packages/desktop/src/**/*.tsx',
        'packages/plugin/src/**/*.tsx',
        '!packages/app/src/components/ui/**',
        '!**/*.test.tsx',
        '!**/*.dom.test.tsx',
        'lint-plugins/ok-rules/__fixtures__/no-demoted-dialog-confirm.fixture.tsx',
      ].sort(),
    );
  });
});
