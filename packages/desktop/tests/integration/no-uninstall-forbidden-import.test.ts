import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readBiomeConfig } from '../../../../test-support/read-biome-config.test-helper.ts';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-uninstall-forbidden-import.fixture.tsx';
const PLUGIN_REL = './biome-plugins/no-uninstall-forbidden-import.grit';

describe('no-uninstall-forbidden-import GritQL plugin', () => {
  test('fires on exactly 13 cases (12 forbidden imports + 1 dynamic import), and on no negative case', () => {
    const result = spawnSync('pnpm', ['exec', 'biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;

    const fires = (output.match(/no-uninstall-forbidden-importgrit/g) ?? []).length;
    expect(fires).toBe(13);
    const forbidden = (output.match(/Forbidden module in the uninstall entry/g) ?? []).length;
    const dynamic = (output.match(/Dynamic import under src\/uninstall/g) ?? []).length;
    expect(forbidden).toBe(12);
    expect(dynamic).toBe(1);

    expect(output).toContain('must connect to nothing');
    expect(output).toContain('eager-load');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-uninstall-forbidden-importgrit');
  });

  test('is registered in biome.jsonc via overrides scoped to src/uninstall (not root plugins)', () => {
    const config = readBiomeConfig(REPO_ROOT);

    const rootPlugins = config.plugins ?? [];
    expect(rootPlugins).not.toContain(PLUGIN_REL);

    const overrides = config.overrides ?? [];
    const matchingOverride = overrides.find((entry) => (entry.plugins ?? []).includes(PLUGIN_REL));
    expect(matchingOverride).toBeDefined();

    const includes = matchingOverride?.includes ?? [];
    expect(includes).toContain('packages/app/src/uninstall/**/*.ts');
    expect(includes).toContain('packages/app/src/uninstall/**/*.tsx');
    expect(includes).toContain('!packages/app/src/uninstall/**/*.test.ts');
    expect(includes).toContain('!packages/app/src/uninstall/**/*.test.tsx');
    expect(includes).toContain('!packages/app/src/uninstall/**/*.dom.test.tsx');
    expect(includes).toContain(FIXTURE_REL);
  });
});
