/**
 * no-demoted-dialog-confirm — Biome GritQL plugin fixture test.
 *
 * Plugin:  `biome-plugins/no-demoted-dialog-confirm.grit`
 * Fixture: `biome-plugins/__fixtures__/no-demoted-dialog-confirm.fixture.tsx`
 *
 * Per precedent #42 (custom Biome enforcement is GritQL plugins). Forbids a
 * dialog footer whose confirm sits on `secondary`, whose near-invisible fill
 * loses the emphasis contest with the `outline` dismiss standing beside it.
 * `ghost`, `link` and `link-muted` are flat at rest too but are not plausible
 * footer confirms; the plugin header records why the pattern stays narrow.
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
import { readBiomeConfig } from '../../../../test-support/read-biome-config.test-helper';

// __dirname → packages/app/tests/lint-plugins/. Repo root is 4 levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-demoted-dialog-confirm.fixture.tsx';
const PLUGIN_REL = './biome-plugins/no-demoted-dialog-confirm.grit';

describe('no-demoted-dialog-confirm GritQL plugin', () => {
  test('fires on exactly 3 demoted dialog footers (and on no negative case)', () => {
    const result = spawnSync('pnpm', ['exec', 'biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    // Surface a spawn failure explicitly: without this, `status` is null on a
    // `pnpm exec` spawn error and the `not.toBe(0)` below passes vacuously,
    // masking the failure as "0 diagnostics".
    expect(result.error).toBeUndefined();
    // biome check exits non-zero when any diagnostic (incl. plugin) fires.
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Demoted confirm in a dialog footer/g) ?? []).length;
    expect(fires).toBe(3);
    // Diagnostic message names the fix (action verb-phrase substring).
    expect(output).toContain('Drop the variant prop');
    // Diagnostic message appends a docs URL — generic URL regex + anchor
    // substring. The anchor check keeps the regex from being vacuously
    // satisfied by an unrelated URL biome might surface elsewhere.
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-demoted-dialog-confirmgrit');
  });

  test('plugin is registered as an override scoped to product chrome (not workspace-wide)', () => {
    const config = readBiomeConfig(REPO_ROOT);
    // NOT at root plugins[] — a workspace-wide promotion would fire on the
    // shadcn primitives and on tests that render the demoted shape on purpose.
    const rootPlugins: string[] = config.plugins ?? [];
    expect(rootPlugins).not.toContain(PLUGIN_REL);

    const overrides: Array<{ includes?: string[]; plugins?: string[] }> = config.overrides ?? [];
    const entry = overrides.find((o) => (o.plugins ?? []).includes(PLUGIN_REL));
    expect(entry).toBeDefined();
    const includes = entry?.includes ?? [];
    // The fixture must be in scope so the firing test above can trigger the rule.
    expect(includes).toContain(FIXTURE_REL);
    // App, desktop, and plugin chrome are the surfaces the rule exists for — a
    // dropped glob would silently stop covering dialogs in that tree.
    expect(includes).toContain('packages/app/src/**/*.tsx');
    expect(includes).toContain('packages/desktop/src/**/*.tsx');
    expect(includes).toContain('packages/plugin/src/**/*.tsx');
    // Assert the negative set so a removed exclusion is caught here rather
    // than only by a red lint run.
    for (const excluded of [
      '!packages/app/src/components/ui/**',
      '!**/*.test.tsx',
      '!**/*.dom.test.tsx',
    ]) {
      expect(includes).toContain(excluded);
    }
  });
});
