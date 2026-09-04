import { cleanup } from '@testing-library/react';
import { Editor, getSchema } from '@tiptap/core';
import type { MarkType, Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from '../../src/editor/extensions/shared';

type TextInputHandler = (view: EditorView, from: number, to: number, text: string) => boolean;

const editors: Editor[] = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  for (const container of containers.splice(0)) container.remove();
  cleanup();
});

function mountEditor(): Editor {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  const editor = new Editor({ element: container, extensions: sharedExtensions, editable: true });
  editors.push(editor);
  editor.view.focus();
  return editor;
}

function typeCharacter(editor: Editor, character: string): void {
  const { from, to } = editor.state.selection;
  const handled =
    editor.view.someProp('handleTextInput', (handler) =>
      (handler as TextInputHandler)(editor.view, from, to, character),
    ) ?? false;
  if (!handled) editor.view.dispatch(editor.state.tr.insertText(character));
}

function inlineObject(editor: Editor, name: string, body: string): PMNode | null {
  const type = editor.schema.nodes[name];
  if (!type) return null;
  return type.isLeaf ? type.createAndFill() : type.createAndFill(null, [editor.schema.text(body)]);
}

function seedParagraph(editor: Editor, lead: string, object: PMNode, tail: string): void {
  const { schema } = editor;
  const paragraph = schema.nodes.paragraph?.create(null, [
    schema.text(lead),
    object,
    schema.text(tail),
  ]);
  if (!paragraph) throw new Error('paragraph missing from schema');
  const doc = schema.nodes.doc?.createAndFill(null, [paragraph]);
  if (!doc) throw new Error('doc missing from schema');
  editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content));
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
}

const INLINE_OBJECT_NAMES: string[] = Object.entries(getSchema(sharedExtensions).nodes)
  .filter(([name, type]) => type.isInline && name !== 'text')
  .map(([name]) => name);

describe('a completion keystroke whose match window spans an inline object', () => {
  test('the roster still has inline objects to guard', () => {
    expect(INLINE_OBJECT_NAMES.length).toBeGreaterThanOrEqual(8);
  });

  test.each(INLINE_OBJECT_NAMES)('completes `**bold**` across %s', (name) => {
    const editor = mountEditor();
    const object = inlineObject(editor, name, 'x');
    expect(object).not.toBeNull();
    seedParagraph(editor, '**see ', object as PMNode, ' here*');

    expect(() => typeCharacter(editor, '*')).not.toThrow();

    const paragraph = editor.state.doc.firstChild;
    expect(paragraph).not.toBeNull();
    expect((paragraph as PMNode).textContent).not.toContain('*');
    expect((paragraph as PMNode).textContent).toBe(`see ${(object as PMNode).textContent} here`);
    let objectSurvived = false;
    (paragraph as PMNode).forEach((child) => {
      if (child.type.name === name) objectSurvived = true;
    });
    expect(objectSurvived).toBe(true);
    const strong = editor.schema.marks.strong;
    expect(strong).toBeDefined();
    const unmarked: string[] = [];
    (paragraph as PMNode).descendants((node) => {
      if (!node.isText && !node.isLeaf) return true;
      if (!strong?.isInSet(node.marks)) unmarked.push(node.type.name);
      return false;
    });
    expect(unmarked, 'every leaf of the delimited span carries strong').toEqual([]);
  });

  test.each(
    INLINE_OBJECT_NAMES,
  )('leaves preceding text untouched when the range stays positive (%s)', (name) => {
    const editor = mountEditor();
    const object = inlineObject(editor, name, 'x');
    expect(object).not.toBeNull();
    const lead = `${'lorem ipsum dolor sit amet '.repeat(2)}**see `;
    seedParagraph(editor, lead, object as PMNode, ' here*');

    expect(() => typeCharacter(editor, '*')).not.toThrow();

    const text = editor.state.doc.firstChild?.textContent ?? '';
    expect(text.startsWith('lorem ipsum dolor sit amet '.repeat(2))).toBe(true);
    expect(text).not.toContain('*');
    const strong = editor.schema.marks.strong;
    expect(strong).toBeDefined();
    const leadEnd = 1 + 'lorem ipsum dolor sit amet '.repeat(2).length;
    expect(editor.state.doc.rangeHasMark(1, leadEnd, strong as MarkType)).toBe(false);
  });

  test('a node with children is faithful regardless of how much it holds', () => {
    for (const body of ['a', 'ab', 'abc', '<Foo bar="baz" />']) {
      const editor = mountEditor();
      const object = inlineObject(editor, 'jsxInline', body);
      expect(object).not.toBeNull();
      seedParagraph(editor, '**see ', object as PMNode, ' here*');

      expect(() => typeCharacter(editor, '*')).not.toThrow();

      expect(editor.state.doc.firstChild?.textContent).toBe(`see ${body} here`);
    }
  });
});
