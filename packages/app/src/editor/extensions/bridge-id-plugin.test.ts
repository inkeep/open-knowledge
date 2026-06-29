
import { describe, expect, test } from 'bun:test';
import { Schema } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import {
  assertBridgeIdInvariant,
  BridgeIdPlugin,
  bridgeIdPluginKey,
  getBridgeId,
} from './bridge-id-plugin.ts';

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

  test('selection-change tx preserves IDs at the same positions', () => {
    const doc = schema.node('doc', null, [jsx('Card', [p('hello')])]);
    const state = makeState(doc);
    const initialId = getBridgeId(state, 0);
    expect(initialId).toMatch(/^b\d+$/);

    const tr = state.tr.setSelection(NodeSelection.create(doc, 0));
    const afterState = state.apply(tr);
    expect(tr.docChanged).toBe(false);

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

  test('every jsxComponent in a freshly-init state resolves to a b{N} ID via getWrapperBridgeId', async () => {
    const { getWrapperBridgeId } = await import('./selection-state-plugin.ts');
    const doc = schema.node('doc', null, [
      jsx('Cards', [jsx('Card', [p('a')])]),
      jsx('Callout', [p('b')]),
      jsx('Card'),
    ]);
    const state = makeState(doc);
    state.doc.descendants((node, pos) => {
      if (node.type.name !== 'jsxComponent') return;
      expect(getWrapperBridgeId(state, pos)).toMatch(/^b\d+$/);
    });
  });

  test('after a doc-change tx, every jsxComponent still resolves to a b{N} ID', async () => {
    const { getWrapperBridgeId } = await import('./selection-state-plugin.ts');
    const doc = schema.node('doc', null, [jsx('Card', [p('x')])]);
    const initial = makeState(doc);
    const after = initial.apply(initial.tr.insert(initial.doc.content.size, jsx('Cards')));
    after.doc.descendants((node, pos) => {
      if (node.type.name !== 'jsxComponent') return;
      expect(getWrapperBridgeId(after, pos)).toMatch(/^b\d+$/);
    });
  });
});
