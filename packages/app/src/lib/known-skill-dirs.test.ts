import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { projectSkillBundleDirs } from '@/lib/known-skill-dirs';

describe('projectSkillBundleDirs', () => {
  const entry = (over: Partial<SkillsListEntry>): SkillsListEntry => ({
    scope: 'project',
    name: 'demo',
    path: '.claude/skills/demo/SKILL.md',
    installed: true,
    hosts: [],
    ...over,
  });

  test('takes the bundle DIR, not the SKILL.md file path', () => {
    expect(projectSkillBundleDirs([entry({})]).has('.claude/skills/demo')).toBe(true);
    expect(projectSkillBundleDirs([entry({})]).has('.claude/skills/demo/SKILL.md')).toBe(false);
  });

  test('excludes global-scope rows, which collide byte-for-byte with project doc names', () => {
    const dirs = projectSkillBundleDirs([
      entry({ scope: 'global', name: 'shared', path: '.agents/skills/shared/SKILL.md' }),
      entry({ scope: 'project', name: 'owned', path: '.agents/skills/owned/SKILL.md' }),
    ]);
    expect(dirs.has('.agents/skills/shared')).toBe(false);
    expect(dirs.has('.agents/skills/owned')).toBe(true);
  });

  test('excludes managed rows, whose path is projectDir-relative not contentDir-relative', () => {
    const dirs = projectSkillBundleDirs([
      entry({
        managed: true,
        name: 'open-knowledge',
        path: '.claude/skills/open-knowledge/SKILL.md',
      }),
    ]);
    expect(dirs.has('.claude/skills/open-knowledge')).toBe(false);
  });

  test('includes both the alias and the canonical location of a symlinked bundle', () => {
    const dirs = projectSkillBundleDirs([
      entry({
        name: 'linked',
        path: '.agents/skills/linked/SKILL.md',
        canonicalPath: 'plugins/ok/skills/linked/SKILL.md',
      }),
    ]);
    expect(dirs.has('.agents/skills/linked')).toBe(true);
    expect(dirs.has('plugins/ok/skills/linked')).toBe(true);
  });

  test('a path with no directory component contributes nothing', () => {
    expect(projectSkillBundleDirs([entry({ path: 'SKILL.md' })]).size).toBe(0);
  });
});
