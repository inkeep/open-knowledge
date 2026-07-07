/**
 * Microcopy ellipsis convention — `microcopy-ellipsis` GritQL plugin.
 *
 * Plugin:  `biome-plugins/microcopy-ellipsis.grit`
 * Fixture: `biome-plugins/__fixtures__/microcopy-ellipsis.fixture.tsx`
 *
 * The codebase reserves U+2026 (`…`) for two surfaces only:
 *   1. macOS native menu items (`packages/desktop/src/main/menu.ts`)
 *   2. Truncation indicators
 *
 * Per precedent #42. The fixture pairs 2 positive cases (JSX text + JSX
 * attribute containing `…`) with 3 negative cases (clean text, clean
 * attribute, and `…` inside a non-UI attribute that the rule must skip);
 * the test asserts the plugin fires exactly 2 times.
 *
 * Exact equality (`toBe(2)`) catches drift in both directions:
 *   - false-negative: a weakened pattern drops below 2 → fails
 *   - false-positive: a widened pattern fires on a clean case → above 2 → fails
 *
 * Test shape: real input → public
 * interface (`biome check`) → observable outcome (diagnostic count).
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// __dirname → packages/app/tests/integration/. Repo root is 4 levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/microcopy-ellipsis.fixture.tsx';

describe('microcopy-ellipsis GritQL plugin', () => {
  test('fires on exactly 2 positive cases (and on no negative case)', () => {
    const result = spawnSync('bunx', ['biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Microcopy: drop the trailing/g) ?? []).length;
    expect(fires).toBe(2);
    // Diagnostic message names the fix (action verb-phrase substring).
    expect(output).toContain('drop the trailing');
    // Diagnostic message appends a docs URL — generic URL regex + anchor
    // substring. The anchor check keeps the regex from being vacuously
    // satisfied by an unrelated URL biome might surface elsewhere.
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#microcopy-ellipsisgrit');
  });

  test('plugin is registered in biome.jsonc', () => {
    const config = require(join(REPO_ROOT, 'biome.jsonc'));
    const plugins = config.plugins ?? [];
    expect(plugins).toContain('./biome-plugins/microcopy-ellipsis.grit');
  });
});
