/**
 * no-roundtrip-identity-oracle — Biome GritQL plugin fixture test.
 *
 * Plugin:  `biome-plugins/no-roundtrip-identity-oracle.grit`
 * Fixture: `biome-plugins/__fixtures__/no-roundtrip-identity-oracle.fixture.tsx`
 *
 * Per precedent #42 (custom Biome enforcement is GritQL plugins). Forbids the
 * byte-fidelity round-trip oracle — `serialize(parse(x))` (or the
 * MarkdownManager method form) asserted equal to the same input `x` — in
 * public-mirrored tests, so a new public test can't reintroduce the engine's
 * byte-identity correctness oracle that the engine fidelity suite owns
 * privately.
 *
 * The fixture pairs 10 positive cases (the identity oracle through toBe /
 * toEqual / toStrictEqual and `===`, in both bare `serialize(parse(...))` and
 * MarkdownManager method forms) with 7 negative cases (a fixed-literal contract
 * assertion, the `normalizeBridge(a) === normalizeBridge(b)` Bridge-invariant
 * contract from precedent #38, the `!==` normalizing-construct detector, the
 * helper-wrapped and two-statement round-trip forms, and a two-different-manager
 * comparison). Exact-equality (`toBe(10)`) catches both false-negative
 * regressions (a weakened pattern drops below 10) and false-positive widenings
 * (a negative starts firing, rising above 10).
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// __dirname → packages/app/tests/lint-plugins/. Repo root is 4 levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-roundtrip-identity-oracle.fixture.tsx';
const PLUGIN_REL = './biome-plugins/no-roundtrip-identity-oracle.grit';

describe('no-roundtrip-identity-oracle GritQL plugin', () => {
  test('fires on exactly 10 byte-identity oracle assertions (and on no negative case)', () => {
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
    const fires = (output.match(/Byte-fidelity round-trip oracle in a public test/g) ?? []).length;
    expect(fires).toBe(10);
    // Diagnostic message names the fix (action verb-phrase substring).
    expect(output).toContain('assert a fixed expected literal for a specific contract');
    // Diagnostic message appends a docs URL — generic URL regex + anchor
    // substring. The anchor check keeps the regex from being vacuously
    // satisfied by an unrelated URL biome might surface elsewhere.
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-roundtrip-identity-oraclegrit');
  });

  test('plugin is registered as an override scoped to the public test surface (not workspace-wide)', () => {
    const config = require(join(REPO_ROOT, 'biome.jsonc'));
    // NOT at root plugins[] — a workspace-wide promotion would fire on
    // excluded internal test suites (where the identity oracle legitimately
    // lives) and turn `bun run lint` red.
    const rootPlugins: string[] = config.plugins ?? [];
    expect(rootPlugins).not.toContain(PLUGIN_REL);

    const overrides: Array<{ includes?: string[]; plugins?: string[] }> = config.overrides ?? [];
    const entry = overrides.find((o) => (o.plugins ?? []).includes(PLUGIN_REL));
    expect(entry).toBeDefined();
    const includes = entry?.includes ?? [];
    // The fixture must be in scope so the firing test above can trigger the rule.
    expect(includes).toContain(FIXTURE_REL);
    // Every cluster and the private test files that own the oracle must be
    // excluded from the plugin scope. Dropping any one would let the rule fire on
    // a private oracle and redden `bun run lint`; assert the negative set so a
    // removed exclusion is caught here, not only by a lint run.
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
});
