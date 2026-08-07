import { describe, expect, test } from 'vitest';
import {
  HIDDEN_CONFIG_BASENAMES,
  isHiddenDocName,
  isProjectSkillBundlePath,
  isValidDocName,
  validateDocName,
} from './doc-name.ts';

describe('isHiddenDocName', () => {
  for (const name of [
    '.cursor/skills/x',
    '.claude/foo',
    'a/.hidden/b',
    '.okignore',
    'a/.b',
    // Non-dotted agent config in HIDDEN_CONFIG_BASENAMES — hidden by basename,
    // at the root and nested.
    'opencode.json',
    'config/opencode.json',
    // Folder templates live under `.ok` with NO skill-style bundle carve-out, so
    // `isHiddenDocName` treats them like any hidden dot-path: a search rank
    // penalty plus exclusion from embeddings and egress, even though they are
    // content docs on disk. (It is deliberately NOT applied to listings /
    // backlinks / `[[` autocomplete, so templates still surface there.) Contrast
    // the skill-bundle carve-out in the visible list below.
    '.ok/templates/daily-standup',
    'notes/.ok/templates/meeting',
  ])
    test(`hidden: ${JSON.stringify(name)}`, () => expect(isHiddenDocName(name)).toBe(true));
  for (const name of [
    'Characters/Spike Spiegel',
    'Music',
    'a/b/c',
    'note.with.dots',
    // Basename match is exact — neither a near-miss extension nor an
    // `opencode.json` ancestor segment counts as hidden.
    'opencode.jsonx',
    'opencode.json/notes',
    // Skill bundle CONTENT is not hidden: the dot-dir is how a harness finds
    // the skill, so classifying it hidden cost skills their search rank,
    // embeddings, egress, and `[[` autocomplete entry.
    '.agents/skills/consolidate-notes/SKILL',
    '.claude/skills/consolidate-notes/references/deep-dive',
    '.codex/skills/consolidate-notes/scripts/run',
    '.ok/skills/stored-skill/SKILL',
  ])
    test(`visible: ${JSON.stringify(name)}`, () => expect(isHiddenDocName(name)).toBe(false));

  test('the skill carve-out admits bundle files without admitting the dot-dir itself', () => {
    // The bundle DIR row stays hidden (no tree row of its own); only files
    // INSIDE a bundle are carved out.
    expect(isHiddenDocName('.cursor/skills/x')).toBe(true);
    expect(isHiddenDocName('.cursor/skills/x/SKILL')).toBe(false);
  });

  test('HIDDEN_CONFIG_BASENAMES contains the seeded opencode.json agent config', () => {
    expect(HIDDEN_CONFIG_BASENAMES.has('opencode.json')).toBe(true);
  });
});

describe('validateDocName', () => {
  test('accepts ordinary extension-less docNames', () => {
    for (const name of ['notes/meeting', 'foo', 'a/b/c', 'releases/v1.0', 'my notes']) {
      expect(validateDocName(name).ok).toBe(true);
      expect(isValidDocName(name)).toBe(true);
    }
  });

  // Each of these previously
  // produced a 500, a junk/hidden file, or an unaddressable doc.
  const REJECTED: Array<[string, string]> = [
    ['', 'empty'],
    ['   ', 'whitespace only'],
    [' foo', 'leading whitespace'],
    ['foo ', 'trailing whitespace'],
    ['.', 'bare dot segment'],
    ['..', 'parent traversal'],
    ['../escape', 'escaping traversal'],
    ['a/', 'trailing slash'],
    ['/abs', 'leading slash'],
    ['a//b', 'doubled slash'],
    ['.foo', 'leading dot (hidden)'],
    ['notes/.bar', 'hidden nested segment'],
    ['x\ty', 'tab control char'],
    ['x\ny', 'newline control char'],
    ['back\\slash', 'backslash'],
  ];

  for (const [name, label] of REJECTED) {
    test(`rejects ${label}: ${JSON.stringify(name)}`, () => {
      const result = validateDocName(name);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
      expect(isValidDocName(name)).toBe(false);
    });
  }
});

describe('isProjectSkillBundlePath', () => {
  for (const name of [
    '.agents/skills/consolidate-notes/SKILL',
    '.claude/skills/a/references/b/c',
    '.codex/skills/a/scripts/run.sh',
    '.ok/skills/a/SKILL',
  ])
    test(`bundle file: ${JSON.stringify(name)}`, () =>
      expect(isProjectSkillBundlePath(name)).toBe(true));

  for (const name of [
    // The bundle dir and its ancestors are not bundle FILES.
    '.agents/skills',
    '.agents/skills/consolidate-notes',
    // `skills/` must sit directly under a single dot-segment root.
    'skills/a/SKILL',
    'notes/.agents/skills/a/SKILL',
    // A global skill keeps the synthetic managed-artifact namespace.
    '__skill__/global/a',
    'Characters/Spike Spiegel',
  ])
    test(`not a bundle file: ${JSON.stringify(name)}`, () =>
      expect(isProjectSkillBundlePath(name)).toBe(false));
});
