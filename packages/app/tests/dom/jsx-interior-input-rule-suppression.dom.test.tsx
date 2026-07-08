/**
 * Markdown input-rule behavior at jsxComponent boundaries, on a real mounted
 * editor. Two facts are pinned:
 *
 *   1. A markdown shortcut ("- ") typed inside a REGISTERED jsxComponent's
 *      editable interior fires its input rule and forms a list — interiors are
 *      ordinary editable ProseMirror content.
 *
 *   2. The same input rule cannot restructure a rawMdxFallback raw-source box.
 *
 * The suppression in (2) has two independent guards. In the running editor the
 * box hosts a nested CodeMirror view whose NodeView swallows every DOM event,
 * so a keystroke typed there never reaches ProseMirror's input pipeline — that
 * capture depends on real focus and real key events and lives in the
 * browser-tier suite. This test pins the SECOND guard, which holds even if a
 * keystroke did reach the pipeline: a rawMdxFallback is `text*` content and
 * `listItem` requires a paragraph as its first child, so `findWrapping` refuses
 * to wrap the box. Injecting the rule directly at a raw-box caret is therefore
 * inert and the raw source survives verbatim.
 *
 * The two assertions pin a genuine difference — rule active in an interior,
 * inert in the box — not a constant: breaking the list input rule reddens (1);
 * making `listItem` accept a non-paragraph first child reddens (2).
 *
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup } from '@testing-library/react';
import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
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

/** Locate the first node of a given type, with its absolute position. */
function findNode(editor: Editor, typeName: string): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (!found && node.type.name === typeName) found = { pos, node };
    return !found;
  });
  return found;
}

/** Caret position immediately after the first text node in the document. */
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

/**
 * Fire ProseMirror's input-rule pipeline the way the view fires it on real text
 * input: it walks each plugin's `handleTextInput(view, from, to, text)` until one
 * returns truthy. Passing the callback to `someProp` reproduces that walk (a bare
 * `someProp('handleTextInput')` would stop at the first plugin's handler).
 */
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

      // A list formed, and it formed INSIDE the Callout interior (not at doc root).
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

      // No list was produced anywhere, and the raw box kept its source verbatim.
      expect(findNode(editor, 'list')).toBeNull();
      const raw = findNode(editor, 'rawMdxFallback');
      expect(raw).not.toBeNull();
      expect(raw?.node.textContent).toBe('-');
    } finally {
      teardown(editor, container);
    }
  });
});
