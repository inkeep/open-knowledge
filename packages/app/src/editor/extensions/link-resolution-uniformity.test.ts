import { toWikiLinkSlug } from '@inkeep/open-knowledge-core';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  resetLinkValidationPolicyForTest,
  setLinkValidationVisible,
} from '../link-validation-policy';
import { buildPagesBySlugIndex, type PageListCacheSnapshot } from '../page-list-cache';
import {
  computeLinkResolutionAttrs,
  computeLinkResolutionState,
  isResolvedAssetHref,
} from './link-resolution';
import type { MarkInfo } from './mark-identity';
import { getWikiLinkResolutionState } from './wiki-link';

beforeEach(() => resetLinkValidationPolicyForTest());

const SOURCE_DOC = 'all-link-types';

function fixtureCache(): PageListCacheSnapshot {
  const pages = new Set(['all-link-types', 'targets/existing-page', 'targets/Case Sensitive']);
  return {
    pages,
    folderPaths: new Set(['targets', 'assets']),
    assetPaths: new Set(['assets/existing.txt', 'assets/manual.pdf']),
    filePaths: new Set(['assets/NOTICE']),
    pagesBySlug: buildPagesBySlugIndex(pages, toWikiLinkSlug),
  };
}

function makeMarkInfo(attrs: Record<string, unknown>, overrides?: Partial<MarkInfo>): MarkInfo {
  return { id: 'm1', markType: 'link', attrs, from: 0, to: 5, ...overrides };
}

const RESOLVED_STATES = ['resolved', 'folder', 'asset', 'external', 'anchor'];

describe('editor resolution state agrees with the canonical server classification', () => {
  test('an existing extensionless ordinary file does not render as a dead link', () => {
    setLinkValidationVisible(true);
    const state = computeLinkResolutionState('assets/NOTICE', SOURCE_DOC, fixtureCache());
    expect(RESOLVED_STATES).toContain(state);
  });

  test('a wiki embed of a missing document carries a resolution state', () => {
    setLinkValidationVisible(true);
    const attrs = computeLinkResolutionAttrs(
      makeMarkInfo({ href: 'targets/missing-embed', sourceForm: 'wikiembed' }),
      fixtureCache(),
      SOURCE_DOC,
    );
    expect(attrs).not.toBeNull();
    expect(attrs?.['data-resolution-state']).toBe('unresolved');
  });

  test('a wiki embed of an existing tracked file renders as an asset, not a dead link', () => {
    setLinkValidationVisible(true);
    const attrs = computeLinkResolutionAttrs(
      makeMarkInfo({ href: 'assets/manual.pdf', sourceForm: 'wikiembed' }),
      fixtureCache(),
      SOURCE_DOC,
    );
    expect(attrs).not.toBeNull();
    expect(RESOLVED_STATES).toContain(attrs?.['data-resolution-state']);
  });

  test('a full reference mark reaches the same decoration path as an inline link', () => {
    setLinkValidationVisible(true);
    const attrs = computeLinkResolutionAttrs(
      makeMarkInfo({
        href: 'targets/missing-reference',
        linkStyle: 'full',
        refLabel: 'missing-ref',
      }),
      fixtureCache(),
      SOURCE_DOC,
    );

    expect(attrs).toEqual({ 'data-resolution-state': 'unresolved' });
  });

  test('control: a missing document still renders unresolved', () => {
    setLinkValidationVisible(true);
    expect(computeLinkResolutionState('targets/missing-wiki', SOURCE_DOC, fixtureCache())).toBe(
      'unresolved',
    );
  });

  test('a wiki-link chip carries the resolution state its target deserves', () => {
    const cache = fixtureCache();
    expect(getWikiLinkResolutionState('targets/existing-page', null, cache)).toBe('resolved');
    expect(getWikiLinkResolutionState('targets/missing-wiki', null, cache)).toBe('unresolved');
    expect(getWikiLinkResolutionState('assets/manual.pdf', null, cache)).toBe('asset');
    expect(getWikiLinkResolutionState('https://inkeep.com', null, cache)).toBe('external');
  });

  test('a wiki-link asset stays optimistic when both file inventories are absent', () => {
    const cache = fixtureCache();
    const legacyCache: PageListCacheSnapshot = {
      pages: cache.pages,
      folderPaths: cache.folderPaths,
      pagesBySlug: cache.pagesBySlug,
    };

    expect(getWikiLinkResolutionState('assets/manual.pdf', null, legacyCache)).toBe('asset');
  });

  test('an extensionless wiki-link target remains a document target', () => {
    expect(getWikiLinkResolutionState('assets/NOTICE', null, fixtureCache())).toBe('unresolved');
  });

  test('the hover panel and the chip agree about an existing extensionless file', () => {
    const cache = fixtureCache();
    expect(
      isResolvedAssetHref('assets/NOTICE', SOURCE_DOC, cache.assetPaths, cache.filePaths, {
        literal: false,
      }),
    ).toBe(true);
    setLinkValidationVisible(true);
    expect(RESOLVED_STATES).toContain(
      computeLinkResolutionState('assets/NOTICE', SOURCE_DOC, cache),
    );
  });

  test('control: a genuinely missing document still reaches the Create-page path', () => {
    const cache = fixtureCache();
    expect(
      isResolvedAssetHref('targets/missing-wiki', SOURCE_DOC, cache.assetPaths, cache.filePaths, {
        literal: false,
      }),
    ).toBe(false);
  });

  test('control: external schemes stay uniformly external', () => {
    const cache = fixtureCache();
    for (const href of [
      'https://example.com/docs',
      'mailto:test@example.com',
      'tel:+15551234567',
      '//cdn.example.com/file.pdf',
    ]) {
      expect(computeLinkResolutionState(href, SOURCE_DOC, cache)).toBe('external');
    }
  });
});
