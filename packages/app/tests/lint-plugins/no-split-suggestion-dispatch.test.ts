/**
 * One-transaction suggestion insertion enforcement — `no-split-suggestion-dispatch`
 * GritQL plugin (precedent #58).
 *
 * Plugin:  `biome-plugins/no-split-suggestion-dispatch.grit`
 * Fixture: `biome-plugins/__fixtures__/no-split-suggestion-dispatch.fixture.tsx`
 *
 * The fixture pairs 3 positive cases (bare trigger-delete chain dispatch with
 * and without `.focus()`, plus the immediately-dispatching `commands.deleteRange`
 * form — all inside a `Suggestion({ ... })` config) with 4 negative cases (the
 * atomic single chain, the `.command()` boundary composition, delegation to
 * `applySlashCommandItem`, and a delete-only chain outside any Suggestion
 * config). The test asserts the plugin fires exactly 3 times.
 *
 * Exact equality (`toBe(3)`) catches drift in both directions:
 *   - false-negative: a weakened pattern drops below 3 → fails
 *   - false-positive: a widened pattern fires on a negative case → above 3 → fails
 *
 * The runtime complement lives in `suggestion-atomicity.dom.test.tsx` and
 * `slash-command-atomicity.dom.test.tsx`, which drive the real surfaces through
 * a real Enter and assert exactly one doc-changing transaction — the lint rule
 * catches the bare-delete dispatch shape statically; the dom tests catch any
 * second dispatch the lint can't see (e.g. inside a delegated item).
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readBiomeConfig } from '../../../../test-support/read-biome-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-split-suggestion-dispatch.fixture.tsx';

describe('no-split-suggestion-dispatch GritQL plugin', () => {
  test('fires on exactly 3 positive cases (and on no negative case)', () => {
    const result = spawnSync('pnpm', ['exec', 'biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Split suggestion dispatch/g) ?? []).length;
    expect(fires).toBe(3);
    expect(output).toContain('Compose the delete and the insert into ONE chain');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-split-suggestion-dispatchgrit');
  });

  test('plugin is registered in biome.jsonc at root plugins (workspace-wide)', () => {
    const config = readBiomeConfig(REPO_ROOT);
    const plugins = config.plugins ?? [];
    expect(plugins).toContain('./biome-plugins/no-split-suggestion-dispatch.grit');
  });
});
