import { act, cleanup, render } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { JsxInline } from '../../src/editor/extensions/jsx-inline';

const KEYSTROKE_COUNT = 100;
const OBSERVED_HEALTHY_DELTA = 1;
const MAX_ITEM_DELTA = 20;

function totalStructs(doc: Y.Doc): number {
  let total = 0;
  for (const [, structs] of doc.store.clients) total += structs.length;
  return total;
}

function jsxInlineElement(doc: Y.Doc): Y.XmlElement | null {
  const paragraph = doc.getXmlFragment('default').get(0);
  if (!(paragraph instanceof Y.XmlElement)) return null;
  for (let i = 0; i < paragraph.length; i += 1) {
    const child = paragraph.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === 'jsxInline') return child;
  }
  return null;
}

function jsxInlineRange(editor: Editor): { pos: number; contentSize: number } {
  let pos = -1;
  let contentSize = 0;
  editor.state.doc.descendants((node, at) => {
    if (node.type.name !== 'jsxInline') return undefined;
    pos = at;
    contentSize = node.content.size;
    return false;
  });
  return { pos, contentSize };
}

function Host({ ydoc, onEditor }: { ydoc: Y.Doc; onEditor: (editor: Editor) => void }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false, undoRedo: false }),
      JsxInline.configure({ docName: 'jsx-inline-item-growth' }),
      Collaboration.configure({ document: ydoc }),
    ],
    editable: true,
    immediatelyRender: true,
  });
  const [portalTarget] = useState(() => document.createElement('div'));
  useEffect(() => {
    document.body.appendChild(portalTarget);
    return () => portalTarget.remove();
  }, [portalTarget]);
  if (editor) onEditor(editor);
  return createPortal(
    // oxlint-disable-next-line ok/no-unportaled-editor-content -- portalled per the H6 contract, with a per-render exclusive target owned by this harness
    <EditorContent editor={editor} />,
    portalTarget,
  );
}

function mountJsxInlineEditor(ydoc: Y.Doc): Editor {
  let captured: Editor | null = null;
  render(
    <Host
      ydoc={ydoc}
      onEditor={(editor) => {
        captured = editor;
      }}
    />,
  );
  if (!captured) throw new Error('editor did not mount');
  const editor = captured as Editor;
  editor.commands.setContent({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'before ' },
          {
            type: 'jsxInline',
            attrs: { componentName: 'Callout' },
            content: [{ type: 'text', text: 'x' }],
          },
          { type: 'text', text: ' after' },
        ],
      },
    ],
  });
  return editor;
}

function recreateJsxInlineElement(ydoc: Y.Doc): void {
  const paragraph = ydoc.getXmlFragment('default').get(0);
  if (!(paragraph instanceof Y.XmlElement)) return;
  for (let i = 0; i < paragraph.length; i += 1) {
    const child = paragraph.get(i);
    if (!(child instanceof Y.XmlElement) || child.nodeName !== 'jsxInline') continue;
    const clone = child.clone();
    ydoc.transact(() => {
      paragraph.delete(i, 1);
      paragraph.insert(i, [clone]);
    });
    return;
  }
}

function typeIntoJsxInline(
  editor: Editor,
  ydoc: Y.Doc,
  options: { mode?: 'append' | 'alternate'; afterKeystroke?: (ydoc: Y.Doc) => void } = {},
): { delta: number; elementPreserved: boolean } {
  const mode = options.mode ?? 'append';
  const elementBefore = jsxInlineElement(ydoc);
  const before = totalStructs(ydoc);
  act(() => {
    for (let i = 0; i < KEYSTROKE_COUNT; i += 1) {
      const { pos, contentSize } = jsxInlineRange(editor);
      if (pos < 0) throw new Error('jsxInline node vanished mid-typing');
      const at = mode === 'alternate' && i % 2 === 0 ? pos + 1 : pos + 1 + contentSize;
      editor.view.dispatch(editor.state.tr.insertText(String.fromCharCode(97 + (i % 26)), at, at));
      options.afterKeystroke?.(ydoc);
    }
  });
  const elementAfter = jsxInlineElement(ydoc);
  return {
    delta: totalStructs(ydoc) - before,
    elementPreserved: elementBefore !== null && elementBefore === elementAfter,
  };
}

afterEach(cleanup);

describe('Y.Item growth under jsxInline typing in a mounted collaborative editor', () => {
  test('typing 100 keystrokes inside a jsxInline node keeps struct growth sublinear', () => {
    const ydoc = new Y.Doc();
    const editor = mountJsxInlineEditor(ydoc);

    expect(jsxInlineElement(ydoc)).toBeInstanceOf(Y.XmlElement);

    const { delta, elementPreserved } = typeIntoJsxInline(editor, ydoc);

    expect(
      delta,
      `Y struct delta ${delta} over ${KEYSTROKE_COUNT} keystrokes exceeds the bound ${MAX_ITEM_DELTA} (observed healthy value: ${OBSERVED_HEALTHY_DELTA}). ` +
        `The bound sits 5x and 10x below the defect arms, which land near 100 and ${KEYSTROKE_COUNT * 2 + 1}, so a delta just above ${MAX_ITEM_DELTA} and still far below ${KEYSTROKE_COUNT} after a routine ` +
        'Yjs / ProseMirror / TipTap bump is a change in their struct-merging internals, not content loss: re-measure and widen this constant. Hunt for a content-loss bug only when the delta approaches per-keystroke growth.',
    ).toBeLessThanOrEqual(MAX_ITEM_DELTA);
    expect(elementPreserved).toBe(true);
    expect(editor.state.doc.textContent).toContain('xabcdefghij');
  });

  test('recreating the jsxInline Y.XmlElement on every keystroke breaks the bound', () => {
    const ydoc = new Y.Doc();
    const editor = mountJsxInlineEditor(ydoc);

    const { delta, elementPreserved } = typeIntoJsxInline(editor, ydoc, {
      afterKeystroke: recreateJsxInlineElement,
    });

    expect(delta).toBeGreaterThan(MAX_ITEM_DELTA);
    expect(elementPreserved).toBe(false);
  });

  test('one unmergeable struct per keystroke breaks the bound', () => {
    const ydoc = new Y.Doc();
    const editor = mountJsxInlineEditor(ydoc);

    const { delta } = typeIntoJsxInline(editor, ydoc, { mode: 'alternate' });

    expect(delta).toBe(KEYSTROKE_COUNT);
    expect(delta).toBeGreaterThan(MAX_ITEM_DELTA);
  });
});
