import { describe, expect, test } from 'vitest';
import {
  buildFolderRows,
  countMatchingDocs,
  coveredByAncestor,
  docCountsByFolder,
  folderOfGlob,
  folderRecursiveGlob,
  selectedFolders,
  toggleFolderGlob,
} from './applies-to-folder-globs';

describe('folderOfGlob', () => {
  test('recognizes both recursive spellings', () => {
    expect(folderOfGlob(folderRecursiveGlob('blog'))).toBe('blog');
    expect(folderOfGlob('blog/**')).toBe('blog');
    expect(folderOfGlob('blog/**/*')).toBe('blog');
    expect(folderOfGlob('  guides/api/** ')).toBe('guides/api');
  });

  test('rejects everything the picker should not claim', () => {
    expect(folderOfGlob('blog')).toBeNull(); // exact doc, not a folder
    expect(folderOfGlob('!blog/**')).toBeNull(); // negation
    expect(folderOfGlob('blog/*')).toBeNull(); // direct children only
    expect(folderOfGlob('**')).toBeNull(); // everything
    expect(folderOfGlob('**/blog/**')).toBeNull(); // folder-anywhere
    expect(folderOfGlob('{a,b}/**')).toBeNull(); // brace set
    expect(folderOfGlob('b*g/**')).toBeNull(); // glob chars in folder
    expect(folderOfGlob('')).toBeNull();
  });
});

describe('selectedFolders / toggleFolderGlob', () => {
  test('round-trips a checkbox toggle', () => {
    const on = toggleFolderGlob([], 'blog', true);
    expect(on).toEqual(['blog/**']);
    expect(selectedFolders(on)).toEqual(new Set(['blog']));
    expect(toggleFolderGlob(on, 'blog', false)).toEqual([]);
  });

  test('checking is a no-op when an equivalent spelling is authored', () => {
    expect(toggleFolderGlob(['blog/**/*'], 'blog', true)).toEqual(['blog/**/*']);
  });

  test('unchecking removes every spelling of that folder and nothing else', () => {
    const globs = ['blog/**', 'blog/**/*', '!blog/drafts/**', 'guides/**', 'notes'];
    expect(toggleFolderGlob(globs, 'blog', false)).toEqual([
      '!blog/drafts/**',
      'guides/**',
      'notes',
    ]);
  });

  test('hand-authored patterns pass through untouched', () => {
    const globs = ['**/reference/**', '!archive/**'];
    expect(selectedFolders(globs)).toEqual(new Set());
    expect(toggleFolderGlob(globs, 'docs', true)).toEqual([...globs, 'docs/**']);
  });
});

describe('coveredByAncestor', () => {
  test('any strict ancestor covers', () => {
    const selected = new Set(['guides']);
    expect(coveredByAncestor('guides/api', selected)).toBe(true);
    expect(coveredByAncestor('guides/api/v2', selected)).toBe(true);
    expect(coveredByAncestor('guides', selected)).toBe(false);
    expect(coveredByAncestor('guidebook', selected)).toBe(false);
    expect(coveredByAncestor('guides/api', new Set(['guide']))).toBe(false);
    expect(coveredByAncestor('blog', selected)).toBe(false);
  });
});

describe('buildFolderRows', () => {
  test('sorts siblings and nests depth-first', () => {
    expect(buildFolderRows(['zeta', 'alpha', 'alpha/inner'])).toEqual([
      { path: 'alpha' },
      { path: 'alpha/inner' },
      { path: 'zeta' },
    ]);
  });

  test('materializes missing ancestors and normalizes noise', () => {
    expect(buildFolderRows(['a/b/c', './a', 'a/', ''])).toEqual([
      { path: 'a' },
      { path: 'a/b' },
      { path: 'a/b/c' },
    ]);
  });
});

describe('docCountsByFolder', () => {
  test('counts each doc toward every ancestor', () => {
    const counts = docCountsByFolder(['blog/a', 'blog/nested/b', 'guides/c', 'root-doc']);
    expect(counts.get('blog')).toBe(2);
    expect(counts.get('blog/nested')).toBe(1);
    expect(counts.get('guides')).toBe(1);
    expect(counts.has('root-doc')).toBe(false);
  });
});

describe('countMatchingDocs', () => {
  test('reads 0 for the bare-folder-name trap and N for the fix', () => {
    const docs = ['blog/a', 'blog/nested/b', 'guides/c'];
    expect(countMatchingDocs('blog', docs)).toEqual({ matched: 0, total: 3 });
    expect(countMatchingDocs('blog/**', docs)).toEqual({ matched: 2, total: 3 });
  });

  test('empty pattern set matches every doc (implicit **)', () => {
    expect(countMatchingDocs(undefined, ['a', 'b'])).toEqual({ matched: 2, total: 2 });
    expect(countMatchingDocs([], ['a', 'b'])).toEqual({ matched: 2, total: 2 });
  });

  test('single-string appliesTo matches like a singleton array', () => {
    const docs = ['blog/a', 'guides/b'];
    expect(countMatchingDocs('blog/**', docs)).toEqual(countMatchingDocs(['blog/**'], docs));
  });

  test('negations subtract', () => {
    expect(countMatchingDocs(['blog/**', '!blog/nested/**'], ['blog/a', 'blog/nested/b'])).toEqual({
      matched: 1,
      total: 2,
    });
  });

  test('multiple folder patterns match their union, not their intersection', () => {
    // Exactly what picking two folders authors. Under intersection semantics
    // no doc can live in both folders, so matched would read 0.
    const docs = ['blog/a', 'blog/nested/b', 'guides/c', 'root-doc'];
    expect(countMatchingDocs(['blog/**', 'guides/**'], docs)).toEqual({ matched: 3, total: 4 });
  });
});
