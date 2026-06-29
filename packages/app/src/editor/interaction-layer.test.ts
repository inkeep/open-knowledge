import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createInteractionLayer,
  type InteractionControls,
  InteractionLayerStore,
  type RegisterParams,
  resolveClickTargetNodeId,
} from './interaction-layer';

interface FakeElement {
  attrs: Record<string, string>;
  parentElement: FakeElement | null;
  getAttribute(key: string): string | null;
}

function makeElement(attrs: Record<string, string> = {}): FakeElement {
  return {
    attrs,
    parentElement: null,
    getAttribute(key) {
      return this.attrs[key] ?? null;
    },
  };
}

function makeControls(): InteractionControls {
  return {
    propPanel: ({ nodeId }) => `panel-${nodeId}`,
  };
}

function makeReg(nodeId: string, type = 'internalLink'): RegisterParams {
  return { nodeId, type, controls: makeControls() };
}

describe('InteractionLayerStore — register / deregister round-trip', () => {
  test('fresh store has no active and no registrations', () => {
    const s = new InteractionLayerStore();
    expect(s.getActiveNode()).toBeNull();
    expect(s.getRegistration('m1')).toBeUndefined();
    expect(s.hasRegistration('m1')).toBe(false);
  });

  test('register then getRegistration returns the registered entry', () => {
    const s = new InteractionLayerStore();
    const reg = makeReg('m1');
    s.register(reg);
    expect(s.getRegistration('m1')).toBe(reg);
    expect(s.hasRegistration('m1')).toBe(true);
  });

  test('deregister removes + returns hasRegistration false', () => {
    const s = new InteractionLayerStore();
    s.register(makeReg('m1'));
    s.deregister('m1');
    expect(s.hasRegistration('m1')).toBe(false);
    expect(s.getRegistration('m1')).toBeUndefined();
  });

  test('register with same nodeId overwrites (last-writer-wins)', () => {
    const s = new InteractionLayerStore();
    const a = makeReg('m1', 'a');
    const b = makeReg('m1', 'b');
    s.register(a);
    s.register(b);
    expect(s.getRegistration('m1')).toBe(b);
  });

  test('deregister for unknown nodeId is a no-op', () => {
    const s = new InteractionLayerStore();
    s.deregister('never-existed');
    expect(s.hasRegistration('never-existed')).toBe(false);
  });
});

describe('InteractionLayerStore — setActiveNode transitions', () => {
  test('setActiveNode to a registered id sets active', () => {
    const s = new InteractionLayerStore();
    s.register(makeReg('m1'));
    s.setActiveNode('m1');
    expect(s.getActiveNode()).toBe('m1');
  });

  test('setActiveNode to an UNREGISTERED id is a no-op', () => {
    const s = new InteractionLayerStore();
    s.setActiveNode('never-registered');
    expect(s.getActiveNode()).toBeNull();
  });

  test('setActiveNode(null) dismisses the active state (AC: setActiveNode(null) hides panel)', () => {
    const s = new InteractionLayerStore();
    s.register(makeReg('m1'));
    s.setActiveNode('m1');
    expect(s.getActiveNode()).toBe('m1');
    s.setActiveNode(null);
    expect(s.getActiveNode()).toBeNull();
  });

  test('deregister of the active node clears active', () => {
    const s = new InteractionLayerStore();
    s.register(makeReg('m1'));
    s.setActiveNode('m1');
    s.deregister('m1');
    expect(s.getActiveNode()).toBeNull();
  });
});

describe('InteractionLayerStore — subscribe / getSnapshot', () => {
  test('getSnapshot is identity-stable between notifies (React tearing guard)', () => {
    const s = new InteractionLayerStore();
    const snap1 = s.getSnapshot();
    const snap2 = s.getSnapshot();
    expect(snap1).toBe(snap2);
  });

  test('snapshot identity changes on setActiveNode', () => {
    const s = new InteractionLayerStore();
    s.register(makeReg('m1'));
    const before = s.getSnapshot();
    s.setActiveNode('m1');
    const after = s.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.activeNodeId).toBe('m1');
  });

  test('snapshot identity changes on deregister that affects active', () => {
    const s = new InteractionLayerStore();
    s.register(makeReg('m1'));
    s.setActiveNode('m1');
    const before = s.getSnapshot();
    s.deregister('m1');
    const after = s.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.active).toBeNull();
  });

  test('snapshot identity does NOT change when register without affecting active', () => {
    const s = new InteractionLayerStore();
    const before = s.getSnapshot();
    s.register(makeReg('m2'));
    const after = s.getSnapshot();
    expect(after).toBe(before);
  });

  test('subscribe callback fires on active transitions', () => {
    const s = new InteractionLayerStore();
    s.register(makeReg('m1'));
    let fires = 0;
    s.subscribe(() => {
      fires++;
    });
    s.setActiveNode('m1');
    expect(fires).toBe(1);
    s.setActiveNode(null);
    expect(fires).toBe(2);
  });

  test('unsubscribe callback stops further firings', () => {
    const s = new InteractionLayerStore();
    s.register(makeReg('m1'));
    let fires = 0;
    const unsub = s.subscribe(() => {
      fires++;
    });
    unsub();
    s.setActiveNode('m1');
    expect(fires).toBe(0);
  });

  test('no-op transitions do NOT fire subscribers', () => {
    const s = new InteractionLayerStore();
    s.register(makeReg('m1'));
    let fires = 0;
    s.subscribe(() => {
      fires++;
    });
    s.setActiveNode(null); // already null
    expect(fires).toBe(0);
  });
});

describe('InteractionLayerStore — clear()', () => {
  test('clears registry + active + fires subscriber', () => {
    const s = new InteractionLayerStore();
    s.register(makeReg('m1'));
    s.register(makeReg('m2'));
    s.setActiveNode('m1');
    let fires = 0;
    s.subscribe(() => {
      fires++;
    });
    s.clear();
    expect(s.hasRegistration('m1')).toBe(false);
    expect(s.hasRegistration('m2')).toBe(false);
    expect(s.getActiveNode()).toBeNull();
    expect(fires).toBe(1);
  });
});

describe('resolveClickTargetNodeId — event-delegation walk', () => {
  test('returns null when target is null', () => {
    const s = new InteractionLayerStore();
    expect(resolveClickTargetNodeId(null, s)).toBeNull();
  });

  test('returns null when no ancestor carries a data-*-id attribute', () => {
    const s = new InteractionLayerStore();
    const root = makeElement();
    const child = makeElement();
    child.parentElement = root;
    expect(resolveClickTargetNodeId(child as unknown as EventTarget, s)).toBeNull();
  });

  test('returns the mark-id when the target itself carries data-mark-id', () => {
    const s = new InteractionLayerStore();
    s.register(makeReg('m1'));
    const chip = makeElement({ 'data-mark-id': 'm1' });
    expect(resolveClickTargetNodeId(chip as unknown as EventTarget, s)).toBe('m1');
  });

  test('walks up the parent chain to find the closest ancestor carrying data-mark-id', () => {
    const s = new InteractionLayerStore();
    s.register(makeReg('m1'));
    const chip = makeElement({ 'data-mark-id': 'm1' });
    const textInsideChip = makeElement();
    textInsideChip.parentElement = chip;
    expect(resolveClickTargetNodeId(textInsideChip as unknown as EventTarget, s)).toBe('m1');
  });

  test('prefers data-mark-id over data-node-id on the same element', () => {
    const s = new InteractionLayerStore();
    s.register(makeReg('m1'));
    s.register(makeReg('n1', 'jsxComponent'));
    const chip = makeElement({ 'data-mark-id': 'm1', 'data-node-id': 'n1' });
    expect(resolveClickTargetNodeId(chip as unknown as EventTarget, s)).toBe('m1');
  });

  test('returns null for data-*-id values that are NOT registered (stale chip)', () => {
    const s = new InteractionLayerStore();
    const chip = makeElement({ 'data-mark-id': 'orphan' });
    expect(resolveClickTargetNodeId(chip as unknown as EventTarget, s)).toBeNull();
  });

  test('nested chips: inner chip wins over outer', () => {
    const s = new InteractionLayerStore();
    s.register(makeReg('outer'));
    s.register(makeReg('inner'));
    const outer = makeElement({ 'data-mark-id': 'outer' });
    const inner = makeElement({ 'data-mark-id': 'inner' });
    inner.parentElement = outer;
    expect(resolveClickTargetNodeId(inner as unknown as EventTarget, s)).toBe('inner');
  });

  test('data-node-id also resolves (for NodeView consumers)', () => {
    const s = new InteractionLayerStore();
    s.register(makeReg('n1', 'jsxComponent'));
    const chip = makeElement({ 'data-node-id': 'n1' });
    expect(resolveClickTargetNodeId(chip as unknown as EventTarget, s)).toBe('n1');
  });
});

describe('createInteractionLayer — handle API without DOM', () => {
  beforeEach(() => {});
  afterEach(() => {});

  test('handle exposes register / deregister / setActiveNode / destroy', () => {
    const editor = { editorView: { dom: null as unknown as HTMLElement } }; // DOM unavailable
    const layer = createInteractionLayer({ editor });
    expect(typeof layer.register).toBe('function');
    expect(typeof layer.deregister).toBe('function');
    expect(typeof layer.setActiveNode).toBe('function');
    expect(typeof layer.getActiveNode).toBe('function');
    expect(typeof layer.getRegistration).toBe('function');
    expect(typeof layer.destroy).toBe('function');
    layer.destroy();
  });

  test('register + getRegistration roundtrip through handle', () => {
    const editor = { editorView: { dom: null as unknown as HTMLElement } };
    const layer = createInteractionLayer({ editor });
    layer.register(makeReg('m1'));
    expect(layer.getRegistration('m1')?.nodeId).toBe('m1');
    layer.destroy();
  });

  test('setActiveNode + getActiveNode roundtrip through handle', () => {
    const editor = { editorView: { dom: null as unknown as HTMLElement } };
    const layer = createInteractionLayer({ editor });
    layer.register(makeReg('m1'));
    layer.setActiveNode('m1');
    expect(layer.getActiveNode()).toBe('m1');
    layer.destroy();
  });

  test('destroy is idempotent (can be called twice without throwing)', () => {
    const editor = { editorView: { dom: null as unknown as HTMLElement } };
    const layer = createInteractionLayer({ editor });
    layer.register(makeReg('m1'));
    layer.destroy();
    expect(() => layer.destroy()).not.toThrow();
  });

  test('destroy clears the registry (subsequent register still works but active is gone)', () => {
    const editor = { editorView: { dom: null as unknown as HTMLElement } };
    const layer = createInteractionLayer({ editor });
    layer.register(makeReg('m1'));
    layer.setActiveNode('m1');
    layer.destroy();
    expect(layer.getActiveNode()).toBeNull();
    expect(layer.getRegistration('m1')).toBeUndefined();
  });

  test('deregister of active clears active (propagates through handle)', () => {
    const editor = { editorView: { dom: null as unknown as HTMLElement } };
    const layer = createInteractionLayer({ editor });
    layer.register(makeReg('m1'));
    layer.setActiveNode('m1');
    expect(layer.getActiveNode()).toBe('m1');
    layer.deregister('m1');
    expect(layer.getActiveNode()).toBeNull();
    layer.destroy();
  });
});

describe('InteractionControls — extension-point shape', () => {
  test('register accepts a controls bag with just propPanel (V2 default)', () => {
    const s = new InteractionLayerStore();
    const controls: InteractionControls = {
      propPanel: ({ nodeId }) => `panel-${nodeId}`,
    };
    s.register({ nodeId: 'm1', type: 'internalLink', controls });
    expect(s.getRegistration('m1')?.controls.propPanel).toBe(controls.propPanel);
    expect(s.getRegistration('m1')?.controls.toolbar).toBeUndefined();
  });

  test('register accepts a controls bag with toolbar + breadcrumb (CB-v2 shape)', () => {
    const s = new InteractionLayerStore();
    const controls: InteractionControls = {
      propPanel: () => 'p',
      toolbar: () => 't',
      breadcrumb: () => 'b',
    };
    s.register({ nodeId: 'n1', type: 'jsxComponent', controls });
    const r = s.getRegistration('n1');
    expect(r?.controls.propPanel).toBeDefined();
    expect(r?.controls.toolbar).toBeDefined();
    expect(r?.controls.breadcrumb).toBeDefined();
  });
});

describe('RegisterParams.handlePrimary (review Critical #3 / Major #4)', () => {
  test('store persists a handlePrimary hook alongside controls', () => {
    const s = new InteractionLayerStore();
    const calls: Array<{ nodeId: string; type: string; newTab: boolean }> = [];
    s.register({
      nodeId: 'm1',
      type: 'internalLink',
      controls: { propPanel: () => null },
      handlePrimary: (ctx) => {
        calls.push({ nodeId: ctx.nodeId, type: ctx.type, newTab: ctx.newTab });
        return true;
      },
    });
    const reg = s.getRegistration('m1');
    expect(reg?.handlePrimary).toBeDefined();
    const handled = reg?.handlePrimary?.({ nodeId: 'm1', type: 'internalLink', newTab: true });
    expect(handled).toBe(true);
    expect(calls).toEqual([{ nodeId: 'm1', type: 'internalLink', newTab: true }]);
  });

  test('returning false/void from handlePrimary lets caller fall through', () => {
    const s = new InteractionLayerStore();
    s.register({
      nodeId: 'm2',
      type: 'internalLink',
      controls: { propPanel: () => null },
      handlePrimary: () => false,
    });
    const reg = s.getRegistration('m2');
    const handled = reg?.handlePrimary?.({ nodeId: 'm2', type: 'internalLink', newTab: false });
    expect(handled).toBe(false);
  });

  test('registrations without handlePrimary are unaffected (rich NodeViews)', () => {
    const s = new InteractionLayerStore();
    s.register({
      nodeId: 'n1',
      type: 'jsxComponent',
      controls: { propPanel: () => 'panel' },
    });
    const reg = s.getRegistration('n1');
    expect(reg?.handlePrimary).toBeUndefined();
  });
});
