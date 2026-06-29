import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-resolved-value-theme-source.fixture.tsx';

describe('1-way theme contract — no-resolved-value-theme-source GritQL plugin', () => {
  test('fires on exactly 3 positive cases (and on no negative case)', () => {
    const result = spawnSync('bunx', ['biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/1-way theme contract:/g) ?? []).length;
    expect(fires).toBe(3);
    expect(output).toContain('pass the unresolved CRDT value');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-resolved-value-theme-sourcegrit');
  });

  test('plugin is registered in biome.jsonc', () => {
    const config = require(join(REPO_ROOT, 'biome.jsonc'));
    const plugins = config.plugins ?? [];
    expect(plugins).toContain('./biome-plugins/no-resolved-value-theme-source.grit');
  });
});
