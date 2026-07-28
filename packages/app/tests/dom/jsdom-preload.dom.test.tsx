/**
 * The Tier-3 jsdom environment must expose the CSSOM-View geometry surface
 * ProseMirror measures through, not only the subset jsdom implements.
 *
 * jsdom ships `getClientRects` / `getBoundingClientRect` on `Element` (both
 * returning zero geometry) but leaves both undefined on `Range`. ProseMirror
 * measures a text position through a `Range`, so every path reaching
 * `coordsAtPos` throws `TypeError: textRange(...).getClientRects is not a
 * function`. Tiptap's `focus()` reaches it from a `requestAnimationFrame`
 * callback guarded only by `editor.isDestroyed`, so whether the throw lands
 * depends on which wins the race — the frame callback or the test's
 * `editor.destroy()`. When the frame wins, the throw surfaces after the test
 * that scheduled it already resolved: an unhandled error that reds the run
 * while every test still reports as passing.
 */

// `cleanup` satisfies the Tier-3 filename contract (every `*.dom.test.tsx`
// must value-import from `@testing-library/react`). This suite constructs the
// Editor directly rather than rendering through RTL; `cleanup` runs in
// `afterEach` so any future RTL render is torn down between tests.
import { cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from '../../src/editor/extensions/shared';

/**
 * Measurement walks the live document, so the editor has to be attached rather
 * than constructed against a detached element.
 */
function mountEditor(): { editor: Editor; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: sharedExtensions,
    editable: true,
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] }],
    },
  });
  return { editor, container };
}

describe('jsdom preload backfills the geometry surface ProseMirror measures through', () => {
  afterEach(() => {
    cleanup();
  });

  test('Range answers geometry queries with the zero rects jsdom already gives Element', () => {
    const range = document.createRange();
    range.selectNodeContents(document.body);

    expect(Array.from(range.getClientRects())).toEqual([]);

    const rect = range.getBoundingClientRect();
    expect([rect.top, rect.left, rect.width, rect.height]).toEqual([0, 0, 0, 0]);
  });

  test('ProseMirror measures a document position instead of throwing', () => {
    const { editor, container } = mountEditor();
    try {
      expect(() => editor.view.coordsAtPos(1)).not.toThrow();
    } finally {
      editor.destroy();
      container.remove();
    }
  });

  test("Tiptap's deferred focus() scrolls to the selection instead of leaking an unhandled error", () => {
    const { editor, container } = mountEditor();
    try {
      // The body of `focus()`'s requestAnimationFrame callback, driven inline so
      // the pin does not race the frame the way production does. The order is
      // load-bearing: an unfocused view scrolls through a branch that never
      // measures, so dropping `view.focus()` makes this pass either way.
      editor.view.focus();
      expect(() => editor.commands.scrollIntoView()).not.toThrow();
    } finally {
      editor.destroy();
      container.remove();
    }
  });
});
