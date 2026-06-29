
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
    expect(output).toContain('Pass `OBSERVER_SYNC_ORIGIN` as the second argument');
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
    expect(includes).toContain('packages/server/src/server-observers.ts');
    expect(includes).toContain(
      'biome-plugins/__fixtures__/path-conditional-map-driven-origin.fixture.tsx',
    );
  });
});
