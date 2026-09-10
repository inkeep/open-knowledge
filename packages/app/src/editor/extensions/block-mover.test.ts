import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { describe, expect, test } from 'vitest';
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
  pos += 1;
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

const listSchema = getSchema(sharedExtensions);
const markdown = new MarkdownManager({ extensions: sharedExtensions });

function listState(input: string, first: string, last = first) {
  const doc = listSchema.nodeFromJSON(markdown.parse(input));
  let from = -1;
  let to = -1;
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return;
    if (node.textContent === first) from = pos + 1;
    if (node.textContent === last) to = pos + 1 + (first === last ? 0 : node.content.size);
  });
  return EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
}

function movedMarkdown(state: EditorState) {
  state.doc.check();
  return markdown.serialize(state.doc.toJSON());
}

describe('keyboard list item movement', () => {
  test.each([
    ['bullet', '- A\n- B\n- C\n', '- A\n- C\n- B\n'],
    ['ordered', '1. A\n2. B\n3. C\n', '1. A\n2. C\n3. B\n'],
    ['task', '- [ ] A\n- [ ] B\n- [x] C\n', '- [ ] A\n- [x] C\n- [ ] B\n'],
  ])('moves a %s item up and back down without losing its selection', (_kind, input, expected) => {
    const state = listState(input, 'C');
    const next = run(state, moveBlockUp);
    expect(movedMarkdown(next)).toBe(expected);
    expect(next.selection.$from.parent.textContent).toBe('C');
    expect(movedMarkdown(run(next, moveBlockDown))).toBe(input);
  });

  test('moves a selected group together and keeps that group selected', () => {
    const state = listState('- A\n- B\n- C\n- D\n', 'B', 'C');
    const next = run(state, moveBlockDown);
    expect(movedMarkdown(next)).toBe('- A\n- D\n- B\n- C\n');
    expect(next.selection.$from.parent.textContent).toBe('B');
    expect(next.selection.$to.parent.textContent).toBe('C');
    expect(movedMarkdown(run(next, moveBlockUp))).toBe('- A\n- B\n- C\n- D\n');
  });

  test('keeps nested descendants with a moved parent', () => {
    const next = run(listState('- A\n  - Child\n- B\n', 'A'), moveBlockDown);
    expect(movedMarkdown(next)).toBe('- B\n- A\n  - Child\n');
  });

  test('moves a first nested item before its parent', () => {
    const next = run(listState('- Parent\n  - Child\n  - Sibling\n- End\n', 'Child'), moveBlockUp);
    expect(movedMarkdown(next)).toBe('- Child\n- Parent\n  - Sibling\n- End\n');
    expect(next.selection.$from.parent.textContent).toBe('Child');
  });

  test('moves a last nested item after its parent', () => {
    const next = run(
      listState('- Parent\n  - Child\n  - Sibling\n- End\n', 'Sibling'),
      moveBlockDown,
    );
    expect(movedMarkdown(next)).toBe('- Parent\n  - Child\n- Sibling\n- End\n');
  });

  test('moves an entire selected nested group without leaving an empty list', () => {
    const next = run(
      listState('- Parent\n  - Child\n  - Sibling\n- End\n', 'Child', 'Sibling'),
      moveBlockDown,
    );
    expect(movedMarkdown(next)).toBe('- Parent\n- Child\n- Sibling\n- End\n');
    expect(next.selection.$from.parent.textContent).toBe('Child');
    expect(next.selection.$to.parent.textContent).toBe('Sibling');
  });

  test.each([
    [moveBlockUp, 'Before\n\n1. A\n2. B\n', 'A', '1. A\n\nBefore\n\n1. B\n'],
    [moveBlockDown, '1. A\n2. B\n\nAfter\n', 'B', '1. A\n\nAfter\n\n1. B\n'],
  ])('moves an edge item across a neighboring document block', (command, input, item, expected) => {
    const next = run(listState(input, item), command);
    expect(movedMarkdown(next)).toBe(expected);
    expect(next.selection.$from.parent.textContent).toBe(item);
  });

  test.each([
    [moveBlockUp, 'Before\n\n> - A\n> - B\n', 'A', '> - A\n> - B\n\nBefore\n'],
    [moveBlockDown, '> - A\n> - B\n\nAfter\n', 'B', 'After\n\n> - A\n> - B\n'],
  ])('moves the enclosing blockquote at a list boundary', (command, input, item, expected) => {
    expect(movedMarkdown(run(listState(input, item), command))).toBe(expected);
  });

  test.each([
    ['1. A\n1. B\n', '1. A\n1. B\n'],
    ['7. A\n9. B\n', '7. A\n9. B\n'],
  ])('preserves whole-list ordinals when relocating the selected list', (input, expected) => {
    expect(movedMarkdown(run(listState(`${input}\nAfter\n`, 'A', 'B'), moveBlockDown))).toBe(
      `After\n\n${expected}`,
    );
    expect(movedMarkdown(run(listState(`Before\n\n${input}`, 'A', 'B'), moveBlockUp))).toBe(
      `${expected}\nBefore\n`,
    );
  });

  test('does not move the whole list when an item reaches a document boundary', () => {
    expect(moveBlockUp(listState('- A\n- B\n', 'A'), undefined)).toBe(false);
    expect(moveBlockDown(listState('- A\n- B\n', 'B'), undefined)).toBe(false);
  });
});
