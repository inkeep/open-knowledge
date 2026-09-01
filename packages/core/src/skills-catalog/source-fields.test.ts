import { describe, expect, test } from 'vitest';
import { parseSkillsShSource } from './acquire/fetch.ts';
import { ownerOf, parseSkillsShCatalogSource, skillsShSkillLinks } from './source-fields.ts';

describe('parseSkillsShCatalogSource', () => {
  test('distinguishes GitHub repositories from website publishers', () => {
    expect(parseSkillsShCatalogSource('anthropics/skills')).toEqual({
      kind: 'github',
      owner: 'anthropics',
      repo: 'skills',
    });
    expect(parseSkillsShCatalogSource('open.feishu.cn')).toEqual({
      kind: 'site',
      hostname: 'open.feishu.cn',
    });
  });

  test('rejects source shapes outside the observed skills.sh contract', () => {
    expect(parseSkillsShCatalogSource('owner/repo/extra')).toBeNull();
    expect(parseSkillsShCatalogSource('https://github.com/owner/repo')).toBeNull();
    expect(parseSkillsShCatalogSource('localhost')).toBeNull();
    expect(parseSkillsShCatalogSource('')).toBeNull();
  });
});

describe('skillsShSkillLinks', () => {
  test('preserves the actual repository in GitHub-backed skill routes', () => {
    expect(skillsShSkillLinks('larksuite/cli', 'lark-attendance')).toEqual({
      sourceKind: 'github',
      skillsUrl: 'https://www.skills.sh/larksuite/cli/lark-attendance',
      sourceUrl: 'https://github.com/larksuite/cli',
    });
  });

  test('uses the site route and publisher URL for website-backed skills', () => {
    expect(skillsShSkillLinks('open.feishu.cn', 'lark-attendance')).toEqual({
      sourceKind: 'site',
      skillsUrl: 'https://www.skills.sh/site/open.feishu.cn/lark-attendance',
      sourceUrl: 'https://open.feishu.cn',
    });
  });

  test('returns null instead of inventing links for unknown sources', () => {
    expect(skillsShSkillLinks('not a source', 'skill')).toBeNull();
    expect(skillsShSkillLinks('owner/repo', '')).toBeNull();
  });
});

describe('ownerOf', () => {
  test('preserves broad publisher extraction independently of strict routing', () => {
    expect(ownerOf('anthropics/skills')).toBe('anthropics');
    expect(ownerOf('open.feishu.cn')).toBeNull();
    expect(ownerOf('owner/repo/extra')).toBe('owner');
  });
});

describe('the skills.sh URL we render is one we can parse back', () => {
  test.each([
    ['larksuite/cli', 'lark-attendance'],
    ['anthropics/skills', 'design'],
  ])('round-trips %s', (source, skill) => {
    const { skillsUrl } = skillsShSkillLinks(source, skill);
    expect(parseSkillsShSource(skillsUrl)).toEqual({
      owner: source.split('/')[0],
      skill,
    });
  });

  test('site routes still resolve owner from the hostname segment', () => {
    const { skillsUrl } = skillsShSkillLinks('open.feishu.cn', 'lark-attendance');
    expect(parseSkillsShSource(skillsUrl)).toEqual({
      owner: 'open.feishu.cn',
      skill: 'lark-attendance',
    });
  });
});
