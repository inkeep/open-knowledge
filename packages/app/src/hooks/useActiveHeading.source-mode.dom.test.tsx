/**
 * Source-mode guard and view-arrival channel for `useActiveHeading`.
 *
 * In source mode the hook measures a CodeMirror view it reads out of an ambient
 * module-level registry rather than receiving as an argument, so the view can
 * legitimately be absent — during a mode toggle, a document switch, or an
 * editor-pool eviction. Two things follow, and this file pins both: an absent
 * view must yield no answer rather than a wrong one, and a view that arrives
 * after render must be picked up rather than leaving the outline frozen at its
 * mount-time answer.
 *
 * Geometry is pinned here only where the assertion is arithmetic over numbers the
 * stub supplies — the resolver's own transform, and which branch of the priority
 * order wins for a given set of positions. What is NOT pinned here is where a
 * browser actually places content: jsdom performs no layout, so any assertion
 * that depended on real measurement would be a green over fabricated numbers.
 * That belongs to the browser tier, which stays the oracle for the end-to-end
 * question of which heading is active as a reader scrolls.
 */

import { Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  getSourceViewForDoc,
  registerSourceView,
  unregisterSourceView,
} from '../editor/active-source-view';
import { useActiveHeading } from './useActiveHeading';

const DOC_NAME = 'source-mode-guard-doc';
const SOURCE_LINES = ['# Alpha', '', 'Prose.', '', '## Beta', '', '## Gamma'];
const SLUGS = ['alpha', 'beta', 'gamma'];

/** jsdom's default viewport height; the predicate's "top half" is above the midpoint. */
const MID_Y = window.innerHeight / 2;

/**
 * A view carrying only the members the source resolver reads. `documentTop` sits
 * at the bottom edge of the viewport and every line block is at a non-negative
 * offset, so no heading resolves into the top half and none has scrolled past —
 * the reader is above the whole document.
 */
function stubView(): EditorView {
  return {
    state: { doc: Text.of(SOURCE_LINES) },
    documentTop: window.innerHeight,
    scaleY: 1,
    lineBlockAt: (pos: number) => ({ from: pos, to: pos, top: pos, height: 20, bottom: pos + 20 }),
  } as unknown as EditorView;
}

/** 1-based lines of `SOURCE_LINES` carrying `# Alpha`, `## Beta`, `## Gamma`. */
const HEADING_LINES = [1, 5, 7];
/**
 * Deliberately not 1. `documentTop` and `BlockInfo.top` are both already in scaled
 * screen space, so the resolver must combine them by plain addition; exposing a
 * non-unit `scaleY` means a resolver that multiplies by it answers differently and
 * gets caught here rather than only under a CSS transform in production.
 */
const SCALE_Y = 2;
/** Tall enough that reading `.bottom` instead of `.top` changes which heading wins. */
const BLOCK_HEIGHT = 800;

/**
 * A view whose geometry is fully controlled, so the resolver's arithmetic becomes
 * observable without layout. Callers state where each heading should land in
 * SCREEN space; the document-space tops are back-computed through the transform
 * CodeMirror itself uses (`documentTop + BlockInfo.top`, no scaling), so an
 * arithmetic change in the resolver moves the answer.
 */
function geometryStub(documentTop: number, screenTops: readonly number[]): EditorView {
  const doc = Text.of(SOURCE_LINES);
  const topByFrom = new Map<number, number>();
  HEADING_LINES.forEach((lineNo, i) => {
    topByFrom.set(doc.line(lineNo).from, screenTops[i] - documentTop);
  });

  return {
    state: { doc },
    documentTop,
    scaleY: SCALE_Y,
    lineBlockAt: (pos: number) => {
      const top = topByFrom.get(pos) ?? 0;
      return { from: pos, to: pos, top, height: BLOCK_HEIGHT, bottom: top + BLOCK_HEIGHT };
    },
  } as unknown as EditorView;
}

function mountHeading(slug: string, top: number): void {
  const el = document.createElement('h2');
  el.id = slug;
  el.textContent = slug;
  el.getBoundingClientRect = () => ({ top, height: 30, bottom: top + 30 }) as DOMRect;
  document.body.append(el);
}

afterEach(() => {
  cleanup();
  const registered = getSourceViewForDoc(DOC_NAME);
  if (registered) unregisterSourceView(DOC_NAME, registered);
  document.body.replaceChildren();
});

describe('useActiveHeading (source mode)', () => {
  test('reports no active heading while no view is registered for the document', () => {
    const { result } = renderHook(() =>
      useActiveHeading(SLUGS, { isSourceMode: true, docName: DOC_NAME }),
    );

    expect(result.current).toBeUndefined();
  });

  test('reports no active heading when no document name is supplied', () => {
    const { result } = renderHook(() => useActiveHeading(SLUGS, { isSourceMode: true }));

    expect(result.current).toBeUndefined();
  });

  test('reports no active heading for a document with no headings', () => {
    registerSourceView(DOC_NAME, stubView());

    const { result } = renderHook(() =>
      useActiveHeading([], { isSourceMode: true, docName: DOC_NAME }),
    );

    expect(result.current).toBeUndefined();
  });

  test('picks up a view registered after the hook rendered', async () => {
    const { result } = renderHook(() =>
      useActiveHeading(SLUGS, { isSourceMode: true, docName: DOC_NAME }),
    );
    expect(result.current).toBeUndefined();

    act(() => {
      registerSourceView(DOC_NAME, stubView());
    });

    await waitFor(() => {
      expect(result.current).toBe('alpha');
    });
  });

  test('measures a view that was already registered at render time', () => {
    registerSourceView(DOC_NAME, stubView());

    const { result } = renderHook(() =>
      useActiveHeading(SLUGS, { isSourceMode: true, docName: DOC_NAME }),
    );

    expect(result.current).toBe('alpha');
  });

  test('returns to no answer when the view unregisters', async () => {
    const view = stubView();
    registerSourceView(DOC_NAME, view);
    const { result } = renderHook(() =>
      useActiveHeading(SLUGS, { isSourceMode: true, docName: DOC_NAME }),
    );
    expect(result.current).toBe('alpha');

    act(() => {
      unregisterSourceView(DOC_NAME, view);
    });

    await waitFor(() => {
      expect(result.current).toBeUndefined();
    });
  });

  test('selects the last heading scrolled above the viewport when none is in the top half', () => {
    // Alpha and Beta are above the viewport, Gamma is below the midpoint, so the
    // scrolled-past branch decides and the answer is Beta rather than Gamma.
    //
    // This case is the unit-tier oracle for the resolver's arithmetic
    // (`documentTop + lineBlockAt(from).top`), which the browser tier otherwise
    // pins alone — and which is inert to error while `scaleY` is 1, so production
    // would not catch a scaling mistake. Each plausible regression lands on a
    // different heading: scaling either term by `scaleY` answers Alpha, reading
    // `.bottom` instead of `.top` answers Alpha, and flipping `documentTop`'s sign
    // puts every heading below the fold so the first-heading fallback answers Alpha.
    registerSourceView(DOC_NAME, geometryStub(-2 * MID_Y, [-2 * MID_Y, -0.1 * MID_Y, 1.5 * MID_Y]));

    const { result } = renderHook(() =>
      useActiveHeading(SLUGS, { isSourceMode: true, docName: DOC_NAME }),
    );

    expect(result.current).toBe('beta');
  });

  test('prefers a heading in the viewport top half over one already scrolled past', () => {
    // Same geometry except Gamma now sits inside the top half. Both modes share
    // one predicate, so this is the source-side twin of the WYSIWYG priority pin
    // in useActiveHeading.dom.test.tsx: top-half wins over scrolled-past.
    registerSourceView(DOC_NAME, geometryStub(-2 * MID_Y, [-2 * MID_Y, -0.1 * MID_Y, 0.5 * MID_Y]));

    const { result } = renderHook(() =>
      useActiveHeading(SLUGS, { isSourceMode: true, docName: DOC_NAME }),
    );

    expect(result.current).toBe('gamma');
  });

  test('resolves heading elements in WYSIWYG mode even while a source view is registered', () => {
    // Both editors are mounted at once, so a registered source view is the NORMAL
    // state in WYSIWYG mode, not an edge case. Mode therefore has to select the
    // resolver — a selection keyed on view presence alone would silently measure
    // CodeMirror line positions for the rich-text pane.
    //
    // The two resolvers are set up to disagree: the DOM places Alpha in the top
    // half, while the registered stub's geometry would answer Gamma. Asserting
    // Alpha is what makes this a real pin rather than a coincidence.
    registerSourceView(DOC_NAME, geometryStub(-2 * MID_Y, [-2 * MID_Y, -0.1 * MID_Y, 0.5 * MID_Y]));
    mountHeading('alpha', MID_Y - 10);
    mountHeading('beta', MID_Y + 600);
    mountHeading('gamma', MID_Y + 900);

    const { result } = renderHook(() =>
      useActiveHeading(SLUGS, { isSourceMode: false, docName: DOC_NAME }),
    );

    expect(result.current).toBe('alpha');
  });

  test('still resolves heading elements in WYSIWYG mode with an empty registry', () => {
    // The guard declines only where the answer is unobtainable. Widening it to
    // "no registered view" would kill the WYSIWYG path, which never consults
    // the registry at all.
    mountHeading('alpha', MID_Y - 10);
    mountHeading('beta', MID_Y + 600);

    const { result } = renderHook(() =>
      useActiveHeading(['alpha', 'beta'], { isSourceMode: false, docName: DOC_NAME }),
    );

    expect(result.current).toBe('alpha');
  });
});
