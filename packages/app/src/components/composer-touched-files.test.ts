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
    const prev = ['notes/roadmap.md'];
    expect(nextTouchedFiles(prev, 'notes/roadmap.md', NONE, true)).toBe(prev);
  });

  test('editing the seed resumes accumulation from what is showing', () => {
    const seeded = nextTouchedFiles([], 'notes/roadmap.md', NONE, true);
    const afterEdit = nextTouchedFiles(seeded, 'notes/doc2.md', NONE, false);
    expect(afterEdit).toEqual(['notes/roadmap.md', 'notes/doc2.md']);
  });
});
