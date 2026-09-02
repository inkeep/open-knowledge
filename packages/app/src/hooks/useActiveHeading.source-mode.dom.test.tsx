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

const MID_Y = window.innerHeight / 2;

function stubView(): EditorView {
  return {
    state: { doc: Text.of(SOURCE_LINES) },
    documentTop: window.innerHeight,
    scaleY: 1,
    lineBlockAt: (pos: number) => ({ from: pos, to: pos, top: pos, height: 20, bottom: pos + 20 }),
  } as unknown as EditorView;
}

const HEADING_LINES = [1, 5, 7];
const SCALE_Y = 2;
const BLOCK_HEIGHT = 800;

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
    registerSourceView(DOC_NAME, geometryStub(-2 * MID_Y, [-2 * MID_Y, -0.1 * MID_Y, 1.5 * MID_Y]));

    const { result } = renderHook(() =>
      useActiveHeading(SLUGS, { isSourceMode: true, docName: DOC_NAME }),
    );

    expect(result.current).toBe('beta');
  });

  test('prefers a heading in the viewport top half over one already scrolled past', () => {
    registerSourceView(DOC_NAME, geometryStub(-2 * MID_Y, [-2 * MID_Y, -0.1 * MID_Y, 0.5 * MID_Y]));

    const { result } = renderHook(() =>
      useActiveHeading(SLUGS, { isSourceMode: true, docName: DOC_NAME }),
    );

    expect(result.current).toBe('gamma');
  });

  test('resolves heading elements in WYSIWYG mode even while a source view is registered', () => {
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
    mountHeading('alpha', MID_Y - 10);
    mountHeading('beta', MID_Y + 600);

    const { result } = renderHook(() =>
      useActiveHeading(['alpha', 'beta'], { isSourceMode: false, docName: DOC_NAME }),
    );

    expect(result.current).toBe('alpha');
  });
});
