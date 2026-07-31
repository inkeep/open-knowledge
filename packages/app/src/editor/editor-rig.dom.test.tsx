/**
 * The contract of `pressEditorKey`, asserted on its own.
 *
 * The helper reports two things about a keystroke because "the keymap claimed
 * it" and "the document changed" are different questions, and its callers each
 * want a different one. The case where the two disagree is the reason the
 * result is a pair rather than a boolean, and no caller exercises that case
 * directly, so it is pinned here.
 */

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
  // A view that reports no focus measures every focus-gated plugin as dormant,
  // so a rig that quietly lost focus would score a keystroke against half an
  // editor. Fail at the mount rather than inside an assertion.
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
    // Enter inside a table cell: the table keymap claims it and advances the
    // caret to the next cell without touching the document. A single boolean
    // would have to call this either "handled", losing the fact that no new
    // typed bytes were reached, or "nothing happened", losing the fact that the
    // key was consumed and no native edit would follow it in a browser. Every
    // caller outside this file reads `docMoved`; `handled` is the half nothing
    // else reads, which is why the disagreement is pinned here.
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
    // The `Mod` prefix is the one part of the shortcut parse that resolves
    // differently per platform, and nothing else in this file exercises it, so
    // a drift in that mapping would surface only as a downstream chord test
    // failing for an unrelated-looking reason.
    //
    // A mark chord at a collapsed caret is also the second shape of the
    // handled/docMoved disagreement, and a different one from the table case
    // above: no selection moves either. The whole effect lands in the stored
    // marks, which is precisely what a steps-only replay used to discard, so
    // this doubles as the primitive-level pin for that half of the repair.
    const editor = mount('<p>alpha</p>');
    editor.commands.setTextSelection(3);

    const docBefore = editor.state.doc;

    expect(pressEditorKey(editor, 'Mod-b')).toEqual({ handled: true, docMoved: false });
    expect(editor.state.doc.eq(docBefore)).toBe(true);
    expect(editor.state.storedMarks?.map((mark) => mark.type.name)).toEqual(['strong']);
  });
});
