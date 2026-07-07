/**
 * IPC discipline enforcement — `no-loosely-typed-webcontents-ipc` GritQL plugin.
 *
 * Plugin:  `biome-plugins/no-loosely-typed-webcontents-ipc.grit`
 * Fixture: `biome-plugins/__fixtures__/no-loosely-typed-webcontents-ipc.fixture.tsx`
 *
 * Per precedent #42 (custom Biome enforcement is GritQL plugins) + precedent
 * #14 (IPC discipline). The fixture pairs 6 positive cases (one per banned
 * primitive) with 4 negative cases (adjacent methods on the same objects +
 * bare-function with the same name); the test asserts the plugin fires
 * exactly 6 times.
 *
 * Exact equality (`toBe(6)`) catches drift in both directions:
 *   - false-negative: a weakened pattern drops below 6 → fails
 *   - false-positive: a widened pattern fires on a negative case → above 6 → fails
 *
 * Real input → public
 * interface (`biome check`) → observable outcome (diagnostic count).
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// __dirname → packages/desktop/tests/integration/. Repo root is 4 levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-loosely-typed-webcontents-ipc.fixture.tsx';

describe('no-loosely-typed-webcontents-ipc GritQL plugin', () => {
  test('fires on exactly 6 banned primitives (and on no negative case)', () => {
    const result = spawnSync('bunx', ['biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Direct electron IPC primitive/g) ?? []).length;
    expect(fires).toBe(6);
    // Diagnostic message names the fix (action verb-phrase substring).
    expect(output).toContain('route through createInvoker');
    // Diagnostic message appends a docs URL — generic URL regex + anchor
    // substring. The anchor check keeps the regex from being vacuously
    // satisfied by an unrelated URL biome might surface elsewhere.
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-loosely-typed-webcontents-ipcgrit');
  });

  test('plugin is registered in biome.jsonc', () => {
    const config = require(join(REPO_ROOT, 'biome.jsonc'));
    const plugins = config.plugins ?? [];
    expect(plugins).toContain('./biome-plugins/no-loosely-typed-webcontents-ipc.grit');
  });
});
