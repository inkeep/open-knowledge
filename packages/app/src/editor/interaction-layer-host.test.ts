import { describe, expect, it } from 'bun:test';
import type { Editor } from '@tiptap/core';
import { __hasInteractionLayerForTests, getInteractionLayer } from './interaction-layer-host';

// Minimal Editor stub — the host only touches `on('destroy', cb)` and the
// `interaction-layer.ts` factory (which duck-types `editorView`/`view`).
function makeFakeEditor(): {
  editor: Editor;
  fireDestroy: () => void;
} {
  const destroyHandlers: Array<() => void> = [];
  const editor = {
    editorView: undefined,
    view: undefined,
    on(event: string, handler: () => void) {
      if (event === 'destroy') destroyHandlers.push(handler);
      return this;
    },
    off() {
      return this;
    },
  } as unknown as Editor;
  return {
    editor,
    fireDestroy: () => {
      for (const h of destroyHandlers) h();
    },
  };
}

describe('interaction-layer-host', () => {
  describe('getInteractionLayer', () => {
    it('creates a handle on first call', () => {
      const { editor } = makeFakeEditor();
      expect(__hasInteractionLayerForTests(editor)).toBe(false);
      const handle = getInteractionLayer(editor);
      expect(handle).toBeTruthy();
      expect(__hasInteractionLayerForTests(editor)).toBe(true);
    });

    it('returns the same handle on subsequent calls (singleton per editor)', () => {
      const { editor } = makeFakeEditor();
      const h1 = getInteractionLayer(editor);
      const h2 = getInteractionLayer(editor);
      const h3 = getInteractionLayer(editor);
      expect(h1).toBe(h2);
      expect(h2).toBe(h3);
    });

    it('returns distinct handles for distinct editors', () => {
      const { editor: ea } = makeFakeEditor();
      const { editor: eb } = makeFakeEditor();
      const a = getInteractionLayer(ea);
      const b = getInteractionLayer(eb);
      expect(a).not.toBe(b);
    });

    it('removes the handle when the editor fires destroy', () => {
      const { editor, fireDestroy } = makeFakeEditor();
      const handle = getInteractionLayer(editor);
      expect(__hasInteractionLayerForTests(editor)).toBe(true);

      fireDestroy();

      expect(__hasInteractionLayerForTests(editor)).toBe(false);
      // The handle is still referenced by the test but its internal state
      // was torn down — we verify that setActiveNode is a no-op post-destroy.
      expect(() => handle.setActiveNode(null)).not.toThrow();
    });

    it('a fresh getInteractionLayer call after destroy creates a new handle', () => {
      const { editor, fireDestroy } = makeFakeEditor();
      const h1 = getInteractionLayer(editor);
      fireDestroy();
      const h2 = getInteractionLayer(editor);
      expect(h1).not.toBe(h2);
    });
  });
});
