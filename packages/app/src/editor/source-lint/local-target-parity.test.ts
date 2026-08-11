/**
 * Cross-surface parity: the same authored local-link occurrence that produces a
 * source-mode CodeMirror diagnostic also produces the WYSIWYG unresolved chip
 * treatment, and neither surface relies on color alone (source: a lint range with
 * its own selector hook + wavy severity underline; WYSIWYG: the `unresolved`
 * resolution state, a wavy underline distinct from a resolved link's solid one).
 *
 * The two surfaces read different inputs — source reads the server's
 * authoritative assessment (a `source: 'links'` finding), WYSIWYG reads the
 * client page-list cache — so this pins that when both are told a target is
 * missing they agree, the cross-surface parity contract a composed fixture
 * exercises end-to-end.
 */

import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { toWikiLinkSlug, type ValidationDocResult } from '@inkeep/open-knowledge-core';
import { GFM } from '@lezer/markdown';
import { describe, expect, test } from 'vitest';
import { computeLinkResolutionState } from '../extensions/link-resolution';
import { buildPagesBySlugIndex, type PageListCacheSnapshot } from '../page-list-cache';
import { mapLocalTargetDiagnostics } from './local-target-diagnostics.ts';

type LinkFinding = ValidationDocResult['diagnostics'][number];

function stateOf(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] })],
  });
}

/** A page-list cache that knows the project but not the target — the WYSIWYG
 *  equivalent of the server assessing the target as missing. */
function cacheWithout(): PageListCacheSnapshot {
  const pages = new Set<string>(['README']);
  return {
    pages,
    folderPaths: new Set(),
    assetPaths: new Set(),
    filePaths: new Set(),
    pagesBySlug: buildPagesBySlugIndex(pages, toWikiLinkSlug),
  };
}

function serverFinding(doc: string, occurrence: string, message: string): LinkFinding {
  const column = doc.indexOf(occurrence);
  return {
    range: { start: { line: 0, character: column }, end: { line: 0, character: column } },
    severity: 'warning',
    source: 'links',
    code: 'dead-link',
    message,
  } as LinkFinding;
}

describe('source ⇄ WYSIWYG parity for an unresolved local link', () => {
  test('a missing file link is flagged in both editor modes', () => {
    const doc = 'See [the report](./missing.pdf) now.\n';
    const href = './missing.pdf';

    // Source mode: the server finding projects to one positioned lint diagnostic.
    const [sourceDiag] = mapLocalTargetDiagnostics(stateOf(doc), [
      serverFinding(
        doc,
        '[the report]',
        `Link target "${href}" does not resolve to an existing file.`,
      ),
    ]);
    expect(sourceDiag).toBeDefined();
    expect(sourceDiag?.markClass).toBe('cm-lint-local-target');

    // WYSIWYG: the chip resolves to `unresolved` (wavy, non-color-only).
    expect(computeLinkResolutionState(href, 'README', cacheWithout())).toBe('unresolved');
  });

  test('a missing document link is flagged in both editor modes', () => {
    const doc = 'See [the page](./gone.md) now.\n';
    const href = './gone.md';

    const [sourceDiag] = mapLocalTargetDiagnostics(stateOf(doc), [
      serverFinding(
        doc,
        '[the page]',
        `Link target "gone" does not resolve to an existing document.`,
      ),
    ]);
    expect(sourceDiag).toBeDefined();

    expect(computeLinkResolutionState(href, 'README', cacheWithout())).toBe('unresolved');
  });

  test('a resolved link is flagged in neither editor mode', () => {
    const doc = 'See [the page](./OTHER.md) now.\n';
    // No server finding for a resolved target → no source diagnostic.
    expect(mapLocalTargetDiagnostics(stateOf(doc), [])).toHaveLength(0);
    // Cache that knows the target → WYSIWYG resolves it.
    const pages = new Set(['README', 'OTHER']);
    const cache: PageListCacheSnapshot = {
      pages,
      folderPaths: new Set(),
      assetPaths: new Set(),
      filePaths: new Set(),
      pagesBySlug: buildPagesBySlugIndex(pages, toWikiLinkSlug),
    };
    expect(computeLinkResolutionState('./OTHER.md', 'README', cache)).toBe('resolved');
  });
});
