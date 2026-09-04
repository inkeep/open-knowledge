import { GapCursor } from '@tiptap/pm/gapcursor';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { describe, expect, test, vi } from 'vitest';
import { moveCaretAfterNode, placeGapCursorAfterNode } from './place-caret.ts';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    thematicBreak: { group: 'block' },
    text: { group: 'inline' },
  },
  marks: {},
});

const HR_POS = 6;
const HR_SIZE = 1;

function docAfterRule(...rest: ('rule' | string)[]) {
  return schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('body')]),
    schema.node('thematicBreak'),
    ...rest.map((r) =>
      r === 'rule'
        ? schema.node('thematicBreak')
        : schema.node('paragraph', null, [schema.text(r)]),
    ),
  ]);
}

function stubView(doc: ReturnType<typeof docAfterRule>) {
  const focus = vi.fn();
  const view = {
    state: EditorState.create({ doc }),
    focus,
    dispatch: (tr: unknown) => {
      view.state = view.state.apply(tr as never);
    },
  };
  return { view, focus };
}

describe('moveCaretAfterNode', () => {
  test('declines, and writes nothing, when the node ends the document', () => {
    const { view } = stubView(docAfterRule());
    const before = view.state.doc;

    expect(moveCaretAfterNode(view as unknown as EditorView, HR_POS, HR_SIZE)).toBe(false);
    expect(view.state.doc.eq(before)).toBe(true);
    expect(view.state.doc.childCount).toBe(2);
  });

  test('leaves the selection alone when it declines', () => {
    const { view } = stubView(docAfterRule());
    const before = view.state.selection;
    moveCaretAfterNode(view as unknown as EditorView, HR_POS, HR_SIZE);
    expect(view.state.selection.eq(before)).toBe(true);
  });

  test('never selects the node it was asked to move past', () => {
    const { view } = stubView(docAfterRule());
    moveCaretAfterNode(view as unknown as EditorView, HR_POS, HR_SIZE);
    expect(view.state.selection.from).not.toBe(HR_POS);
  });

  test('moves into the following block without touching the document', () => {
    const { view } = stubView(docAfterRule('tail'));
    const before = view.state.doc;

    expect(moveCaretAfterNode(view as unknown as EditorView, HR_POS, HR_SIZE)).toBe(true);
    expect(view.state.doc.eq(before)).toBe(true);
    expect(view.state.selection.$head.parent).toBe(view.state.doc.lastChild);
    expect(view.state.selection.from).toBeGreaterThan(HR_POS + HR_SIZE);
  });

  test('reports a stale position loudly rather than clamping it', () => {
    const { view } = stubView(docAfterRule());
    const past = view.state.doc.content.size + 5;

    expect(() => moveCaretAfterNode(view as unknown as EditorView, past, HR_SIZE)).toThrow(
      RangeError,
    );
  });

  test('leaves DOM focus alone', () => {
    const { view, focus } = stubView(docAfterRule('tail'));
    moveCaretAfterNode(view as unknown as EditorView, HR_POS, HR_SIZE);
    expect(focus).not.toHaveBeenCalled();
  });
});

describe('placeGapCursorAfterNode', () => {
  test('parks past a leaf that ends the document, and writes nothing', () => {
    const { view } = stubView(docAfterRule());
    const before = view.state.doc;

    expect(placeGapCursorAfterNode(view as unknown as EditorView, HR_POS, HR_SIZE)).toBe(true);
    expect(view.state.selection).toBeInstanceOf(GapCursor);
    expect(view.state.selection.from).toBe(HR_POS + HR_SIZE);
    expect(view.state.doc.eq(before)).toBe(true);
  });

  test('declines when a textblock follows, leaving selection and document alone', () => {
    const { view } = stubView(docAfterRule('tail'));
    const beforeDoc = view.state.doc;
    const beforeSel = view.state.selection;

    expect(placeGapCursorAfterNode(view as unknown as EditorView, HR_POS, HR_SIZE)).toBe(false);
    expect(view.state.selection.eq(beforeSel)).toBe(true);
    expect(view.state.doc.eq(beforeDoc)).toBe(true);
  });

  test('declines inside a textblock', () => {
    const { view } = stubView(docAfterRule());

    expect(placeGapCursorAfterNode(view as unknown as EditorView, 1, 1)).toBe(false);
  });

  test('reports a stale position loudly rather than clamping it', () => {
    const { view } = stubView(docAfterRule());
    const past = view.state.doc.content.size + 5;

    expect(() => placeGapCursorAfterNode(view as unknown as EditorView, past, HR_SIZE)).toThrow(
      RangeError,
    );
  });

  test('parks between two leaves mid-document', () => {
    const { view } = stubView(docAfterRule('rule', 'tail'));

    expect(placeGapCursorAfterNode(view as unknown as EditorView, HR_POS, HR_SIZE)).toBe(true);
    expect(view.state.selection).toBeInstanceOf(GapCursor);
    expect(view.state.selection.from).toBe(HR_POS + HR_SIZE);
  });
});
