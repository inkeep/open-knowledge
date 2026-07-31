import type { SkillScope } from '@inkeep/open-knowledge-core';
import type { FileTreeSortEntry } from '@pierre/trees';
import { describe, expect, test } from 'vitest';
import { createSkillSortComparator, SKILL_MD_PATH } from '@/lib/skill-sort';

// Scope-header basename → scope, mirroring `labelToScope` in SkillsSidebarSection
// (built from the user-facing "Project"/"Global" labels).
const labelToScope: ReadonlyMap<string, SkillScope> = new Map([
  ['Project', 'project'],
  ['Global', 'global'],
]);

/** Build a `FileTreeSortEntry` from a tree path (trailing slash ⇒ directory). */
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

/** Sort a list of tree paths with the comparator and return them re-ordered. */
function sortPaths(paths: string[], detected: ReadonlySet<string> = new Set()): string[] {
  const cmp = createSkillSortComparator(labelToScope, detected);
  return [...paths].sort((a, b) => cmp(entry(a), entry(b)));
}

describe('createSkillSortComparator', () => {
  test('scope headers order project above global (not alphabetically)', () => {
    // Alphabetical would put Global first ("Global" < "Project"); the comparator must not.
    expect(sortPaths(['Global/', 'Project/'])).toEqual(['Project/', 'Global/']);
    expect(sortPaths(['Project/', 'Global/'])).toEqual(['Project/', 'Global/']);
  });

  test('every project entry sorts before every global entry across MIXED depths (the live bug)', () => {
    // Pierre feeds the comparator entries at mixed depths — a depth-1 scope header
    // vs a depth-3 skill file under the OTHER scope. The old depth-gated scope
    // check never fired for those pairs, so Global's SKILL.md pulled the whole
    // Global group above the Project header. Every Project/* must precede every
    // Global/* regardless of depth.
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
    // `zeta` is managed, `alpha` is detected — managed wins despite alpha < zeta alphabetically.
    const detected = new Set(['Project/alpha']);
    expect(sortPaths(['Project/alpha/', 'Project/zeta/'], detected)).toEqual([
      'Project/zeta/',
      'Project/alpha/',
    ]);
  });

  test('within a scope, same-managed-status skills sort alphabetically (numeric)', () => {
    expect(sortPaths(['Project/skill-10/', 'Project/skill-2/'])).toEqual([
      'Project/skill-2/',
      'Project/skill-10/',
    ]);
  });

  test('SKILL.md sorts first among a skill’s files (depth 3)', () => {
    // Alphabetically "SKILL.md" would sort after "aaa.md"; it must lead its siblings.
    expect(sortPaths([`Project/foo/${SKILL_MD_PATH}`, 'Project/foo/aaa.md'])).toEqual([
      `Project/foo/${SKILL_MD_PATH}`,
      'Project/foo/aaa.md',
    ]);
  });

  test('a SKILL.md nested deeper than the skill root does not jump its siblings', () => {
    // Depth-4 SKILL.md (inside a subfolder) has no first-sort privilege.
    const paths = ['Project/foo/sub/aaa.md', `Project/foo/sub/${SKILL_MD_PATH}`];
    // Falls through to alphabetical: "SKILL.md" > "aaa.md" (case-insensitive base).
    expect(sortPaths(paths)).toEqual([
      'Project/foo/sub/aaa.md',
      `Project/foo/sub/${SKILL_MD_PATH}`,
    ]);
  });

  test('among non-SKILL.md siblings, a subdirectory sorts above a file', () => {
    // Neither is SKILL.md, so the isDirectory branch decides: dir before file,
    // even though "refs" > "aaa.md" alphabetically.
    expect(sortPaths(['Project/foo/aaa.md', 'Project/foo/refs/'])).toEqual([
      'Project/foo/refs/',
      'Project/foo/aaa.md',
    ]);
  });
});
