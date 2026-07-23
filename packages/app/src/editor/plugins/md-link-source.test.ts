import { toWikiLinkSlug } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { buildPagesBySlugIndex, type PageListCacheSnapshot } from '../page-list-cache';
import { markdownSourceLinkClass } from './md-link-source';

function makeCache(opts: {
  pages?: Iterable<string>;
  folderPaths?: Iterable<string>;
  assetPaths?: Iterable<string>;
}): PageListCacheSnapshot {
  const pages = new Set(opts.pages ?? []);
  return {
    pages,
    folderPaths: new Set(opts.folderPaths ?? []),
    assetPaths: new Set(opts.assetPaths ?? []),
    pagesBySlug: buildPagesBySlugIndex(pages, toWikiLinkSlug),
  };
}

describe('markdownSourceLinkClass', () => {
  test('external URLs are not source-mode internal links', () => {
    expect(markdownSourceLinkClass('https://example.com', 'README', makeCache({}))).toBeNull();
    expect(markdownSourceLinkClass('//example.com/page', 'README', makeCache({}))).toBeNull();
  });

  test('cache-cold internal links keep the normal internal class', () => {
    expect(markdownSourceLinkClass('./missing.md', 'README', null)).toBe('cm-md-internal-link');
  });

  test('missing root-absolute docs use the broken class after cache warms', () => {
    expect(markdownSourceLinkClass('/not-existing', 'README', makeCache({ pages: [] }))).toBe(
      'cm-md-internal-link cm-md-link-broken',
    );
  });

  test('existing root-absolute docs keep the normal internal class', () => {
    expect(
      markdownSourceLinkClass('/docs/page.md', 'README', makeCache({ pages: ['docs/page'] })),
    ).toBe('cm-md-internal-link');
  });

  test('assets use the broken class only when absent from the asset index', () => {
    const cache = makeCache({ assetPaths: ['test/he.png'] });
    expect(markdownSourceLinkClass('./test/he.png', 'README', cache)).toBe('cm-md-internal-link');
    expect(markdownSourceLinkClass('./test/hegggg.png', 'README', cache)).toBe(
      'cm-md-internal-link cm-md-link-broken',
    );
    expect(markdownSourceLinkClass('/test/he.png', 'README', cache)).toBe('cm-md-internal-link');
  });
});
