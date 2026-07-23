import { describe, expect, test } from 'vitest';
import { buildLinkPathSuggestions, isSlashPathSuggestionValue } from './link-path-suggestions-core';

describe('isSlashPathSuggestionValue', () => {
  test('only treats a single leading slash as the path suggestion trigger', () => {
    expect(isSlashPathSuggestionValue('/')).toBe(true);
    expect(isSlashPathSuggestionValue('/guides')).toBe(true);
    expect(isSlashPathSuggestionValue('//example.com')).toBe(false);
    expect(isSlashPathSuggestionValue('guides')).toBe(false);
  });
});

describe('buildLinkPathSuggestions', () => {
  const pages = new Set(['docs/install', 'guides/bun', 'guides/intro', 'notes/api']);
  const folderPaths = new Set(['docs', 'guides', 'notes']);
  const assetPaths = new Set(['assets/logo.png', 'guides/demo.mov']);

  test('does not suggest paths until the value starts with a single slash', () => {
    expect(buildLinkPathSuggestions({ value: 'guides', pages, folderPaths })).toEqual([]);
    expect(buildLinkPathSuggestions({ value: 'https://example.com', pages, folderPaths })).toEqual(
      [],
    );
    expect(buildLinkPathSuggestions({ value: '//example.com', pages, folderPaths })).toEqual([]);
  });

  test('suggests matching existing page and folder paths after slash input', () => {
    expect(buildLinkPathSuggestions({ value: '/guides', pages, folderPaths })).toEqual([
      { kind: 'folder', path: 'guides' },
      { kind: 'page', path: 'guides/bun' },
      { kind: 'page', path: 'guides/intro' },
    ]);
  });

  test('normalizes markdown extensions in the slash query', () => {
    expect(buildLinkPathSuggestions({ value: '/docs/install.md', pages, folderPaths })).toEqual([
      { kind: 'page', path: 'docs/install' },
    ]);
  });

  test('can include existing asset paths for wiki-link targets', () => {
    expect(
      buildLinkPathSuggestions({
        value: '/logo',
        pages,
        folderPaths,
        assetPaths,
        includeAssets: true,
      }),
    ).toEqual([{ kind: 'asset', path: 'assets/logo.png' }]);
  });

  test('omits asset paths unless the caller opts in', () => {
    expect(
      buildLinkPathSuggestions({
        value: '/logo',
        pages,
        folderPaths,
        assetPaths,
      }),
    ).toEqual([]);
  });

  test('ranks basename substring matches before full-path-only substring matches', () => {
    expect(
      buildLinkPathSuggestions({
        value: '/api',
        pages: new Set(['guides/api/reference', 'notes/api']),
      }),
    ).toEqual([
      { kind: 'page', path: 'notes/api' },
      { kind: 'page', path: 'guides/api/reference' },
    ]);
  });
});
