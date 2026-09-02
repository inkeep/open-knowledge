import { sharedExtensions as coreExtensions, MarkdownManager } from '@inkeep/open-knowledge-core';
import { cleanup } from '@testing-library/react';
import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from './shared';

const mdManager = new MarkdownManager({ extensions: coreExtensions });

const CALLOUT_SOURCE_RAW = '<Callout title="A">\n\nA body\n\n</Callout>';

function pristineCalloutDoc(): JSONContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'jsxComponent',
        attrs: {
          content: '',
          componentName: 'Callout',
          kind: 'element',
          attributes: [],
          sourceRaw: CALLOUT_SOURCE_RAW,
          sourceDirty: false,
          props: { title: 'A' },
        },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A body' }] }],
      },
    ],
  };
}

function mountEditor(content: JSONContent): { editor: Editor; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    content,
    extensions: sharedExtensions,
    editable: true,
  });
  return { editor, container };
}

function locateCalloutInterior(editor: Editor): { calloutPos: number; interiorTextPos: number } {
  let calloutPos = -1;
  let interiorTextPos = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'jsxComponent' && calloutPos === -1) {
      calloutPos = pos;
      return true;
    }
    if (calloutPos !== -1 && node.isText && interiorTextPos === -1) {
      interiorTextPos = pos + 1;
      return false;
    }
    return true;
  });
  if (calloutPos === -1 || interiorTextPos === -1) {
    throw new Error('Callout interior text not found');
  }
  return { calloutPos, interiorTextPos };
}

function calloutSourceDirty(editor: Editor): boolean {
  let dirty = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'jsxComponent') {
      dirty = Boolean(node.attrs.sourceDirty);
      return false;
    }
    return true;
  });
  return dirty;
}

describe('interior-content edit flips sourceDirty and re-derives serialization', () => {
  afterEach(() => {
    cleanup();
  });

  test('an in-place interior edit flips sourceDirty and the serializer re-derives fresh bytes', () => {
    const { editor, container } = mountEditor(pristineCalloutDoc());
    try {
      expect(calloutSourceDirty(editor)).toBe(false);

      const { interiorTextPos } = locateCalloutInterior(editor);
      editor.commands.insertContentAt(interiorTextPos, 'ZZZ');

      expect(calloutSourceDirty(editor)).toBe(true);

      const serialized = mdManager.serialize(editor.getJSON());
      expect(serialized).toContain('ZZZ');
      expect(serialized).not.toBe(CALLOUT_SOURCE_RAW);
    } finally {
      editor.destroy();
      container.remove();
    }
  });

  test('serialize stays on the verbatim-sourceRaw fast path when the interior is untouched', () => {
    const { editor, container } = mountEditor(pristineCalloutDoc());
    try {
      expect(calloutSourceDirty(editor)).toBe(false);
      const serialized = mdManager.serialize(editor.getJSON());
      expect(serialized.trim()).toBe(CALLOUT_SOURCE_RAW.trim());
    } finally {
      editor.destroy();
      container.remove();
    }
  });
});
