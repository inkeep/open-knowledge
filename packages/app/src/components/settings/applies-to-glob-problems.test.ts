/**
 * The parser reads strings composed by the server's `lint/frontmatter-schemas.ts`.
 * Every literal here is the shape that file emits — if these fail after a
 * server-side wording change, the settings panel has stopped attributing glob
 * findings to their globs and the two sides need re-syncing.
 */

import { describe, expect, test } from 'vitest';
import { indexGlobProblemsByFile, parseAppliesToGlobProblem } from './applies-to-glob-problems';

const UNMATCHED =
  'unmatched appliesTo glob "specs/**" — matches no docs in this project (frontmatter mapping for .ok/schemas/doc.schema.json)';
const SUSPICIOUS =
  'suspicious appliesTo glob "blog/" — a trailing slash can never match (doc paths have no trailing slash) (frontmatter mapping for .ok/schemas/blog.schema.json)';
const INVALID =
  'invalid appliesTo glob "[" — Unterminated character class (frontmatter mapping for schemas/local.schema.json)';

describe('parseAppliesToGlobProblem', () => {
  test('splits an unmatched problem into kind, pattern, detail, and file', () => {
    expect(parseAppliesToGlobProblem(UNMATCHED)).toEqual({
      kind: 'unmatched',
      pattern: 'specs/**',
      detail: 'matches no docs in this project',
      file: '.ok/schemas/doc.schema.json',
    });
  });

  test('keeps a detail that itself contains parentheses intact', () => {
    // The mapping suffix is matched from the right precisely so this detail
    // (the real trailing-slash wording) survives.
    expect(parseAppliesToGlobProblem(SUSPICIOUS)).toEqual({
      kind: 'suspicious',
      pattern: 'blog/',
      detail: 'a trailing slash can never match (doc paths have no trailing slash)',
      file: '.ok/schemas/blog.schema.json',
    });
  });

  test('parses the invalid kind', () => {
    expect(parseAppliesToGlobProblem(INVALID)?.kind).toBe('invalid');
    expect(parseAppliesToGlobProblem(INVALID)?.pattern).toBe('[');
  });

  test('unquotes a pattern carrying JSON escapes', () => {
    const problem =
      'unmatched appliesTo glob "a\\"b/**" — matches no docs in this project (frontmatter mapping for s.json)';
    expect(parseAppliesToGlobProblem(problem)?.pattern).toBe('a"b/**');
  });

  test('returns null for problems that are not glob findings', () => {
    for (const other of [
      'frontmatter schema .ok/schemas/doc.schema.json: cannot read (ENOENT)',
      '[.markdownlint.json] malformed markdownlint config',
      '',
    ]) {
      expect(parseAppliesToGlobProblem(other)).toBeNull();
    }
  });

  test('returns null on a recognized prefix with an unrecognized tail', () => {
    // Degrading to null keeps the finding in the flat list rather than
    // dropping it, so a server-side reword loses attribution, not the signal.
    for (const malformed of [
      'unmatched appliesTo glob specs/** — no quotes (frontmatter mapping for s.json)',
      'unmatched appliesTo glob "specs/**" — missing the mapping suffix',
      'unmatched appliesTo glob "specs/**" (frontmatter mapping for s.json)',
      'unmatched appliesTo glob "specs/**" — detail (frontmatter mapping for )',
    ]) {
      expect(parseAppliesToGlobProblem(malformed)).toBeNull();
    }
  });
});

describe('indexGlobProblemsByFile', () => {
  test('groups parseable problems by file then pattern, skipping the rest', () => {
    const index = indexGlobProblemsByFile([UNMATCHED, INVALID, 'unrelated problem']);
    expect([...index.keys()].sort()).toEqual([
      '.ok/schemas/doc.schema.json',
      'schemas/local.schema.json',
    ]);
    expect(index.get('.ok/schemas/doc.schema.json')?.get('specs/**')).toBe(
      'matches no docs in this project',
    );
  });

  test('joins several findings on one pattern so the tooltip reports all of them', () => {
    const index = indexGlobProblemsByFile([
      'suspicious appliesTo glob "blog/" — a trailing slash can never match (doc paths have no trailing slash) (frontmatter mapping for s.json)',
      'unmatched appliesTo glob "blog/" — matches no docs in this project (frontmatter mapping for s.json)',
    ]);
    expect(index.get('s.json')?.get('blog/')).toBe(
      'a trailing slash can never match (doc paths have no trailing slash); matches no docs in this project',
    );
  });

  test('is empty when nothing parses', () => {
    expect(indexGlobProblemsByFile(['[.markdownlint.json] malformed'])).toEqual(new Map());
  });
});
