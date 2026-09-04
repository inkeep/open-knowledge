
import { cleanup } from '@testing-library/react';
import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from '../../src/editor/extensions/shared';

type TextInputHandler = (view: EditorView, from: number, to: number, text: string) => boolean;

function mountEditor(content: JSONContent): { editor: Editor; container: HTMLDivElement } {
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

function teardown(editor: Editor, container: HTMLDivElement): void {
  editor.destroy();
  container.remove();
}

function findNode(editor: Editor, typeName: string): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (!found && node.type.name === typeName) found = { pos, node };
    return !found;
  });
  return found;
}

function caretAfterFirstText(editor: Editor): number {
  let pos = -1;
  editor.state.doc.descendants((node, at) => {
    if (pos < 0 && node.isText) {
      pos = at + node.nodeSize;
      return false;
    }
    return pos < 0;
  });
  return pos;
}

function typeSpace(editor: Editor, at: number): boolean {
  return (
    editor.view.someProp('handleTextInput', (handler) =>
      (handler as TextInputHandler)(editor.view, at, at, ' '),
    ) ?? false
  );
}

describe('Markdown input rules at jsxComponent boundaries', () => {
  afterEach(() => cleanup());

  test('a list input rule fires inside a registered jsxComponent interior', () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'jsxComponent',
          attrs: { componentName: 'Callout', kind: 'element' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '-' }] }],
        },
      ],
    };
    const { editor, container } = mountEditor(content);
    try {
      const handled = typeSpace(editor, caretAfterFirstText(editor));
      expect(handled).toBe(true);

      const callout = findNode(editor, 'jsxComponent');
      expect(callout).not.toBeNull();
      let listInsideCallout = false;
      callout?.node.descendants((n) => {
        if (n.type.name === 'list') listInsideCallout = true;
        return !listInsideCallout;
      });
      expect(listInsideCallout).toBe(true);
    } finally {
      teardown(editor, container);
    }
  });

  test('the same list input rule does not restructure a rawMdxFallback raw box', () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'rawMdxFallback',
          attrs: { reason: 'unregistered-component' },
          content: [{ type: 'text', text: '-' }],
        },
      ],
    };
    const { editor, container } = mountEditor(content);
    try {
      typeSpace(editor, caretAfterFirstText(editor));

      expect(findNode(editor, 'list')).toBeNull();
      const raw = findNode(editor, 'rawMdxFallback');
      expect(raw).not.toBeNull();
      expect(raw?.node.textContent).toBe('-');
    } finally {
      teardown(editor, container);
    }
  });
});
