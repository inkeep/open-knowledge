import { describe, expect, test } from 'vitest';
import { pluginUpstreamsByName } from './plugin-upstream.ts';
import type { CatalogSkill } from './schema.ts';

function skill(name: string, home: string, provenance: Record<string, unknown>): CatalogSkill {
  return {
    name,
    description: '',
    files: { skillMd: `${home}/SKILL.md`, scripts: [], references: [] },
    sourceHarness: 'claude',
    sourceHarnesses: ['claude'],
    home,
    provenance,
    inert: { commands: false, hooks: false, mcp: false },
  } as CatalogSkill;
}

const hashes: Record<string, string> = {
  '/cache/shared/write-skill': 'hash-write',
  '/cache/eng/1on1': 'hash-1on1',
};
const hashOf = (home: string) => hashes[home];

describe('pluginUpstreamsByName', () => {
  test('indexes a plugin-provided skill under its bare name', () => {
    const index = pluginUpstreamsByName(
      [
        skill('write-skill', '/cache/shared/write-skill', {
          plugin: 'shared',
          marketplace: 'inkeep-team-skills',
          version: '1.2.725',
          repositoryUrl: 'https://github.com/inkeep/team-skills',
        }),
      ],
      hashOf,
    );

    expect(index.get('write-skill')).toEqual({
      source: 'shared@inkeep-team-skills',
      plugin: 'shared',
      marketplace: 'inkeep-team-skills',
      provider: 'claude',
      contentHash: 'hash-write',
      version: '1.2.725',
      repositoryUrl: 'https://github.com/inkeep/team-skills',
      home: '/cache/shared/write-skill',
    });
  });

  test('a bare skill dir is not an upstream', () => {
    const index = pluginUpstreamsByName(
      [skill('grill-me', '/cache/shared/write-skill', { scope: 'user' })],
      hashOf,
    );
    expect(index.size).toBe(0);
  });

  test('a plugin without a marketplace is not an upstream', () => {
    const index = pluginUpstreamsByName(
      [skill('write-skill', '/cache/shared/write-skill', { plugin: 'shared' })],
      hashOf,
    );
    expect(index.size).toBe(0);
  });

  test('an unreadable bundle is dropped rather than indexed with a blank hash', () => {
    const index = pluginUpstreamsByName(
      [
        skill('missing', '/cache/gone', {
          plugin: 'shared',
          marketplace: 'inkeep-team-skills',
        }),
      ],
      hashOf,
    );
    expect(index.size).toBe(0);
  });

  test('a name held by two plugins resolves to the first, as the detected list does', () => {
    const index = pluginUpstreamsByName(
      [
        skill('1on1', '/cache/eng/1on1', { plugin: 'eng', marketplace: 'inkeep-team-skills' }),
        skill('1on1', '/cache/shared/write-skill', {
          plugin: 'shared',
          marketplace: 'inkeep-team-skills',
        }),
      ],
      hashOf,
    );
    expect(index.get('1on1')?.source).toBe('eng@inkeep-team-skills');
    expect(index.size).toBe(1);
  });

  test('optional provenance is omitted rather than sent as undefined', () => {
    const index = pluginUpstreamsByName(
      [
        skill('write-skill', '/cache/shared/write-skill', {
          plugin: 'shared',
          marketplace: 'inkeep-team-skills',
        }),
      ],
      hashOf,
    );
    const upstream = index.get('write-skill');
    expect(upstream).toBeDefined();
    expect('version' in (upstream ?? {})).toBe(false);
    expect('repositoryUrl' in (upstream ?? {})).toBe(false);
  });
});
