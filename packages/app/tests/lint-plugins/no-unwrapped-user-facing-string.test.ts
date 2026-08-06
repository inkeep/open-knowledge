/**
 * no-unwrapped-user-facing-string — Biome GritQL plugin fixture test.
 *
 * Plugin:  `biome-plugins/no-unwrapped-user-facing-string.grit`
 * Fixture: `biome-plugins/__fixtures__/no-unwrapped-user-facing-string.fixture.tsx`
 *
 * Per precedent #42 (custom Biome enforcement is GritQL plugins). The rule makes
 * a hardcoded user-facing string a build-visible defect instead of a convention
 * a contributor has to remember.
 *
 * The fixture pairs 15 positive cases across the rule's four branches (2 toast
 * arguments, 2 JSX text nodes, 4 UI-facing attributes, 7 UI-facing object
 * properties) with 9 negative groups (`<Trans>` children direct and nested,
 * the `t` macro in child / attribute / object position, shortcut/code/path/
 * brand tokens, `<Brand> icon` marks, format-token placeholders, non-literal
 * toast arguments, unscoped property names, and TypeScript member positions).
 * Exact equality catches a weakened pattern (count drops) and a widened one (a
 * negative starts firing). The per-branch counts catch the compensating case a
 * total cannot: one branch losing a case while another gains one.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readBiomeConfig } from '../../../../test-support/read-biome-config.test-helper';

// __dirname → packages/app/tests/lint-plugins/. Repo root is 4 levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-unwrapped-user-facing-string.fixture.tsx';
const PLUGIN_REL = './biome-plugins/no-unwrapped-user-facing-string.grit';

function checkFixture(): string {
  // `--max-diagnostics` is load-bearing, not tuning: biome's default cap is 20
  // and the fixture already carries more than that between this rule's own
  // hits and the a11y / suppression diagnostics its declarations attract. At
  // the default, the counts below would silently measure the cap.
  const result = spawnSync(
    'pnpm',
    ['exec', 'biome', 'check', '--max-diagnostics=200', FIXTURE_REL],
    {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    },
  );
  // Surface a spawn failure explicitly: without this, `status` is null on a
  // `pnpm exec` spawn error and the `not.toBe(0)` below passes vacuously,
  // masking the failure as "0 diagnostics".
  expect(result.error).toBeUndefined();
  // biome check exits non-zero when any diagnostic (incl. plugin) fires.
  expect(result.status).not.toBe(0);
  return `${result.stdout}\n${result.stderr}`;
}

function countMatches(output: string, pattern: RegExp): number {
  return (output.match(pattern) ?? []).length;
}

describe('no-unwrapped-user-facing-string GritQL plugin', () => {
  test('fires on exactly 15 unwrapped user-facing strings (and on no negative case)', () => {
    expect(countMatches(checkFixture(), /Unwrapped user-facing string/g)).toBe(15);
  });

  test('each branch carries its own share of the count', () => {
    const output = checkFixture();
    expect(countMatches(output, /Unwrapped user-facing string in a toast argument/g)).toBe(2);
    expect(countMatches(output, /Unwrapped user-facing string in JSX text/g)).toBe(2);
    expect(countMatches(output, /Unwrapped user-facing string in a UI-facing attribute/g)).toBe(4);
    expect(
      countMatches(output, /Unwrapped user-facing string in a UI-facing object property/g),
    ).toBe(7);
  });

  test('the diagnostic names the fix and links this rule section of the docs', () => {
    const output = checkFixture();
    // Fix-noun: the action a reader applies to make the message go away.
    expect(output).toContain('Wrap it with the Lingui');
    // Docs URL — generic URL regex + anchor substring. The anchor check keeps
    // the regex from being vacuously satisfied by an unrelated URL biome might
    // surface elsewhere.
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-unwrapped-user-facing-stringgrit');
  });

  test('plugin is registered as an override scoped to the product surface (not workspace-wide)', () => {
    const config = readBiomeConfig(REPO_ROOT);
    // NOT at root plugins[] — a workspace-wide promotion would fire on docs,
    // scripts, and every package that legitimately ships English-only strings
    // (the CLI command surface above all), turning `pnpm lint` red.
    const rootPlugins: string[] = config.plugins ?? [];
    expect(rootPlugins).not.toContain(PLUGIN_REL);

    const overrides: Array<{ includes?: string[]; plugins?: string[] }> = config.overrides ?? [];
    const entry = overrides.find((o) => (o.plugins ?? []).includes(PLUGIN_REL));
    expect(entry).toBeDefined();
    const includes = entry?.includes ?? [];
    // The fixture must be in scope so the firing tests above can trigger the rule.
    expect(includes).toContain(FIXTURE_REL);
    // `.ts` as well as `.tsx`: the toast branch's dominant shape is a plain
    // `lib/` helper. Dropping either extension would silently halve the scope.
    for (const included of [
      'packages/app/src/**/*.ts',
      'packages/app/src/**/*.tsx',
      'packages/desktop/src/**/*.ts',
      'packages/desktop/src/**/*.tsx',
      'packages/plugin/src/**/*.ts',
      'packages/plugin/src/**/*.tsx',
    ]) {
      expect(includes).toContain(included);
    }
    // Assert the negative set too, so a removed exclusion is caught here rather
    // than as a wall of diagnostics on the next unrelated lint run.
    for (const excluded of [
      '!packages/app/src/editor/**',
      '!packages/app/src/components/ui/**',
      // Electron main. `lingui extract` reads packages/app/src only, so the
      // object-property branch would demand a fix that does not exist there.
      '!packages/desktop/src/main/**',
      '!**/*.test.ts',
      '!**/*.test.tsx',
      '!**/*.dom.test.tsx',
    ]) {
      expect(includes).toContain(excluded);
    }
  });
});
