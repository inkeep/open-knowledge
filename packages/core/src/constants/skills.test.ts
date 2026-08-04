import { describe, expect, test } from 'vitest';
import { extractSkillRefs, isOpenKnowledgeSkillsSource, rewriteSkillRefs } from './skills.ts';

describe('rewriteSkillRefs', () => {
  test('rewrites both forms the extractor reads', () => {
    const body = 'Load /grill-me first.\nInline: `/grill-me`.\n(/grill-me) and [/grill-me]\n';
    expect(rewriteSkillRefs(body, 'grill-me', 'grilling')).toBe(
      'Load /grilling first.\nInline: `/grilling`.\n(/grilling) and [/grilling]\n',
    );
  });

  // The contract: rewrite exactly what draws an edge. Anything `extractSkillRefs`
  // ignores must survive a rename untouched, or a rename starts corrupting prose
  // and file paths that merely look like refs.
  test('leaves alone every occurrence that draws no edge', () => {
    const inert = [
      'A path /grill-me/steps.md keeps going.',
      'No boundary before x/grill-me.',
      'Hyphen run /grill-me-2 is a different slug.',
    ];
    for (const body of inert) {
      expect(extractSkillRefs(body)).not.toContain('grill-me');
      expect(rewriteSkillRefs(body, 'grill-me', 'grilling')).toBe(body);
    }
  });

  test('rewrites only the named skill, not its neighbours', () => {
    const body = 'Use /alpha then /beta then /alphabet.\n';
    expect(rewriteSkillRefs(body, 'alpha', 'omega')).toBe(
      'Use /omega then /beta then /alphabet.\n',
    );
  });

  test('handles adjacent refs and repeats', () => {
    expect(rewriteSkillRefs('/ab /ab (/ab) `/ab`', 'ab', 'cd')).toBe('/cd /cd (/cd) `/cd`');
    // A single character is below the grammar's minimum, so it is not a ref.
    expect(rewriteSkillRefs('/a /a', 'a', 'b')).toBe('/a /a');
  });

  test('no-ops when the name is unchanged, stop-listed, or absent', () => {
    expect(rewriteSkillRefs('Load /grill-me.', 'grill-me', 'grill-me')).toBe('Load /grill-me.');
    expect(rewriteSkillRefs('Files under /tmp.', 'tmp', 'temp')).toBe('Files under /tmp.');
    expect(rewriteSkillRefs('Nothing here.', 'grill-me', 'grilling')).toBe('Nothing here.');
  });

  test('a rewritten body extracts the new name and no longer the old', () => {
    const out = rewriteSkillRefs('See /grill-me and `/grill-me`.', 'grill-me', 'grilling');
    expect(extractSkillRefs(out)).toEqual(['grilling']);
  });
});

describe('isOpenKnowledgeSkillsSource', () => {
  // Decides two things: whether a present skill is ours (seed collision), and
  // whether an install counts toward our own skills.sh listing. The lock keeps
  // the raw source the user arrived through, so all of these are the same repo.
  test('matches the bare repo, a skills.sh listing URL, and a git URL', () => {
    for (const source of [
      'inkeep/open-knowledge-skills',
      'https://skills.sh/inkeep/open-knowledge-skills/note-taking',
      'https://github.com/inkeep/open-knowledge-skills.git',
      'git@github.com:inkeep/open-knowledge-skills.git',
    ]) {
      expect(isOpenKnowledgeSkillsSource(source)).toBe(true);
    }
  });

  // The privacy rule this predicate carves out of: a repo the user did not
  // choose from the marketplace is never announced to a third party.
  // The predicate gates two things: whether a present skill is OURS (so seed may
  // refresh it) and whether an install is announced to skills.sh. A loose match
  // therefore both clobbers and leaks, so the boundaries are load-bearing.
  test('a lookalike owner is not us', () => {
    // Valid `owner/repo` shape, contains our repo as a substring, is not ours.
    // A substring test would announce this third party's repo to skills.sh.
    expect(isOpenKnowledgeSkillsSource('notinkeep/open-knowledge-skills')).toBe(false);
    expect(isOpenKnowledgeSkillsSource('inkeep/open-knowledge-skills-fork')).toBe(false);
  });

  test("our repo path on somebody else's host is not us", () => {
    for (const source of [
      'https://evil.example/inkeep/open-knowledge-skills',
      'evil.example.com/inkeep/open-knowledge-skills',
      'https://evil.example/redirect?to=inkeep/open-knowledge-skills',
      'git@evil.example:inkeep/open-knowledge-skills.git',
    ]) {
      expect(isOpenKnowledgeSkillsSource(source)).toBe(false);
    }
  });

  test('does not match somebody else', () => {
    for (const source of [
      'someone-else/skills',
      'inkeep/agents',
      'https://skills.sh/anthropics/skills/code-review',
      'adopt:claude',
      '',
    ]) {
      expect(isOpenKnowledgeSkillsSource(source)).toBe(false);
    }
  });
});
