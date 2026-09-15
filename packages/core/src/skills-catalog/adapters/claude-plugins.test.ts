import fs, {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { enumerateClaudePlugins } from './claude-plugins.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-claude-plugins-'));
});
afterEach(() => {
  vi.restoreAllMocks();
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
  return (bundles[0]?.skills[0] as { provenance: Record<string, unknown> } | undefined)?.provenance;
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

test('project plugin selection matches Windows drive-letter and separator variants', () => {
  seedPlugin('toolkit@market');
  const installedPath = join(root, 'installed_plugins.json');
  const installed = JSON.parse(readFileSync(installedPath, 'utf-8')) as {
    plugins: Record<string, Array<Record<string, string>>>;
  };
  const entry = installed.plugins['toolkit@market']?.[0];
  if (entry === undefined) throw new Error('fixture entry was not created');
  entry.scope = 'project';
  entry.projectPath = 'C:\\Users\\me\\project\\';
  writeFileSync(installedPath, JSON.stringify(installed));

  expect(enumerateClaudePlugins(root, 'claude', 'c:/Users/me/project')).toHaveLength(1);
  expect(enumerateClaudePlugins(root, 'claude', 'c:/Users/me/Project')).toHaveLength(0);
});

describe('directory-sourced marketplaces', () => {
  function seedDirectoryMarketplace({
    source = './tools/plugins/oktools',
    metadataPluginRoot,
    pluginRelativePath = 'tools/plugins/oktools',
  }: {
    source?: string;
    metadataPluginRoot?: string;
    pluginRelativePath?: string;
  } = {}): string {
    const repo = join(root, 'repo');
    const pluginRoot = join(repo, pluginRelativePath);
    const skill = join(pluginRoot, 'skills', 'linux-vm');
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: linux-vm\ndescription: VM\n---\n');
    mkdirSync(join(repo, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(repo, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'local-market',
        ...(metadataPluginRoot !== undefined
          ? { metadata: { pluginRoot: metadataPluginRoot } }
          : {}),
        plugins: [{ name: 'oktools', source, version: '0.1.0' }],
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    expect(warn).not.toHaveBeenCalled();
  });

  test('an in-root source resolves when the marketplace directory is a symlink', () => {
    seedDirectoryMarketplace();
    const marketplaceDir = join(root, 'repo');
    const canonicalMarketplaceDir = join(root, 'canonical-repo');
    renameSync(marketplaceDir, canonicalMarketplaceDir);
    symlinkSync(
      canonicalMarketplaceDir,
      marketplaceDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(enumerateClaudePlugins(root, 'claude')).toHaveLength(1);
  });

  test('scoped enumeration does not read a foreign directory marketplace manifest', () => {
    seedDirectoryMarketplace();
    const manifestPath = join(root, 'repo', '.claude-plugin', 'marketplace.json');
    const descriptor = Object.getOwnPropertyDescriptor(fs, 'readFileSync');
    if (descriptor === undefined) throw new Error('readFileSync descriptor is unavailable');
    const original = fs.readFileSync.bind(fs);
    const reads: string[] = [];
    Object.defineProperty(fs, 'readFileSync', {
      ...descriptor,
      value: (...args: Parameters<typeof fs.readFileSync>) => {
        reads.push(String(args[0]));
        return original(...args);
      },
    });
    syncBuiltinESMExports();
    try {
      expect(enumerateClaudePlugins(root, 'claude', join(root, 'another-project'))).toHaveLength(0);
      expect(reads).not.toContain(manifestPath);
    } finally {
      Object.defineProperty(fs, 'readFileSync', descriptor);
      syncBuiltinESMExports();
    }
  });

  test('metadata.pluginRoot resolves a bare source beneath the declared base', () => {
    const pluginRoot = seedDirectoryMarketplace({
      source: 'oktools',
      metadataPluginRoot: './tools/plugins',
    });
    const bundles = enumerateClaudePlugins(root, 'claude');

    expect(bundles).toHaveLength(1);
    expect((bundles[0]?.skills[0] as { home?: string } | undefined)?.home).toBe(
      join(pluginRoot, 'skills', 'linux-vm'),
    );
  });

  test('an absolute metadata.pluginRoot inside the marketplace is rejected', () => {
    const pluginRoot = join(root, 'repo', 'tools', 'plugins');
    seedDirectoryMarketplace({ source: 'oktools', metadataPluginRoot: pluginRoot });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(enumerateClaudePlugins(root, 'claude')).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      '[skills-catalog] rejected directory marketplace plugin source',
      expect.objectContaining({
        marketplaceDir: join(root, 'repo'),
        plugin: 'oktools',
        cause: 'metadata.pluginRoot must be a relative path inside the marketplace',
      }),
    );
  });

  test('a bare source without metadata.pluginRoot is rejected', () => {
    seedDirectoryMarketplace({ source: 'oktools', pluginRelativePath: 'oktools' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(enumerateClaudePlugins(root, 'claude')).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      '[skills-catalog] rejected directory marketplace plugin source',
      expect.objectContaining({
        marketplaceDir: join(root, 'repo'),
        plugin: 'oktools',
        cause: 'metadata.pluginRoot is required for a bare source',
      }),
    );
  });

  test.each([
    {
      separator: 'slash',
      source: 'nested/oktools',
      pluginRelativePath: 'tools/plugins/nested/oktools',
    },
    {
      separator: 'backslash',
      source: 'nested\\oktools',
      pluginRelativePath: 'tools/plugins/nested\\oktools',
    },
  ])(
    'rejects a $separator-bearing source that omits the explicit relative prefix',
    ({ source, pluginRelativePath }) => {
      seedDirectoryMarketplace({
        source,
        metadataPluginRoot: './tools/plugins',
        pluginRelativePath,
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(enumerateClaudePlugins(root, 'claude')).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        '[skills-catalog] rejected directory marketplace plugin source',
        expect.objectContaining({
          marketplaceDir: join(root, 'repo'),
          plugin: 'oktools',
          cause: 'unsupported source form',
        }),
      );
    },
  );

  test('does not report invalid sources for unrelated marketplace plugins', () => {
    seedDirectoryMarketplace();
    const manifestPath = join(root, 'repo', '.claude-plugin', 'marketplace.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      plugins: Array<Record<string, unknown>>;
    };
    manifest.plugins.push({ name: 'unrelated', source: 'nested/unrelated' });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(enumerateClaudePlugins(root, 'claude')).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test.each([
    { kind: 'missing', source: undefined },
    { kind: 'non-string', source: 42 },
  ])('reports a $kind selected source', ({ source }) => {
    seedDirectoryMarketplace();
    const manifestPath = join(root, 'repo', '.claude-plugin', 'marketplace.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      plugins: Array<Record<string, unknown>>;
    };
    const selected = manifest.plugins[0];
    if (selected === undefined) throw new Error('fixture plugin was not created');
    if (source === undefined) selected.name = 'another-plugin';
    else selected.source = source;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(enumerateClaudePlugins(root, 'claude')).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      '[skills-catalog] rejected directory marketplace plugin source',
      expect.objectContaining({
        marketplaceDir: join(root, 'repo'),
        plugin: 'oktools',
        cause: 'missing or invalid source',
      }),
    );
  });

  test('an explicit relative source ignores a valid relative pluginRoot', () => {
    const pluginRoot = seedDirectoryMarketplace({ metadataPluginRoot: './other-plugins' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bundles = enumerateClaudePlugins(root, 'claude');

    expect(bundles).toHaveLength(1);
    expect((bundles[0]?.skills[0] as { home?: string } | undefined)?.home).toBe(
      join(pluginRoot, 'skills', 'linux-vm'),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  test('an explicit relative source ignores an invalid absolute pluginRoot', () => {
    const pluginRoot = seedDirectoryMarketplace({ metadataPluginRoot: join(root, 'outside') });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bundles = enumerateClaudePlugins(root, 'claude');

    expect(bundles).toHaveLength(1);
    expect((bundles[0]?.skills[0] as { home?: string } | undefined)?.home).toBe(
      join(pluginRoot, 'skills', 'linux-vm'),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  test('a parent-relative pluginRoot is rejected by its field contract', () => {
    seedDirectoryMarketplace({
      source: 'oktools',
      metadataPluginRoot: '../outside',
      pluginRelativePath: '../outside/oktools',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(enumerateClaudePlugins(root, 'claude')).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      '[skills-catalog] rejected directory marketplace plugin source',
      expect.objectContaining({
        marketplaceDir: join(root, 'repo'),
        plugin: 'oktools',
        cause: 'metadata.pluginRoot must be a relative path inside the marketplace',
      }),
    );
  });

  test('an unresolvable candidate reports a bounded filesystem cause', () => {
    seedDirectoryMarketplace({
      source: './missing/oktools',
      pluginRelativePath: 'present/oktools',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(enumerateClaudePlugins(root, 'claude')).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      '[skills-catalog] rejected directory marketplace plugin source',
      expect.objectContaining({
        marketplaceDir: join(root, 'repo'),
        plugin: 'oktools',
        cause: expect.stringContaining('ENOENT'),
      }),
    );
    const warningContext = warn.mock.calls[0]?.[1] as { cause?: unknown } | undefined;
    if (typeof warningContext?.cause !== 'string') throw new Error('warning cause was not emitted');
    expect(warningContext.cause.length).toBeLessThanOrEqual(500);
  });

  test('an unsupported parent-relative source contributes nothing', () => {
    seedDirectoryMarketplace({
      source: '../outside/oktools',
      pluginRelativePath: '../outside/oktools',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(enumerateClaudePlugins(root, 'claude')).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      '[skills-catalog] rejected directory marketplace plugin source',
      expect.objectContaining({
        marketplaceDir: join(root, 'repo'),
        plugin: 'oktools',
        cause: 'unsupported source form',
      }),
    );
  });

  test('a source symlink that escapes the marketplace is rejected', () => {
    seedDirectoryMarketplace({
      source: './plugins/oktools',
      pluginRelativePath: '../outside/oktools',
    });
    mkdirSync(join(root, 'repo', 'plugins'), { recursive: true });
    symlinkSync(
      join(root, 'outside', 'oktools'),
      join(root, 'repo', 'plugins', 'oktools'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(enumerateClaudePlugins(root, 'claude')).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      '[skills-catalog] rejected directory marketplace plugin source',
      expect.objectContaining({
        marketplaceDir: join(root, 'repo'),
        plugin: 'oktools',
        cause: 'source resolves outside marketplace',
      }),
    );
  });

  test('a directory marketplace whose manifest is unreadable contributes nothing', () => {
    seedDirectoryMarketplace();
    const marketplaceDir = join(root, 'repo');
    writeFileSync(join(marketplaceDir, '.claude-plugin', 'marketplace.json'), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(enumerateClaudePlugins(root, 'claude')).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      '[skills-catalog] failed to read directory marketplace manifest',
      expect.objectContaining({
        marketplaceDir,
        cause: expect.any(String),
      }),
    );
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
