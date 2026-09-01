/**
 * no-inline-tolerance-class — Biome GritQL plugin fixture test.
 *
 * Plugin:  `biome-plugins/no-inline-tolerance-class.grit`
 * Fixture: `biome-plugins/__fixtures__/no-inline-tolerance-class.fixture.tsx`
 *
 * Per precedent #42 (custom Biome enforcement is GritQL plugins). Forbids a
 * public-mirrored test from writing a bridge tolerance-class catalog value
 * (`BRIDGE_TOLERANCE_CLASSES`) inline as a string literal. Importing the catalog
 * symbol into a public test is already blocked by `check-mirror-test-policy`
 * Check B (moat-import); this rule closes the complementary gap where a test
 * re-encodes a class value inline, bypassing the import check.
 *
 * Three guarantees, each its own test:
 *   1. Fires on exactly the planted positives (and on no negative) — the
 *      bidirectional `toBe(8)` count, plus the diagnostic-message contract.
 *   2. Registered as an override scoped to the public test surface, never at
 *      root `plugins[]` (which would fire on the excluded clusters where the
 *      catalog legitimately lives).
 *   3. The matched fidelity classes plus the four universal text-encoding
 *      classes partition `BRIDGE_TOLERANCE_CLASSES` exactly — a class added to
 *      the catalog reddens here until it is classified into one bucket, so the
 *      guard can never silently cover a stale subset.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readBiomeConfig } from '../../../../test-support/read-biome-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-inline-tolerance-class.fixture.tsx';
const PLUGIN_REL = './biome-plugins/no-inline-tolerance-class.grit';
const GRIT_ABS = join(REPO_ROOT, 'biome-plugins/no-inline-tolerance-class.grit');
const CATALOG_SOURCE_ABS = join(REPO_ROOT, 'packages/core/src/bridge/normalize.ts');

describe('no-inline-tolerance-class GritQL plugin', () => {
  test('fires on exactly 8 inline fidelity-class literals (and on no negative case)', () => {
    const result = spawnSync('pnpm', ['exec', 'biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Inline bridge normalization-class value in a public test/g) ?? [])
      .length;
    expect(fires).toBe(8);
    expect(output).toContain('hard-coding a BRIDGE_TOLERANCE_CLASSES label');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-inline-tolerance-classgrit');
  });

  test('plugin is registered as an override scoped to the public test surface (not workspace-wide)', () => {
    const config = readBiomeConfig(REPO_ROOT);
    const rootPlugins: string[] = config.plugins ?? [];
    expect(rootPlugins).not.toContain(PLUGIN_REL);

    const overrides: Array<{ includes?: string[]; plugins?: string[] }> = config.overrides ?? [];
    const entry = overrides.find((o) => (o.plugins ?? []).includes(PLUGIN_REL));
    expect(entry).toBeDefined();
    const includes = entry?.includes ?? [];
    expect(includes).toContain(FIXTURE_REL);
    for (const excluded of [
      '!packages/md-conformance/**',
      '!packages/app/tests/fidelity/**',
      '!packages/core/src/markdown/**/*.test.ts',
      '!packages/core/src/bridge/**/*.test.ts',
      '!**/*.private.*',
    ]) {
      expect(includes).toContain(excluded);
    }
  });

  test('matched fidelity set + universal-encoding set partition BRIDGE_TOLERANCE_CLASSES', () => {
    const UNIVERSAL_ENCODING = ['bom', 'crlf', 'trailing-whitespace', 'trailing-newline'];

    const catalogSrc = readFileSync(CATALOG_SOURCE_ABS, 'utf-8');
    const arrayBody = catalogSrc.match(/BRIDGE_TOLERANCE_CLASSES\s*=\s*\[([\s\S]*?)\]/)?.[1];
    expect(arrayBody).toBeDefined();
    const catalog = [...(arrayBody ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(catalog.length).toBeGreaterThan(0);

    const gritArms = readFileSync(GRIT_ABS, 'utf-8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    const matched = [...gritArms.matchAll(/`'([^']+)'`/g)].map((m) => m[1]).sort();

    expect(matched.filter((c) => UNIVERSAL_ENCODING.includes(c))).toEqual([]);
    const union = [...new Set([...matched, ...UNIVERSAL_ENCODING])].sort();
    expect(union).toEqual(catalog);
  });
});
