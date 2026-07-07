/**
 * 1-way theme contract — `no-resolved-value-theme-source` GritQL plugin.
 *
 * Plugin:  `biome-plugins/no-resolved-value-theme-source.grit`
 * Fixture: `biome-plugins/__fixtures__/no-resolved-value-theme-source.fixture.tsx`
 *
 * Per precedent #42, GritQL plugins are the canonical custom-enforcement
 * mechanism. This test mirrors the shape codified in precedent #42's
 * authoring template: shell out to `bunx biome check` on a fixture file
 * with deliberate violations + clean usage; assert exact diagnostic count.
 *
 * Exact-equality assertion (`toBe(3)`) catches BOTH directions of drift:
 *   - false-negative: a weakened pattern that no longer fires on a positive
 *     case → count drops below 3 → test fails
 *   - false-positive: a widened pattern that fires on one of the fixture's
 *     4 negative cases → count rises above 3 → test fails
 *
 * The latter is the asymmetric-coverage property `toBeGreaterThanOrEqual`
 * lacks; it's why fixture design pairs positive cases with negative ones.
 *
 * Pattern C test: real input → public
 * interface (`biome check`) → observable outcome (diagnostic count).
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// __dirname → packages/desktop/tests/integration/. Repo root is 4 levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-resolved-value-theme-source.fixture.tsx';

describe('1-way theme contract — no-resolved-value-theme-source GritQL plugin', () => {
  test('fires on exactly 3 positive cases (and on no negative case)', () => {
    const result = spawnSync('bunx', ['biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/1-way theme contract:/g) ?? []).length;
    expect(fires).toBe(3);
    // Diagnostic message names the fix (action verb-phrase substring).
    expect(output).toContain('pass the unresolved CRDT value');
    // Diagnostic message appends a docs URL — generic URL regex + anchor
    // substring. The anchor check keeps the regex from being vacuously
    // satisfied by an unrelated URL biome might surface elsewhere.
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-resolved-value-theme-sourcegrit');
  });

  test('plugin is registered in biome.jsonc', () => {
    const config = require(join(REPO_ROOT, 'biome.jsonc'));
    const plugins = config.plugins ?? [];
    expect(plugins).toContain('./biome-plugins/no-resolved-value-theme-source.grit');
  });
});
