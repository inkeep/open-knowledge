/**
 * Typing a checkbox into existence, at the mounted rung.
 *
 * The rules that make a task item are only meaningful through the keystroke
 * path, and that path is where they had a hole: the bullet rule claims `- ` at
 * the space, so a user typing `- [ ] ` was already inside a `listItem` by the
 * time the `[` landed and the hyphenated task rule — whose regex needs that
 * marker — could never match. Every checkbox spelling typed by hand produced
 * literal text instead, while the schema-level regex tests passed, because a
 * regex cannot see which rule ran first.
 *
 * So this tier is the one that can fail the way a user does: the real app
 * roster, a real mounted editor with focus, and the same `handleTextInput`
 * walk the view performs on text input.
 *
 */

import { cleanup } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, test } from 'vitest';
import { mountAppEditor, pressEditorKey } from '../../src/editor/editor-rig.test-helper';

type TextInputHandler = (view: EditorView, from: number, to: number, text: string) => boolean;

const editors: Editor[] = [];

afterEach(() => {
  // Every mount is torn down here rather than at each call site: the
  // parametrised cases below mount one editor per spelling, and a zombie left
  // in `document.body` would be visible to any later test that reads
  // `document.activeElement` or walks the body's children.
  for (const editor of editors.splice(0)) {
    const host = editor.options.element as HTMLElement;
    editor.destroy();
    host.remove();
  }
  cleanup();
});

/** `mountAppEditor` plus this file's teardown registry. */
function mountEditor(): Editor {
  const editor = mountAppEditor();
  editors.push(editor);
  return editor;
}

/**
 * Feed characters the way the view does on text input: walk every plugin's
 * `handleTextInput` until one claims each one, and insert plainly when none
 * does. One character at a time is the point — a rule that only fires when the
 * whole string arrives at once is exactly the defect being pinned.
 */
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

/**
 * Deliver `text` as ONE `handleTextInput` call, the way an IME commit,
 * dictation, or a text-expansion tool hands over a finished phrase — as
 * opposed to `type`, which sends a character at a time the way a keyboard
 * does. Returns whether a rule claimed it.
 */
function typeChunk(editor: Editor, text: string): boolean {
  const { from, to } = editor.state.selection;
  return (
    editor.view.someProp('handleTextInput', (handler) =>
      (handler as TextInputHandler)(editor.view, from, to, text),
    ) ?? false
  );
}

/** The first `listItem` in the document, or null when nothing wrapped. */
function firstListItem(editor: Editor): PMNode | null {
  let found: PMNode | null = null;
  editor.state.doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === 'listItem') found = node;
    return !found;
  });
  return found;
}

/**
 * The document's text, so a case can assert the marker was consumed. Blocks
 * join with nothing: a rule that wraps leaves a trailing paragraph behind, and
 * a separator would make every assertion carry that artifact.
 */
function textOf(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, '');
}

describe('task list input rules', () => {
  // The bare shorthand shared with other editors, and — because the bullet
  // rule has already eaten any leading `- ` — the only spelling a typing user
  // can actually complete.
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
      // The non-canonical uppercase box round-trips; every other spelling
      // serializes as the canonical `[x]` / `[ ]`.
      expect(item?.attrs.sourceCheckboxChar).toBe(sourceCheckboxChar);
      expect(textOf(editor)).toBe('');
    });
  });

  // The regression. Note which rule these reach: `- ` autoformats at the space,
  // so the caret is inside the new item and its paragraph reads `[ ]` — and the
  // runner matches against the CURRENT TEXTBLOCK's text, so the marker is gone
  // from the candidate string. These therefore run the BARE rule through its
  // tick branch, not the hyphenated rule whose spelling they use. The
  // hyphenated rule is covered by the chunked-delivery block below.
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
      // One item, not an item wrapping a second list holding the real one.
      let listCount = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'list') listCount += 1;
        return true;
      });
      expect(listCount).toBe(1);
    });
  });

  // The hyphenated rule's only reachable route, and the only case in this file
  // that reddens if that rule is deleted. Typing cannot get here for the reason
  // above; a marker delivered whole still carries its `- `, which is what a
  // dictation or text-expansion commit looks like. Paste is NOT such a route —
  // input rules never see it, and a pasted `- [ ] ` gets its checkbox from the
  // markdown parser instead.
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
    test.each([
      // A wikilink opener — the second `[` breaks the rule.
      '[[',
      // A reference-style link label, not a checkbox.
      '[a] ',
      '[xy] ',
      // Anchored at the textblock start, so mid-paragraph is untouched.
      'a[] ',
      'see [x] ',
    ])('%j stays as typed', (typed) => {
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

  // The escape hatch, and it is NOT the same on both branches — which is why
  // each branch gets its own case. A rule that WRAPPED a paragraph inverts back
  // to that paragraph. A rule that only TICKED an existing item leaves the item
  // behind, because the bullet was an earlier, separate input-rule application
  // and `undoInputRule` inverts exactly one.
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

    // The tick is undone and the typed marker comes back as text...
    expect(handled).toBe(true);
    expect(firstListItem(editor)?.attrs.checked).toBeNull();
    expect(textOf(editor)).toBe(typed.slice(2));
    // ...but the bullet is still there, so this is not the one-keystroke
    // escape the wrapped case gets. No second rule is left to invert: the
    // next Backspace goes unclaimed by any plugin and falls through to
    // ordinary character deletion.
    expect(editor.state.doc.firstChild?.type.name).toBe('list');
    expect(pressEditorKey(editor, 'Backspace').handled).toBe(false);
  });
});
