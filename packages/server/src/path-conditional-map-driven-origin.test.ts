/**
 * Observer A origin discipline — `path-conditional-map-driven-origin` GritQL
 * plugin.
 *
 * Plugin:  `biome-plugins/path-conditional-map-driven-origin.grit`
 * Fixture: `biome-plugins/__fixtures__/path-conditional-map-driven-origin.fixture.tsx`
 *
 * The fixture pairs 7 positive cases (bare `doc.transact(fn)`, wrong origin in
 * 2-arg / 3-arg form, and a bare call whose callback merely mentions the
 * sanctioned origin) with 3 negative cases (the sanctioned origin in the second
 * argument position, including one whose callback also mentions it). The test
 * asserts the plugin fires exactly 7 times.
 *
 * Exact equality (`toBe(7)`) catches drift in both directions:
 *   - false-negative: a weakened pattern drops below 7 -> fails
 *   - false-positive: a widened pattern fires on a negative case -> above 7 -> fails
 *
 * The plugin is registered via `overrides[].plugins` in `biome.jsonc` rather
 * than at root `plugins[]`, with the in-scope file restricted to the one
 * observer-cross-CRDT spine (`packages/server/src/server-observers.ts`) plus
 * the fixture self-include. Both invariants are asserted below so an
 * accidental scope-widening (rule moved to root plugins) or scope-narrowing
 * (the file missing from the override) fails CI.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/path-conditional-map-driven-origin.fixture.tsx';

describe('path-conditional-map-driven-origin GritQL plugin', () => {
  test('fires on exactly 7 positive cases (and on no negative case)', () => {
    const result = spawnSync('bunx', ['biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Observer-side transact call missing sanctioned origin/g) ?? [])
      .length;
    expect(fires).toBe(7);
    // Diagnostic message names the sanctioned origin + the second-argument fix.
    expect(output).toContain('Pass `OBSERVER_SYNC_ORIGIN` as the second argument');
    // Diagnostic message appends a docs URL - generic URL regex + anchor
    // substring. The anchor check keeps the regex from being vacuously
    // satisfied by an unrelated URL biome might surface elsewhere.
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#path-conditional-map-driven-origingrit');
  });

  test('plugin is registered in biome.jsonc via overrides (not root plugins)', () => {
    const config = require(join(REPO_ROOT, 'biome.jsonc')) as {
      plugins?: string[];
      overrides?: Array<{ includes?: string[]; plugins?: string[] }>;
    };

    const rootPlugins = config.plugins ?? [];
    expect(rootPlugins).not.toContain('./biome-plugins/path-conditional-map-driven-origin.grit');

    const overrides = config.overrides ?? [];
    const matchingOverride = overrides.find((entry) =>
      (entry.plugins ?? []).includes('./biome-plugins/path-conditional-map-driven-origin.grit'),
    );
    expect(matchingOverride).toBeDefined();

    const includes = matchingOverride?.includes ?? [];
    // The one observer-cross-CRDT spine file in scope.
    expect(includes).toContain('packages/server/src/server-observers.ts');
    // Fixture self-include so this test's positive cases still trigger.
    expect(includes).toContain(
      'biome-plugins/__fixtures__/path-conditional-map-driven-origin.fixture.tsx',
    );
  });
});
