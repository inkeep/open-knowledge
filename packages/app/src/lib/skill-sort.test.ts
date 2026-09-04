import type { SkillScope } from '@inkeep/open-knowledge-core';
import type { FileTreeSortEntry } from '@pierre/trees';
import { describe, expect, test } from 'vitest';
import { createSkillSortComparator, SKILL_MD_PATH } from '@/lib/skill-sort';

const labelToScope: ReadonlyMap<string, SkillScope> = new Map([
  ['Project', 'project'],
  ['Global', 'global'],
]);

function entry(path: string): FileTreeSortEntry {
  const isDirectory = path.endsWith('/');
  const segments = (isDirectory ? path.slice(0, -1) : path).split('/');
  return {
    basename: segments[segments.length - 1] ?? '',
    depth: segments.length,
    isDirectory,
    path,
    segments,
  };
}

function sortPaths(
  paths: string[],
  detected: ReadonlySet<string> = new Set(),
  skills: ReadonlySet<string> = new Set(),
  groups: ReadonlySet<string> = new Set(),
  pinned: ReadonlySet<string> = new Set(),
): string[] {
  const cmp = createSkillSortComparator(labelToScope, detected, groups, skills, pinned);
  return [...paths].sort((a, b) => cmp(entry(a), entry(b)));
}

describe('createSkillSortComparator', () => {
  test('scope headers order project above global (not alphabetically)', () => {
    expect(sortPaths(['Global/', 'Project/'])).toEqual(['Project/', 'Global/']);
    expect(sortPaths(['Project/', 'Global/'])).toEqual(['Project/', 'Global/']);
  });

  test('every project entry sorts before every global entry across MIXED depths (the live bug)', () => {
    const paths = [
      'Global/',
      'Global/build/',
      `Global/build/${SKILL_MD_PATH}`,
      'Project/',
      'Project/open-knowledge/',
      `Project/open-knowledge/${SKILL_MD_PATH}`,
    ];
    const sorted = sortPaths(paths);
    const lastProject = sorted.reduce((acc, p, i) => (p.startsWith('Project/') ? i : acc), -1);
    const firstGlobal = sorted.findIndex((p) => p.startsWith('Global/'));
    expect(lastProject).toBeGreaterThanOrEqual(0);
    expect(firstGlobal).toBeGreaterThan(lastProject);
  });

  test('within a scope, managed skills sort above detected ones', () => {
    const detected = new Set(['Project/alpha']);
    expect(
      sortPaths(['Project/alpha/', 'Project/zeta/'], detected, new Set(['Project/zeta'])),
    ).toEqual(['Project/zeta/', 'Project/alpha/']);
  });

  test('authored skills lead their scope, ahead of anything grouped', () => {
    const groups = new Set(['Global/anthropics-skills']);
    const skills = new Set([
      'Global/alpha',
      'Global/zeta',
      'Global/anthropics-skills/deep-research',
    ]);
    const sorted = sortPaths(
      [
        `Global/alpha/${SKILL_MD_PATH}`,
        `Global/zeta/${SKILL_MD_PATH}`,
        `Global/anthropics-skills/deep-research/${SKILL_MD_PATH}`,
      ],
      new Set(),
      skills,
      groups,
    );
    expect(sorted[0]).toBe(`Global/alpha/${SKILL_MD_PATH}`);
    expect(sorted[sorted.length - 1]).toBe(
      `Global/anthropics-skills/deep-research/${SKILL_MD_PATH}`,
    );
  });

  test('within a scope, same-managed-status skills sort alphabetically (numeric)', () => {
    const skills = new Set(['Project/skill-10', 'Project/skill-2']);
    expect(sortPaths(['Project/skill-10/', 'Project/skill-2/'], new Set(), skills)).toEqual([
      'Project/skill-2/',
      'Project/skill-10/',
    ]);
  });

  test('SKILL.md sorts first among a skill’s files', () => {
    const skills = new Set(['Project/foo']);
    expect(
      sortPaths([`Project/foo/${SKILL_MD_PATH}`, 'Project/foo/aaa.md'], new Set(), skills),
    ).toEqual([`Project/foo/${SKILL_MD_PATH}`, 'Project/foo/aaa.md']);
  });

  test('a SKILL.md nested deeper than the skill root does not jump its siblings', () => {
    const paths = ['Project/foo/sub/aaa.md', `Project/foo/sub/${SKILL_MD_PATH}`];
    expect(sortPaths(paths, new Set(), new Set(['Project/foo']))).toEqual([
      'Project/foo/sub/aaa.md',
      `Project/foo/sub/${SKILL_MD_PATH}`,
    ]);
  });

  test('the PINNED section leads its scope, ahead of authored skills', () => {
    const pinned = new Set(['Global/PINNED']);
    const skills = new Set(['Global/PINNED/ponytail', 'Global/mine', 'Global/eng/browser']);
    const groups = new Set(['Global/eng']);
    expect(
      sortPaths(
        [
          `Global/mine/${SKILL_MD_PATH}`,
          `Global/eng/browser/${SKILL_MD_PATH}`,
          `Global/PINNED/ponytail/${SKILL_MD_PATH}`,
        ],
        new Set(),
        skills,
        groups,
        pinned,
      ),
    ).toEqual([
      `Global/PINNED/ponytail/${SKILL_MD_PATH}`,
      `Global/mine/${SKILL_MD_PATH}`,
      `Global/eng/browser/${SKILL_MD_PATH}`,
    ]);
  });

  test('groups order alphabetically among themselves', () => {
    const groups = new Set(['Global/ponytail', 'Global/eng', 'Global/open-knowledge-skills']);
    const skills = new Set([
      'Global/ponytail/audit',
      'Global/eng/browser',
      'Global/open-knowledge-skills/discovery',
    ]);
    expect(
      sortPaths(
        [
          `Global/ponytail/audit/${SKILL_MD_PATH}`,
          `Global/open-knowledge-skills/discovery/${SKILL_MD_PATH}`,
          `Global/eng/browser/${SKILL_MD_PATH}`,
        ],
        new Set(),
        skills,
        groups,
      ),
    ).toEqual([
      `Global/eng/browser/${SKILL_MD_PATH}`,
      `Global/open-knowledge-skills/discovery/${SKILL_MD_PATH}`,
      `Global/ponytail/audit/${SKILL_MD_PATH}`,
    ]);
  });

  test('among non-SKILL.md siblings, a subdirectory sorts above a file', () => {
    expect(sortPaths(['Project/foo/aaa.md', 'Project/foo/refs/'])).toEqual([
      'Project/foo/refs/',
      'Project/foo/aaa.md',
    ]);
  });
});
