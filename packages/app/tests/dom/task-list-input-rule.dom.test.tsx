import { cleanup } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, test } from 'vitest';
import { mountAppEditor, pressEditorKey } from '../../src/editor/editor-rig.test-helper';

type TextInputHandler = (view: EditorView, from: number, to: number, text: string) => boolean;

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) {
    const host = editor.options.element as HTMLElement;
    editor.destroy();
    host.remove();
  }
  cleanup();
});

function mountEditor(): Editor {
  const editor = mountAppEditor();
  editors.push(editor);
  return editor;
}

function type(editor: Editor, text: string): void {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const handled =
      editor.view.someProp('handleTextInput', (handler) =>
        (handler as TextInputHandler)(editor.view, from, to, character),
      ) ?? false;
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(character));
  }
}

function typeChunk(editor: Editor, text: string): boolean {
  const { from, to } = editor.state.selection;
  return (
    editor.view.someProp('handleTextInput', (handler) =>
      (handler as TextInputHandler)(editor.view, from, to, text),
    ) ?? false
  );
}

function firstListItem(editor: Editor): PMNode | null {
  let found: PMNode | null = null;
  editor.state.doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === 'listItem') found = node;
    return !found;
  });
  return found;
}

function textOf(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, '');
}

describe('task list input rules', () => {
  describe.each([
    { typed: '[] ', checked: false, sourceCheckboxChar: null },
    { typed: '[ ] ', checked: false, sourceCheckboxChar: null },
    { typed: '[x] ', checked: true, sourceCheckboxChar: null },
    { typed: '[X] ', checked: true, sourceCheckboxChar: 'X' },
  ])('bare $typed in a paragraph', ({ typed, checked, sourceCheckboxChar }) => {
    test('becomes an empty task item', () => {
      const editor = mountEditor();
      type(editor, typed);

      const item = firstListItem(editor);
      expect(item).not.toBeNull();
      expect(item?.attrs.checked).toBe(checked);
      expect(item?.attrs.sourceCheckboxChar).toBe(sourceCheckboxChar);
      expect(textOf(editor)).toBe('');
    });
  });

  describe.each([
    { typed: '- [ ] ', checked: false },
    { typed: '- [] ', checked: false },
    { typed: '* [x] ', checked: true },
    { typed: '+ [X] ', checked: true },
  ])('typing $typed', ({ typed, checked }) => {
    test('ticks the item the bullet rule already made, without nesting', () => {
      const editor = mountEditor();
      type(editor, typed);

      const item = firstListItem(editor);
      expect(item?.attrs.checked).toBe(checked);
      expect(textOf(editor)).toBe('');
      let listCount = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'list') listCount += 1;
        return true;
      });
      expect(listCount).toBe(1);
    });
  });

  describe.each([
    { chunk: '- [] ', checked: false },
    { chunk: '- [ ] ', checked: false },
    { chunk: '* [x] ', checked: true },
  ])('a whole marker delivered in one chunk: $chunk', ({ chunk, checked }) => {
    test('reaches the hyphenated rule', () => {
      const editor = mountEditor();

      expect(typeChunk(editor, chunk)).toBe(true);
      expect(firstListItem(editor)?.attrs.checked).toBe(checked);
      expect(textOf(editor)).toBe('');
    });
  });

  test('a checkbox typed into an existing item keeps its text', () => {
    const editor = mountEditor();
    type(editor, '- ');
    type(editor, '[] ');
    type(editor, 'buy milk');

    expect(firstListItem(editor)?.attrs.checked).toBe(false);
    expect(textOf(editor)).toBe('buy milk');
  });

  test('the marker is consumed, so the item serializes as canonical GFM', () => {
    const editor = mountEditor();
    type(editor, '[x] ');
    type(editor, 'done');

    const item = firstListItem(editor);
    expect(item?.attrs.checked).toBe(true);
    expect(item?.textContent).toBe('done');
  });

  describe('shapes that must stay literal text', () => {
    test.each(['[[', '[a] ', '[xy] ', 'a[] ', 'see [x] '])('%j stays as typed', (typed) => {
      const editor = mountEditor();
      type(editor, typed);

      expect(firstListItem(editor)).toBeNull();
      expect(textOf(editor)).toBe(typed);
    });
  });

  describe('plain list rules still win their own shapes', () => {
    test.each([
      { typed: '- ', ordered: false },
      { typed: '1. ', ordered: true },
    ])('$typed makes a plain item, not a task item', ({ typed, ordered }) => {
      const editor = mountEditor();
      type(editor, typed);

      const item = firstListItem(editor);
      expect(item?.attrs.checked).toBeNull();
      let list: PMNode | null = null;
      editor.state.doc.descendants((node) => {
        if (!list && node.type.name === 'list') list = node;
        return !list;
      });
      expect((list as PMNode | null)?.attrs.ordered).toBe(ordered);
    });
  });

  test.each([
    '- ',
    '[x] ',
  ])('Backspace right after %j dissolves the wrapped item back to a paragraph', (typed) => {
    const editor = mountEditor();
    type(editor, typed);
    expect(firstListItem(editor)).not.toBeNull();

    const { handled } = pressEditorKey(editor, 'Backspace');

    expect(handled).toBe(true);
    expect(firstListItem(editor)).toBeNull();
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
  });

  test.each([
    '- [x] ',
    '- [ ] ',
  ])('Backspace right after %j un-ticks the item but leaves the bullet', (typed) => {
    const editor = mountEditor();
    type(editor, typed);
    expect(firstListItem(editor)?.attrs.checked).not.toBeNull();

    const { handled } = pressEditorKey(editor, 'Backspace');

    expect(handled).toBe(true);
    expect(firstListItem(editor)?.attrs.checked).toBeNull();
    expect(textOf(editor)).toBe(typed.slice(2));
    expect(editor.state.doc.firstChild?.type.name).toBe('list');
    expect(pressEditorKey(editor, 'Backspace').handled).toBe(false);
  });
});
