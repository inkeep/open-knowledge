import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { enumeratePackSkills } from './skill-pack-sources.ts';

const PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'skills', 'packs');

describe('enumeratePackSkills', () => {
  test('a flat pack ships exactly one skill, named by its frontmatter', () => {
    const skills = enumeratePackSkills(join(PACKS_DIR, 'plain-notes'));
    expect(skills.map((s) => s.name)).toEqual(['note-taking']);
    expect(skills[0]?.excludePaths).toEqual(['README.md', 'plugin.json', 'skills']);
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
    expect(root?.excludePaths).toEqual([
      'consolidate',
      'research',
      'README.md',
      'plugin.json',
      'skills',
    ]);
    expect(members.map((m) => m.excludePaths)).toEqual([[], []]);
    expect(members.map((m) => m.name)).toEqual(['consolidate-notes', 'research-with-sources']);
  });

  test("members under the spec's skills/ location enumerate like legacy members", () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-pack-spec-shape-'));
    try {
      writeFileSync(join(dir, 'plugin.json'), '{"name":"demo"}');
      mkdirSync(join(dir, 'skills', 'member-a'), { recursive: true });
      writeFileSync(
        join(dir, 'skills', 'member-a', 'SKILL.md'),
        '---\nname: member-a\ndescription: d\n---\n',
      );
      const skills = enumeratePackSkills(dir);
      expect(skills.map((s) => s.name)).toEqual(['member-a']);
      expect(skills[0]?.excludePaths).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a directory with no SKILL.md anywhere ships no skill', () => {
    expect(enumeratePackSkills(join(PACKS_DIR, 'does-not-exist'))).toEqual([]);
  });
});
