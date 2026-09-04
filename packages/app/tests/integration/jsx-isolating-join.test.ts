import {
  joinBackward,
  joinForward,
  selectNodeBackward,
  selectNodeForward,
} from '@tiptap/pm/commands';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { describe, expect, test } from 'vitest';
import { mdManager, schema } from './test-harness';

type PmCommand = (state: EditorState, dispatch?: (tr: EditorState['tr']) => void) => boolean;

function seedDoc(md: string): EditorState {
  const doc = schema.nodeFromJSON(mdManager.parse(md));
  return EditorState.create({ doc, schema });
}

function findJsx(state: EditorState): { pos: number; nodeSize: number } {
  let pos = -1;
  let nodeSize = 0;
  state.doc.descendants((node, p) => {
    if (pos === -1 && node.type.name === 'jsxComponent') {
      pos = p;
      nodeSize = node.nodeSize;
      return false;
    }
    return true;
  });
  expect(pos).toBeGreaterThanOrEqual(0);
  return { pos, nodeSize };
}

function caretAfterNode(state: EditorState): EditorState {
  const { pos, nodeSize } = findJsx(state);
  const caret = pos + nodeSize + 1;
  const $caret = state.doc.resolve(caret);
  expect($caret.parent.isTextblock).toBe(true);
  expect($caret.parentOffset).toBe(0);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret)));
}

function caretBeforeNode(state: EditorState): EditorState {
  const { pos } = findJsx(state);
  const caret = pos - 1;
  const $caret = state.doc.resolve(caret);
  expect($caret.parent.isTextblock).toBe(true);
  expect($caret.parentOffset).toBe($caret.parent.content.size);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret)));
}

function run(state: EditorState, cmd: PmCommand) {
  let dispatched = false;
  let next = state;
  const result = cmd(state, (tr) => {
    dispatched = true;
    next = state.apply(tr);
  });
  return { result, dispatched, next };
}

const SEEDS: ReadonlyArray<{ label: string; name: string; backward: string; forward: string }> = [
  {
    label: 'registered Callout',
    name: 'Callout',
    backward: '<Callout type="info">\n\nbody\n\n</Callout>\n\nafter\n',
    forward: 'before\n\n<Callout type="info">\n\nbody\n\n</Callout>\n',
  },
  {
    label: 'unregistered Steps',
    name: 'Steps',
    backward: '<Steps>\n\nbody\n\n</Steps>\n\nafter\n',
    forward: 'before\n\n<Steps>\n\nbody\n\n</Steps>\n',
  },
];

describe('isolating-join contract at the jsxComponent boundary', () => {
  for (const seed of SEEDS) {
    test(`joinBackward is a no-op just after a ${seed.label}`, () => {
      const state = caretAfterNode(seedDoc(seed.backward));
      const { result, dispatched } = run(state, joinBackward);
      expect(result).toBe(false);
      expect(dispatched).toBe(false);
    });

    test(`joinForward is a no-op just before a ${seed.label}`, () => {
      const state = caretBeforeNode(seedDoc(seed.forward));
      const { result, dispatched } = run(state, joinForward);
      expect(result).toBe(false);
      expect(dispatched).toBe(false);
    });

    test(`Backspace/Delete chain selects (never joins) a ${seed.label} at its edges`, () => {
      const backward = run(caretAfterNode(seedDoc(seed.backward)), selectNodeBackward);
      expect(backward.result).toBe(true);
      expect(backward.next.selection).toBeInstanceOf(NodeSelection);
      expect((backward.next.selection as NodeSelection).node.type.name).toBe('jsxComponent');
      expect((backward.next.selection as NodeSelection).node.attrs.componentName).toBe(seed.name);

      const forward = run(caretBeforeNode(seedDoc(seed.forward)), selectNodeForward);
      expect(forward.result).toBe(true);
      expect(forward.next.selection).toBeInstanceOf(NodeSelection);
      expect((forward.next.selection as NodeSelection).node.type.name).toBe('jsxComponent');
      expect((forward.next.selection as NodeSelection).node.attrs.componentName).toBe(seed.name);
    });
  }
});
