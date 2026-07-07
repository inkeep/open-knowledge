/**
 * SelectionStatePlugin unit tests — pure PM EditorState (no DOM/TipTap wiring).
 *
 * Covers `deriveAncestorChain` + `deriveBlockSelection` behavior in isolation.
 * DOM event classification (mousedown → 'pointer', keydown → 'keyboard') lives
 * in `props.handleDOMEvents` / `handleKeyDown` and is exercised by the E2E
 * suite; the origin-override path via `SELECTION_ORIGIN_META_KEY`
 * is testable here because it's tr-meta-based.
 */

import { describe, expect, test } from 'bun:test';
import { Schema } from '@tiptap/pm/model';
import { EditorState, NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state';
import { bridgeIdPluginKey } from './bridge-id-plugin.ts';
import {
  type BlockSelection,
  computeSelectionApply,
  deriveAncestorChain,
  deriveBlockSelection,
  isBlockNavigationKey,
  type PluginRuntime,
  SELECTION_ORIGIN_META_KEY,
  selectionStatePluginKey,
} from './selection-state-plugin.ts';

// ── Minimal schema mirroring jsxComponent shape ──────────────────────────
// jsxComponent is a block node with content 'block*', the same content
// expression the core schema uses (packages/core/src/extensions/jsx-component.ts).
// We add an attr `componentName` to mirror the real attrs the plugin reads.

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    jsxComponent: {
      group: 'block',
      content: 'block*',
      attrs: {
        componentName: { default: 'Unknown' },
      },
      // Needs to be selectable so NodeSelection works.
      selectable: true,
    },
    text: { group: 'inline' },
  },
  marks: {},
});

const EMPTY: BlockSelection = {
  selectedBlockId: null,
  ancestorChain: [],
  selectionOrigin: 'programmatic',
  isDragging: false,
  rangeEncompassedBlockIds: new Set<string>(),
};

/** Stub plugin that mirrors `BridgeIdPlugin`'s state shape so unit tests can
 *  exercise the range-encompass derivation (which reads `posToId`). The real
 *  plugin walks the doc on transactions; we walk once at init for the test
 *  fixture, which is enough because the tests don't mutate doc content
 *  (only selection state). Each jsxComponent gets a synthetic `b<pos>` id. */
function makeStubBridgeIdPlugin() {
  return new Plugin({
    key: bridgeIdPluginKey,
    state: {
      init(_c, state) {
        const posToId = new Map<number, string>();
        state.doc.descendants((node, pos) => {
          if (node.type.name === 'jsxComponent') {
            posToId.set(pos, `b${pos}`);
          }
          return true;
        });
        return {
          yElementToId: new WeakMap(),
          posToId,
          counter: posToId.size,
        };
      },
      apply(_tr, value) {
        return value;
      },
    },
  });
}

/** Plugin stub that mirrors the real plugin's state shape so we can run
 *  `EditorState.create({plugins: [stub]})` and walk `apply` semantics. We
 *  can't use the real plugin here because it pulls in TipTap's Extension
 *  machinery. `deriveBlockSelection` is the testable unit. */
function makeStubPlugin() {
  return new Plugin<BlockSelection>({
    key: selectionStatePluginKey,
    state: {
      init: (_c, s) => deriveBlockSelection(s, EMPTY),
      apply: (tr, prev, _o, newState) => {
        const metaOrigin = tr.getMeta(SELECTION_ORIGIN_META_KEY);
        return deriveBlockSelection(newState, prev, {
          origin: metaOrigin ?? prev.selectionOrigin,
        });
      },
    },
  });
}

function makeStateFromDoc(doc: ReturnType<Schema['node']>) {
  return EditorState.create({ doc, plugins: [makeStubPlugin()] });
}

// ── Doc builders (ergonomics) ────────────────────────────────────────────

const p = (text = ''): ReturnType<Schema['node']> =>
  text ? schema.node('paragraph', null, [schema.text(text)]) : schema.node('paragraph');

const jsx = (
  componentName: string,
  children: ReturnType<Schema['node']>[] = [],
): ReturnType<Schema['node']> => schema.node('jsxComponent', { componentName }, children);

// ── Tests ────────────────────────────────────────────────────────────────

describe('deriveAncestorChain', () => {
  test('returns empty chain when selection is outside any jsxComponent', () => {
    const doc = schema.node('doc', null, [p('hello')]);
    const state = makeStateFromDoc(doc);
    const chain = deriveAncestorChain(
      state,
      TextSelection.create(doc, 1), // cursor in paragraph
    );
    expect(chain).toEqual([]);
  });

  test('returns single entry for NodeSelection on top-level jsxComponent', () => {
    const card = jsx('Card', [p('body')]);
    const doc = schema.node('doc', null, [card]);
    const state = makeStateFromDoc(doc);
    const chain = deriveAncestorChain(state, NodeSelection.create(doc, 0));
    expect(chain).toHaveLength(1);
    expect(chain[0].componentName).toBe('Card');
    expect(chain[0].pos).toBe(0);
    expect(chain[0].bridgeId).toMatch(/^pos-0$|^b\d+$/); // fallback or real bridgeId
  });

  test('returns two-entry chain for nested Card-in-Cards NodeSelection on inner', () => {
    const inner = jsx('Card', [p('inner')]);
    const outer = jsx('Cards', [inner]);
    const doc = schema.node('doc', null, [outer]);
    const state = makeStateFromDoc(doc);
    // The inner Card sits at position 1 (inside outer which starts at 0).
    const chain = deriveAncestorChain(state, NodeSelection.create(doc, 1));
    expect(chain).toHaveLength(2);
    expect(chain[0].componentName).toBe('Cards');
    expect(chain[1].componentName).toBe('Card');
  });

  test('TextSelection inside a jsxComponent maps to that component as innermost', () => {
    const card = jsx('Card', [p('hello')]);
    const doc = schema.node('doc', null, [card]);
    const state = makeStateFromDoc(doc);
    // Cursor inside the paragraph text inside the Card.
    // Positions: <doc 0><card 1><p 2>h e l l o</p><card/></doc>
    //   card opens at 0, p opens at 1, text starts at 2.
    const chain = deriveAncestorChain(state, TextSelection.create(doc, 3));
    expect(chain).toHaveLength(1);
    expect(chain[0].componentName).toBe('Card');
  });

  test('deeply nested chain preserves outer→inner order', () => {
    // <Cards><Card><Steps><Step><p/></Step></Steps></Card></Cards>
    const step = jsx('Step', [p('s')]);
    const steps = jsx('Steps', [step]);
    const card = jsx('Card', [steps]);
    const cards = jsx('Cards', [card]);
    const doc = schema.node('doc', null, [cards]);
    const state = makeStateFromDoc(doc);
    // NodeSelection on innermost Step — pos should be cards(0) + card(1) + steps(1) + 1 = 3
    const chain = deriveAncestorChain(state, NodeSelection.create(doc, 3));
    expect(chain.map((e) => e.componentName)).toEqual(['Cards', 'Card', 'Steps', 'Step']);
  });
});

describe('deriveBlockSelection', () => {
  test('initial state: empty chain, null selectedBlockId', () => {
    const doc = schema.node('doc', null, [p('hello')]);
    const state = makeStateFromDoc(doc);
    const sel = deriveBlockSelection(state, EMPTY);
    expect(sel.selectedBlockId).toBeNull();
    expect(sel.ancestorChain).toEqual([]);
  });

  test('NodeSelection on jsxComponent populates selectedBlockId', () => {
    const doc = schema.node('doc', null, [jsx('Card', [p('x')])]);
    let state = makeStateFromDoc(doc);
    const tr = state.tr.setSelection(NodeSelection.create(doc, 0));
    state = state.apply(tr);
    const sel = selectionStatePluginKey.getState(state);
    expect(sel?.selectedBlockId).not.toBeNull();
    expect(sel?.ancestorChain).toHaveLength(1);
    expect(sel?.ancestorChain[0].componentName).toBe('Card');
  });

  test('nested selection: selectedBlockId is innermost', () => {
    const inner = jsx('Card');
    const outer = jsx('Cards', [inner]);
    const doc = schema.node('doc', null, [outer]);
    let state = makeStateFromDoc(doc);
    // inner Card at pos 1
    state = state.apply(state.tr.setSelection(NodeSelection.create(doc, 1)));
    const sel = selectionStatePluginKey.getState(state);
    expect(sel?.ancestorChain).toHaveLength(2);
    expect(sel?.ancestorChain[1].componentName).toBe('Card');
    expect(sel?.selectedBlockId).toBe(sel?.ancestorChain[1].bridgeId);
  });

  test('selection moving off a jsxComponent clears selectedBlockId', () => {
    const doc = schema.node('doc', null, [jsx('Card', [p('a')]), p('b')]);
    let state = makeStateFromDoc(doc);
    // Select the Card.
    state = state.apply(state.tr.setSelection(NodeSelection.create(doc, 0)));
    expect(selectionStatePluginKey.getState(state)?.selectedBlockId).not.toBeNull();
    // Move selection into the bare paragraph (outside any jsxComponent).
    // Card nodeSize = 1 (open) + 1 (para open) + 1 (char) + 1 (para close) + 1 (close) = 5.
    // Paragraph 'b' starts at pos 5, text at 6.
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 6)));
    const sel = selectionStatePluginKey.getState(state);
    expect(sel?.selectedBlockId).toBeNull();
    expect(sel?.ancestorChain).toEqual([]);
  });

  test('reference preservation: identical derived state returns prev', () => {
    const doc = schema.node('doc', null, [p('hello')]);
    const state = makeStateFromDoc(doc);
    const sel1 = deriveBlockSelection(state, EMPTY);
    const sel2 = deriveBlockSelection(state, sel1);
    expect(sel2).toBe(sel1); // reference equal — critical for useSyncExternalStore
  });

  test('SELECTION_ORIGIN_META_KEY overrides origin', () => {
    const doc = schema.node('doc', null, [jsx('Card', [p('x')])]);
    let state = makeStateFromDoc(doc);
    const tr = state.tr
      .setSelection(NodeSelection.create(doc, 0))
      .setMeta(SELECTION_ORIGIN_META_KEY, 'programmatic');
    state = state.apply(tr);
    const sel = selectionStatePluginKey.getState(state);
    expect(sel?.selectionOrigin).toBe('programmatic');
  });

  test('ancestorChain entries carry pos matching selection', () => {
    const doc = schema.node('doc', null, [jsx('Card', [p('x')])]);
    const state = makeStateFromDoc(doc);
    const chain = deriveAncestorChain(state, NodeSelection.create(doc, 0));
    expect(chain[0].pos).toBe(0);
  });
});

describe('computeSelectionApply (real plugin apply path)', () => {
  // These tests exercise the real apply pure helper that the production
  // plugin wires up — covering the precedence chain (meta > pending > prev),
  // the consume-on-selection-change semantics, and the refresh-tx exemption.

  const seed = (origin: BlockSelection['selectionOrigin']): BlockSelection => ({
    ...EMPTY,
    selectionOrigin: origin,
  });

  test('pending pointer origin lands on the next selection-change tx', () => {
    const doc = schema.node('doc', null, [jsx('Card', [p('x')])]);
    const state = makeStateFromDoc(doc);
    const runtime: PluginRuntime = { pendingOrigin: 'pointer', isDragging: false };
    const tr = state.tr.setSelection(NodeSelection.create(doc, 0));
    const next = computeSelectionApply(tr, EMPTY, state.apply(tr), runtime);
    expect(next.selectionOrigin).toBe('pointer');
    // pendingOrigin consumed.
    expect(runtime.pendingOrigin).toBeNull();
  });

  test('pending origin is NOT consumed by a tx that does not change selection', () => {
    // Race scenario: user clicks → pendingOrigin='pointer'. Before the
    // user's selection-changing tx arrives, a foreign tx (e.g. y-prosemirror
    // remote sync or a meta-only tx) runs apply. The plugin must NOT
    // consume the pending origin — otherwise the user's actual selection
    // change inherits prev (stale) instead of 'pointer'.
    const doc = schema.node('doc', null, [p('hi')]);
    const state = makeStateFromDoc(doc);
    const runtime: PluginRuntime = { pendingOrigin: 'pointer', isDragging: false };
    const noopTr = state.tr.setMeta('foreign', true); // no selection change
    const after = computeSelectionApply(noopTr, EMPTY, state.apply(noopTr), runtime);
    // Origin not advanced (prev remains); pending preserved for next tx.
    expect(after.selectionOrigin).toBe('programmatic');
    expect(runtime.pendingOrigin).toBe('pointer');
  });

  test('refresh-tagged tx does NOT consume pending origin even if selectionSet', () => {
    // Defense in depth: even if a refresh tx happens to set a selection
    // somehow, the explicit refresh tag exempts it from consumption.
    const doc = schema.node('doc', null, [jsx('Card', [p('x')])]);
    const state = makeStateFromDoc(doc);
    const runtime: PluginRuntime = { pendingOrigin: 'keyboard', isDragging: false };
    const refreshTr = state.tr
      .setSelection(NodeSelection.create(doc, 0))
      .setMeta('selectionStatePlugin/refresh', true);
    const after = computeSelectionApply(refreshTr, EMPTY, state.apply(refreshTr), runtime);
    // Refresh tx did not consume pending — pending still 'keyboard'.
    expect(runtime.pendingOrigin).toBe('keyboard');
    // Origin falls through to prev because pending wasn't consumed.
    expect(after.selectionOrigin).toBe('programmatic');
  });

  test('SELECTION_ORIGIN_META_KEY (meta) overrides pending origin', () => {
    const doc = schema.node('doc', null, [jsx('Card', [p('x')])]);
    const state = makeStateFromDoc(doc);
    const runtime: PluginRuntime = { pendingOrigin: 'pointer', isDragging: false };
    const tr = state.tr
      .setSelection(NodeSelection.create(doc, 0))
      .setMeta(SELECTION_ORIGIN_META_KEY, 'programmatic');
    const after = computeSelectionApply(tr, EMPTY, state.apply(tr), runtime);
    // Meta wins; pending still consumed (selectionSet=true).
    expect(after.selectionOrigin).toBe('programmatic');
    expect(runtime.pendingOrigin).toBeNull();
  });

  test('keyboard pendingOrigin produces selectionOrigin=keyboard', () => {
    const doc = schema.node('doc', null, [jsx('Card', [p('x')])]);
    const state = makeStateFromDoc(doc);
    const runtime: PluginRuntime = { pendingOrigin: 'keyboard', isDragging: false };
    const tr = state.tr.setSelection(NodeSelection.create(doc, 0));
    const after = computeSelectionApply(tr, EMPTY, state.apply(tr), runtime);
    expect(after.selectionOrigin).toBe('keyboard');
  });

  test('isDragging propagates from runtime to next state', () => {
    const doc = schema.node('doc', null, [p('hi')]);
    const state = makeStateFromDoc(doc);
    const runtime: PluginRuntime = { pendingOrigin: null, isDragging: true };
    const tr = state.tr.setMeta('selectionStatePlugin/refresh', true);
    const after = computeSelectionApply(tr, EMPTY, state.apply(tr), runtime);
    expect(after.isDragging).toBe(true);
  });

  test('runtime undefined falls back to prev (no crash)', () => {
    // If the runtime WeakMap entry was somehow GC'd or missing, the apply
    // must not crash; falls back to prev for both origin and isDragging.
    const doc = schema.node('doc', null, [jsx('Card', [p('x')])]);
    const state = makeStateFromDoc(doc);
    const tr = state.tr.setSelection(NodeSelection.create(doc, 0));
    const prev = seed('keyboard');
    const after = computeSelectionApply(tr, prev, state.apply(tr), undefined);
    expect(after.selectionOrigin).toBe('keyboard');
    expect(after.isDragging).toBe(false);
  });
});

describe('rangeEncompassedBlockIds (range-encompass soft halo derivation)', () => {
  /** Doc builder that registers the stub bridge-id plugin so `posToId` is
   *  populated — the rangeEncompass derivation reads it. */
  function makeStateWithBridgeIds(doc: ReturnType<Schema['node']>) {
    return EditorState.create({ doc, plugins: [makeStubBridgeIdPlugin(), makeStubPlugin()] });
  }

  test('TextSelection covering multiple jsxComponents populates the set', () => {
    // Doc: <p>a</p><Callout><p>b</p></Callout><p>c</p><Accordion><p>d</p></Accordion><p>e</p>
    // We expect both Callout AND Accordion bridgeIds in the set when the
    // range covers them entirely.
    const callout = jsx('Callout', [p('b')]);
    const accordion = jsx('Accordion', [p('d')]);
    const doc = schema.node('doc', null, [p('a'), callout, p('c'), accordion, p('e')]);
    const state = makeStateWithBridgeIds(doc);
    const sel = deriveBlockSelection(
      state,
      EMPTY,
      // override origin so derivation runs cleanly
      { origin: 'programmatic' },
    );
    // Initial selection is at start of doc (TextSelection(0,0)). No range.
    expect(sel.rangeEncompassedBlockIds.size).toBe(0);
    // Apply a TextSelection from doc-start (0) to doc-end. Every
    // jsxComponent should now be encompassed.
    const tr = state.tr.setSelection(TextSelection.create(state.doc, 0, state.doc.content.size));
    const next = state.apply(tr);
    const after = selectionStatePluginKey.getState(next);
    expect(after).toBeDefined();
    // Two jsxComponents present in the doc → both ids in the set.
    expect(after?.rangeEncompassedBlockIds.size).toBe(2);
    // selectedBlockId stays null — this is a TextSelection-shaped range,
    // NOT a NodeSelection-on-one-block.
    expect(after?.selectedBlockId).toBeNull();
  });

  test('NodeSelection produces an empty range-encompassed set', () => {
    const card = jsx('Callout', [p('body')]);
    const doc = schema.node('doc', null, [card]);
    let state = makeStateWithBridgeIds(doc);
    state = state.apply(state.tr.setSelection(NodeSelection.create(doc, 0)));
    const sel = selectionStatePluginKey.getState(state);
    // NodeSelection populates selectedBlockId, leaves rangeEncompassedBlockIds empty.
    expect(sel?.selectedBlockId).not.toBeNull();
    expect(sel?.rangeEncompassedBlockIds.size).toBe(0);
  });

  test('TextSelection inside a jsxComponent (no range) produces an empty set', () => {
    const card = jsx('Callout', [p('body')]);
    const doc = schema.node('doc', null, [card]);
    let state = makeStateWithBridgeIds(doc);
    // Cursor inside the paragraph text inside the Callout — collapsed selection.
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
    const sel = selectionStatePluginKey.getState(state);
    expect(sel?.rangeEncompassedBlockIds.size).toBe(0);
  });

  test('TextSelection range that does NOT fully contain a jsxComponent excludes it', () => {
    // Range covers the first paragraph and dips into the Callout's opening
    // tag but not its full nodeSize — Callout's bridgeId must NOT be in the set.
    const callout = jsx('Callout', [p('body')]);
    const doc = schema.node('doc', null, [p('a'), callout, p('z')]);
    let state = makeStateWithBridgeIds(doc);
    // Doc positions: <doc 0><p 1>a</p 3><callout 3>...
    // Range from 0 to 4 covers the paragraph and the Callout's open tag but
    // not the Callout's full nodeSize.
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 0, 4)));
    const sel = selectionStatePluginKey.getState(state);
    expect(sel?.rangeEncompassedBlockIds.size).toBe(0);
  });

  test('identity preservation: two consecutive derive calls return ===', () => {
    // invariant: identical state → identical reference. Adding the new
    // set field must NOT regress useSyncExternalStore's bail-on-=== gate.
    const callout = jsx('Callout', [p('body')]);
    const doc = schema.node('doc', null, [p('a'), callout, p('z')]);
    const state = makeStateWithBridgeIds(doc);
    const sel1 = deriveBlockSelection(state, EMPTY);
    const sel2 = deriveBlockSelection(state, sel1);
    expect(sel2).toBe(sel1);
  });

  test('identity preservation under range coverage: same range → identical reference', () => {
    // The range-encompass derivation must not break identity preservation
    // when the SAME range is computed twice in a row (e.g., a foreign tx
    // re-runs apply without changing selection).
    const callout = jsx('Callout', [p('body')]);
    const doc = schema.node('doc', null, [p('a'), callout, p('z')]);
    let state = makeStateWithBridgeIds(doc);
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 0, state.doc.content.size)),
    );
    const prev = selectionStatePluginKey.getState(state) as BlockSelection;
    const next = deriveBlockSelection(state, prev);
    expect(next).toBe(prev);
  });

  test('two BlockSelections with same-size-but-different rangeEncompassed sets are NOT identity-equal', () => {
    // Defends against a future optimization that compares set sizes alone
    // (skipping the per-element `.has()` loop in `blockSelectionEqual`):
    // a size-only comparison would silently preserve identity across two
    // semantically different selection states, breaking useSyncExternalStore's
    // change detection and leaving the halo paint stale across consecutive
    // drag-select revisions. Two wrapped Callouts at different positions; a
    // range that covers exactly the first, then a range that covers exactly
    // the second — both sets are size 1 with different ids.
    const docNode = schema.node('doc', null, [
      p('a'),
      jsx('Callout', [p('one')]),
      p('mid'),
      jsx('Callout', [p('two')]),
      p('z'),
    ]);
    let state = makeStateWithBridgeIds(docNode);
    // First range — encompass only the first Callout. Find its bounds.
    const firstCalloutPos = 3; // <p>a</p>(0..2) → 3 is the first Callout start
    const firstCalloutNode = state.doc.nodeAt(firstCalloutPos);
    if (!firstCalloutNode || firstCalloutNode.type.name !== 'jsxComponent') {
      throw new Error('test fixture: expected jsxComponent at pos 3');
    }
    const firstEnd = firstCalloutPos + firstCalloutNode.nodeSize;
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, firstCalloutPos, firstEnd)),
    );
    const selA = selectionStatePluginKey.getState(state) as BlockSelection;
    expect(selA.rangeEncompassedBlockIds.size).toBe(1);

    // Second range — encompass only the second Callout. Both sets are
    // size-1 but contain DIFFERENT bridgeIds.
    let secondCalloutPos = -1;
    state.doc.descendants((node, pos) => {
      if (secondCalloutPos !== -1) return false;
      if (node.type.name === 'jsxComponent' && pos > firstCalloutPos) {
        secondCalloutPos = pos;
        return false;
      }
      return true;
    });
    if (secondCalloutPos === -1) throw new Error('test fixture: second jsxComponent not found');
    const secondCalloutNode = state.doc.nodeAt(secondCalloutPos);
    if (!secondCalloutNode) throw new Error('test fixture: secondCallout disappeared');
    const secondEnd = secondCalloutPos + secondCalloutNode.nodeSize;
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, secondCalloutPos, secondEnd)),
    );
    const selB = selectionStatePluginKey.getState(state) as BlockSelection;
    expect(selB.rangeEncompassedBlockIds.size).toBe(1);

    // Both same size, different ids → must NOT be identity-equal. If they
    // were, the React layer would skip the re-render and the soft halo
    // would stay painted on the first Callout instead of moving to the second.
    expect(selB).not.toBe(selA);
    const idsA = Array.from(selA.rangeEncompassedBlockIds);
    const idsB = Array.from(selB.rangeEncompassedBlockIds);
    expect(idsA[0]).not.toBe(idsB[0]);
  });
});

describe('BlockSelection shape invariants', () => {
  test('selectedBlockId matches ancestorChain[last].bridgeId when non-null', () => {
    const doc = schema.node('doc', null, [jsx('Card', [p('x')])]);
    let state = makeStateFromDoc(doc);
    state = state.apply(state.tr.setSelection(NodeSelection.create(doc, 0)));
    const sel = selectionStatePluginKey.getState(state);
    expect(sel?.selectedBlockId).not.toBeNull();
    expect(sel?.selectedBlockId).toBe(sel?.ancestorChain[sel.ancestorChain.length - 1].bridgeId);
  });

  test('selectedBlockId is null iff ancestorChain is empty', () => {
    const doc = schema.node('doc', null, [p('hi')]);
    const state = makeStateFromDoc(doc);
    const sel = selectionStatePluginKey.getState(state);
    expect(sel?.selectedBlockId).toBeNull();
    expect(sel?.ancestorChain).toEqual([]);
  });

  test('isDragging defaults to false on init', () => {
    const doc = schema.node('doc', null, [p('hi')]);
    const state = makeStateFromDoc(doc);
    const sel = selectionStatePluginKey.getState(state);
    expect(sel?.isDragging).toBe(false);
  });
});

// ── isBlockNavigationKey — the origin-classification key list ────────────
// Exported so this table can assert every key we tag as 'keyboard' origin.
// The keydown handler itself is exercised only by E2E (ArrowDown);
// this table guards against silent regressions if someone trims the list
// (e.g. drops Home/End/PageUp/PageDown for being "not arrows").
describe('isBlockNavigationKey', () => {
  test.each([
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Tab',
    'Escape',
    'Enter',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ])('returns true for navigation key %s', (key) => {
    expect(isBlockNavigationKey(key)).toBe(true);
  });

  test.each([
    'a',
    '1',
    ' ',
    'Shift',
    'Control',
    'Meta',
    'F1',
    '',
  ])('returns false for non-navigation key %p', (key) => {
    expect(isBlockNavigationKey(key)).toBe(false);
  });
});
