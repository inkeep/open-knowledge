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

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// __dirname → packages/app/tests/lint-plugins/. OK subtree root is 4 levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-inline-tolerance-class.fixture.tsx';
const PLUGIN_REL = './biome-plugins/no-inline-tolerance-class.grit';
const GRIT_ABS = join(REPO_ROOT, 'biome-plugins/no-inline-tolerance-class.grit');
const CATALOG_SOURCE_ABS = join(REPO_ROOT, 'packages/core/src/bridge/normalize.ts');

describe('no-inline-tolerance-class GritQL plugin', () => {
  test('fires on exactly 8 inline fidelity-class literals (and on no negative case)', () => {
    const result = spawnSync('bunx', ['biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    // Surface a spawn failure explicitly: without this, `status` is null on a
    // `bunx` spawn error and the `not.toBe(0)` below passes vacuously, masking
    // the failure as "0 diagnostics".
    expect(result.error).toBeUndefined();
    // biome check exits non-zero when any diagnostic (incl. plugin) fires.
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Inline bridge normalization-class value in a public test/g) ?? [])
      .length;
    expect(fires).toBe(8);
    // Diagnostic message names the fix (action verb-phrase substring).
    expect(output).toContain('hard-coding a BRIDGE_TOLERANCE_CLASSES label');
    // Diagnostic message appends a docs URL — generic URL regex + anchor
    // substring. The anchor check keeps the regex from being vacuously
    // satisfied by an unrelated URL biome might surface elsewhere.
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-inline-tolerance-classgrit');
  });

  test('plugin is registered as an override scoped to the public test surface (not workspace-wide)', () => {
    const config = require(join(REPO_ROOT, 'biome.jsonc'));
    // NOT at root plugins[] — a workspace-wide promotion would fire on the
    // excluded clusters (where the catalog legitimately lives) and on the
    // catalog source itself, turning `bun run lint` red.
    const rootPlugins: string[] = config.plugins ?? [];
    expect(rootPlugins).not.toContain(PLUGIN_REL);

    const overrides: Array<{ includes?: string[]; plugins?: string[] }> = config.overrides ?? [];
    const entry = overrides.find((o) => (o.plugins ?? []).includes(PLUGIN_REL));
    expect(entry).toBeDefined();
    const includes = entry?.includes ?? [];
    // The fixture must be in scope so the firing test above can trigger the rule.
    expect(includes).toContain(FIXTURE_REL);
    // The clusters that own the catalog (the bridge tests, the conformance
    // estate, the fidelity suite, and the private test files) must be excluded
    // from the plugin scope. Dropping any one would let the rule fire on a test
    // that legitimately keys on the catalog and redden `bun run lint`; assert the
    // negative set so a removed exclusion is caught here, not only by a lint run.
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
    // The four universal text-encoding classes are deliberately NOT matched: they
    // are normalizations every text tool performs (not distinctive classes) and
    // the public floor telemetry runtime surfaces them, so public tests assert
    // them legitimately. They are pinned here so the partition is explicit.
    const UNIVERSAL_ENCODING = ['bom', 'crlf', 'trailing-whitespace', 'trailing-newline'];

    // Drift canary: extract the catalog from its source text (NOT an import — a
    // public-shipping test importing the symbol would itself trip Check B) and
    // the `or {}` arm values from the plugin text. The matched fidelity arms plus
    // the universal-encoding set must exactly partition the catalog: a class added
    // to the catalog reddens here until it is classified into one bucket, and an
    // arm whose value is no longer a catalog member reddens too.
    const catalogSrc = readFileSync(CATALOG_SOURCE_ABS, 'utf-8');
    const arrayBody = catalogSrc.match(/BRIDGE_TOLERANCE_CLASSES\s*=\s*\[([\s\S]*?)\]/)?.[1];
    expect(arrayBody).toBeDefined();
    const catalog = [...(arrayBody ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    // Non-vacuity: the catalog must be non-empty, else a failed extraction would
    // make the equality below pass vacuously against an empty plugin.
    expect(catalog.length).toBeGreaterThan(0);

    // Strip `//` comment lines so the docstring's illustrative `'…'` examples
    // are not mistaken for `or {}` arms; the surviving body holds only the arm
    // literals and the diagnostic message (which carries no backtick-quoted
    // token), so the arm regex captures exactly the matched class set.
    const gritArms = readFileSync(GRIT_ABS, 'utf-8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    const matched = [...gritArms.matchAll(/`'([^']+)'`/g)].map((m) => m[1]).sort();

    // The matched set must never include a universal-encoding class (that would
    // redden a legitimate floor test).
    expect(matched.filter((c) => UNIVERSAL_ENCODING.includes(c))).toEqual([]);
    // The two buckets partition the catalog exactly: union equals the catalog,
    // with no member left unclassified and no stale arm outside the catalog.
    const union = [...new Set([...matched, ...UNIVERSAL_ENCODING])].sort();
    expect(union).toEqual(catalog);
  });
});
