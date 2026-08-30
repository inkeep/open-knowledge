/**
 * Sole route-hash builder — `no-raw-route-hash-construction` GritQL plugin.
 *
 * Plugin:  `biome-plugins/no-raw-route-hash-construction.grit`
 * Fixture: `biome-plugins/__fixtures__/no-raw-route-hash-construction.fixture.tsx`
 *
 * The fixture pairs 5 positives (a template interpolation onto the prefix, the
 * single- and double-quoted concatenations, the prefix reached later in a
 * template, and one inside a JSX attribute) with negatives: the comparison
 * forms `startsWith('#/')` and `=== '#/'`, the bare content-root sentinel, a
 * string that merely mentions the prefix, and a different prefix ending in a
 * slash. Exact equality on the fire count catches drift both ways — a
 * false-negative regression (< 5) and a false-positive widening (> 5).
 *
 * Two of the negatives are the reason this is a lint plugin rather than a
 * source scan. The positive inside the JSX attribute sits after a regex
 * literal (`.replace(/"/g, …)`) and a JSX apostrophe, and a comment at the top
 * of the fixture spells the offending shape verbatim. A hand-rolled lexer has
 * to model regex literals, JSX text and comments to get those three right;
 * matching a node's own source text gets them right by construction.
 *
 * The plugin is registered via `overrides[].plugins` in `biome.jsonc`, scoped
 * to `packages/app/src/**` minus `lib/doc-hash.ts` — the sanctioned builder —
 * and minus tests, which write expected hashes as literals.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readBiomeConfig } from '../../../../test-support/read-biome-config.test-helper.ts';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-raw-route-hash-construction.fixture.tsx';
const PLUGIN_REL = './biome-plugins/no-raw-route-hash-construction.grit';

describe('no-raw-route-hash-construction GritQL plugin', () => {
  test('fires exactly 5 times — one per hand-built hash, none on the read forms', () => {
    const result = spawnSync('pnpm', ['exec', 'biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      windowsHide: true,
    });
    // Guard against a vacuous pass if `pnpm exec biome` itself fails to spawn
    // (missing binary / PATH) — `result.status` would be null and
    // `not.toBe(0)` would pass while asserting nothing about biome's output.
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;

    const fires = (output.match(/Raw route-hash construction/g) ?? []).length;
    expect(fires).toBe(5);

    // The message names the escape route rather than only the offence.
    expect(output).toContain('hashFromDocName');
    expect(output).toContain('hashFromFolderPath');
    expect(output).toContain('biome-plugins/README.md#no-raw-route-hash-constructiongrit');
  });

  test('plugin is registered in biome.jsonc via overrides, with doc-hash.ts excluded', () => {
    const config = readBiomeConfig(REPO_ROOT);

    expect(config.plugins ?? []).not.toContain(PLUGIN_REL);

    const overrides = config.overrides ?? [];
    const matchingOverride = overrides.find((entry) => (entry.plugins ?? []).includes(PLUGIN_REL));
    expect(matchingOverride).toBeDefined();

    const includes = matchingOverride?.includes ?? [];
    expect(includes).toContain('packages/app/src/**/*.ts');
    expect(includes).toContain('packages/app/src/**/*.tsx');
    // The exclusion is the whole rule: doc-hash.ts is the one sanctioned
    // builder, so scoping that leaks it back in would make the rule unusable
    // and someone would delete it rather than the exclusion.
    expect(includes).toContain('!packages/app/src/lib/doc-hash.ts');
    expect(includes).toContain(FIXTURE_REL);
  });
});
