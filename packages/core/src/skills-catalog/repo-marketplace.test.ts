import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRepoMarketplacePlugins, repoMarketplacePluginFor } from './repo-marketplace.ts';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ok-repo-marketplace-'));
  mkdirSync(join(repo, '.claude-plugin'));
  writeFileSync(
    join(repo, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'inkeep-agents-private',
      plugins: [
        { name: 'agents', source: './public/agents/plugins/agents' },
        { name: 'remote', source: 'github:foo/bar' },
        { name: 'missing', source: './nowhere' },
        { name: 'absolute', source: join(repo, 'public/agents/plugins/agents') },
        { name: 'disabled', source: './public/agents/plugins/agents' },
        { name: 'phantom', source: './phantom' },
        { name: 'escape', source: '../outside-plugin' },
      ],
    }),
  );
  mkdirSync(join(repo, '.claude'));
  writeFileSync(
    join(repo, '.claude', 'settings.json'),
    JSON.stringify({
      enabledPlugins: {
        'agents@inkeep-agents-private': true,
        'absolute@inkeep-agents-private': true,
        'disabled@inkeep-agents-private': false,
        'phantom@inkeep-agents-private': true,
        'escape@inkeep-agents-private': true,
      },
    }),
  );
  mkdirSync(join(repo, 'public/agents/plugins/agents/.claude-plugin'), { recursive: true });
  writeFileSync(
    join(repo, 'public/agents/plugins/agents/.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'agents', repository: 'https://github.com/inkeep/agents-private' }),
  );
  mkdirSync(join(repo, 'public/agents/plugins/agents/skills/write-docs'), { recursive: true });
  mkdirSync(join(repo, 'public/agents/plugins/agents/references/not-a-skill'), { recursive: true });
  mkdirSync(join(repo, '.agents/skills'), { recursive: true });
  symlinkSync(
    '../../public/agents/plugins/agents/skills/write-docs',
    join(repo, '.agents/skills/write-docs'),
  );
  mkdirSync(join(repo, '.agents/skills/hand-authored'));
  mkdirSync(join(repo, '..', 'outside-plugin', 'skills'), { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(join(repo, '..', 'outside-plugin'), { recursive: true, force: true });
});

describe('repo-declared marketplace plugins', () => {
  it('keeps only in-tree, enabled plugin roots, with the plugin.json repository as url', () => {
    const plugins = readRepoMarketplacePlugins(repo);
    expect(plugins.map((p) => p.name)).toEqual(['agents']);
    expect(plugins[0]).toMatchObject({
      marketplace: 'inkeep-agents-private',
      url: 'https://github.com/inkeep/agents-private',
    });
  });

  it('identifies a symlinked in-repo plugin skill; leaves a hand-authored one alone', () => {
    const plugins = readRepoMarketplacePlugins(repo);
    expect(repoMarketplacePluginFor(plugins, join(repo, '.agents/skills/write-docs'))?.name).toBe(
      'agents',
    );
    expect(
      repoMarketplacePluginFor(plugins, join(repo, '.agents/skills/hand-authored')),
    ).toBeNull();
    expect(repoMarketplacePluginFor(plugins, join(repo, '.agents/skills/gone'))).toBeNull();
    expect(
      repoMarketplacePluginFor(
        plugins,
        join(repo, 'public/agents/plugins/agents/references/not-a-skill'),
      ),
    ).toBeNull();
  });

  it('is empty without a manifest, and without enabledPlugins', () => {
    expect(readRepoMarketplacePlugins(join(repo, 'public'))).toEqual([]);
    rmSync(join(repo, '.claude', 'settings.json'));
    expect(readRepoMarketplacePlugins(repo)).toEqual([]);
  });

  it('warns on a malformed manifest instead of treating it as absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(join(repo, '.claude-plugin', 'marketplace.json'), '{ not json');
    expect(readRepoMarketplacePlugins(repo)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
