
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


const p = (text = ''): ReturnType<Schema['node']> =>
  text ? schema.node('paragraph', null, [schema.text(text)]) : schema.node('paragraph');

const jsx = (
  componentName: string,
  children: ReturnType<Schema['node']>[] = [],
): ReturnType<Schema['node']> => schema.node('jsxComponent', { componentName }, children);


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
    const chain = deriveAncestorChain(state, NodeSelection.create(doc, 1));
    expect(chain).toHaveLength(2);
    expect(chain[0].componentName).toBe('Cards');
    expect(chain[1].componentName).toBe('Card');
  });

  test('TextSelection inside a jsxComponent maps to that component as innermost', () => {
    const card = jsx('Card', [p('hello')]);
    const doc = schema.node('doc', null, [card]);
    const state = makeStateFromDoc(doc);
    const chain = deriveAncestorChain(state, TextSelection.create(doc, 3));
    expect(chain).toHaveLength(1);
    expect(chain[0].componentName).toBe('Card');
  });

  test('deeply nested chain preserves outer→inner order', () => {
    const step = jsx('Step', [p('s')]);
    const steps = jsx('Steps', [step]);
    const card = jsx('Card', [steps]);
    const cards = jsx('Cards', [card]);
    const doc = schema.node('doc', null, [cards]);
    const state = makeStateFromDoc(doc);
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
    state = state.apply(state.tr.setSelection(NodeSelection.create(doc, 1)));
    const sel = selectionStatePluginKey.getState(state);
    expect(sel?.ancestorChain).toHaveLength(2);
    expect(sel?.ancestorChain[1].componentName).toBe('Card');
    expect(sel?.selectedBlockId).toBe(sel?.ancestorChain[1].bridgeId);
  });

  test('selection moving off a jsxComponent clears selectedBlockId', () => {
    const doc = schema.node('doc', null, [jsx('Card', [p('a')]), p('b')]);
    let state = makeStateFromDoc(doc);
    state = state.apply(state.tr.setSelection(NodeSelection.create(doc, 0)));
    expect(selectionStatePluginKey.getState(state)?.selectedBlockId).not.toBeNull();
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
    expect(runtime.pendingOrigin).toBeNull();
  });

  test('pending origin is NOT consumed by a tx that does not change selection', () => {
    const doc = schema.node('doc', null, [p('hi')]);
    const state = makeStateFromDoc(doc);
    const runtime: PluginRuntime = { pendingOrigin: 'pointer', isDragging: false };
    const noopTr = state.tr.setMeta('foreign', true); // no selection change
    const after = computeSelectionApply(noopTr, EMPTY, state.apply(noopTr), runtime);
    expect(after.selectionOrigin).toBe('programmatic');
    expect(runtime.pendingOrigin).toBe('pointer');
  });

  test('refresh-tagged tx does NOT consume pending origin even if selectionSet', () => {
    const doc = schema.node('doc', null, [jsx('Card', [p('x')])]);
    const state = makeStateFromDoc(doc);
    const runtime: PluginRuntime = { pendingOrigin: 'keyboard', isDragging: false };
    const refreshTr = state.tr
      .setSelection(NodeSelection.create(doc, 0))
      .setMeta('selectionStatePlugin/refresh', true);
    const after = computeSelectionApply(refreshTr, EMPTY, state.apply(refreshTr), runtime);
    expect(runtime.pendingOrigin).toBe('keyboard');
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
    const callout = jsx('Callout', [p('b')]);
    const accordion = jsx('Accordion', [p('d')]);
    const doc = schema.node('doc', null, [p('a'), callout, p('c'), accordion, p('e')]);
    const state = makeStateWithBridgeIds(doc);
    const sel = deriveBlockSelection(
      state,
      EMPTY,
      { origin: 'programmatic' },
    );
    expect(sel.rangeEncompassedBlockIds.size).toBe(0);
    const tr = state.tr.setSelection(TextSelection.create(state.doc, 0, state.doc.content.size));
    const next = state.apply(tr);
    const after = selectionStatePluginKey.getState(next);
    expect(after).toBeDefined();
    expect(after?.rangeEncompassedBlockIds.size).toBe(2);
    expect(after?.selectedBlockId).toBeNull();
  });

  test('NodeSelection produces an empty range-encompassed set', () => {
    const card = jsx('Callout', [p('body')]);
    const doc = schema.node('doc', null, [card]);
    let state = makeStateWithBridgeIds(doc);
    state = state.apply(state.tr.setSelection(NodeSelection.create(doc, 0)));
    const sel = selectionStatePluginKey.getState(state);
    expect(sel?.selectedBlockId).not.toBeNull();
    expect(sel?.rangeEncompassedBlockIds.size).toBe(0);
  });

  test('TextSelection inside a jsxComponent (no range) produces an empty set', () => {
    const card = jsx('Callout', [p('body')]);
    const doc = schema.node('doc', null, [card]);
    let state = makeStateWithBridgeIds(doc);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
    const sel = selectionStatePluginKey.getState(state);
    expect(sel?.rangeEncompassedBlockIds.size).toBe(0);
  });

  test('TextSelection range that does NOT fully contain a jsxComponent excludes it', () => {
    const callout = jsx('Callout', [p('body')]);
    const doc = schema.node('doc', null, [p('a'), callout, p('z')]);
    let state = makeStateWithBridgeIds(doc);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 0, 4)));
    const sel = selectionStatePluginKey.getState(state);
    expect(sel?.rangeEncompassedBlockIds.size).toBe(0);
  });

  test('identity preservation: two consecutive derive calls return ===', () => {
    const callout = jsx('Callout', [p('body')]);
    const doc = schema.node('doc', null, [p('a'), callout, p('z')]);
    const state = makeStateWithBridgeIds(doc);
    const sel1 = deriveBlockSelection(state, EMPTY);
    const sel2 = deriveBlockSelection(state, sel1);
    expect(sel2).toBe(sel1);
  });

  test('identity preservation under range coverage: same range → identical reference', () => {
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
    const docNode = schema.node('doc', null, [
      p('a'),
      jsx('Callout', [p('one')]),
      p('mid'),
      jsx('Callout', [p('two')]),
      p('z'),
    ]);
    let state = makeStateWithBridgeIds(docNode);
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
