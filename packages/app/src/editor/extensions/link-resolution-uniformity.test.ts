/**
 * Editor-side half of link-classification uniformity.
 *
 * The server already computes a canonical classification for every authored
 * occurrence — `{targetKind, resolvedTarget, status, reason, resolutionMethod}`
 * — against the full inventory (documents AND files). The editor decoration is a
 * CONSUMER of that answer, so for any given occurrence its rendered state must
 * agree with what the server concluded. Where it re-derives existence from a
 * narrower view of the same inventory, it disagrees, and the user sees a blue
 * chip on a dead target or a redlink on a file that is right there on disk.
 *
 * The cross-plane server pin lives in
 * `packages/server/src/link-classification-uniformity.test.ts`. This file pins
 * the client half of the same invariant.
 *
 * Deliberately out of scope, because they are not classification disagreements:
 * external schemes (already uniformly `external` on every plane) and the wiki
 * escaped-pipe (`\|`) trailing-backslash defect, which every surface reports
 * identically and which is fixed separately.
 */

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

/**
 * The same fixture inventory the server-side uniformity pin uses, in the shape
 * `/api/documents` hands the client. `assets/NOTICE` is the load-bearing entry:
 * an EXISTING extensionless ordinary file.
 */
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

/** States that render as "this target is fine" rather than as a redlink. */
const RESOLVED_STATES = ['resolved', 'folder', 'asset', 'external', 'anchor'];

describe('editor resolution state agrees with the canonical server classification', () => {
  test('an existing extensionless ordinary file does not render as a dead link', () => {
    // The server proves `assets/NOTICE` exists (`targetKind: 'file'`,
    // `status: 'exact'`). The client classifies the extensionless href as a
    // DOCUMENT and then resolves it against `pages` + `folderPaths` only —
    // `filePaths` never enters the document branch — so the same occurrence the
    // server called an existing file renders unresolved and offers Create page.
    setLinkValidationVisible(true);
    const state = computeLinkResolutionState('assets/NOTICE', SOURCE_DOC, fixtureCache());
    expect(RESOLVED_STATES).toContain(state);
  });

  test('a wiki embed of a missing document carries a resolution state', () => {
    // `computeLinkResolutionAttrs` returns null for every `sourceForm:
    // 'wikiembed'` mark, so a document-shaped embed naming a target the server
    // reports as missing gets no decoration at all and renders resolved-blue.
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
    // The mirror of the case above: skipping every wiki embed also means an
    // embed pointing at a file the server tracks gets no state, so the editor
    // cannot distinguish it from the missing one.
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
    // Guard, not a RED assertion. The uniformity fix must not reach agreement by
    // making the editor optimistic about everything.
    setLinkValidationVisible(true);
    expect(computeLinkResolutionState('targets/missing-wiki', SOURCE_DOC, fixtureCache())).toBe(
      'unresolved',
    );
  });

  test('a wiki-link chip carries the resolution state its target deserves', () => {
    // Wiki-link chips are NODES, and the decoration plugin is registered for
    // `markTypes: ['link']`, so nothing ever reached them: a missing target
    // rendered in resolved-blue while Problems reported it missing and the
    // hover card offered Create page.
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
    // The hover card decides its Create-page affordance from
    // `resolveLinkTargetIntent(docName, {pages, folderPaths})`, which cannot see
    // tracked files. Left alone it offers Create page for `assets/NOTICE` while
    // the chip beside it renders resolved — the same occurrence, two verdicts,
    // one of them offering to create a document over a file that exists.
    //
    // `isResolvedAssetHref` is the shared predicate both surfaces consult; this
    // pins that it answers yes here, so the panel's guard short-circuits before
    // the doc-intent resolver ever runs.
    const cache = fixtureCache();
    expect(
      isResolvedAssetHref('assets/NOTICE', SOURCE_DOC, cache.assetPaths, cache.filePaths),
    ).toBe(true);
    setLinkValidationVisible(true);
    expect(RESOLVED_STATES).toContain(
      computeLinkResolutionState('assets/NOTICE', SOURCE_DOC, cache),
    );
  });

  test('control: a genuinely missing document still reaches the Create-page path', () => {
    // The guard must not swallow the affordance for a target that really is a
    // missing document — that is the row the matrix expects Create page on.
    const cache = fixtureCache();
    expect(
      isResolvedAssetHref('targets/missing-wiki', SOURCE_DOC, cache.assetPaths, cache.filePaths),
    ).toBe(false);
  });

  test('control: external schemes stay uniformly external', () => {
    // Guard, not a RED assertion. External handling is already uniform across
    // every plane and is explicitly out of scope for this fix.
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
