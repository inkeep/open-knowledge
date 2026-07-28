/**
 * "Connects to nothing" first-hop feedback — `no-uninstall-forbidden-import`
 * GritQL plugin.
 *
 * Plugin:  `biome-plugins/no-uninstall-forbidden-import.grit`
 * Fixture: `biome-plugins/__fixtures__/no-uninstall-forbidden-import.fixture.tsx`
 *
 * The fixture pairs 13 positive cases (12 forbidden static imports — one per
 * denylisted specifier across every import shape — plus one dynamic import) with
 * negative cases (the allowed core package, shadcn primitives, plain
 * markdown-render prosemirror/@tiptap, and `yjs-not-real` which must not
 * prefix-match `yjs`). The test asserts the plugin fires exactly 13 times.
 *
 * Exact equality (`toBe(13)`) catches drift in both directions:
 *   - false-negative: a weakened pattern drops below 13 → fails
 *   - false-positive: a widened pattern fires on a negative case → above 13 → fails
 *
 * This GritQL rule is only shallow first-hop feedback; the authoritative
 * "connects to nothing" gate is the transitive-module-graph test at
 * `tests/unit/uninstall-module-graph.test.ts`.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readBiomeConfig } from '../../../../test-support/read-biome-config.test-helper.ts';

// __dirname → packages/desktop/tests/integration/. Repo root is 4 levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-uninstall-forbidden-import.fixture.tsx';
const PLUGIN_REL = './biome-plugins/no-uninstall-forbidden-import.grit';

describe('no-uninstall-forbidden-import GritQL plugin', () => {
  test('fires on exactly 13 cases (12 forbidden imports + 1 dynamic import), and on no negative case', () => {
    const result = spawnSync('pnpm', ['exec', 'biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;

    // Every diagnostic from this rule ends with the docs anchor; counting it
    // covers both message variants (forbidden import + dynamic import).
    const fires = (output.match(/no-uninstall-forbidden-importgrit/g) ?? []).length;
    expect(fires).toBe(13);
    const forbidden = (output.match(/Forbidden module in the uninstall entry/g) ?? []).length;
    const dynamic = (output.match(/Dynamic import under src\/uninstall/g) ?? []).length;
    expect(forbidden).toBe(12);
    expect(dynamic).toBe(1);

    // Each message names the fix (action verb-phrase substring) and links the docs.
    expect(output).toContain('must connect to nothing');
    expect(output).toContain('eager-load');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-uninstall-forbidden-importgrit');
  });

  test('is registered in biome.jsonc via overrides scoped to src/uninstall (not root plugins)', () => {
    const config = readBiomeConfig(REPO_ROOT);

    const rootPlugins = config.plugins ?? [];
    expect(rootPlugins).not.toContain(PLUGIN_REL);

    const overrides = config.overrides ?? [];
    const matchingOverride = overrides.find((entry) => (entry.plugins ?? []).includes(PLUGIN_REL));
    expect(matchingOverride).toBeDefined();

    const includes = matchingOverride?.includes ?? [];
    // Positive scope: the shipped uninstall entry source.
    expect(includes).toContain('packages/app/src/uninstall/**/*.ts');
    expect(includes).toContain('packages/app/src/uninstall/**/*.tsx');
    // Negative scope: test files are exempt — a dom test legitimately does
    // `await import('./main')` to prove the entry paints.
    expect(includes).toContain('!packages/app/src/uninstall/**/*.test.ts');
    expect(includes).toContain('!packages/app/src/uninstall/**/*.test.tsx');
    expect(includes).toContain('!packages/app/src/uninstall/**/*.dom.test.tsx');
    // Fixture self-include so this test's positive cases still trigger.
    expect(includes).toContain(FIXTURE_REL);
  });
});
