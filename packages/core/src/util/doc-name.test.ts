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
    'opencode.json',
    'config/opencode.json',
    '.ok/templates/daily-standup',
    'notes/.ok/templates/meeting',
  ])
    test(`hidden: ${JSON.stringify(name)}`, () => expect(isHiddenDocName(name)).toBe(true));
  for (const name of [
    'Characters/Spike Spiegel',
    'Music',
    'a/b/c',
    'note.with.dots',
    'opencode.jsonx',
    'opencode.json/notes',
    '.agents/skills/consolidate-notes/SKILL',
    '.claude/skills/consolidate-notes/references/deep-dive',
    '.codex/skills/consolidate-notes/scripts/run',
    '.ok/skills/stored-skill/SKILL',
  ])
    test(`visible: ${JSON.stringify(name)}`, () => expect(isHiddenDocName(name)).toBe(false));

  test('the skill carve-out admits bundle files without admitting the dot-dir itself', () => {
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
    '.agents/skills',
    '.agents/skills/consolidate-notes',
    'skills/a/SKILL',
    'notes/.agents/skills/a/SKILL',
    '__skill__/global/a',
    'Characters/Spike Spiegel',
  ])
    test(`not a bundle file: ${JSON.stringify(name)}`, () =>
      expect(isProjectSkillBundlePath(name)).toBe(false));
});
