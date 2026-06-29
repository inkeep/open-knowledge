import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/no-raw-html-interactive-element.fixture.tsx';

describe('no-raw-html-interactive-element GritQL plugin', () => {
  test('fires on exactly 8 positive cases (and on no negative case)', () => {
    const result = spawnSync('bunx', ['biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/Raw HTML interactive primitive/g) ?? []).length;
    expect(fires).toBe(8);
    expect(output).toContain('use shadcn Button/Input/Textarea/Select');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#no-raw-html-interactive-elementgrit');
  });

  test('plugin is registered in biome.jsonc via overrides (not root plugins)', () => {
    const config = require(join(REPO_ROOT, 'biome.jsonc')) as {
      plugins?: string[];
      overrides?: Array<{ includes?: string[]; plugins?: string[] }>;
    };

    const rootPlugins = config.plugins ?? [];
    expect(rootPlugins).not.toContain('./biome-plugins/no-raw-html-interactive-element.grit');

    const overrides = config.overrides ?? [];
    const matchingOverride = overrides.find((entry) =>
      (entry.plugins ?? []).includes('./biome-plugins/no-raw-html-interactive-element.grit'),
    );
    expect(matchingOverride).toBeDefined();

    const includes = matchingOverride?.includes ?? [];
    expect(includes).toContain('packages/app/src/**/*.tsx');
    expect(includes).toContain('packages/desktop/src/**/*.tsx');
    expect(includes).toContain('packages/plugin/src/**/*.tsx');
    expect(includes).toContain('!packages/app/src/editor/**');
    expect(includes).toContain('!packages/app/src/components/ui/**');
    expect(includes).toContain('!**/*.test.tsx');
    expect(includes).toContain('!**/*.dom.test.tsx');
    expect(includes).toContain(
      'biome-plugins/__fixtures__/no-raw-html-interactive-element.fixture.tsx',
    );
  });
});
