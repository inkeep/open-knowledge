/**
 * The context-chip rule, which has been wrong in both directions: a seeded
 * conflict instruction made every visited doc attach itself, and suppressing
 * that dropped even the file the instruction names.
 */

import { describe, expect, test } from 'vitest';
import { nextTouchedFiles } from './composer-touched-files';

const NONE: ReadonlySet<string> = new Set();

describe('nextTouchedFiles — user is composing', () => {
  test('accumulates each doc visited mid-draft', () => {
    let files = nextTouchedFiles([], 'notes/roadmap.md', NONE, false);
    files = nextTouchedFiles(files, 'notes/doc2.md', NONE, false);
    expect(files).toEqual(['notes/roadmap.md', 'notes/doc2.md']);
  });

  test('never re-adds a dismissed path', () => {
    const dismissed = new Set(['notes/roadmap.md']);
    expect(nextTouchedFiles([], 'notes/roadmap.md', dismissed, false)).toEqual([]);
  });

  test('collapses an extension variant of the same stem', () => {
    const files = nextTouchedFiles(['notes/roadmap.md'], 'notes/roadmap.mdx', NONE, false);
    expect(files).toEqual(['notes/roadmap.mdx']);
  });
});

describe('nextTouchedFiles — untouched seed', () => {
  test('carries the active doc, so the named file is attached', () => {
    expect(nextTouchedFiles([], 'notes/roadmap.md', NONE, true)).toEqual(['notes/roadmap.md']);
  });

  test('REPLACES on switch rather than accumulating', () => {
    // Clicking through conflicted docs attached all of them: a seeded draft is
    // non-empty, which the composer read as the user gathering context.
    let files = nextTouchedFiles([], 'notes/roadmap.md', NONE, true);
    files = nextTouchedFiles(files, 'notes/doc2.md', NONE, true);
    files = nextTouchedFiles(files, 'notes/doc3.md', NONE, true);
    expect(files).toEqual(['notes/doc3.md']);
  });

  test('still honours a dismissed path', () => {
    const dismissed = new Set(['notes/roadmap.md']);
    expect(nextTouchedFiles([], 'notes/roadmap.md', dismissed, true)).toEqual([]);
  });

  test('is referentially stable when already correct', () => {
    // The effect runs on every render; a fresh array each time would loop.
    const prev = ['notes/roadmap.md'];
    expect(nextTouchedFiles(prev, 'notes/roadmap.md', NONE, true)).toBe(prev);
  });

  test('editing the seed resumes accumulation from what is showing', () => {
    const seeded = nextTouchedFiles([], 'notes/roadmap.md', NONE, true);
    const afterEdit = nextTouchedFiles(seeded, 'notes/doc2.md', NONE, false);
    expect(afterEdit).toEqual(['notes/roadmap.md', 'notes/doc2.md']);
  });
});
