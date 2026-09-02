import { cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from '../../src/editor/extensions/shared';

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
      editor.view.focus();
      expect(() => editor.commands.scrollIntoView()).not.toThrow();
    } finally {
      editor.destroy();
      container.remove();
    }
  });
});
