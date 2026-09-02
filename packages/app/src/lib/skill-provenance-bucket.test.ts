import type { CatalogSkill, SkillsListEntry } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { bucketForDetected, bucketForSkill, bucketKey } from './skill-provenance-bucket';

function skill(origin?: SkillsListEntry['origin']): SkillsListEntry {
  return {
    name: 'example',
    scope: 'project',
    path: '.agents/skills/example/SKILL.md',
    installed: true,
    hosts: [],
    ...(origin ? { origin } : {}),
  } as SkillsListEntry;
}

function detected(plugin?: string): CatalogSkill {
  return {
    name: 'example',
    description: '',
    files: { skillMd: '/tmp/example/SKILL.md', scripts: [], references: [] },
    sourceHarness: 'claude',
    sourceHarnesses: ['claude'],
    home: '/tmp',
    provenance: plugin ? { plugin } : {},
    inert: { commands: false, hooks: false, mcp: false },
  } as CatalogSkill;
}

describe('bucketForSkill', () => {
  test('a skill with no lock entry is ungrouped', () => {
    expect(bucketForSkill(skill())).toBeNull();
  });

  test('an owner/repo source buckets by repo, with the owner as publisher', () => {
    const b = bucketForSkill(
      skill({ source: 'inkeep/open-knowledge-skills', importedAt: '2026-08-13T00:00:00.000Z' }),
    );
    expect(b).toEqual({
      kind: 'source',
      id: 'open-knowledge-skills',
      publisher: 'inkeep',
      url: 'https://www.skills.sh/inkeep/open-knowledge-skills',
    });
  });

  test('built-ins are not special-cased — they bucket under their source like anything else', () => {
    const b = bucketForSkill(
      skill({ source: 'inkeep/open-knowledge-skills', importedAt: '2026-08-13T00:00:00.000Z' }),
    );
    expect(b).not.toBeNull();
    expect(b && bucketKey(b)).toBe('source:open-knowledge-skills\u0001inkeep');
  });

  test('a plugin-cache source buckets as its plugin, so a copy rejoins the originals', () => {
    const b = bucketForSkill(
      skill({
        source: '/Users/x/.claude/plugins/cache/ponytail/ponytail/4.8.4/skills/ponytail-audit',
        importedAt: '2026-08-13T00:00:00.000Z',
      }),
    );
    expect(b).toEqual({ kind: 'plugin', id: 'ponytail', publisher: null, url: null });
  });

  test('a cache copy with a server-resolved marketplaceUrl carries a verified parent owner', () => {
    const b = bucketForSkill(
      skill({
        source: '/Users/x/.claude/plugins/cache/inkeep-team-skills/applied-ai/1.0.0/skills/codie',
        marketplaceUrl: 'https://github.com/inkeep/team-skills',
        importedAt: 'now',
      }),
    );
    expect(b?.parent).toEqual({
      id: 'inkeep-team-skills',
      publisher: 'inkeep',
      url: 'https://github.com/inkeep/team-skills',
      marketplace: true,
    });
  });

  test('a detected plugin carries the marketplace repo the registry recorded', () => {
    const d = detected('ponytail');
    const withRepo = {
      ...d,
      provenance: { ...d.provenance, repositoryUrl: 'https://github.com/DietrichGebert/ponytail' },
    };
    expect(bucketForDetected(withRepo)?.url).toBe('https://github.com/DietrichGebert/ponytail');
  });

  test('a marketplace plugin path buckets the same way', () => {
    const b = bucketForSkill(
      skill({ source: '/home/x/.claude/plugins/marketplaces/eng/x', importedAt: 'now' }),
    );
    expect(b).toEqual({ kind: 'plugin', id: 'eng', publisher: null, url: null });
  });

  test('an adopt: source groups by harness and has no publisher', () => {
    const b = bucketForSkill(skill({ source: 'adopt:cursor', importedAt: 'now' }));
    expect(b).toEqual({ kind: 'source', id: 'cursor', publisher: null, url: null });
  });

  test('a self-hosted git URL still buckets, with no publisher to avatar', () => {
    const b = bucketForSkill(
      skill({ source: 'https://git.corp.internal/tools.git', importedAt: 'now' }),
    );
    expect(b?.kind).toBe('source');
    expect(b?.id).toBe('tools');
    expect(b?.publisher).toBeNull();
  });

  test('a recorded publisher wins over one derived from the source', () => {
    const b = bucketForSkill(
      skill({
        source: 'inkeep/open-knowledge-skills',
        publisher: 'openknowledge',
        importedAt: 'now',
      }),
    );
    expect(b?.publisher).toBe('openknowledge');
  });
});

describe('bucketForDetected', () => {
  test('a Claude plugin resident buckets as its plugin', () => {
    expect(bucketForDetected(detected('eng'))).toEqual({
      kind: 'plugin',
      id: 'eng',
      publisher: null,
      url: null,
    });
  });

  test('off Claude there is no plugin provenance, so nothing groups', () => {
    expect(bucketForDetected(detected())).toBeNull();
  });
});

describe('bucketForSkill — plugin identity', () => {
  test('a skill that IS a plugin skill groups under the plugin, like its cache residents', () => {
    const bucket = bucketForSkill({
      scope: 'project',
      name: 'linux-vm',
      path: '.agents/skills/linux-vm/SKILL.md',
      installed: true,
      hosts: ['agents'],
      plugin: { name: 'ok', marketplace: 'inkeep-agents-private', provider: 'claude' },
    } as never);
    expect(bucket).toEqual({ kind: 'plugin', id: 'ok', publisher: null, url: null });
  });

  test('identity beats origin when both are present', () => {
    const bucket = bucketForSkill({
      scope: 'project',
      name: 'x',
      path: '.agents/skills/x/SKILL.md',
      installed: true,
      hosts: [],
      plugin: { name: 'ok', marketplace: 'm', provider: 'claude' },
      origin: { source: 'someone/repo', importedAt: '2026-01-01T00:00:00.000Z' },
    } as never);
    expect(bucket?.kind).toBe('plugin');
    expect(bucket?.id).toBe('ok');
  });
});
