import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readBiomeConfig } from '../../../../test-support/read-biome-config.test-helper.ts';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/require-windowshide-on-spawn.fixture.tsx';

describe('require-windowshide-on-spawn GritQL plugin', () => {
  test('fires exactly 7 times — one per spawn that hides neither way', () => {
    const result = spawnSync('pnpm', ['exec', 'biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;

    const fires = (output.match(/without a hidden Windows console/g) ?? []).length;
    expect(fires).toBe(7);

    expect(output).toContain('withHiddenWindowsConsole');
    expect(output).toContain('windowsHide: true');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#require-windowshide-on-spawngrit');
  });

  test('plugin is registered in biome.jsonc via overrides (not root plugins)', () => {
    const config = readBiomeConfig(REPO_ROOT);

    const rootPlugins = config.plugins ?? [];
    expect(rootPlugins).not.toContain('./biome-plugins/require-windowshide-on-spawn.grit');

    const overrides = config.overrides ?? [];
    const matchingOverride = overrides.find((entry) =>
      (entry.plugins ?? []).includes('./biome-plugins/require-windowshide-on-spawn.grit'),
    );
    expect(matchingOverride).toBeDefined();

    const includes = matchingOverride?.includes ?? [];
    expect(includes).toContain('packages/server/src/**/*.ts');
    expect(includes).toContain('packages/cli/src/**/*.ts');
    expect(includes).toContain('packages/desktop/src/**/*.ts');
    expect(includes).toContain('!**/*.test.ts');
    expect(includes).toContain(
      'biome-plugins/__fixtures__/require-windowshide-on-spawn.fixture.tsx',
    );
  });
});
