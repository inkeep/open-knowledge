
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

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
    expect(output).toContain('route through createInvoker');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-loosely-typed-webcontents-ipcgrit');
  });

  test('plugin is registered in biome.jsonc', () => {
    const config = require(join(REPO_ROOT, 'biome.jsonc'));
    const plugins = config.plugins ?? [];
    expect(plugins).toContain('./biome-plugins/no-loosely-typed-webcontents-ipc.grit');
  });
});
