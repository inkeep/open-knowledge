import { describe, expect, test } from 'bun:test';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { currentTopLevelBlock, moveBlockDown, moveBlockUp } from './block-mover';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
  marks: {},
});

function makeState(paraTexts: string[], cursorPara = 0): EditorState {
  const nodes = paraTexts.map((t) =>
    t.length > 0 ? schema.node('paragraph', null, [schema.text(t)]) : schema.node('paragraph'),
  );
  const doc = schema.node('doc', null, nodes);
  let pos = 0;
  for (let i = 0; i < cursorPara; i++) pos += nodes[i].nodeSize;
  pos += 1; // step inside the paragraph (past its opening token)
  return EditorState.create({ doc, selection: TextSelection.near(doc.resolve(pos)) });
}

function run(
  state: EditorState,
  // biome-ignore lint/suspicious/noExplicitAny: ProseMirror Transaction
  cmd: (s: EditorState, d?: (tr: any) => void) => boolean,
): EditorState {
  let next: EditorState | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: ProseMirror Transaction
  cmd(state, (tr: any) => {
    next = state.apply(tr);
  });
  expect(next).not.toBeNull();
  return next as unknown as EditorState;
}

function docTexts(state: EditorState): string[] {
  const result: string[] = [];
  state.doc.forEach((node) => {
    result.push(node.textContent);
  });
  return result;
}


describe('currentTopLevelBlock', () => {
  test('returns block boundaries for cursor in first paragraph', () => {
    const state = makeState(['Hello', 'World']);
    const block = currentTopLevelBlock(state);
    expect(block).toEqual({ from: 0, to: 7 });
  });

  test('returns block boundaries for cursor in second paragraph', () => {
    const state = makeState(['Hello', 'World'], 1);
    const block = currentTopLevelBlock(state);
    expect(block).toEqual({ from: 7, to: 14 });
  });

  test('returns null when selection depth is 0', () => {
    const fakeState = { selection: { $from: { depth: 0 } } } as unknown as EditorState;
    expect(currentTopLevelBlock(fakeState)).toBeNull();
  });
});


describe('moveBlockUp', () => {
  test('returns false when cursor is in the first block (no-op)', () => {
    const state = makeState(['A', 'B'], 0);
    expect(moveBlockUp(state, undefined)).toBe(false);
  });

  test('returns false for a single-block document', () => {
    const state = makeState(['Only']);
    expect(moveBlockUp(state, undefined)).toBe(false);
  });

  test('swaps two paragraphs', () => {
    const next = run(makeState(['A', 'B'], 1), moveBlockUp);
    expect(docTexts(next)).toEqual(['B', 'A']);
  });

  test('moves middle block up in a three-block doc', () => {
    const next = run(makeState(['A', 'B', 'C'], 1), moveBlockUp);
    expect(docTexts(next)).toEqual(['B', 'A', 'C']);
  });

  test('cursor stays inside the moved block after move', () => {
    const next = run(makeState(['Hello', 'World'], 1), moveBlockUp);
    const sel = next.selection as TextSelection;
    expect(sel.$cursor).not.toBeNull();
    expect((sel.$cursor as NonNullable<typeof sel.$cursor>).before(1)).toBe(0);
  });
});


describe('moveBlockDown', () => {
  test('returns false when cursor is in the last block (no-op)', () => {
    const state = makeState(['A', 'B'], 1);
    expect(moveBlockDown(state, undefined)).toBe(false);
  });

  test('returns false for a single-block document', () => {
    const state = makeState(['Only']);
    expect(moveBlockDown(state, undefined)).toBe(false);
  });

  test('swaps two paragraphs', () => {
    const next = run(makeState(['A', 'B'], 0), moveBlockDown);
    expect(docTexts(next)).toEqual(['B', 'A']);
  });

  test('moves middle block down in a three-block doc', () => {
    const next = run(makeState(['A', 'B', 'C'], 1), moveBlockDown);
    expect(docTexts(next)).toEqual(['A', 'C', 'B']);
  });

  test('cursor stays inside the moved block after move', () => {
    const next = run(makeState(['Hello', 'World'], 0), moveBlockDown);
    const sel = next.selection as TextSelection;
    expect(sel.$cursor).not.toBeNull();
    expect((sel.$cursor as NonNullable<typeof sel.$cursor>).before(1)).toBe(7);
  });
});
