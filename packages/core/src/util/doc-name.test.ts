import { describe, expect, test } from 'bun:test';
import {
  HIDDEN_CONFIG_BASENAMES,
  isHiddenDocName,
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
  ])
    test(`visible: ${JSON.stringify(name)}`, () => expect(isHiddenDocName(name)).toBe(false));

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
