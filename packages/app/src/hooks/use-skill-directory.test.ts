import type { SkillSearchResult, SkillsListEntry } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { findImportedSkill } from './use-skill-directory';

function result(over: Partial<SkillSearchResult> = {}): SkillSearchResult {
  return {
    id: 'r1',
    name: 'find-skills',
    description: null,
    source: 'vercel-labs/skills',
    publisher: 'vercel-labs',
    installs: 100,
    ...over,
  } as SkillSearchResult;
}

function entry(name: string, source: string | null, scope = 'project'): SkillsListEntry {
  return {
    name,
    scope,
    origin: source === null ? null : { source },
  } as unknown as SkillsListEntry;
}

describe('findImportedSkill', () => {
  test('matches the exact frontmatter name', () => {
    const hit = entry('find-skills', 'vercel-labs/skills');
    expect(findImportedSkill([hit], result())).toBe(hit);
  });

  test('matches the -imported collision rename', () => {
    const hit = entry('find-skills-imported', 'vercel-labs/skills');
    expect(findImportedSkill([hit], result())).toBe(hit);
  });

  test('matches a numbered -imported-N collision rename', () => {
    const hit = entry('find-skills-imported-2', 'vercel-labs/skills');
    expect(findImportedSkill([hit], result())).toBe(hit);
  });

  test('does not match the same name from a different source', () => {
    const other = entry('find-skills', 'someone-else/skills');
    expect(findImportedSkill([other], result())).toBeNull();
  });

  test('does not match a different skill from the same source', () => {
    const sibling = entry('agent-browser', 'vercel-labs/skills');
    expect(findImportedSkill([sibling], result())).toBeNull();
  });

  test('ignores an entry with no origin', () => {
    expect(findImportedSkill([entry('find-skills', null)], result())).toBeNull();
  });

  test('does not match an unrelated name sharing the prefix', () => {
    const decoy = entry('find-skills-extra', 'vercel-labs/skills');
    expect(findImportedSkill([decoy], result())).toBeNull();
  });

  test('returns null against an empty list', () => {
    expect(findImportedSkill([], result())).toBeNull();
  });
});
