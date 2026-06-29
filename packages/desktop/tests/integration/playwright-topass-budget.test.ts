
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/playwright-topass-budget.fixture.tsx';

describe('Invariant B — playwright-topass-budget GritQL plugin', () => {
  test('fires on exactly 5 sub-15s toPass budgets (and on no negative case)', () => {
    const result = spawnSync('bunx', ['biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Invariant B: raise the `toPass/g) ?? []).length;
    expect(fires).toBe(5);
    expect(output).toContain('raise the `toPass({ timeout })` budget');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#playwright-topass-budgetgrit');
  });

  test('plugin is registered in biome.jsonc overrides, scoped to deep-link + external-link + fixture', () => {
    const config = require(join(REPO_ROOT, 'biome.jsonc'));
    const pluginPath = './biome-plugins/playwright-topass-budget.grit';

    const rootPlugins: string[] = config.plugins ?? [];
    expect(rootPlugins).not.toContain(pluginPath);

    const overrides: Array<{ includes?: string[]; plugins?: string[] }> = config.overrides ?? [];
    const matching = overrides.find((o) => (o.plugins ?? []).includes(pluginPath));
    expect(matching).toBeDefined();
    const includes = matching?.includes ?? [];
    expect(includes).toContain('packages/desktop/tests/smoke/deep-link.e2e.ts');
    expect(includes).toContain('packages/desktop/tests/smoke/external-link.e2e.ts');
    expect(includes).toContain('biome-plugins/__fixtures__/playwright-topass-budget.fixture.tsx');
  });
});
