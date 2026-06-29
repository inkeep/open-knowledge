
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-unportaled-editor-content.fixture.tsx';

describe('no-unportaled-editor-content GritQL plugin', () => {
  test('fires on exactly 3 positive cases (and on no negative case)', () => {
    const result = spawnSync('bunx', ['biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Portal-only: render <EditorContent/g) ?? []).length;
    expect(fires).toBe(3);
    expect(output).toContain('render <EditorContent />');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-unportaled-editor-contentgrit');
  });

  test('plugin is registered in biome.jsonc', () => {
    const config = require(join(REPO_ROOT, 'biome.jsonc'));
    const plugins = config.plugins ?? [];
    expect(plugins).toContain('./biome-plugins/no-unportaled-editor-content.grit');
  });
});
