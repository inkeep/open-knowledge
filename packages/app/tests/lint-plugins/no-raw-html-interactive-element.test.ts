/**
 * UI primitives discipline enforcement — `no-raw-html-interactive-element` GritQL plugin.
 *
 * Plugin:  `biome-plugins/no-raw-html-interactive-element.grit`
 * Fixture: `biome-plugins/__fixtures__/no-raw-html-interactive-element.fixture.tsx`
 *
 * The fixture pairs 8 positive cases (one per banned-tag/closing-form combination)
 * with 5 negative cases (shadcn replacements + PascalCase composite components that
 * resemble the banned tags). The test asserts the plugin fires exactly 8 times.
 *
 * Exact equality (`toBe(8)`) catches drift in both directions:
 *   - false-negative: a weakened pattern drops below 8 → fails
 *   - false-positive: a widened pattern fires on a negative case → above 8 → fails
 *
 * The plugin is registered via `overrides[].plugins` in `biome.jsonc` rather than
 * at root `plugins[]`, with a positive include glob scoped to production .tsx files
 * under packages/{app,desktop,plugin}/src/** and explicit negative excludes for:
 *  - packages/app/src/editor/** (ProseMirror NodeViews legitimately render raw HTML)
 *  - packages/app/src/components/ui/** (these ARE the shadcn primitive wrappers)
 *  - *.test.tsx + *.dom.test.tsx (test fixtures aren't user-facing UI)
 *
 * Both invariants are asserted below so an accidental scope-widening (rule moved
 * to root plugins) or scope-narrowing (the exemptions missing) fails CI.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// __dirname → packages/app/tests/lint-plugins/. Repo root is 4 levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-raw-html-interactive-element.fixture.tsx';

describe('no-raw-html-interactive-element GritQL plugin', () => {
  test('fires on exactly 8 positive cases (and on no negative case)', () => {
    const result = spawnSync('bunx', ['biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Raw HTML interactive primitive/g) ?? []).length;
    expect(fires).toBe(8);
    // Diagnostic message names the fix (action verb-phrase substring).
    expect(output).toContain('use shadcn Button/Input/Textarea/Select');
    // Diagnostic message appends a docs URL — generic URL regex + anchor
    // substring. The anchor check keeps the regex from being vacuously
    // satisfied by an unrelated URL biome might surface elsewhere.
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-raw-html-interactive-elementgrit');
  });

  test('plugin is registered in biome.jsonc via overrides (not root plugins)', () => {
    // Bun's loader treats `.jsonc` as JSON and strips `//` comments cleanly,
    // matching the loader used by `no-loosely-typed-webcontents-ipc.test.ts`.
    const config = require(join(REPO_ROOT, 'biome.jsonc')) as {
      plugins?: string[];
      overrides?: Array<{ includes?: string[]; plugins?: string[] }>;
    };

    const rootPlugins = config.plugins ?? [];
    expect(rootPlugins).not.toContain('./biome-plugins/no-raw-html-interactive-element.grit');

    const overrides = config.overrides ?? [];
    const matchingOverride = overrides.find((entry) =>
      (entry.plugins ?? []).includes('./biome-plugins/no-raw-html-interactive-element.grit'),
    );
    expect(matchingOverride).toBeDefined();

    const includes = matchingOverride?.includes ?? [];
    // Positive scope: in-scope .tsx surfaces.
    expect(includes).toContain('packages/app/src/**/*.tsx');
    expect(includes).toContain('packages/desktop/src/**/*.tsx');
    expect(includes).toContain('packages/plugin/src/**/*.tsx');
    // Negative scope: load-bearing exemptions. ProseMirror NodeViews +
    // shadcn UI wrappers + test fixtures MUST remain exempt.
    expect(includes).toContain('!packages/app/src/editor/**');
    expect(includes).toContain('!packages/app/src/components/ui/**');
    expect(includes).toContain('!**/*.test.tsx');
    expect(includes).toContain('!**/*.dom.test.tsx');
    // Fixture self-include so this test's positive cases still trigger.
    expect(includes).toContain(
      'biome-plugins/__fixtures__/no-raw-html-interactive-element.fixture.tsx',
    );
  });
});
