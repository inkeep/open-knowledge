import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  enumeratePluginProvider,
  inspectPluginSource,
  resolvePluginUpdateSource,
} from './registry.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-plugin-provider-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedCacheVersion(version: string): string {
  const pluginRoot = join(root, 'plugins', 'cache', 'market', 'toolkit', version);
  const skill = join(pluginRoot, 'skills', 'review');
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'toolkit', version }),
  );
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: review\ndescription: Review\n---\n');
  return skill;
}

describe('plugin provider registry', () => {
  test('inspects a Claude cache source into provider-neutral provenance', () => {
    const source = seedCacheVersion('1.2.3');
    writeFileSync(
      join(root, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ market: { source: { source: 'github', repo: 'acme/skills' } } }),
    );

    expect(inspectPluginSource(source)).toEqual({
      provider: 'claude',
      plugin: 'toolkit',
      version: '1.2.3',
      marketplace: 'market',
      repositoryUrl: 'https://github.com/acme/skills',
    });
  });

  test('inspects a marketplace checkout from its plugin manifest', () => {
    const pluginRoot = join(root, 'plugins', 'marketplaces', 'market', 'plugins', 'toolkit');
    const source = join(pluginRoot, 'skills', 'review');
    mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'toolkit', version: '3.0.0' }),
    );

    expect(inspectPluginSource(source)).toEqual({
      provider: 'claude',
      plugin: 'toolkit',
      version: '3.0.0',
      marketplace: 'market',
    });
  });

  test('resolves updates through the matching provider and passes ordinary sources through', () => {
    const oldSource = seedCacheVersion('1.0.0');
    const latestSource = seedCacheVersion('2.0.0');

    expect(resolvePluginUpdateSource(oldSource)).toBe(latestSource);
    expect(resolvePluginUpdateSource('acme/repository')).toBe('acme/repository');
    expect(resolvePluginUpdateSource(oldSource, 'future-provider')).toBe(oldSource);
  });

  test('rejects an ordinary directory that merely resembles a plugin cache path', () => {
    const ordinary = join(
      root,
      'repository',
      'plugins',
      'cache',
      'market',
      'toolkit',
      '1.0.0',
      'skills',
      'review',
    );
    mkdirSync(ordinary, { recursive: true });
    writeFileSync(join(ordinary, 'SKILL.md'), '---\nname: review\ndescription: Review\n---\n');

    expect(inspectPluginSource(ordinary)).toBeNull();
    expect(resolvePluginUpdateSource(ordinary)).toBe(ordinary);
  });

  test('enumerates a provider without exposing its manifest format to the caller', () => {
    const pluginRoot = join(root, 'plugins', 'cache', 'market', 'toolkit', '1.0.0');
    const skill = join(pluginRoot, 'skills', 'review');
    mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: review\ndescription: Review\n---\n');
    writeFileSync(
      join(root, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'toolkit@market': [{ installPath: pluginRoot, scope: 'user', version: '1.0.0' }],
        },
      }),
    );

    const bundles = enumeratePluginProvider('claude', join(root, 'plugins'));

    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.skills[0]?.provenance).toMatchObject({
      pluginProvider: 'claude',
      plugin: 'toolkit',
      marketplace: 'market',
      version: '1.0.0',
    });
  });
});
