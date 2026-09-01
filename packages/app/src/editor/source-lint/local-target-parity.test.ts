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

    const [sourceDiag] = mapLocalTargetDiagnostics(stateOf(doc), [
      serverFinding(
        doc,
        '[the report]',
        `Link target "${href}" does not resolve to an existing file.`,
      ),
    ]);
    expect(sourceDiag).toBeDefined();
    expect(sourceDiag?.markClass).toBe('cm-lint-local-target');

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
    expect(mapLocalTargetDiagnostics(stateOf(doc), [])).toHaveLength(0);
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
