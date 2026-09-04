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
      expect(text.startsWith('a'), `${name} lost the text before it`).toBe(true);
      expect(text.endsWith('b'), `${name} lost the text after it`).toBe(true);
    }
  });
});
