import { cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, test } from 'vitest';
import { pressEditorKey } from './editor-rig.test-helper';
import { sharedExtensions } from './extensions/shared';

const mounted: { editor: Editor; container: HTMLDivElement }[] = [];

afterEach(() => {
  for (const { editor, container } of mounted.splice(0)) {
    editor.destroy();
    container.remove();
  }
  cleanup();
});

function mount(content: string): Editor {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    content,
    extensions: sharedExtensions,
    editable: true,
  });
  editor.view.focus();
  if (!editor.view.hasFocus()) {
    throw new Error('editor-rig mount: the view did not take focus');
  }
  mounted.push({ editor, container });
  return editor;
}

describe('pressEditorKey', () => {
  test('a key the keymap claims comes back handled', () => {
    const editor = mount('<p>alpha</p>');
    editor.commands.setTextSelection(3);

    expect(pressEditorKey(editor, 'Enter')).toEqual({ handled: true, docMoved: true });
  });

  test('a key nothing claims comes back unhandled', () => {
    const editor = mount('<p>alpha</p>');
    editor.commands.setTextSelection(3);

    expect(pressEditorKey(editor, 'F9')).toEqual({ handled: false, docMoved: false });
  });

  test('a key that only moves the selection is handled and moves no document', () => {
    const editor = mount('<p></p>');
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    editor.commands.insertContent('a');

    const docBefore = editor.state.doc;
    const selectionBefore = editor.state.selection.from;

    expect(pressEditorKey(editor, 'Enter')).toEqual({ handled: true, docMoved: false });
    expect(editor.state.doc.eq(docBefore)).toBe(true);
    expect(editor.state.selection.from).not.toBe(selectionBefore);
  });

  test('a Mod- chord reaches its handler and lands in the stored marks', () => {
    const editor = mount('<p>alpha</p>');
    editor.commands.setTextSelection(3);

    const docBefore = editor.state.doc;

    expect(pressEditorKey(editor, 'Mod-b')).toEqual({ handled: true, docMoved: false });
    expect(editor.state.doc.eq(docBefore)).toBe(true);
    expect(editor.state.storedMarks?.map((mark) => mark.type.name)).toEqual(['strong']);
  });
});
