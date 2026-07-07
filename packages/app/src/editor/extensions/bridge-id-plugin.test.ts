/**
 * BridgeIdPlugin unit tests — covers the load-bearing pieces SelectionStatePlugin
 * depends on: stable IDs at init, no-doc-change pos-remap branch, and the
 * uniqueness invariant.
 *
 * Notes on scope:
 *   - These tests run against pure PM `EditorState` without y-prosemirror
 *     binding (the plugin's `findYElementForPos` returns null). That's the
 *     exact path taken at editor init before y-prosemirror has mapped the
 *     fragment, so the no-binding behavior IS production behavior for the
 *     first frames after mount.
 *   - The Y.XmlElement-identity-stable-across-Observer-B-reparse property
 *     requires a real Y.Doc + y-prosemirror harness — covered by the
 *     `assertBridgeIdInvariant` calls in the integration suite. This file
 *     covers the no-binding code paths because that's what's testable
 *     without spinning up a Hocuspocus client.
 */

import { describe, expect, test } from 'bun:test';
import { Schema } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import {
  assertBridgeIdInvariant,
  BridgeIdPlugin,
  bridgeIdPluginKey,
  getBridgeId,
} from './bridge-id-plugin.ts';

// Match the schema used by selection-state-plugin tests so the two
// suites converge on the same node shapes.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    jsxComponent: {
      group: 'block',
      content: 'block*',
      attrs: { componentName: { default: 'Unknown' } },
      selectable: true,
    },
    text: { group: 'inline' },
  },
  marks: {},
});

const p = (text = ''): ReturnType<Schema['node']> =>
  text ? schema.node('paragraph', null, [schema.text(text)]) : schema.node('paragraph');
const jsx = (name: string, children: ReturnType<Schema['node']>[] = []) =>
  schema.node('jsxComponent', { componentName: name }, children);

/** Build an EditorState with the real BridgeIdPlugin's PM plugin installed.
 *  Bypasses TipTap's Extension wiring — addProseMirrorPlugins() returns the
 *  PM plugins directly, which we hand to EditorState.create. */
function makeState(doc: ReturnType<Schema['node']>): EditorState {
  const ext = BridgeIdPlugin;
  // ext.config.addProseMirrorPlugins is bound to a TipTap Extension
  // instance, so we invoke it directly with `this: { editor }` — but the
  // BridgeIdPlugin doesn't actually read editor in addProseMirrorPlugins,
  // so a shim suffices.
  // biome-ignore lint/suspicious/noExplicitAny: PM plugin extraction
  const plugins = (ext.config.addProseMirrorPlugins as any).call({ editor: null });
  return EditorState.create({ doc, plugins });
}

/** Helper: get plugin state, throwing on null so tests fail fast (and so
 *  the type narrows for downstream code without `?.` cascades). */
function getPluginState(state: EditorState) {
  const ps = bridgeIdPluginKey.getState(state);
  if (!ps) throw new Error('bridgeIdPlugin not installed');
  return ps;
}

describe('BridgeIdPlugin.init', () => {
  test('assigns b{N} IDs to every jsxComponent in the initial doc', () => {
    const doc = schema.node('doc', null, [jsx('Cards', [jsx('Card', [p('a')])])]);
    const state = makeState(doc);
    const ps = getPluginState(state);
    expect(ps.posToId.size).toBe(2);
    // Every entry has a `b{N}` shape — even without y-prosemirror binding.
    for (const id of ps.posToId.values()) {
      expect(id).toMatch(/^b\d+$/);
    }
  });

  test('assertBridgeIdInvariant passes after init', () => {
    const doc = schema.node('doc', null, [jsx('Card'), jsx('Cards', [jsx('Card')])]);
    const state = makeState(doc);
    expect(() => assertBridgeIdInvariant(state)).not.toThrow();
  });

  test('all assigned IDs are unique', () => {
    const doc = schema.node('doc', null, [jsx('Card'), jsx('Card'), jsx('Card')]);
    const state = makeState(doc);
    const ids = [...getPluginState(state).posToId.values()];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('BridgeIdPlugin.apply (no-doc-change branch)', () => {
  // This is the load-bearing path SelectionStatePlugin reads on every
  // selection-only transaction. It must remap positions correctly so
  // ancestor-chain bridgeId lookups resolve to the same b{N} ID across
  // selection changes that don't mutate the doc.

  test('selection-change tx preserves IDs at the same positions', () => {
    const doc = schema.node('doc', null, [jsx('Card', [p('hello')])]);
    const state = makeState(doc);
    const initialId = getBridgeId(state, 0);
    expect(initialId).toMatch(/^b\d+$/);

    // Selection-only tx — docChanged should be false.
    const tr = state.tr.setSelection(NodeSelection.create(doc, 0));
    const afterState = state.apply(tr);
    expect(tr.docChanged).toBe(false);

    // ID for the same node at pos 0 must be identical.
    const afterId = getBridgeId(afterState, 0);
    expect(afterId).toBe(initialId);
  });

  test('TextSelection inside a jsxComponent does not invalidate IDs', () => {
    const doc = schema.node('doc', null, [jsx('Card', [p('text')])]);
    const state = makeState(doc);
    const initialId = getBridgeId(state, 0);

    const tr = state.tr.setSelection(TextSelection.create(state.doc, 3));
    const afterState = state.apply(tr);
    expect(tr.docChanged).toBe(false);
    expect(getBridgeId(afterState, 0)).toBe(initialId);
  });

  test('multiple sequential selection-only txs keep IDs stable', () => {
    // Verifies the no-doc-change branch is idempotent across N applies —
    // a regression in pos-remap would surface as drifting IDs after a
    // few selection changes.
    const doc = schema.node('doc', null, [jsx('Cards', [jsx('Card')])]);
    let state = makeState(doc);
    const cardsId = getBridgeId(state, 0);
    const cardId = getBridgeId(state, 1);

    for (let i = 0; i < 5; i++) {
      const sel =
        i % 2 === 0 ? NodeSelection.create(state.doc, 0) : NodeSelection.create(state.doc, 1);
      state = state.apply(state.tr.setSelection(sel));
    }

    expect(getBridgeId(state, 0)).toBe(cardsId);
    expect(getBridgeId(state, 1)).toBe(cardId);
  });
});

describe('BridgeIdPlugin.apply (doc-change branch)', () => {
  test('inserting a jsxComponent assigns a fresh b{N} ID', () => {
    const doc = schema.node('doc', null, [p('hi')]);
    const initial = makeState(doc);
    expect(getPluginState(initial).posToId.size).toBe(0);

    // Insert a jsxComponent at the document end.
    const inserted = initial.apply(initial.tr.insert(initial.doc.content.size, jsx('Card')));
    const ps = getPluginState(inserted);
    expect(ps.posToId.size).toBe(1);
    const id = [...ps.posToId.values()][0];
    expect(id).toMatch(/^b\d+$/);
  });

  test('removing a jsxComponent removes its mapping', () => {
    const doc = schema.node('doc', null, [jsx('Card', [p('x')])]);
    const state = makeState(doc);
    expect(getPluginState(state).posToId.size).toBe(1);

    const firstChild = state.doc.firstChild;
    if (!firstChild) throw new Error('expected at least one child');
    const after = state.apply(state.tr.delete(0, firstChild.nodeSize));
    expect(getPluginState(after).posToId.size).toBe(0);
  });
});

describe('Production unreachability of selection-state-plugin pos-N fallback', () => {
  // The `pos-${pos}` fallback in selection-state-plugin's `getWrapperBridgeId`
  // is documented as unreachable in production because BridgeIdPlugin's `init`
  // assigns b{N} IDs synchronously to every jsxComponent.
  // This test enforces the unreachability claim — if a future change to
  // BridgeIdPlugin breaks the init invariant (priority adjustment, async init,
  // selective initialization), this test catches it before the fallback's
  // halo-flicker / chain-leaf-churn regression silently re-activates.
  //
  // Imports `getWrapperBridgeId` from selection-state-plugin so the assertion
  // is co-located with the actual production call site, not just the
  // bridge-id-plugin's own posToId map.

  test('every jsxComponent in a freshly-init state resolves to a b{N} ID via getWrapperBridgeId', async () => {
    const { getWrapperBridgeId } = await import('./selection-state-plugin.ts');
    const doc = schema.node('doc', null, [
      jsx('Cards', [jsx('Card', [p('a')])]),
      jsx('Callout', [p('b')]),
      jsx('Card'),
    ]);
    const state = makeState(doc);
    // Walk every jsxComponent; assert getWrapperBridgeId returns a b{N} ID,
    // never the pos-N synthetic fallback.
    state.doc.descendants((node, pos) => {
      if (node.type.name !== 'jsxComponent') return;
      expect(getWrapperBridgeId(state, pos)).toMatch(/^b\d+$/);
    });
  });

  test('after a doc-change tx, every jsxComponent still resolves to a b{N} ID', async () => {
    const { getWrapperBridgeId } = await import('./selection-state-plugin.ts');
    const doc = schema.node('doc', null, [jsx('Card', [p('x')])]);
    const initial = makeState(doc);
    // Insert another component — exercises the doc-change branch.
    const after = initial.apply(initial.tr.insert(initial.doc.content.size, jsx('Cards')));
    after.doc.descendants((node, pos) => {
      if (node.type.name !== 'jsxComponent') return;
      expect(getWrapperBridgeId(after, pos)).toMatch(/^b\d+$/);
    });
  });
});
