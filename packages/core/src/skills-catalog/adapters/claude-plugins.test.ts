import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { enumerateClaudePlugins } from './claude-plugins.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-claude-plugins-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedPlugin(key: string): void {
  const installPath = join(root, 'cache', 'market', 'toolkit', '1.0.0');
  const skill = join(installPath, 'skills', 'review');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: review\ndescription: Review\n---\n');
  writeFileSync(
    join(root, 'installed_plugins.json'),
    JSON.stringify({
      plugins: {
        [key]: [{ scope: 'user', installPath, version: '1.0.0', lastUpdated: '2026-01-01' }],
      },
    }),
  );
}

function writeRegistry(value: unknown): void {
  writeFileSync(join(root, 'known_marketplaces.json'), JSON.stringify(value));
}

function provenanceOf(): Record<string, unknown> {
  const bundles = enumerateClaudePlugins(root, 'claude');
  expect(bundles).toHaveLength(1);
  return (bundles[0]?.skills[0] as { provenance: Record<string, unknown> }).provenance;
}

describe('enumerateClaudePlugins — repository URL stamp', () => {
  test('stamps the GitHub repo the registry records for the marketplace', () => {
    seedPlugin('toolkit@market');
    writeRegistry({ market: { source: { source: 'github', repo: 'acme/skills' } } });

    expect(provenanceOf()).toMatchObject({
      plugin: 'toolkit',
      marketplace: 'market',
      repositoryUrl: 'https://github.com/acme/skills',
    });
  });

  test('omits the URL for a marketplace installed from a local directory', () => {
    seedPlugin('toolkit@market');
    writeRegistry({ market: { source: { source: 'directory', path: '/somewhere' } } });

    expect(provenanceOf().repositoryUrl).toBeUndefined();
  });

  test('omits the URL when the registry names a DIFFERENT marketplace', () => {
    seedPlugin('toolkit@market');
    writeRegistry({ other: { source: { source: 'github', repo: 'acme/skills' } } });

    expect(provenanceOf().repositoryUrl).toBeUndefined();
  });

  test('omits the URL when the plugin key carries no marketplace', () => {
    seedPlugin('toolkit');
    writeRegistry({ market: { source: { source: 'github', repo: 'acme/skills' } } });

    const p = provenanceOf();
    expect(p.plugin).toBe('toolkit');
    expect(p.marketplace).toBeUndefined();
    expect(p.repositoryUrl).toBeUndefined();
  });

  test('survives a missing or malformed registry rather than failing enumeration', () => {
    seedPlugin('toolkit@market');
    expect(provenanceOf().repositoryUrl).toBeUndefined();

    writeFileSync(join(root, 'known_marketplaces.json'), '{ not json');
    expect(provenanceOf().repositoryUrl).toBeUndefined();
  });
});

describe('directory-sourced marketplaces', () => {
  function seedDirectoryMarketplace(): string {
    const repo = join(root, 'repo');
    const pluginRoot = join(repo, 'tools', 'plugins', 'oktools');
    const skill = join(pluginRoot, 'skills', 'linux-vm');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: linux-vm\ndescription: VM\n---\n');
    mkdirSync(join(repo, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(repo, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'local-market',
        plugins: [{ name: 'oktools', source: './tools/plugins/oktools', version: '0.1.0' }],
      }),
    );
    writeFileSync(
      join(root, 'known_marketplaces.json'),
      JSON.stringify({
        'local-market': { source: { source: 'directory', path: repo }, installLocation: repo },
      }),
    );
    writeFileSync(
      join(root, 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'oktools@local-market': [
            {
              scope: 'project',
              projectPath: repo,
              installPath: join(root, 'cache', 'local-market', 'oktools', '0.1.0'),
              version: '0.1.0',
              lastUpdated: '2026-01-01',
            },
          ],
        },
      }),
    );
    return pluginRoot;
  }

  test('an install whose cache path was never written resolves through the marketplace dir', () => {
    const pluginRoot = seedDirectoryMarketplace();
    const bundles = enumerateClaudePlugins(root, 'claude');

    expect(bundles).toHaveLength(1);
    const skill = bundles[0]?.skills[0];
    expect(skill?.name).toBe('linux-vm');
    expect((skill as { home?: string } | undefined)?.home).toBe(
      join(pluginRoot, 'skills', 'linux-vm'),
    );
    expect(skill?.provenance.plugin).toBe('oktools');
    expect(skill?.provenance.marketplace).toBe('local-market');
    expect(skill?.provenance.scope).toBe('project');
  });

  test('a directory marketplace whose manifest is unreadable contributes nothing', () => {
    const pluginRoot = seedDirectoryMarketplace();
    writeFileSync(join(root, 'repo', '.claude-plugin', 'marketplace.json'), '{not json');
    expect(enumerateClaudePlugins(root, 'claude')).toHaveLength(0);
    void pluginRoot;
  });

  test('a relative registry path is refused rather than resolved against cwd', () => {
    seedDirectoryMarketplace();
    writeFileSync(
      join(root, 'known_marketplaces.json'),
      JSON.stringify({
        'local-market': { source: { source: 'directory', path: './repo' } },
      }),
    );
    expect(enumerateClaudePlugins(root, 'claude')).toHaveLength(0);
  });
});
