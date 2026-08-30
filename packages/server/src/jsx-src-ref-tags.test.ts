import { JSX_SRC_REF_TAGS, normalizeDocRelativeAssetUrl } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  createJsxSrcAttrRe,
  readJsxSrcRefTagAt,
  resolveJsxSrcRefTarget,
} from './jsx-src-ref-tags.ts';

describe('readJsxSrcRefTagAt', () => {
  test('matches a registry tag whose first > is its own self-close', () => {
    const line = '<Mirror src="api-spec" anchor="x" />';
    const match = readJsxSrcRefTagAt(line, 0);
    expect(match?.spec.tagName).toBe('Mirror');
    expect(match?.matchLength).toBe(line.length);
  });

  test('rejects when the first > at-or-after idx is not a self-close', () => {
    // The probe must reject on the unmatched distant `>` without letting the
    // attribute window consume-and-backtrack across the line.
    expect(readJsxSrcRefTagAt('<Mirror src="a" > <Mirror src="b" />', 0)).toBeNull();
    expect(readJsxSrcRefTagAt('<Mirror src="a"', 0)).toBeNull();
  });
});

describe('createJsxSrcAttrRe', () => {
  test('attribute matcher requires whitespace before the attribute name', () => {
    const re = createJsxSrcAttrRe('src');
    expect(' src="a"'.match(re)).toEqual(['src="a"']);
    expect(' data-src="a"'.match(re)).toBeNull();
  });
});

describe('resolveJsxSrcRefTarget', () => {
  const mirror = JSX_SRC_REF_TAGS.find((tag) => tag.tagName === 'Mirror');
  const excalidraw = JSX_SRC_REF_TAGS.find((tag) => tag.tagName === 'Excalidraw');
  if (!mirror || !excalidraw) throw new Error('registry entries missing');

  test('bare-doc-name values resolve verbatim, without path arithmetic', () => {
    expect(resolveJsxSrcRefTarget(mirror, 'api-spec', 'notes/index')).toBe('api-spec');
    expect(resolveJsxSrcRefTarget(mirror, '', 'notes/index')).toBeNull();
  });

  test('bare-doc-name values are not scheme-filtered — renderer parity', () => {
    // The renderer hands a <Mirror src> straight to the live-doc provider
    // without scheme-testing it, so the resolver must not reject a
    // colon-bearing docName here. Callers that cannot track such a reference
    // (graph extractor, broken-link advisory) gate on isExternalHref
    // themselves.
    expect(resolveJsxSrcRefTarget(mirror, 'https://example.com/x', 'notes/index')).toBe(
      'https://example.com/x',
    );
    expect(resolveJsxSrcRefTarget(mirror, 'meeting:standup', 'notes/index')).toBe(
      'meeting:standup',
    );
  });

  test('doc-relative external-scheme values resolve to null', () => {
    for (const value of ['https://example.com/x', 'mailto:someone@example.com']) {
      expect(resolveJsxSrcRefTarget(excalidraw, value, 'notes/index')).toBeNull();
    }
    // A plain scheme-free path still resolves under both kinds.
    expect(resolveJsxSrcRefTarget(mirror, 'notes/board.excalidraw', 'notes/index')).toBe(
      'notes/board.excalidraw',
    );
    expect(resolveJsxSrcRefTarget(excalidraw, '/notes/board.excalidraw', 'notes/index')).toBe(
      'notes/board.excalidraw',
    );
  });

  test('doc-relative values resolve the way the renderer resolves them', () => {
    // Pinned to normalizeDocRelativeAssetUrl — the function the app's
    // render-prop normalization applies before the component sees `src`.
    for (const [value, sourceDocName] of [
      ['board.excalidraw', 'notes/index'],
      ['./board.excalidraw', 'notes/index'],
      ['../diagrams/board.excalidraw', 'notes/index'],
      ['/diagrams/board.excalidraw', 'notes/index'],
    ] as const) {
      expect(resolveJsxSrcRefTarget(excalidraw, value, sourceDocName)).toBe(
        normalizeDocRelativeAssetUrl(value, sourceDocName).slice(1),
      );
    }
  });

  test('unresolvable doc-relative values return null', () => {
    expect(resolveJsxSrcRefTarget(excalidraw, '', 'notes/index')).toBeNull();
    expect(
      resolveJsxSrcRefTarget(excalidraw, 'https://example.com/b.excalidraw', 'notes/index'),
    ).toBeNull();
    expect(resolveJsxSrcRefTarget(excalidraw, '../../escape.excalidraw', 'notes/index')).toBeNull();
    expect(resolveJsxSrcRefTarget(excalidraw, '/', 'notes/index')).toBeNull();
  });
});
