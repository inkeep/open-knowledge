import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readBiomeConfig } from '../../../../test-support/read-biome-config.test-helper';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-themeless-pierre-diff.fixture.tsx';

describe('no-themeless-pierre-diff GritQL plugin', () => {
  test('fires on exactly 7 positive cases (and on no negative case)', () => {
    const result = spawnSync('pnpm', ['exec', 'biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/@pierre\/diffs render contract/g) ?? []).length;
    expect(fires).toBe(7);
    const themeFires = (output.match(/add `theme: okPierreTheme\(\)`/g) ?? []).length;
    const styleFires = (output.match(/does not set diffStyle: 'unified'/g) ?? []).length;
    expect(themeFires).toBe(5);
    expect(styleFires).toBe(2);
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-themeless-pierre-diffgrit');
  });

  test('plugin is registered in biome.jsonc via overrides (not root plugins)', () => {
    const config = readBiomeConfig(REPO_ROOT);

    const rootPlugins = config.plugins ?? [];
    expect(rootPlugins).not.toContain('./biome-plugins/no-themeless-pierre-diff.grit');

    const overrides = config.overrides ?? [];
    const matchingOverride = overrides.find((entry) =>
      (entry.plugins ?? []).includes('./biome-plugins/no-themeless-pierre-diff.grit'),
    );
    expect(matchingOverride).toBeDefined();

    const includes = matchingOverride?.includes ?? [];
    expect(includes).toContain('packages/app/src/**/*.tsx');
    expect(includes).toContain('!**/*.test.tsx');
    expect(includes).toContain('!**/*.dom.test.tsx');
    expect(includes).toContain('biome-plugins/__fixtures__/no-themeless-pierre-diff.fixture.tsx');
  });
});
