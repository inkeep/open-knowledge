import { describe, expect, test } from 'bun:test';
import ignore from 'ignore';
import { buildOkignorePatternFromTarget } from './file-tree-okignore';

describe('buildOkignorePatternFromTarget — file leaves', () => {
  test('docName + .md extension produces an anchored pattern with the on-disk path', () => {
    expect(
      buildOkignorePatternFromTarget({ kind: 'file', path: 'drafts/foo', docExt: '.md' }),
    ).toBe('/drafts/foo.md');
  });

  test('docName + .mdx extension preserves the .mdx on-disk extension', () => {
    expect(
      buildOkignorePatternFromTarget({ kind: 'file', path: 'docs/page', docExt: '.mdx' }),
    ).toBe('/docs/page.mdx');
  });

  test('missing docExt defaults to .md', () => {
    expect(buildOkignorePatternFromTarget({ kind: 'file', path: 'notes/scratch' })).toBe(
      '/notes/scratch.md',
    );
  });

  test('root-level file produces a pattern at the project root', () => {
    expect(buildOkignorePatternFromTarget({ kind: 'file', path: 'README', docExt: '.md' })).toBe(
      '/README.md',
    );
  });

  test('deeply nested file path round-trips into the pattern', () => {
    expect(
      buildOkignorePatternFromTarget({
        kind: 'file',
        path: 'projects/2026/q2/plan',
        docExt: '.md',
      }),
    ).toBe('/projects/2026/q2/plan.md');
  });

  test('filename containing a dash and dots survives unchanged', () => {
    expect(
      buildOkignorePatternFromTarget({
        kind: 'file',
        path: 'my-folder/file.with.dots',
        docExt: '.md',
      }),
    ).toBe('/my-folder/file.with.dots.md');
  });
});

describe('buildOkignorePatternFromTarget — folders', () => {
  test('top-level folder produces an anchored folder pattern with trailing slash', () => {
    expect(buildOkignorePatternFromTarget({ kind: 'folder', path: 'drafts' })).toBe('/drafts/');
  });

  test('nested folder path includes all intermediate segments', () => {
    expect(buildOkignorePatternFromTarget({ kind: 'folder', path: 'a/b/c' })).toBe('/a/b/c/');
  });

  test('folder kind ignores docExt even if supplied (no extension on directories)', () => {
    expect(
      buildOkignorePatternFromTarget({
        kind: 'folder',
        path: 'logs',
        docExt: '.md',
      } as never),
    ).toBe('/logs/');
  });
});

describe('buildOkignorePatternFromTarget — invariants', () => {
  test('output always begins with a leading slash (anchored to project root)', () => {
    expect(
      buildOkignorePatternFromTarget({ kind: 'file', path: 'foo', docExt: '.md' }).startsWith('/'),
    ).toBe(true);
    expect(buildOkignorePatternFromTarget({ kind: 'folder', path: 'foo' }).startsWith('/')).toBe(
      true,
    );
  });

  test('folder output always ends with a trailing slash', () => {
    expect(buildOkignorePatternFromTarget({ kind: 'folder', path: 'foo' }).endsWith('/')).toBe(
      true,
    );
  });

  test('file output never has a trailing slash', () => {
    expect(
      buildOkignorePatternFromTarget({ kind: 'file', path: 'foo', docExt: '.md' }).endsWith('/'),
    ).toBe(false);
  });

  test('pure function — repeated calls return identical strings', () => {
    const target = {
      kind: 'file' as const,
      path: 'drafts/foo',
      docExt: '.md',
    };
    expect(buildOkignorePatternFromTarget(target)).toBe(buildOkignorePatternFromTarget(target));
  });
});

describe('buildOkignorePatternFromTarget — glob-metacharacter escaping', () => {

  test('filename with [bracket] segment is escaped so the literal file matches', () => {
    const pattern = buildOkignorePatternFromTarget({
      kind: 'file',
      path: 'notes/[draft]',
      docExt: '.md',
    });
    const ig = ignore().add(pattern);
    expect(ig.ignores('notes/[draft].md')).toBe(true);
    expect(ig.ignores('notes/a.md')).toBe(false);
    expect(ig.ignores('notes/d.md')).toBe(false);
  });

  test('folder name with [bracket] segment is escaped so the literal folder matches', () => {
    const pattern = buildOkignorePatternFromTarget({
      kind: 'folder',
      path: 'projects/[v2]',
    });
    const ig = ignore().add(pattern);
    expect(ig.ignores('projects/[v2]/foo.md')).toBe(true);
    expect(ig.ignores('projects/v/foo.md')).toBe(false);
    expect(ig.ignores('projects/2/foo.md')).toBe(false);
  });

  test('filename with literal asterisk is escaped to avoid matching unrelated files', () => {
    const pattern = buildOkignorePatternFromTarget({
      kind: 'file',
      path: 'foo*bar',
      docExt: '.md',
    });
    const ig = ignore().add(pattern);
    expect(ig.ignores('foo*bar.md')).toBe(true);
    expect(ig.ignores('fooXYZbar.md')).toBe(false);
  });

  test('filename with embedded backslash is escaped so the literal char matches', () => {
    const pattern = buildOkignorePatternFromTarget({
      kind: 'file',
      path: 'a\\b',
      docExt: '.md',
    });
    const ig = ignore().add(pattern);
    expect(ig.ignores('a\\b.md')).toBe(true);
  });

  test('plain filenames pass through unchanged (no spurious escaping)', () => {
    expect(
      buildOkignorePatternFromTarget({ kind: 'file', path: 'drafts/foo', docExt: '.md' }),
    ).toBe('/drafts/foo.md');
  });
});
