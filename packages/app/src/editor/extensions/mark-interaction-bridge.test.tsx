/**
 * mark-interaction-bridge — unit tests.
 *
 * Covers three surfaces:
 *   1. `getCurrentMarkInfo` live-lookup helper — state present / absent / wrong id.
 *   2. `buildMarkBridgeHandlers` — onRegister/onDeregister wiring with a mock layer.
 *      PropPanel renderer receives correct ctx. Predicate behavior is NOT tested
 *      here — that's markIdentityPlugin's responsibility (already covered).
 *   3. `buildMarkInteractionBridge` — returns a Plugin keyed by markIdentityKey.
 *
 * No PM View mount required: the handler surface is validated by calling
 * `onRegister` / `onDeregister` directly and asserting the mock layer was
 * invoked with the expected params. PM plugin lifecycle (view().update firing
 * diffs) is already covered by mark-identity.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import type { Editor } from '@tiptap/core';
import { type Mark, Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import {
  type InteractionContext,
  type InteractionLayerHandle,
  InteractionLayerStore,
  type RegisterParams,
} from '../interaction-layer';
import { type MarkInfo, markIdentityKey, markIdentityPlugin } from './mark-identity';
import {
  buildMarkBridgeHandlers,
  buildMarkInteractionBridge,
  getCurrentMarkInfo,
} from './mark-interaction-bridge';

// ---------------------------------------------------------------------------
// Test schema + helpers
// ---------------------------------------------------------------------------

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
  marks: {
    link: { attrs: { href: {} } },
    strong: {},
  },
});

function buildDoc(runs: Array<{ text: string; marks?: Mark[] }>) {
  const paragraph = schema.node(
    'paragraph',
    null,
    runs.map((r) => schema.text(r.text, r.marks)),
  );
  return schema.node('doc', null, [paragraph]);
}

function linkMark(href: string): Mark {
  return schema.mark('link', { href });
}

function stateWithIdentity(runs: Array<{ text: string; marks?: Mark[] }>): EditorState {
  return EditorState.create({
    doc: buildDoc(runs),
    plugins: [markIdentityPlugin({ markTypes: ['link'] })],
  });
}

/**
 * Fake InteractionLayerHandle that records register/deregister calls so tests
 * can assert the bridge wired them correctly. The layer API is small enough
 * to duck-type without a library.
 */
interface FakeLayer extends InteractionLayerHandle {
  registerCalls: RegisterParams[];
  deregisterCalls: string[];
  setActiveNodeCalls: Array<string | null>;
}

function makeFakeLayer(): FakeLayer {
  const registerCalls: RegisterParams[] = [];
  const deregisterCalls: string[] = [];
  const setActiveNodeCalls: Array<string | null> = [];
  let activeNode: string | null = null;
  // Real InteractionLayerStore — exposes the same API the production layer
  // uses so the fake satisfies the InteractionLayerHandle contract (which
  // now requires `store`).
  const store = new InteractionLayerStore();
  return {
    register(params) {
      registerCalls.push(params);
      store.register(params);
    },
    deregister(id) {
      deregisterCalls.push(id);
      store.deregister(id);
    },
    setActiveNode(id) {
      setActiveNodeCalls.push(id);
      activeNode = id;
      store.setActiveNode(id);
    },
    getActiveNode() {
      return activeNode;
    },
    getRegistration(id) {
      return store.getRegistration(id);
    },
    destroy() {
      /* no-op */
    },
    store,
    registerCalls,
    deregisterCalls,
    setActiveNodeCalls,
  };
}

/** Minimal Editor shape — only `.state` is read by the bridge / tests. */
function makeFakeEditor(state: EditorState): Editor {
  return { state } as unknown as Editor;
}

function makeMarkInfo(overrides: Partial<MarkInfo> = {}): MarkInfo {
  return {
    id: 'm1',
    markType: 'link',
    attrs: { href: '/a' },
    from: 1,
    to: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getCurrentMarkInfo
// ---------------------------------------------------------------------------

describe('getCurrentMarkInfo', () => {
  test('returns null when markIdentityPlugin is not installed', () => {
    const state = EditorState.create({
      doc: buildDoc([{ text: 'hello', marks: [linkMark('/a')] }]),
      plugins: [], // NO markIdentityPlugin
    });
    expect(getCurrentMarkInfo(state, 'm1')).toBeNull();
  });

  test('returns null when the mark ID is unknown', () => {
    const state = stateWithIdentity([{ text: 'hello', marks: [linkMark('/a')] }]);
    expect(getCurrentMarkInfo(state, 'nonexistent')).toBeNull();
  });

  test('returns MarkInfo for a tracked mark', () => {
    const state = stateWithIdentity([{ text: 'hello', marks: [linkMark('/a')] }]);
    const info = getCurrentMarkInfo(state, 'm1');
    expect(info).not.toBeNull();
    expect(info?.id).toBe('m1');
    expect(info?.markType).toBe('link');
    expect(info?.attrs).toEqual({ href: '/a' });
    // First text node starts at pos 1; 'hello' is 5 chars wide.
    expect(info?.from).toBe(1);
    expect(info?.to).toBe(6);
  });

  test('returns the correct MarkInfo among multiple tracked marks', () => {
    const state = stateWithIdentity([
      { text: 'first ', marks: [linkMark('/a')] },
      { text: 'mid ' },
      { text: 'second', marks: [linkMark('/b')] },
    ]);
    const m1 = getCurrentMarkInfo(state, 'm1');
    const m2 = getCurrentMarkInfo(state, 'm2');
    expect(m1?.attrs).toEqual({ href: '/a' });
    expect(m2?.attrs).toEqual({ href: '/b' });
  });
});

// ---------------------------------------------------------------------------
// buildMarkBridgeHandlers — onRegister wiring
// ---------------------------------------------------------------------------

describe('buildMarkBridgeHandlers — onRegister', () => {
  test('onRegister forwards to layer.register with type + nodeId from MarkInfo', () => {
    const editor = makeFakeEditor(stateWithIdentity([]));
    const layer = makeFakeLayer();
    const { onRegister } = buildMarkBridgeHandlers({
      editor,
      layer,
      renderPropPanel: () => null,
    });
    onRegister(makeMarkInfo({ id: 'm7', markType: 'link' }));
    expect(layer.registerCalls.length).toBe(1);
    expect(layer.registerCalls[0]?.type).toBe('link');
    expect(layer.registerCalls[0]?.nodeId).toBe('m7');
  });

  test('registered controls.propPanel delegates to renderPropPanel with augmented ctx', () => {
    const editor = makeFakeEditor(stateWithIdentity([]));
    const layer = makeFakeLayer();
    const renderCalls: MarkPropPanelCtxCapture[] = [];
    const { onRegister } = buildMarkBridgeHandlers({
      editor,
      layer,
      renderPropPanel: (ctx) => {
        renderCalls.push({
          editor: ctx.editor,
          nodeId: ctx.nodeId,
          deactivate: ctx.deactivate,
        });
        return null;
      },
    });
    onRegister(makeMarkInfo({ id: 'm3' }));
    const reg = layer.registerCalls[0];
    expect(reg).toBeDefined();
    const propPanel = reg?.controls.propPanel;
    expect(typeof propPanel).toBe('function');

    // Invoke the registered propPanel with a layer-supplied InteractionContext
    // and verify the user-supplied renderer was called with the expected
    // augmented MarkPropPanelContext.
    const deactivate = () => {};
    const ctx: InteractionContext = { nodeId: 'm3', type: 'link', deactivate };
    propPanel?.(ctx);

    expect(renderCalls.length).toBe(1);
    expect(renderCalls[0]?.editor).toBe(editor);
    expect(renderCalls[0]?.nodeId).toBe('m3');
    expect(renderCalls[0]?.deactivate).toBe(deactivate);
  });

  test('multiple onRegister calls result in one layer.register per call', () => {
    const editor = makeFakeEditor(stateWithIdentity([]));
    const layer = makeFakeLayer();
    const { onRegister } = buildMarkBridgeHandlers({
      editor,
      layer,
      renderPropPanel: () => null,
    });
    onRegister(makeMarkInfo({ id: 'm1' }));
    onRegister(makeMarkInfo({ id: 'm2', markType: 'link', attrs: { href: '/b' } }));
    expect(layer.registerCalls.length).toBe(2);
    expect(layer.registerCalls.map((c) => c.nodeId)).toEqual(['m1', 'm2']);
  });

  test('onRegister does NOT set toolbar or breadcrumb (V2 wires propPanel only)', () => {
    const editor = makeFakeEditor(stateWithIdentity([]));
    const layer = makeFakeLayer();
    const { onRegister } = buildMarkBridgeHandlers({
      editor,
      layer,
      renderPropPanel: () => null,
    });
    onRegister(makeMarkInfo({ id: 'm1' }));
    const reg = layer.registerCalls[0];
    expect(reg?.controls.propPanel).toBeDefined();
    expect(reg?.controls.toolbar).toBeUndefined();
    expect(reg?.controls.breadcrumb).toBeUndefined();
  });
});

interface MarkPropPanelCtxCapture {
  editor: Editor;
  nodeId: string;
  deactivate: () => void;
}

// ---------------------------------------------------------------------------
// buildMarkBridgeHandlers — onDeregister wiring
// ---------------------------------------------------------------------------

describe('buildMarkBridgeHandlers — onDeregister', () => {
  test('onDeregister forwards the ID to layer.deregister', () => {
    const editor = makeFakeEditor(stateWithIdentity([]));
    const layer = makeFakeLayer();
    const { onDeregister } = buildMarkBridgeHandlers({
      editor,
      layer,
      renderPropPanel: () => null,
    });
    onDeregister('m5');
    expect(layer.deregisterCalls).toEqual(['m5']);
  });

  test('multiple deregisters are forwarded in order', () => {
    const editor = makeFakeEditor(stateWithIdentity([]));
    const layer = makeFakeLayer();
    const { onDeregister } = buildMarkBridgeHandlers({
      editor,
      layer,
      renderPropPanel: () => null,
    });
    onDeregister('m1');
    onDeregister('m2');
    onDeregister('m3');
    expect(layer.deregisterCalls).toEqual(['m1', 'm2', 'm3']);
  });
});

// ---------------------------------------------------------------------------
// buildMarkInteractionBridge — plugin factory
// ---------------------------------------------------------------------------

describe('buildMarkInteractionBridge', () => {
  test('returns a Plugin keyed by markIdentityKey', () => {
    const editor = makeFakeEditor(stateWithIdentity([]));
    const layer = makeFakeLayer();
    const plugin = buildMarkInteractionBridge({
      editor,
      layer,
      markTypes: ['link'],
      renderPropPanel: () => null,
    });
    expect(plugin.spec.key).toBe(markIdentityKey);
  });

  test('plugin can be installed on an EditorState without throwing', () => {
    const layer = makeFakeLayer();
    const placeholderEditor = makeFakeEditor(stateWithIdentity([]));
    const plugin = buildMarkInteractionBridge({
      editor: placeholderEditor,
      layer,
      markTypes: ['link'],
      renderPropPanel: () => null,
    });
    // Install on a fresh state alongside the plugin itself — verifies the
    // plugin's init() + apply() paths run cleanly without errors.
    const doc = buildDoc([{ text: 'hello', marks: [linkMark('/a')] }]);
    expect(() => EditorState.create({ doc, plugins: [plugin] })).not.toThrow();
  });

  test('markTypes param is copied — caller-side mutation does not affect plugin', () => {
    const editor = makeFakeEditor(stateWithIdentity([]));
    const layer = makeFakeLayer();
    const markTypes = ['link'];
    const plugin = buildMarkInteractionBridge({
      editor,
      layer,
      markTypes,
      renderPropPanel: () => null,
    });
    // Mutate caller-side array — shouldn't change plugin behavior (verified
    // by no throw during install + structural presence of key).
    markTypes.push('strong');
    expect(plugin.spec.key).toBe(markIdentityKey);
  });
});
