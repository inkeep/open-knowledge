/**
 * DOM-tier tests for `deriveEditorClipOptions` — the floating-ui clipping
 * config that keeps the selection bubble menu inside the editor's visible
 * content region (scroll container minus the toolbar band and the live
 * bottom-composer / conflict-footer overlays).
 *
 * DOM tier because the derivable resolves the `.editor-doc-scroll` ancestor
 * via `closest()` on a rendered tree and reads the overlay-height CSS vars
 * off the document root's inline style — both real-DOM behaviors.
 *
 * The load-bearing property is liveness: the options function is re-invoked
 * per `computePosition` pass and must reflect the overlay vars *at that
 * moment* (the composer card grows with its draft and collapses to nothing),
 * not a snapshot from when the menu mounted.
 *
 * Invocation: `bun run test:dom` from `packages/app/`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { TOOLBAR_HEIGHT } from '../extensions/frozen-table-headers';
import { deriveEditorClipOptions } from './bubble-menu-clip';

/** Renders the editor-DOM shape the derivable walks: a `.editor-doc-scroll`
 *  scroll container wrapping the ProseMirror mount the editor points at. */
function renderEditorInScroller(): { editor: Editor; scroller: HTMLElement } {
  const { container } = render(
    <div className="editor-doc-scroll">
      <div data-testid="pm-mount" />
    </div>,
  );
  const scroller = container.querySelector('.editor-doc-scroll') as HTMLElement;
  const dom = container.querySelector('[data-testid="pm-mount"]') as HTMLElement;
  return { editor: { view: { dom } } as unknown as Editor, scroller };
}

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--ask-composer-height');
  document.documentElement.style.removeProperty('--conflict-footer-height');
});

describe('deriveEditorClipOptions', () => {
  test('bounds to the editor scroll container with the toolbar band as top inset', () => {
    const { editor, scroller } = renderEditorInScroller();
    const options = deriveEditorClipOptions(editor)();
    expect(options.boundary).toBe(scroller);
    expect(options.padding).toEqual({ top: TOOLBAR_HEIGHT, bottom: 0 });
  });

  test('bottom inset tracks the published composer height', () => {
    const { editor } = renderEditorInScroller();
    document.documentElement.style.setProperty('--ask-composer-height', '236px');
    expect(deriveEditorClipOptions(editor)().padding.bottom).toBe(236);
  });

  test('conflict-footer overlay alone sets the bottom inset', () => {
    const { editor } = renderEditorInScroller();
    document.documentElement.style.setProperty('--conflict-footer-height', '48px');
    expect(deriveEditorClipOptions(editor)().padding.bottom).toBe(48);
  });

  test('composer and conflict-footer overlays stack into one bottom inset', () => {
    const { editor } = renderEditorInScroller();
    document.documentElement.style.setProperty('--ask-composer-height', '236px');
    document.documentElement.style.setProperty('--conflict-footer-height', '48px');
    expect(deriveEditorClipOptions(editor)().padding.bottom).toBe(284);
  });

  test('re-reads overlay heights on every invocation', () => {
    const { editor } = renderEditorInScroller();
    const derive = deriveEditorClipOptions(editor);
    expect(derive().padding.bottom).toBe(0);
    document.documentElement.style.setProperty('--ask-composer-height', '180px');
    expect(derive().padding.bottom).toBe(180);
    document.documentElement.style.removeProperty('--ask-composer-height');
    expect(derive().padding.bottom).toBe(0);
  });

  test('malformed overlay value reads as no inset', () => {
    const { editor } = renderEditorInScroller();
    document.documentElement.style.setProperty('--ask-composer-height', 'auto');
    expect(deriveEditorClipOptions(editor)().padding.bottom).toBe(0);
  });

  test('omits the boundary when no scroll container is resolvable', () => {
    const { container } = render(<div data-testid="pm-mount" />);
    const dom = container.querySelector('[data-testid="pm-mount"]') as HTMLElement;
    const editor = { view: { dom } } as unknown as Editor;
    const options = deriveEditorClipOptions(editor)();
    expect('boundary' in options).toBe(false);
    expect(options.padding.top).toBe(TOOLBAR_HEIGHT);
  });

  test('pre-mount editor (throwing view proxy) falls back to the default boundary', () => {
    const editor = {
      get view(): never {
        throw new Error('view not mounted');
      },
    } as unknown as Editor;
    const options = deriveEditorClipOptions(editor)();
    expect('boundary' in options).toBe(false);
    expect(options.padding.top).toBe(TOOLBAR_HEIGHT);
  });
});
