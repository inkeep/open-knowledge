/**
 * `no-unportaled-editor-content` GritQL plugin test.
 *
 * Plugin:  `biome-plugins/no-unportaled-editor-content.grit`
 * Fixture: `biome-plugins/__fixtures__/no-unportaled-editor-content.fixture.tsx`
 *
 * Per precedent #42 (custom Biome enforcement is GritQL plugins). The
 * fixture pairs 3 positive cases (bare/paired/nested `<EditorContent />`)
 * with 3 negative cases (canonical portaled site with inline suppression,
 * `<PureEditorContent />` sibling, bare import). The test asserts the
 * plugin fires exactly 3 times.
 *
 * Exact equality (`toBe(3)`) catches drift in both directions:
 *   - false-negative: a weakened pattern drops below 3 → fails
 *   - false-positive: a widened pattern fires on a negative case → above 3 → fails
 *
 * real input → public
 * interface (`biome check`) → observable outcome (diagnostic count).
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// __dirname → packages/app/tests/integration/. Repo root is 4 levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-unportaled-editor-content.fixture.tsx';

describe('no-unportaled-editor-content GritQL plugin', () => {
  test('fires on exactly 3 positive cases (and on no negative case)', () => {
    const result = spawnSync('bunx', ['biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Portal-only: render <EditorContent/g) ?? []).length;
    expect(fires).toBe(3);
    // Diagnostic message names the fix (action verb-phrase substring).
    expect(output).toContain('render <EditorContent />');
    // Diagnostic message appends a docs URL — generic URL regex + anchor
    // substring. The anchor check keeps the regex from being vacuously
    // satisfied by an unrelated URL biome might surface elsewhere.
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-unportaled-editor-contentgrit');
  });

  test('plugin is registered in biome.jsonc', () => {
    const config = require(join(REPO_ROOT, 'biome.jsonc'));
    const plugins = config.plugins ?? [];
    expect(plugins).toContain('./biome-plugins/no-unportaled-editor-content.grit');
  });
});
