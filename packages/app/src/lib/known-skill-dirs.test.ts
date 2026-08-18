import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { projectSkillBundleDirs } from '@/lib/known-skill-dirs';

/**
 * The two filters here are the load-bearing ones, and neither is visible in the
 * shape of the output — a regression in either produces a set that still looks
 * plausible while classifying the wrong documents.
 */
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
    // `.agents/skills/shared/SKILL.md` is a real HOME-relative path for a global
    // skill AND a real contentDir-relative doc name for a project one. Nothing in
    // the string separates them, so `scope` is the only discriminator — without
    // it a global skill silently claims a project document, which is this bug
    // running in the opposite direction.
    const dirs = projectSkillBundleDirs([
      entry({ scope: 'global', name: 'shared', path: '.agents/skills/shared/SKILL.md' }),
      entry({ scope: 'project', name: 'owned', path: '.agents/skills/owned/SKILL.md' }),
    ]);
    expect(dirs.has('.agents/skills/shared')).toBe(false);
    expect(dirs.has('.agents/skills/owned')).toBe(true);
  });

  test('excludes managed rows, whose path is projectDir-relative not contentDir-relative', () => {
    // Under a configured `content.dir` the built-in row's base differs from every
    // other project row's, so its path is not a valid doc-name prefix. Built-ins
    // sit at dot-roots, where shape covers them anyway.
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
    // Both index as documents, so the surface must not depend on which one the
    // user reached.
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
