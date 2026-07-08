/**
 * WYSIWYG paste INTO a jsxComponent interior — registered + unregistered.
 *
 * The unit tests in `handle-paste.test.ts` and the reorder tests in
 * `clipboard-dispatcher-reorder.test.ts` drive the dispatcher against a fake
 * view whose `tr.replaceSelection` only CAPTURES the produced slice — the
 * caret always sits at the doc body and the slice is never fitted against a
 * real document. They confirm which branch fired and what slice shape it
 * produced, but structurally cannot observe how that slice lands when the
 * caret is inside an isolating `jsxComponent` content hole.
 *
 * This file closes that gap: it seeds a real EditorState from parsed markdown,
 * places a collapsed caret inside the interior of a registered (`Callout`) and
 * an unregistered (`Steps`) component, then runs the REAL dispatcher against a
 * view backed by that real state — so `replaceSelection` performs real PM
 * slice-fitting across the isolating boundary. The assertion is on the
 * resulting document: the pasted block nests as a child of the component
 * interior, the component container survives with its identity, and the
 * pre-existing interior content is preserved.
 *
 * Registered and unregistered components are the same `jsxComponent` node at
 * the schema level (isolating, `block*`) — the interior-fit path is identical,
 * which is why both are exercised over the same three payloads.
 *
 * No DOM: the dispatcher only touches `view.state` and `view.dispatch`, so a
 * plain object wrapping a real EditorState reaches the production code path
 * without a TipTap EditorView (same constraint the selection-state harness
 * works around).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { mdManager, schema } from './test-harness';

// paste-failure-toast pulls in sonner; stub it so module load + any
// degradation path is inert in the node test runtime.
mock.module('sonner', () => ({ toast: { error: mock(() => {}) } }));

// Imported after the sonner mock so the dispatcher's transitive sonner import
// resolves to the stub.
let createHandlePaste: typeof import('../../src/editor/clipboard/handle-paste.ts').createHandlePaste;
beforeEach(async () => {
  ({ createHandlePaste } = await import('../../src/editor/clipboard/handle-paste.ts'));
});

let origWarn: typeof console.warn;
beforeEach(() => {
  origWarn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  console.warn = origWarn;
});

function fakeDT(data: Record<string, string>): ClipboardEvent {
  return {
    clipboardData: { types: Object.keys(data), getData: (k: string) => data[k] ?? '' },
  } as unknown as ClipboardEvent;
}

/** A view whose state is a real EditorState — dispatch applies for real, so
 *  `tr.replaceSelection` runs PM's actual slice-fitting against the doc. */
function realStateView(initial: EditorState) {
  let state = initial;
  return {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = state.apply(tr);
    },
    current: () => state,
  };
}

/** Seed a doc from markdown and return a state whose collapsed caret sits at
 *  the first text position inside the first jsxComponent's interior. */
function seedWithInteriorCaret(md: string): EditorState {
  const doc = schema.nodeFromJSON(mdManager.parse(md));
  const base = EditorState.create({ doc, schema });
  let jsxPos = -1;
  base.doc.descendants((node, pos) => {
    if (jsxPos === -1 && node.type.name === 'jsxComponent') {
      jsxPos = pos;
      return false;
    }
    return true;
  });
  expect(jsxPos).toBeGreaterThanOrEqual(0);
  // jsxPos = component open; +1 enters the interior; +2 lands inside the first
  // interior paragraph's text (mirrors selection-state.test.ts T4).
  const interiorCaret = jsxPos + 2;
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, interiorCaret)));
}

const REGISTERED_SEED = '<Callout type="info">\n\nbody\n\n</Callout>\n';
const UNREGISTERED_SEED = '<Steps>\n\nbody\n\n</Steps>\n';
const SEEDS: ReadonlyArray<{ label: string; md: string; name: string }> = [
  { label: 'registered Callout', md: REGISTERED_SEED, name: 'Callout' },
  { label: 'unregistered Steps', md: UNREGISTERED_SEED, name: 'Steps' },
];

/** Run the dispatcher into an interior caret and return the container
 *  jsxComponent from the resulting doc (asserting the isolating boundary was
 *  preserved — the paste nested INTO the component, not beside it). */
function pasteIntoInterior(seedMd: string, expectedName: string, dt: ClipboardEvent) {
  const paste = createHandlePaste({ mdManager });
  const view = realStateView(seedWithInteriorCaret(seedMd));
  const handled = paste(view as never, dt);
  const doc = view.current().doc;
  expect(handled).toBe(true);
  // Container survived as the sole top-level node with its identity intact —
  // the pasted slice did not split or escape the isolating component.
  expect(doc.childCount).toBe(1);
  const container = doc.firstChild;
  expect(container?.type.name).toBe('jsxComponent');
  expect(container?.attrs.componentName).toBe(expectedName);
  return container as NonNullable<typeof container>;
}

/** Component-interior children by node-type name (direct children only). */
function interiorChildTypes(container: ReturnType<typeof pasteIntoInterior>): string[] {
  const types: string[] = [];
  container.forEach((child) => {
    types.push(child.type.name);
  });
  return types;
}

describe('WYSIWYG paste into a jsxComponent interior', () => {
  test('markdown pastes as nested blocks inside registered + unregistered interiors', () => {
    for (const seed of SEEDS) {
      const container = pasteIntoInterior(
        seed.md,
        seed.name,
        fakeDT({ 'text/plain': '## Head\n\n- one\n- two\n' }),
      );
      const childTypes = interiorChildTypes(container);
      // Pasted heading + list nested as the interior's leading blocks.
      expect(childTypes[0]).toBe('heading');
      expect(childTypes).toContain('list');
      const heading = container.child(0);
      expect(heading.textContent).toBe('Head');
      // Pre-existing interior body preserved as the trailing block.
      expect(container.lastChild?.type.name).toBe('paragraph');
      expect(container.lastChild?.textContent).toBe('body');
    }
  });

  test('an HTML table pastes as a nested table inside registered + unregistered interiors', () => {
    for (const seed of SEEDS) {
      const container = pasteIntoInterior(
        seed.md,
        seed.name,
        fakeDT({
          'text/plain': 'a\tb\nc\td',
          'text/html': '<table><tr><th>a</th><th>b</th></tr><tr><td>c</td><td>d</td></tr></table>',
        }),
      );
      const childTypes = interiorChildTypes(container);
      // Table nested as a direct interior child (not escaped to doc root).
      expect(childTypes[0]).toBe('table');
      expect(container.child(0).childCount).toBeGreaterThan(0); // rows present
      // Pre-existing interior body preserved.
      expect(container.lastChild?.type.name).toBe('paragraph');
      expect(container.lastChild?.textContent).toBe('body');
    }
  });

  test('a nested JSX block pastes as a nested jsxComponent inside registered + unregistered interiors', () => {
    for (const seed of SEEDS) {
      const container = pasteIntoInterior(
        seed.md,
        seed.name,
        fakeDT({ 'text/plain': '<Callout type="note">\n\nnested body\n\n</Callout>\n' }),
      );
      const childTypes = interiorChildTypes(container);
      // Nested component landed as a child jsxComponent, distinct identity.
      expect(childTypes[0]).toBe('jsxComponent');
      expect(container.child(0).attrs.componentName).toBe('Callout');
      expect(container.child(0).textContent).toBe('nested body');
      // Pre-existing interior body preserved.
      expect(container.lastChild?.type.name).toBe('paragraph');
      expect(container.lastChild?.textContent).toBe('body');
    }
  });
});
