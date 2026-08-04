/**
 * Input-rule replacement ranges across inline objects, at the mounted rung.
 *
 * The range a rule replaces is arithmetic over the length of the string the
 * runner matched (`from - (match[0].length - text.length)`), so it is only
 * correct while every node before the caret contributed as many characters as
 * it occupies positions. When one does not, a completion keystroke either
 * throws `RangeError` out of `handleTextInput` — the keystroke crashes — or,
 * with enough text ahead of it to keep the range positive, silently rewrites
 * the wrong span. Both are reachable through the shipped `**bold**` rule.
 *
 * The schema-level contract is pinned in core. This tier is the one that can
 * fail the way a user does: the real app roster, a real mounted editor with
 * focus, and the same `handleTextInput` walk the view performs on text input.
 *
 */

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
  // Every mount is torn down here rather than at each call site: the
  // parametrised cases below mount one editor per inline node, and a zombie
  // left in `document.body` would be visible to any later test that reads
  // `document.activeElement` or walks the body's children.
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
  // ProseMirror's own focus rather than `commands.focus()`, which defers the
  // real DOM focus into a frame that lands after every synchronous step here.
  editor.view.focus();
  return editor;
}

/**
 * Feed one character the way the view does on text input: walk every plugin's
 * `handleTextInput` until one claims it, and insert plainly when none does.
 */
function typeCharacter(editor: Editor, character: string): void {
  const { from, to } = editor.state.selection;
  const handled =
    editor.view.someProp('handleTextInput', (handler) =>
      (handler as TextInputHandler)(editor.view, from, to, character),
    ) ?? false;
  if (!handled) editor.view.dispatch(editor.state.tr.insertText(character));
}

/** One instance of `name`, filled with text when the node takes content. */
function inlineObject(editor: Editor, name: string, body: string): PMNode | null {
  const type = editor.schema.nodes[name];
  if (!type) return null;
  return type.isLeaf ? type.createAndFill() : type.createAndFill(null, [editor.schema.text(body)]);
}

/** Seed `<lead><object><tail>` in one paragraph and park the caret at its end. */
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

/**
 * Names of every inline node the roster can put in a rule's match window.
 *
 * Built from the schema rather than a mounted editor: this runs at module
 * scope, before any `afterEach` exists to tear a mount down, and the names are
 * a property of the roster rather than of any editor over it.
 */
const INLINE_OBJECT_NAMES: string[] = Object.entries(getSchema(sharedExtensions).nodes)
  .filter(([name, type]) => type.isInline && name !== 'text')
  .map(([name]) => name);

describe('a completion keystroke whose match window spans an inline object', () => {
  test('the roster still has inline objects to guard', () => {
    // Guards the parametrised cases below against silently becoming vacuous if
    // the roster ever loses its inline nodes.
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
    // The delimiters are consumed, not left stranded in the text...
    expect((paragraph as PMNode).textContent).not.toContain('*');
    // ...the surviving text is exactly what the user wrote between them (a
    // node with children contributes its own text, a leaf contributes none)...
    expect((paragraph as PMNode).textContent).toBe(`see ${(object as PMNode).textContent} here`);
    // ...the object itself survived the replacement...
    let objectSurvived = false;
    (paragraph as PMNode).forEach((child) => {
      if (child.type.name === name) objectSurvived = true;
    });
    expect(objectSurvived).toBe(true);
    // ...and the mark covers the delimited span exactly. `rangeHasMark` would
    // not show this — it is an ANY check, so it also holds when the mark starts
    // several characters too far left, which is the pre-fix shape.
    const strong = editor.schema.marks.strong;
    expect(strong).toBeDefined();
    const unmarked: string[] = [];
    // Walk to the leaves: a mark applied over a range lands on the text inside
    // a node with children, not on the wrapper, so checking direct children
    // alone would report a correctly-marked inline element as unmarked.
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
    // With a short paragraph a skewed range runs off the document and throws.
    // A long lead keeps it in bounds, where the same skew is silent: the rule
    // rewrites a span that starts too far left and eats the text before it.
    const editor = mountEditor();
    const object = inlineObject(editor, name, 'x');
    expect(object).not.toBeNull();
    const lead = `${'lorem ipsum dolor sit amet '.repeat(2)}**see `;
    seedParagraph(editor, lead, object as PMNode, ' here*');

    expect(() => typeCharacter(editor, '*')).not.toThrow();

    const text = editor.state.doc.firstChild?.textContent ?? '';
    expect(text.startsWith('lorem ipsum dolor sit amet '.repeat(2))).toBe(true);
    expect(text).not.toContain('*');
    // The silent form of the skew marks text the user never delimited, so pin
    // that negative directly rather than inferring it from the text alone.
    const strong = editor.schema.marks.strong;
    expect(strong).toBeDefined();
    const leadEnd = 1 + 'lorem ipsum dolor sit amet '.repeat(2).length;
    expect(editor.state.doc.rangeHasMark(1, leadEnd, strong as MarkType)).toBe(false);
  });

  test('a node with children is faithful regardless of how much it holds', () => {
    // A wrapper's skew scales with its content, so a short body can land on the
    // correct range by coincidence while a realistic one runs off the document.
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
