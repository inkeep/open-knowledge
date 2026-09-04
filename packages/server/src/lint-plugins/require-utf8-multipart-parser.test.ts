import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readBiomeConfig } from '../../../../test-support/read-biome-config.test-helper.ts';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/require-utf8-multipart-parser.fixture.tsx';
const PLUGIN_REL = './biome-plugins/require-utf8-multipart-parser.grit';

describe('require-utf8-multipart-parser GritQL plugin', () => {
  test('fires exactly 3 times — one per direct busboy construction', () => {
    const result = spawnSync('pnpm', ['exec', 'biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;

    const fires = (output.match(/busboy constructed directly/g) ?? []).length;
    expect(fires).toBe(3);

    expect(output).toContain('createMultipartParser');
    expect(output).toContain('packages/server/src/multipart.ts');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#require-utf8-multipart-parsergrit');
  });

  test('the factory module itself is exempt, so the sanctioned call passes', () => {
    const result = spawnSync(
      'pnpm',
      ['exec', 'biome', 'check', 'packages/server/src/multipart.ts'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        windowsHide: true,
      },
    );
    expect(result.error).toBeUndefined();
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toMatch(/Checked \d+ file/);
    expect(output).not.toContain('busboy constructed directly');
  });

  test('plugin is registered in biome.jsonc via overrides (not root plugins)', () => {
    const config = readBiomeConfig(REPO_ROOT);

    const rootPlugins = config.plugins ?? [];
    expect(rootPlugins).not.toContain(PLUGIN_REL);

    const overrides = config.overrides ?? [];
    const matchingOverride = overrides.find((entry) => (entry.plugins ?? []).includes(PLUGIN_REL));
    expect(matchingOverride).toBeDefined();

    const includes = matchingOverride?.includes ?? [];
    expect(includes).toContain('**/*.ts');
    expect(includes).toContain('**/*.tsx');
    expect(includes).toContain('**/*.mts');
    expect(includes).not.toContain('packages/server/src/**/*.ts');
    expect(includes).toContain('!packages/server/src/multipart.ts');
    expect(includes).toContain('!**/*.test.ts');
    expect(includes).toContain(FIXTURE_REL);
  });
});
