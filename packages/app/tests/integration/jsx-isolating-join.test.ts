/**
 * Isolating-join Backspace/Delete contract at the jsxComponent boundary.
 *
 * `jsx-component.test.ts` pins the schema flag `isolating: true` statically.
 * This file pins the BEHAVIOR that flag governs: the ProseMirror join commands
 * the base keymap binds to Backspace/Delete must NOT merge content across the
 * isolating boundary — so a keystroke at the edge of the component can never
 * fold the neighbouring block into (or out of) the component's content hole.
 *
 * Exercised for a registered (`Callout`) AND an unregistered (`Steps`)
 * component: both are the same `jsxComponent` node at the schema level, so the
 * join decision is name-independent — the unregistered arm has no coverage
 * today.
 *
 * Command-rung, not a real browser: `joinBackward` / `joinForward` read only
 * `state.selection` + the doc, so a plain `EditorState` plus a capturing
 * dispatch drives the exact code path the keymap runs. A jsdom native
 * Backspace can't reach this decision — with no layout, PM's `endOfTextblock`
 * probe can't confirm the caret is at the block edge, so the join is never
 * attempted and the boundary looks inert for the wrong reason. Invoking the
 * command directly removes that confound.
 */

import { describe, expect, test } from 'bun:test';
import {
  joinBackward,
  joinForward,
  selectNodeBackward,
  selectNodeForward,
} from '@tiptap/pm/commands';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { mdManager, schema } from './test-harness';

type PmCommand = (state: EditorState, dispatch?: (tr: EditorState['tr']) => void) => boolean;

function seedDoc(md: string): EditorState {
  const doc = schema.nodeFromJSON(mdManager.parse(md));
  return EditorState.create({ doc, schema });
}

/** Position + node of the first jsxComponent in the doc. */
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

/** Collapsed caret at the START of the block that follows the jsxComponent —
 *  the "just after the node" position Backspace acts from. */
function caretAfterNode(state: EditorState): EditorState {
  const { pos, nodeSize } = findJsx(state);
  const caret = pos + nodeSize + 1; // +nodeSize → following block open; +1 → its offset 0
  const $caret = state.doc.resolve(caret);
  expect($caret.parent.isTextblock).toBe(true);
  expect($caret.parentOffset).toBe(0); // at the block's leading edge
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret)));
}

/** Collapsed caret at the END of the block that precedes the jsxComponent —
 *  the "just before the node" position Delete acts from. */
function caretBeforeNode(state: EditorState): EditorState {
  const { pos } = findJsx(state);
  const caret = pos - 1; // one inside the preceding block, at its trailing edge
  const $caret = state.doc.resolve(caret);
  expect($caret.parent.isTextblock).toBe(true);
  expect($caret.parentOffset).toBe($caret.parent.content.size); // at the block's trailing edge
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret)));
}

/** Run a PM command with a capturing dispatch; report result + whether it
 *  produced a transaction + the resulting state. */
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
      // The isolating boundary refuses the join: no merge, no transaction.
      expect(result).toBe(false);
      expect(dispatched).toBe(false);
    });

    test(`joinForward is a no-op just before a ${seed.label}`, () => {
      const state = caretBeforeNode(seedDoc(seed.forward));
      const { result, dispatched } = run(state, joinForward);
      expect(result).toBe(false);
      expect(dispatched).toBe(false);
    });

    /**
     * Characterization of the full Backspace/Delete chain fallback: after the
     * join refuses, the base keymap tries selectNode*, which SELECTS the whole
     * component (a non-destructive block NodeSelection) rather than merging
     * across the boundary. Pinned so a regression that turned this into a
     * content-merging join would be caught here too.
     *
     */
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
