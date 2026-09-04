import { describe, expect, test } from 'vitest';
import { githubUrl, skillAutoUpdateEnabled, skillOriginUrl } from './use-skill-origin';

describe('githubUrl', () => {
  test('owner/repo shorthand resolves to the repo page', () => {
    expect(githubUrl('inkeep/agents')).toBe('https://github.com/inkeep/agents');
  });

  test('a subpath after owner/repo is dropped (links to the repo root)', () => {
    expect(githubUrl('inkeep/agents/packages/app')).toBe('https://github.com/inkeep/agents');
  });

  test('a trailing .git is stripped from shorthand', () => {
    expect(githubUrl('inkeep/agents.git')).toBe('https://github.com/inkeep/agents');
  });

  test('a github.com URL passes through, minus any .git suffix', () => {
    expect(githubUrl('https://github.com/inkeep/agents')).toBe('https://github.com/inkeep/agents');
    expect(githubUrl('https://github.com/inkeep/agents.git')).toBe(
      'https://github.com/inkeep/agents',
    );
  });

  test('a non-GitHub https URL is not linked', () => {
    expect(githubUrl('https://gitlab.com/inkeep/agents')).toBeNull();
  });

  test('local / non-remote sources are not linked', () => {
    expect(githubUrl('./local/skill')).toBeNull();
    expect(githubUrl('/abs/path/skill')).toBeNull();
    expect(githubUrl('~/home/skill')).toBeNull();
    expect(githubUrl('file:///tmp/skill')).toBeNull();
    expect(githubUrl('git@github.com:inkeep/agents.git')).toBeNull();
  });
});

describe('skillOriginUrl', () => {
  test('links an edited plugin copy to its marketplace repository', () => {
    expect(
      skillOriginUrl(
        {
          source: '/Users/test/.claude/plugins/cache/acme/ponytail-audit/1.0.0',
          marketplaceUrl: 'https://github.com/acme/ponytail-plugin',
          importedAt: '2026-07-24T12:00:00.000Z',
        },
        'ponytail-audit',
      ),
    ).toBe('https://github.com/acme/ponytail-plugin');
  });

  test('builds the skills.sh page URL from the source repo, not a literal "skills"', () => {
    expect(
      skillOriginUrl(
        {
          source: 'inkeep/open-knowledge-skills',
          publisher: 'inkeep',
          skill: 'open-knowledge-discovery',
          importedAt: '2026-07-30T12:00:00.000Z',
        },
        'open-knowledge-discovery',
      ),
    ).toBe('https://www.skills.sh/inkeep/open-knowledge-skills/open-knowledge-discovery');
  });

  test('uses the /site/ shape for a website-catalog source', () => {
    expect(
      skillOriginUrl(
        {
          source: 'open.feishu.cn',
          publisher: 'open.feishu.cn',
          skill: 'lark-attendance',
          importedAt: '2026-07-30T12:00:00.000Z',
        },
        'lark-attendance',
      ),
    ).toBe('https://www.skills.sh/site/open.feishu.cn/lark-attendance');
  });

  test('falls back to the GitHub repo when the import recorded no publisher', () => {
    expect(
      skillOriginUrl(
        { source: 'acme/toolkit', importedAt: '2026-07-30T12:00:00.000Z' },
        'widget-audit',
      ),
    ).toBe('https://github.com/acme/toolkit');
  });
});

describe('skillAutoUpdateEnabled', () => {
  const origin = (source: string, autoUpdate?: boolean) => ({
    source,
    importedAt: '2026-07-29T12:00:00.000Z',
    ...(autoUpdate !== undefined ? { autoUpdate } : {}),
  });

  test('requires explicit opt-in for remote sources', () => {
    expect(skillAutoUpdateEnabled(origin('inkeep/open-knowledge-skills'))).toBe(false);
    expect(skillAutoUpdateEnabled(origin('https://github.com/inkeep/open-knowledge-skills'))).toBe(
      false,
    );
    expect(skillAutoUpdateEnabled(origin('git@github.com:inkeep/open-knowledge-skills.git'))).toBe(
      false,
    );
    expect(skillAutoUpdateEnabled(origin('inkeep/open-knowledge-skills', true))).toBe(true);
  });

  test('keeps local sources on by default and honors an explicit opt-out', () => {
    expect(skillAutoUpdateEnabled(origin('/Users/test/skills/local'))).toBe(true);
    expect(skillAutoUpdateEnabled(origin('./skills/local'))).toBe(true);
    expect(skillAutoUpdateEnabled(origin('file:///tmp/local'))).toBe(true);
    expect(skillAutoUpdateEnabled(origin('C:\\skills\\local'))).toBe(true);
    expect(skillAutoUpdateEnabled(origin('/Users/test/skills/local', false))).toBe(false);
  });
});
