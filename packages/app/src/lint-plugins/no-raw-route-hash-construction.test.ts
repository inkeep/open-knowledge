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
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;

    const fires = (output.match(/Raw route-hash construction/g) ?? []).length;
    expect(fires).toBe(5);

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
    expect(includes).toContain('!packages/app/src/lib/doc-hash.ts');
    expect(includes).toContain(FIXTURE_REL);
  });
});
