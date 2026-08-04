/**
 * Plain-text copy from an editor that adds no `editorProps` of its own.
 *
 * `renderText` makes every inline node contribute one character per document
 * position so the input-rule runner computes correct replacement ranges. TipTap
 * stores that on the NodeSpec as `toText`, which its built-in
 * `clipboardTextSerializer` also reads — with the opposite need. `getTextBetween`
 * swaps the serializer's output in for the node and stops descending, so without
 * a counterweight a copied image would carry the placeholder and a copied inline
 * JSX element would lose its text.
 *
 * The read-only viewers mount the shared roster with no `editorProps`, so this
 * exercises the roster ALONE — no overrides, no disabled core extensions. That
 * is what makes it a pin for editors added later rather than for today's two.
 *
 */

import { cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Slice } from '@tiptap/pm/model';
import { afterEach, describe, expect, test } from 'vitest';
import { INLINE_OBJECT_PLACEHOLDER } from '../../../core/src/extensions/input-rule-text.ts';
import { sharedExtensions } from '../../src/editor/extensions/shared';

const editors: Editor[] = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  for (const container of containers.splice(0)) container.remove();
  cleanup();
});

/** An editor with the shared roster and nothing else — a viewer's shape. */
function mountBareEditor(content?: PMNode): Editor {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  const editor = new Editor({
    element: container,
    ...(content ? { content: content.toJSON() } : {}),
    extensions: sharedExtensions,
  });
  editors.push(editor);
  return editor;
}

/**
 * The `text/plain` payload the view would put on the clipboard for the doc.
 *
 * Selects the document first: the serializer this guards against reads the
 * SELECTION rather than the slice it is handed, so serializing a freshly
 * mounted editor would return the empty string and every absence assertion
 * below would hold vacuously.
 */
function copyWholeDocAsPlainText(editor: Editor): string {
  editor.commands.selectAll();
  const { doc } = editor.state;
  const slice = new Slice(doc.content, 0, 0);
  const serializer = editor.view.someProp('clipboardTextSerializer');
  expect(serializer, 'no clipboardTextSerializer on a bare roster').toBeDefined();
  const text = (serializer as (s: Slice, v: unknown) => string)(slice, editor.view);
  expect(text, 'empty payload would make the assertions vacuous').not.toBe('');
  return text;
}

describe('plain-text copy from an editor with no editorProps of its own', () => {
  test('an inline leaf contributes no placeholder', () => {
    const probe = mountBareEditor();
    const { schema } = probe;
    const image = schema.nodes.image?.create({ src: 'a.png', alt: 'a' });
    expect(image).toBeDefined();
    const doc = schema.nodes.doc?.createAndFill(null, [
      schema.nodes.paragraph?.create(null, [
        schema.text('before '),
        image as PMNode,
        schema.text(' after'),
      ]) as PMNode,
    ]);
    expect(doc).not.toBeNull();

    const text = copyWholeDocAsPlainText(mountBareEditor(doc as PMNode));

    expect(text).not.toContain(INLINE_OBJECT_PLACEHOLDER);
    expect(text).toBe('before  after');
  });

  test('a node with children keeps its visible text', () => {
    // The sharper half: the serializer path stops descending once it has
    // handled a node, so a placeholder here would not merely be added — it
    // would REPLACE the element's text.
    const probe = mountBareEditor();
    const { schema } = probe;
    const jsx = schema.nodes.jsxInline?.create(null, [schema.text('<Foo bar="baz" />')]);
    expect(jsx).toBeDefined();
    const doc = schema.nodes.doc?.createAndFill(null, [
      schema.nodes.paragraph?.create(null, [schema.text('see '), jsx as PMNode]) as PMNode,
    ]);
    expect(doc).not.toBeNull();

    const text = copyWholeDocAsPlainText(mountBareEditor(doc as PMNode));

    expect(text).toContain('<Foo bar="baz" />');
    expect(text).not.toContain(INLINE_OBJECT_PLACEHOLDER);
  });

  test('every inline node in the roster stays out of the payload', () => {
    const probe = mountBareEditor();
    const { schema } = probe;
    for (const [name, type] of Object.entries(schema.nodes)) {
      if (!type.isInline || name === 'text') continue;
      const node = type.isLeaf
        ? type.createAndFill()
        : type.createAndFill(null, [schema.text('x')]);
      if (!node) continue;
      const doc = schema.nodes.doc?.createAndFill(null, [
        schema.nodes.paragraph?.create(null, [schema.text('a'), node, schema.text('b')]) as PMNode,
      ]);
      if (!doc) continue;

      const text = copyWholeDocAsPlainText(mountBareEditor(doc));

      expect(text, `${name} leaked the placeholder into text/plain`).not.toContain(
        INLINE_OBJECT_PLACEHOLDER,
      );
      // The surrounding text must survive too: the serializer path replaces a
      // node AND stops descending, so a regression can drop text, not just add.
      expect(text.startsWith('a'), `${name} lost the text before it`).toBe(true);
      expect(text.endsWith('b'), `${name} lost the text after it`).toBe(true);
    }
  });
});
