import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { enumeratePackSkills } from './skill-pack-sources.ts';

// Enumerate the SOURCE assets directly. `listPackSkillSources` / `findPackSkillSource`
// probe a co-installed OK Desktop bundle and the built `dist/` tree first, so a test
// that went through them would assert about whatever build happens to be on the
// machine. The pure enumerator over the git-tracked assets is the real contract.
const PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'skills', 'packs');

describe('enumeratePackSkills', () => {
  test('a flat pack ships exactly one skill, named by its frontmatter', () => {
    const skills = enumeratePackSkills(join(PACKS_DIR, 'plain-notes'));
    expect(skills.map((s) => s.name)).toEqual(['note-taking']);
    expect(skills[0]?.excludePaths).toEqual(['README.md']);
  });

  test('a decomposed pack ships its root skill first, then one skill per member dir', () => {
    const skills = enumeratePackSkills(join(PACKS_DIR, 'software-lifecycle'));
    expect(skills.map((s) => s.name)).toEqual([
      'software-lifecycle',
      'frame-a-proposal',
      'record-a-decision',
      'review-a-design',
      'write-a-postmortem',
      'write-a-spec',
    ]);
  });

  test('the root skill excludes its member dirs; members exclude nothing', () => {
    const [root, ...members] = enumeratePackSkills(join(PACKS_DIR, 'knowledge-base'));
    expect(root?.excludePaths).toEqual(['consolidate', 'research', 'README.md']);
    expect(members.map((m) => m.excludePaths)).toEqual([[], []]);
    // `references/` holds no SKILL.md, so it stays with the skill that owns it
    // rather than being mistaken for a member.
    expect(members.map((m) => m.name)).toEqual(['consolidate-notes', 'research-with-sources']);
  });

  test('a directory with no SKILL.md anywhere ships no skill', () => {
    expect(enumeratePackSkills(join(PACKS_DIR, 'does-not-exist'))).toEqual([]);
  });
});
