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

  test('matches a bare name query without requiring a leading slash', () => {
    expect(buildLinkPathSuggestions({ value: 'guides', pages, folderPaths })).toEqual([
      { kind: 'folder', path: 'guides' },
      { kind: 'page', path: 'guides/bun' },
      { kind: 'page', path: 'guides/intro' },
    ]);
    expect(buildLinkPathSuggestions({ value: 'install', pages, folderPaths })).toEqual([
      { kind: 'page', path: 'docs/install' },
    ]);
  });

  test('returns nothing for a bare query that matches no path', () => {
    expect(buildLinkPathSuggestions({ value: 'zzz-nope', pages, folderPaths })).toEqual([]);
    expect(buildLinkPathSuggestions({ value: 'https://example.com', pages, folderPaths })).toEqual(
      [],
    );
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
    const ranked = [
      { kind: 'page', path: 'notes/api' },
      { kind: 'page', path: 'guides/api/reference' },
    ];
    expect(
      buildLinkPathSuggestions({
        value: '/api',
        pages: new Set(['guides/api/reference', 'notes/api']),
      }),
    ).toEqual(ranked);
    expect(
      buildLinkPathSuggestions({
        value: 'api',
        pages: new Set(['guides/api/reference', 'notes/api']),
      }),
    ).toEqual(ranked);
  });

  test('browse ordering keeps content pages ahead of dot-directory files', () => {
    const mixed = new Set(['.github/ci', '.changeset/note', 'docs/install', 'guides/intro']);
    const browsed = buildLinkPathSuggestions({ value: '', pages: mixed }).map((s) => s.path);
    const firstDotIndex = browsed.findIndex((p) => p.split('/')[0]?.startsWith('.'));
    const lastNonDotIndex = browsed.reduce(
      (last, p, i) => (p.split('/')[0]?.startsWith('.') ? last : i),
      -1,
    );
    expect(lastNonDotIndex).toBeLessThan(firstDotIndex);
    expect(browsed.slice(0, 2)).toEqual(['docs/install', 'guides/intro']);
  });
});
