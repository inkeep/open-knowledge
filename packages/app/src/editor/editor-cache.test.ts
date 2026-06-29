
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { Editor } from '@tiptap/core';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import {
  __consumeRenameSnapshot,
  __getActivityMountList,
  __getCacheOrder,
  __getCacheSize,
  __peekCm,
  __resetCacheForTests,
  __resetRenameSnapshotStore,
  BYTES_CACHE_THRESHOLD,
  CACHE_ENABLED,
  type CmCacheEntry,
  captureRenameSnapshots,
  evictCmEditor,
  evictTiptapEditor,
  MAX_CACHE,
  mountCmEditor,
  mountTiptapEditor,
  parkCmEditor,
  parkTiptapEditor,
  peekRenameSnapshot,
  peekTiptap,
  type RenameSelectionJSON,
  type RenameSnapshot,
  setActivityMountList,
  shouldCacheEditor,
  storeRenameSnapshot,
  subscribePoolEviction,
  type TiptapCacheEntry,
  VIEW_COUNT_CACHE_THRESHOLD,
} from './editor-cache';
import {
  __mountPromiseCacheSize,
  __mountPromiseSettled,
  __resetMountPromiseCache,
  mountTiptapEditorPromise,
} from './mount-promise';


interface FakeNode {
  parentElement: FakeNode | null;
  scrollTop: number;
  children: FakeNode[];
  appendChild(child: FakeNode): FakeNode;
  removeChild(child: FakeNode): FakeNode;
  setAttribute(key: string, value: string): void;
  style: Record<string, string>;
}

function makeNode(): FakeNode {
  const node: FakeNode = {
    parentElement: null,
    scrollTop: 0,
    children: [],
    style: {},
    setAttribute(_key, _value) {
    },
    appendChild(child) {
      if (child.parentElement) child.parentElement.removeChild(child);
      node.children.push(child);
      child.parentElement = node;
      return child;
    },
    removeChild(child) {
      const idx = node.children.indexOf(child);
      if (idx !== -1) node.children.splice(idx, 1);
      child.parentElement = null;
      return child;
    },
  };
  return node;
}


interface FakeTiptapEditorSpies {
  destroyCalls: number;
  focusCalls: number;
  mountCalls: number;
}

function makeFakeTiptapEditor(dom: FakeNode): {
  editor: Editor;
  spies: FakeTiptapEditorSpies;
} {
  const spies: FakeTiptapEditorSpies = { destroyCalls: 0, focusCalls: 0, mountCalls: 0 };
  const editor = {
    editorView: {
      dom,
      scrollDOM: dom,
    },
    commands: {
      focus() {
        spies.focusCalls++;
      },
    },
    mount(target: FakeNode) {
      spies.mountCalls++;
      target.appendChild(dom);
    },
    destroy() {
      spies.destroyCalls++;
    },
    isDestroyed: false,
  } as unknown as Editor;
  return { editor, spies };
}

interface FakeCmViewSpies {
  destroyCalls: number;
  focusCalls: number;
}

function makeFakeCmView(dom: FakeNode): { view: EditorView; spies: FakeCmViewSpies } {
  const spies: FakeCmViewSpies = { destroyCalls: 0, focusCalls: 0 };
  const view = {
    dom,
    scrollDOM: dom,
    focus() {
      spies.focusCalls++;
    },
    destroy() {
      spies.destroyCalls++;
    },
  } as unknown as EditorView;
  return { view, spies };
}


interface FakeProviderSpies {
  destroyCalls: number;
  connectCalls: number;
  disconnectCalls: number;
}

function makeFakeProvider(ydoc: Y.Doc): { provider: HocuspocusProvider; spies: FakeProviderSpies } {
  const spies: FakeProviderSpies = { destroyCalls: 0, connectCalls: 0, disconnectCalls: 0 };
  const provider = {
    document: ydoc,
    destroy() {
      spies.destroyCalls++;
    },
    connect() {
      spies.connectCalls++;
      return Promise.resolve();
    },
    disconnect() {
      spies.disconnectCalls++;
    },
  } as unknown as HocuspocusProvider;
  return { provider, spies };
}


interface TiptapHarness {
  docName: string;
  ydoc: Y.Doc;
  ytext: Y.Text;
  fragment: Y.XmlFragment;
  editor: Editor;
  provider: HocuspocusProvider;
  container: FakeNode;
  editorDom: FakeNode;
  spies: FakeTiptapEditorSpies;
  providerSpies: FakeProviderSpies;
  factoryCallCount: number;
  factory: (container: FakeNode) => {
    editor: Editor;
    ydoc: Y.Doc;
    ytext: Y.Text;
    provider: HocuspocusProvider;
  };
}

function makeTiptapHarness(docName: string): TiptapHarness {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  const fragment = ydoc.getXmlFragment('default');
  const editorDom = makeNode();
  const { editor, spies } = makeFakeTiptapEditor(editorDom);
  const { provider, spies: providerSpies } = makeFakeProvider(ydoc);
  const container = makeNode();
  let factoryCallCount = 0;
  const harness: TiptapHarness = {
    docName,
    ydoc,
    ytext,
    fragment,
    editor,
    provider,
    container,
    editorDom,
    spies,
    providerSpies,
    factoryCallCount: 0,
    factory: (ctr) => {
      factoryCallCount++;
      harness.factoryCallCount = factoryCallCount;
      ctr.appendChild(editorDom);
      return { editor, ydoc, ytext, provider };
    },
  };
  return harness;
}

interface CmHarness {
  docName: string;
  ydoc: Y.Doc;
  ytext: Y.Text;
  view: EditorView;
  provider: HocuspocusProvider;
  container: FakeNode;
  viewDom: FakeNode;
  spies: FakeCmViewSpies;
  providerSpies: FakeProviderSpies;
  factoryCallCount: number;
  themeCompartment: Compartment;
  wordWrapCompartment: Compartment;
  placeholderCompartment: Compartment;
  factory: (container: FakeNode) => {
    view: EditorView;
    ydoc: Y.Doc;
    ytext: Y.Text;
    provider: HocuspocusProvider;
    themeCompartment: Compartment;
    wordWrapCompartment: Compartment;
    placeholderCompartment: Compartment;
  };
}

function makeCmHarness(docName: string): CmHarness {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  const viewDom = makeNode();
  const { view, spies } = makeFakeCmView(viewDom);
  const { provider, spies: providerSpies } = makeFakeProvider(ydoc);
  const container = makeNode();
  const themeCompartment = new Compartment();
  const wordWrapCompartment = new Compartment();
  const placeholderCompartment = new Compartment();
  let factoryCallCount = 0;
  const harness: CmHarness = {
    docName,
    ydoc,
    ytext,
    view,
    provider,
    container,
    viewDom,
    spies,
    providerSpies,
    factoryCallCount: 0,
    themeCompartment,
    wordWrapCompartment,
    placeholderCompartment,
    factory: (ctr) => {
      factoryCallCount++;
      harness.factoryCallCount = factoryCallCount;
      ctr.appendChild(viewDom);
      return {
        view,
        ydoc,
        ytext,
        provider,
        themeCompartment,
        wordWrapCompartment,
        placeholderCompartment,
      };
    },
  };
  return harness;
}


describe('CACHE_ENABLED constant', () => {
  test('is true by default (V2 ships enabled)', () => {
    expect(CACHE_ENABLED).toBe(true);
  });
});

describe('MAX_CACHE constant', () => {
  test('is 10 — coupling to MAX_POOL', () => {
    expect(MAX_CACHE).toBe(10);
  });
});

describe('TipTap cache — lifecycle', () => {
  beforeEach(() => {
    __resetCacheForTests();
  });
  afterEach(() => {
    __resetCacheForTests();
  });

  test('mount: cache-miss calls factory and stores entry', () => {
    const h = makeTiptapHarness('doc-a');
    expect(__getCacheSize('tiptap')).toBe(0);

    const entry = mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });

    expect(h.factoryCallCount).toBe(1);
    expect(__getCacheSize('tiptap')).toBe(1);
    expect(entry.editor).toBe(h.editor);
    expect(entry.ydoc).toBe(h.ydoc);
    expect(entry.ytext).toBe(h.ytext);
    expect(entry.provider).toBe(h.provider);
    expect(entry.activeMountKey).toBe(h.docName);
  });

  test('mount: cache-hit reparents without constructing a new editor', () => {
    const h = makeTiptapHarness('doc-a');
    const first = mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(h.factoryCallCount).toBe(1);

    const newContainer = makeNode();
    const second = mountTiptapEditor({
      docName: h.docName,
      container: newContainer as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });

    expect(h.factoryCallCount).toBe(1);
    expect(second).toBe(first);
    expect(h.editorDom.parentElement).toBe(newContainer);
    expect(h.container.children).not.toContain(h.editorDom);
  });

  test('mount: cache-hit restores scrollTop captured at park', () => {
    const h = makeTiptapHarness('doc-a');
    const entry = mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    h.editorDom.scrollTop = 1234;
    parkTiptapEditor(entry);
    expect(entry.scrollTop).toBe(1234);

    const newContainer = makeNode();
    mountTiptapEditor({
      docName: h.docName,
      container: newContainer as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(newContainer.scrollTop).toBe(1234);
  });

  test('mount: cache-hit restores focus ONLY when editor owned focus at park time', () => {
    const h = makeTiptapHarness('doc-a');
    const entry = mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    const focusCountAfterFirstMount = h.spies.focusCalls;

    parkTiptapEditor(entry);
    expect(entry.hadFocus).toBe(false);
    const newContainerA = makeNode();
    mountTiptapEditor({
      docName: h.docName,
      container: newContainerA as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(h.spies.focusCalls).toBe(focusCountAfterFirstMount);

    entry.hadFocus = true;
    parkTiptapEditor(entry);
    entry.hadFocus = true;
    const newContainerB = makeNode();
    const beforeB = h.spies.focusCalls;
    mountTiptapEditor({
      docName: h.docName,
      container: newContainerB as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(h.spies.focusCalls).toBeGreaterThan(beforeB);
  });

  test('park: detaches DOM from container but does NOT destroy', () => {
    const h = makeTiptapHarness('doc-a');
    const entry = mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(h.editorDom.parentElement).toBe(h.container);

    parkTiptapEditor(entry);

    expect(h.editorDom.parentElement).not.toBe(h.container);
    expect(h.container.children).not.toContain(h.editorDom);
    expect(h.spies.destroyCalls).toBe(0);
    expect(peekTiptap(h.docName)).toBe(entry);
    expect(entry.activeMountKey).toBeNull();
  });

  test('park: clears activeMountKey', () => {
    const h = makeTiptapHarness('doc-a');
    const entry = mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(entry.activeMountKey).toBe(h.docName);
    parkTiptapEditor(entry);
    expect(entry.activeMountKey).toBeNull();
  });

  test('evict: calls destroy on editor + provider + ydoc', () => {
    const h = makeTiptapHarness('doc-a');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    const ydocDestroySpy = mock(h.ydoc.destroy.bind(h.ydoc));
    h.ydoc.destroy = ydocDestroySpy;

    const result = evictTiptapEditor(h.docName);

    expect(result).toBe(true);
    expect(h.spies.destroyCalls).toBe(1);
    expect(h.providerSpies.destroyCalls).toBe(1);
    expect(ydocDestroySpy).toHaveBeenCalledTimes(1);
    expect(peekTiptap(h.docName)).toBeUndefined();
    expect(__getCacheSize('tiptap')).toBe(0);

    expect(evictTiptapEditor(h.docName)).toBe(false);
    expect(h.spies.destroyCalls).toBe(1);
  });

  test('evict: return false for unknown docName', () => {
    expect(evictTiptapEditor('never-existed')).toBe(false);
  });
});

describe('TipTap cache — mount-park-mount round-trip', () => {
  beforeEach(() => __resetCacheForTests());
  afterEach(() => __resetCacheForTests());

  test('doc content preserved (Y.XmlFragment + Y.Text)', () => {
    const h = makeTiptapHarness('doc-a');
    const entry = mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });

    h.ytext.insert(0, 'hello from round-trip');
    const ytextBefore = entry.ytext.toString();
    const fragBefore = h.fragment.toString();
    expect(ytextBefore).toBe('hello from round-trip');

    parkTiptapEditor(entry);

    const newContainer = makeNode();
    const re = mountTiptapEditor({
      docName: h.docName,
      container: newContainer as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(re).toBe(entry);
    expect(re.ytext.toString()).toBe(ytextBefore);
    expect(h.fragment.toString()).toBe(fragBefore);

    re.ydoc.transact(() => {
      re.ytext.insert(re.ytext.length, ' — post-reparent');
    });
    expect(re.ytext.toString()).toBe('hello from round-trip — post-reparent');
  });

  test('5 park-mount cycles work without regression', () => {
    const h = makeTiptapHarness('doc-a');
    const entry = mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    h.ytext.insert(0, 'cycle-test');

    for (let i = 0; i < 5; i++) {
      parkTiptapEditor(entry);
      expect(entry.activeMountKey).toBeNull();

      const ctr = makeNode();
      const re = mountTiptapEditor({
        docName: h.docName,
        container: ctr as unknown as HTMLElement,
        factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
      });
      expect(re).toBe(entry);
      expect(re.activeMountKey).toBe(h.docName);
      expect(re.ytext.toString()).toBe('cycle-test');
      expect(h.editorDom.parentElement).toBe(ctr);
    }

    expect(h.factoryCallCount).toBe(1);
    expect(h.spies.destroyCalls).toBe(0);
  });

  test('multiple docs round-trip independently', () => {
    const a = makeTiptapHarness('doc-a');
    const b = makeTiptapHarness('doc-b');
    mountTiptapEditor({
      docName: a.docName,
      container: a.container as unknown as HTMLElement,
      factory: a.factory as unknown as (el: HTMLElement) => ReturnType<typeof a.factory>,
    });
    mountTiptapEditor({
      docName: b.docName,
      container: b.container as unknown as HTMLElement,
      factory: b.factory as unknown as (el: HTMLElement) => ReturnType<typeof b.factory>,
    });
    a.ytext.insert(0, 'a-content');
    b.ytext.insert(0, 'b-content');

    const peekA = peekTiptap(a.docName);
    const peekB = peekTiptap(b.docName);
    if (!peekA || !peekB) throw new Error('cache entries missing');
    parkTiptapEditor(peekA);
    parkTiptapEditor(peekB);

    const ctrB = makeNode();
    const reB = mountTiptapEditor({
      docName: b.docName,
      container: ctrB as unknown as HTMLElement,
      factory: b.factory as unknown as (el: HTMLElement) => ReturnType<typeof b.factory>,
    });
    expect(reB.ytext.toString()).toBe('b-content');
    expect(a.factoryCallCount).toBe(1);
    expect(b.factoryCallCount).toBe(1);
  });
});

describe('TipTap cache — LRU eviction at MAX_CACHE capacity', () => {
  beforeEach(() => __resetCacheForTests());
  afterEach(() => __resetCacheForTests());

  test('11th mount evicts the LRU entry (oldest first)', () => {
    const harnesses: TiptapHarness[] = [];
    for (let i = 0; i < MAX_CACHE; i++) {
      const h = makeTiptapHarness(`doc-${i}`);
      harnesses.push(h);
      mountTiptapEditor({
        docName: h.docName,
        container: h.container as unknown as HTMLElement,
        factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
      });
    }
    expect(__getCacheSize('tiptap')).toBe(MAX_CACHE);

    expect(harnesses[0].spies.destroyCalls).toBe(0);

    const extra = makeTiptapHarness('doc-extra');
    mountTiptapEditor({
      docName: extra.docName,
      container: extra.container as unknown as HTMLElement,
      factory: extra.factory as unknown as (el: HTMLElement) => ReturnType<typeof extra.factory>,
    });
    expect(__getCacheSize('tiptap')).toBe(MAX_CACHE);
    expect(peekTiptap('doc-0')).toBeUndefined();
    expect(peekTiptap('doc-extra')).toBeDefined();
    expect(harnesses[0].spies.destroyCalls).toBe(1);
  });

  test('mount refreshes LRU order — re-mounting moves to most-recent', () => {
    const harnesses: TiptapHarness[] = [];
    for (let i = 0; i < 3; i++) {
      const h = makeTiptapHarness(`doc-${i}`);
      harnesses.push(h);
      mountTiptapEditor({
        docName: h.docName,
        container: h.container as unknown as HTMLElement,
        factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
      });
    }
    expect(__getCacheOrder('tiptap')).toEqual(['doc-0', 'doc-1', 'doc-2']);

    const harnessA = harnesses[0];
    mountTiptapEditor({
      docName: harnessA.docName,
      container: makeNode() as unknown as HTMLElement,
      factory: harnessA.factory as unknown as (
        el: HTMLElement,
      ) => ReturnType<typeof harnessA.factory>,
    });
    expect(__getCacheOrder('tiptap')).toEqual(['doc-1', 'doc-2', 'doc-0']);
  });
});

describe('TipTap cache — __uncached / kill-switch path', () => {
  beforeEach(() => __resetCacheForTests());
  afterEach(() => __resetCacheForTests());

  test('__uncached entry: park() destroys the editor (pre-V2 behavior)', () => {
    const h = makeTiptapHarness('doc-a');
    h.container.appendChild(h.editorDom);
    const entry: TiptapCacheEntry = {
      editor: h.editor,
      ydoc: h.ydoc,
      ytext: h.ytext,
      provider: h.provider,
      scrollTop: 0,
      hadFocus: false,
      activeMountKey: h.docName,
      __uncached: true,
    };

    expect(h.spies.destroyCalls).toBe(0);
    parkTiptapEditor(entry);
    expect(h.spies.destroyCalls).toBe(1);
    expect(entry.activeMountKey).toBeNull();
  });

  test('__uncached entry: NOT stored in cache (verified by peekTiptap)', () => {
    expect(__getCacheSize('tiptap')).toBe(0);
    const h = makeTiptapHarness('doc-a');
    const entry: TiptapCacheEntry = {
      editor: h.editor,
      ydoc: h.ydoc,
      ytext: h.ytext,
      provider: h.provider,
      scrollTop: 0,
      hadFocus: false,
      activeMountKey: h.docName,
      __uncached: true,
    };
    expect(peekTiptap(h.docName)).toBeUndefined();
    parkTiptapEditor(entry);
    expect(h.spies.destroyCalls).toBe(1);
  });
});

describe('TipTap cache — undoManager.restore cleanup on destroy', () => {

  let originalGetState: typeof yUndoPluginKey.getState;

  beforeEach(() => {
    __resetCacheForTests();
    originalGetState = yUndoPluginKey.getState;
    yUndoPluginKey.getState = ((state: unknown) => {
      const tagged = state as { __testUndoManager?: unknown } | null | undefined;
      if (tagged?.__testUndoManager) {
        return { undoManager: tagged.__testUndoManager } as ReturnType<typeof originalGetState>;
      }
      return originalGetState.call(yUndoPluginKey, state as never);
    }) as typeof originalGetState;
  });

  afterEach(() => {
    yUndoPluginKey.getState = originalGetState;
    __resetCacheForTests();
  });

  function attachStubUndoManager(
    editor: Editor,
  ): { restore: unknown } & { __initialRestore: () => string } {
    const initialRestore = () => 'leak-marker';
    const undoManager = {
      restore: initialRestore as unknown,
      __initialRestore: initialRestore,
    };
    (editor as unknown as { state: unknown }).state = {
      __testUndoManager: undoManager,
    };
    return undoManager;
  }

  test('parkTiptapEditor on __uncached entry clears undoManager.restore after destroy', () => {
    const h = makeTiptapHarness('doc-a');
    const undoManager = attachStubUndoManager(h.editor);
    expect(undoManager.restore).toBe(undoManager.__initialRestore);

    const entry: TiptapCacheEntry = {
      editor: h.editor,
      ydoc: h.ydoc,
      ytext: h.ytext,
      provider: h.provider,
      scrollTop: 0,
      hadFocus: false,
      activeMountKey: h.docName,
      __uncached: true,
    };

    parkTiptapEditor(entry);

    expect(h.spies.destroyCalls).toBe(1);
    expect(undoManager.restore).toBeUndefined();
    expect(entry.activeMountKey).toBeNull();
  });

  test('evictTiptapEditor clears undoManager.restore after destroy', () => {
    const h = makeTiptapHarness('doc-a');
    const undoManager = attachStubUndoManager(h.editor);
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(undoManager.restore).toBe(undoManager.__initialRestore);

    const result = evictTiptapEditor(h.docName);

    expect(result).toBe(true);
    expect(h.spies.destroyCalls).toBe(1);
    expect(h.providerSpies.destroyCalls).toBe(1);
    expect(undoManager.restore).toBeUndefined();
    expect(peekTiptap(h.docName)).toBeUndefined();
  });

  test('cleanup is resilient when editor.destroy() throws', () => {
    const h = makeTiptapHarness('doc-a');
    const undoManager = attachStubUndoManager(h.editor);
    (h.editor as unknown as { destroy: () => void }).destroy = () => {
      h.spies.destroyCalls++;
      throw new Error('throwing-proxy');
    };

    const entry: TiptapCacheEntry = {
      editor: h.editor,
      ydoc: h.ydoc,
      ytext: h.ytext,
      provider: h.provider,
      scrollTop: 0,
      hadFocus: false,
      activeMountKey: h.docName,
      __uncached: true,
    };

    expect(() => parkTiptapEditor(entry)).not.toThrow();
    expect(h.spies.destroyCalls).toBe(1);
    expect(undoManager.restore).toBeUndefined();
  });

  test('evictTiptapEditor capture-before-destroy ordering: state inaccessible AFTER destroy still clears restore', () => {
    const h = makeTiptapHarness('doc-a');
    const undoManager = attachStubUndoManager(h.editor);
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    (h.editor as unknown as { destroy: () => void }).destroy = () => {
      h.spies.destroyCalls++;
      Object.defineProperty(h.editor, 'state', {
        get() {
          throw new Error('state after destroy — TipTap throwing proxy');
        },
        configurable: true,
      });
    };

    const result = evictTiptapEditor(h.docName);

    expect(result).toBe(true);
    expect(h.spies.destroyCalls).toBe(1);
    expect(h.providerSpies.destroyCalls).toBe(1);
    expect(undoManager.restore).toBeUndefined();
    expect(peekTiptap(h.docName)).toBeUndefined();
  });

  test('evictTiptapEditor cleanup is resilient when editor.destroy() throws', () => {
    const h = makeTiptapHarness('doc-a');
    const undoManager = attachStubUndoManager(h.editor);
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    (h.editor as unknown as { destroy: () => void }).destroy = () => {
      h.spies.destroyCalls++;
      throw new Error('throwing-proxy');
    };

    const result = evictTiptapEditor(h.docName);

    expect(result).toBe(true);
    expect(h.spies.destroyCalls).toBe(1);
    expect(h.providerSpies.destroyCalls).toBe(1);
    expect(undoManager.restore).toBeUndefined();
    expect(peekTiptap(h.docName)).toBeUndefined();
  });

  test('capture-before-destroy ordering: state inaccessible AFTER destroy still clears restore', () => {
    const h = makeTiptapHarness('doc-a');
    const undoManager = attachStubUndoManager(h.editor);
    (h.editor as unknown as { destroy: () => void }).destroy = () => {
      h.spies.destroyCalls++;
      Object.defineProperty(h.editor, 'state', {
        get() {
          throw new Error('state after destroy — TipTap throwing proxy');
        },
        configurable: true,
      });
    };

    const entry: TiptapCacheEntry = {
      editor: h.editor,
      ydoc: h.ydoc,
      ytext: h.ytext,
      provider: h.provider,
      scrollTop: 0,
      hadFocus: false,
      activeMountKey: h.docName,
      __uncached: true,
    };

    parkTiptapEditor(entry);

    expect(h.spies.destroyCalls).toBe(1);
    expect(undoManager.restore).toBeUndefined();
  });

  test('no crash when editor.state throws (TipTap throwing-proxy mid-teardown)', () => {
    const h = makeTiptapHarness('doc-a');
    Object.defineProperty(h.editor, 'state', {
      get() {
        throw new Error('throwing-proxy state');
      },
      configurable: true,
    });

    const entry: TiptapCacheEntry = {
      editor: h.editor,
      ydoc: h.ydoc,
      ytext: h.ytext,
      provider: h.provider,
      scrollTop: 0,
      hadFocus: false,
      activeMountKey: h.docName,
      __uncached: true,
    };

    expect(() => parkTiptapEditor(entry)).not.toThrow();
    expect(h.spies.destroyCalls).toBe(1);
  });

  test('no-op when undoManager cannot be located (e.g. editor without y-undo plugin)', () => {
    const h = makeTiptapHarness('doc-a');
    const entry: TiptapCacheEntry = {
      editor: h.editor,
      ydoc: h.ydoc,
      ytext: h.ytext,
      provider: h.provider,
      scrollTop: 0,
      hadFocus: false,
      activeMountKey: h.docName,
      __uncached: true,
    };

    expect(() => parkTiptapEditor(entry)).not.toThrow();
    expect(h.spies.destroyCalls).toBe(1);
  });
});


describe('CM6 cache — lifecycle', () => {
  beforeEach(() => __resetCacheForTests());
  afterEach(() => __resetCacheForTests());

  test('mount: cache-miss calls factory and stores entry', () => {
    const h = makeCmHarness('cm-doc-a');
    const entry = mountCmEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(h.factoryCallCount).toBe(1);
    expect(__getCacheSize('cm')).toBe(1);
    expect(entry.view).toBe(h.view);
    expect(entry.ydoc).toBe(h.ydoc);
    expect(entry.ytext).toBe(h.ytext);
    expect(entry.activeMountKey).toBe(h.docName);
  });

  test('mount: stores the factory compartments on the entry and preserves them across cache-hit', () => {
    const h = makeCmHarness('cm-doc-a');
    const first = mountCmEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(first.themeCompartment).toBe(h.themeCompartment);
    expect(first.wordWrapCompartment).toBe(h.wordWrapCompartment);
    expect(first.placeholderCompartment).toBe(h.placeholderCompartment);

    const second = mountCmEditor({
      docName: h.docName,
      container: makeNode() as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(second.themeCompartment).toBe(h.themeCompartment);
    expect(second.wordWrapCompartment).toBe(h.wordWrapCompartment);
    expect(second.placeholderCompartment).toBe(h.placeholderCompartment);
    expect(h.factoryCallCount).toBe(1);
  });

  test('park then remount: compartments survive the park→remount round-trip', () => {
    const h = makeCmHarness('cm-doc-a');
    const first = mountCmEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    parkCmEditor(first);

    const remounted = mountCmEditor({
      docName: h.docName,
      container: makeNode() as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(remounted).toBe(first);
    expect(remounted.themeCompartment).toBe(h.themeCompartment);
    expect(remounted.wordWrapCompartment).toBe(h.wordWrapCompartment);
    expect(remounted.placeholderCompartment).toBe(h.placeholderCompartment);
    expect(h.factoryCallCount).toBe(1);
  });

  test('mount: cache-hit reparents view.dom without construction', () => {
    const h = makeCmHarness('cm-doc-a');
    const first = mountCmEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    const newContainer = makeNode();
    const second = mountCmEditor({
      docName: h.docName,
      container: newContainer as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(second).toBe(first);
    expect(h.viewDom.parentElement).toBe(newContainer);
    expect(h.factoryCallCount).toBe(1);
  });

  test('park: detaches view.dom, preserves scrollTop, does NOT destroy', () => {
    const h = makeCmHarness('cm-doc-a');
    const entry = mountCmEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    h.viewDom.scrollTop = 5678;
    parkCmEditor(entry);

    expect(h.viewDom.parentElement).not.toBe(h.container);
    expect(entry.scrollTop).toBe(5678);
    expect(entry.activeMountKey).toBeNull();
    expect(h.spies.destroyCalls).toBe(0);
    expect(__peekCm(h.docName)).toBe(entry);
  });

  test('mount after park: restores scrollTop (Major #11: focus only when editor owned focus)', () => {
    const h = makeCmHarness('cm-doc-a');
    const entry = mountCmEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    h.viewDom.scrollTop = 42;
    parkCmEditor(entry);
    const focusBefore = h.spies.focusCalls;

    const ctr = makeNode();
    mountCmEditor({
      docName: h.docName,
      container: ctr as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(ctr.scrollTop).toBe(42);
    expect(h.spies.focusCalls).toBe(focusBefore);

    entry.hadFocus = true;
    const ctr2 = makeNode();
    const before2 = h.spies.focusCalls;
    mountCmEditor({
      docName: h.docName,
      container: ctr2 as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(h.spies.focusCalls).toBeGreaterThan(before2);
  });

  test('evict: destroys view + provider + ydoc', () => {
    const h = makeCmHarness('cm-doc-a');
    mountCmEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    const ydocDestroySpy = mock(h.ydoc.destroy.bind(h.ydoc));
    h.ydoc.destroy = ydocDestroySpy;

    expect(evictCmEditor(h.docName)).toBe(true);
    expect(h.spies.destroyCalls).toBe(1);
    expect(h.providerSpies.destroyCalls).toBe(1);
    expect(ydocDestroySpy).toHaveBeenCalledTimes(1);
    expect(__peekCm(h.docName)).toBeUndefined();
  });

  test('5 park-mount cycles work for CM6', () => {
    const h = makeCmHarness('cm-doc-a');
    const entry = mountCmEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    h.ytext.insert(0, 'cm-cycle-test');

    for (let i = 0; i < 5; i++) {
      parkCmEditor(entry);
      const ctr = makeNode();
      const re = mountCmEditor({
        docName: h.docName,
        container: ctr as unknown as HTMLElement,
        factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
      });
      expect(re).toBe(entry);
      expect(re.ytext.toString()).toBe('cm-cycle-test');
      expect(h.viewDom.parentElement).toBe(ctr);
    }
    expect(h.factoryCallCount).toBe(1);
    expect(h.spies.destroyCalls).toBe(0);
  });

  test('__uncached CM entry: park destroys view', () => {
    const h = makeCmHarness('cm-doc-a');
    h.container.appendChild(h.viewDom);
    const entry: CmCacheEntry = {
      view: h.view,
      ydoc: h.ydoc,
      ytext: h.ytext,
      provider: h.provider,
      themeCompartment: h.themeCompartment,
      wordWrapCompartment: h.wordWrapCompartment,
      placeholderCompartment: h.placeholderCompartment,
      parkingNode: null,
      scrollTop: 0,
      hadFocus: false,
      activeMountKey: h.docName,
      __uncached: true,
    };
    parkCmEditor(entry);
    expect(h.spies.destroyCalls).toBe(1);
    expect(entry.activeMountKey).toBeNull();
  });

  test('CM LRU eviction at MAX_CACHE', () => {
    const harnesses: CmHarness[] = [];
    for (let i = 0; i < MAX_CACHE; i++) {
      const h = makeCmHarness(`cm-doc-${i}`);
      harnesses.push(h);
      mountCmEditor({
        docName: h.docName,
        container: h.container as unknown as HTMLElement,
        factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
      });
    }
    expect(__getCacheSize('cm')).toBe(MAX_CACHE);

    const extra = makeCmHarness('cm-doc-extra');
    mountCmEditor({
      docName: extra.docName,
      container: extra.container as unknown as HTMLElement,
      factory: extra.factory as unknown as (el: HTMLElement) => ReturnType<typeof extra.factory>,
    });
    expect(__peekCm('cm-doc-0')).toBeUndefined();
    expect(__peekCm('cm-doc-extra')).toBeDefined();
    expect(harnesses[0].spies.destroyCalls).toBe(1);
  });
});


describe('STOP rule: editor-cache never calls editor.mount() / editor.unmount()', () => {
  test('source contains no reference to editor.mount( or editor.unmount(', async () => {
    const sourceText = await Bun.file(`${import.meta.dir}/editor-cache.ts`).text();
    const code = sourceText
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .join('\n');
    expect(/editor\.mount\s*\(/.test(code)).toBe(false);
    expect(/editor\.unmount\s*\(/.test(code)).toBe(false);
  });
});


describe('Module-level cache survives simulated remounts', () => {
  beforeEach(() => __resetCacheForTests());
  afterEach(() => __resetCacheForTests());

  test('double-mount with same docName (StrictMode style) does not leak', () => {
    const h = makeTiptapHarness('doc-a');
    const first = mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    parkTiptapEditor(first);
    const ctr = makeNode();
    const second = mountTiptapEditor({
      docName: h.docName,
      container: ctr as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(second).toBe(first);
    expect(__getCacheSize('tiptap')).toBe(1);
    expect(h.factoryCallCount).toBe(1);
  });
});


describe('size-gate constants', () => {
  test('VIEW_COUNT_CACHE_THRESHOLD = 50', () => {
    expect(VIEW_COUNT_CACHE_THRESHOLD).toBe(50);
  });
  test('BYTES_CACHE_THRESHOLD = 8_000_000 (admits PROJECT-class docs post-CV:auto)', () => {
    expect(BYTES_CACHE_THRESHOLD).toBe(8_000_000);
  });
});

describe('shouldCacheEditor — pure gate', () => {
  test('small doc: cache admitted', () => {
    expect(shouldCacheEditor({ viewCount: 5, bytes: 8_000 })).toBe(true);
  });
  test('exactly at viewCount threshold: cache refused (>= gate)', () => {
    expect(shouldCacheEditor({ viewCount: 50, bytes: 1 })).toBe(false);
  });
  test('one below viewCount threshold: cache admitted', () => {
    expect(shouldCacheEditor({ viewCount: 49, bytes: 1 })).toBe(true);
  });
  test('exactly at bytes threshold: cache admitted (> gate, not >=)', () => {
    expect(shouldCacheEditor({ viewCount: 0, bytes: 8_000_000 })).toBe(true);
  });
  test('one above bytes threshold: cache refused', () => {
    expect(shouldCacheEditor({ viewCount: 0, bytes: 8_000_001 })).toBe(false);
  });
  test('both gates active: refuse on any violation', () => {
    expect(shouldCacheEditor({ viewCount: 100, bytes: 9_000_000 })).toBe(false);
  });
  test('viewCount alone fails (bytes pass): refuse', () => {
    expect(shouldCacheEditor({ viewCount: 100, bytes: 1_000_000 })).toBe(false);
  });
  test('viewCount=0 sentinel does not activate the viewCount branch', () => {
    expect(shouldCacheEditor({ viewCount: 0, bytes: 100 })).toBe(true);
    expect(shouldCacheEditor({ viewCount: 0, bytes: 9_000_000 })).toBe(false);
  });
});

describe('mountTiptapEditor — size gate falls through to __uncached', () => {
  beforeEach(() => __resetCacheForTests());
  afterEach(() => __resetCacheForTests());

  test('gate-refused mount: entry is __uncached and NOT stored in cache', () => {
    const h = makeTiptapHarness('big-doc');
    const entry = mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
      sizeStats: { viewCount: 100, bytes: 1_000_000 },
    });
    expect(entry.__uncached).toBe(true);
    expect(__getCacheSize('tiptap')).toBe(0);
    expect(peekTiptap(h.docName)).toBeUndefined();
  });

  test('gate-admitted mount: entry IS cached (no __uncached tag)', () => {
    const h = makeTiptapHarness('small-doc');
    const entry = mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
      sizeStats: { viewCount: 5, bytes: 8_000 },
    });
    expect(entry.__uncached).toBeUndefined();
    expect(__getCacheSize('tiptap')).toBe(1);
    expect(peekTiptap(h.docName)).toBe(entry);
  });

  test('omitted sizeStats: entry is cached (legacy callers default to cache)', () => {
    const h = makeTiptapHarness('legacy-doc');
    const entry = mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(entry.__uncached).toBeUndefined();
    expect(__getCacheSize('tiptap')).toBe(1);
  });

  test('gate-refused entry: park() destroys (pre-V2 fallthrough)', () => {
    const h = makeTiptapHarness('big-doc');
    const entry = mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
      sizeStats: { viewCount: 100, bytes: 0 },
    });
    expect(h.spies.destroyCalls).toBe(0);
    parkTiptapEditor(entry);
    expect(h.spies.destroyCalls).toBe(1);
  });
});

describe('mountCmEditor — size gate mirror of TipTap', () => {
  beforeEach(() => __resetCacheForTests());
  afterEach(() => __resetCacheForTests());

  test('CM gate-refused entry: park destroys', () => {
    const h = makeCmHarness('cm-big');
    const entry = mountCmEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
      sizeStats: { viewCount: 200, bytes: 100 },
    });
    expect(entry.__uncached).toBe(true);
    expect(__getCacheSize('cm')).toBe(0);
    parkCmEditor(entry);
    expect(h.spies.destroyCalls).toBe(1);
  });
});


describe('setActivityMountList — connect/disconnect transitions', () => {
  beforeEach(() => __resetCacheForTests());
  afterEach(() => __resetCacheForTests());

  test('promotion: newly active doc triggers provider.connect()', () => {
    const h = makeTiptapHarness('doc-a');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(h.providerSpies.connectCalls).toBe(0);

    setActivityMountList(['doc-a']);
    expect(h.providerSpies.connectCalls).toBe(1);
    expect(__getActivityMountList()).toEqual(['doc-a']);
  });

  test('demotion: doc falling out of list triggers provider.disconnect()', () => {
    const h = makeTiptapHarness('doc-a');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    setActivityMountList(['doc-a']);
    expect(h.providerSpies.connectCalls).toBe(1);

    setActivityMountList([]);
    expect(h.providerSpies.disconnectCalls).toBe(1);
    expect(__getActivityMountList()).toEqual([]);
  });

  test('stable doc: still in list on next call, no extra connect/disconnect', () => {
    const h = makeTiptapHarness('doc-a');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    setActivityMountList(['doc-a']);
    expect(h.providerSpies.connectCalls).toBe(1);

    setActivityMountList(['doc-a']);
    expect(h.providerSpies.connectCalls).toBe(1);
    expect(h.providerSpies.disconnectCalls).toBe(0);
  });

  test('mixed transition: one demoted + one promoted in a single call', () => {
    const a = makeTiptapHarness('doc-a');
    const b = makeTiptapHarness('doc-b');
    mountTiptapEditor({
      docName: a.docName,
      container: a.container as unknown as HTMLElement,
      factory: a.factory as unknown as (el: HTMLElement) => ReturnType<typeof a.factory>,
    });
    mountTiptapEditor({
      docName: b.docName,
      container: b.container as unknown as HTMLElement,
      factory: b.factory as unknown as (el: HTMLElement) => ReturnType<typeof b.factory>,
    });
    setActivityMountList(['doc-a']);
    expect(a.providerSpies.connectCalls).toBe(1);
    expect(b.providerSpies.connectCalls).toBe(0);

    setActivityMountList(['doc-b']);
    expect(a.providerSpies.disconnectCalls).toBe(1);
    expect(b.providerSpies.connectCalls).toBe(1);
  });

  test('unknown docName in list: no crash, no connect (provider not yet in cache)', () => {
    setActivityMountList(['doc-a']);
    expect(__getActivityMountList()).toEqual(['doc-a']);
  });

  test('CM-only cache entry: provider transitions still fire (same docName)', () => {
    const h = makeCmHarness('cm-only-doc');
    mountCmEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    setActivityMountList(['cm-only-doc']);
    expect(h.providerSpies.connectCalls).toBe(1);
  });

  test('pool-resident-but-not-V2-cached doc: demote still disconnects via ProviderPool fallback', () => {
    const ydoc = new Y.Doc();
    const { provider, spies } = makeFakeProvider(ydoc);
    const fakePool = {
      entries: new Map<string, { provider: HocuspocusProvider }>([
        ['orphan-doc', { provider }],
      ]) as ReadonlyMap<string, { provider: HocuspocusProvider }>,
      onEvict: (_cb: (docName: string) => void) => () => {
      },
    };
    const unsubscribe = subscribePoolEviction(fakePool);
    try {
      expect(peekTiptap('orphan-doc')).toBeUndefined();
      expect(__peekCm('orphan-doc')).toBeUndefined();

      setActivityMountList(['orphan-doc']);
      expect(spies.connectCalls).toBe(1);

      setActivityMountList([]);
      expect(spies.disconnectCalls).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  test('subscribePoolEviction unsubscribe clears pool reference: subsequent demote no-ops without pool', () => {
    const ydoc = new Y.Doc();
    const { provider, spies } = makeFakeProvider(ydoc);
    const fakePool = {
      entries: new Map<string, { provider: HocuspocusProvider }>([
        ['orphan-doc', { provider }],
      ]) as ReadonlyMap<string, { provider: HocuspocusProvider }>,
      onEvict: (_cb: (docName: string) => void) => () => {},
    };
    const unsubscribe = subscribePoolEviction(fakePool);
    setActivityMountList(['orphan-doc']);
    expect(spies.connectCalls).toBe(1);

    unsubscribe();

    setActivityMountList([]);
    expect(spies.disconnectCalls).toBe(0);
  });
});


describe('parkingNode — per-entry exclusivity', () => {
  beforeEach(() => {
    __resetCacheForTests();
    installDocumentStub();
  });
  afterEach(() => {
    __resetCacheForTests();
    uninstallDocumentStub();
  });

  test('TipTap: two parked entries hold distinct parkingNode references with exclusive children', () => {
    const a = makeTiptapHarness('doc-a-parking');
    const b = makeTiptapHarness('doc-b-parking');
    mountTiptapEditor({
      docName: a.docName,
      container: a.container as unknown as HTMLElement,
      factory: a.factory as unknown as (el: HTMLElement) => ReturnType<typeof a.factory>,
    });
    mountTiptapEditor({
      docName: b.docName,
      container: b.container as unknown as HTMLElement,
      factory: b.factory as unknown as (el: HTMLElement) => ReturnType<typeof b.factory>,
    });

    const entryA = peekTiptap(a.docName);
    const entryB = peekTiptap(b.docName);
    if (!entryA || !entryB) throw new Error('cache entries missing');

    parkTiptapEditor(entryA);
    parkTiptapEditor(entryB);

    expect(entryA.parkingNode).not.toBeNull();
    expect(entryB.parkingNode).not.toBeNull();
    expect(entryA.parkingNode).not.toBe(entryB.parkingNode);

    const parkA = entryA.parkingNode as unknown as FakeNode;
    const parkB = entryB.parkingNode as unknown as FakeNode;
    expect(parkA.children).toEqual([a.editorDom]);
    expect(parkB.children).toEqual([b.editorDom]);
  });

  test('CM6: two parked entries hold distinct parkingNode references with exclusive children', () => {
    const a = makeCmHarness('cm-doc-a-parking');
    const b = makeCmHarness('cm-doc-b-parking');
    mountCmEditor({
      docName: a.docName,
      container: a.container as unknown as HTMLElement,
      factory: a.factory as unknown as (el: HTMLElement) => ReturnType<typeof a.factory>,
    });
    mountCmEditor({
      docName: b.docName,
      container: b.container as unknown as HTMLElement,
      factory: b.factory as unknown as (el: HTMLElement) => ReturnType<typeof b.factory>,
    });

    const entryA = __peekCm(a.docName);
    const entryB = __peekCm(b.docName);
    if (!entryA || !entryB) throw new Error('cache entries missing');

    parkCmEditor(entryA);
    parkCmEditor(entryB);

    expect(entryA.parkingNode).not.toBeNull();
    expect(entryB.parkingNode).not.toBeNull();
    expect(entryA.parkingNode).not.toBe(entryB.parkingNode);

    const parkA = entryA.parkingNode as unknown as FakeNode;
    const parkB = entryB.parkingNode as unknown as FakeNode;
    expect(parkA.children).toEqual([a.viewDom]);
    expect(parkB.children).toEqual([b.viewDom]);
  });

  test('TipTap: re-park after a mount cycle preserves parkingNode identity (lazy idempotency)', () => {
    const h = makeTiptapHarness('doc-park-cycle-tiptap');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    const entry = peekTiptap(h.docName);
    if (!entry) throw new Error('cache entry missing');

    parkTiptapEditor(entry);
    const firstParkingNode = entry.parkingNode;
    expect(firstParkingNode).not.toBeNull();

    const ctr2 = makeNode();
    mountTiptapEditor({
      docName: h.docName,
      container: ctr2 as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(h.editorDom.parentElement).toBe(ctr2);

    parkTiptapEditor(entry);
    expect(entry.parkingNode).toBe(firstParkingNode);
  });

  test('CM6: re-park after a mount cycle preserves parkingNode identity (lazy idempotency)', () => {
    const h = makeCmHarness('cm-doc-park-cycle');
    mountCmEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    const entry = __peekCm(h.docName);
    if (!entry) throw new Error('cache entry missing');

    parkCmEditor(entry);
    const firstParkingNode = entry.parkingNode;
    expect(firstParkingNode).not.toBeNull();

    const ctr2 = makeNode();
    mountCmEditor({
      docName: h.docName,
      container: ctr2 as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(h.viewDom.parentElement).toBe(ctr2);

    parkCmEditor(entry);
    expect(entry.parkingNode).toBe(firstParkingNode);
  });
});

describe('subscribePoolEviction — onEvict propagation', () => {
  beforeEach(() => __resetCacheForTests());
  afterEach(() => __resetCacheForTests());

  test('pool eviction destroys both TipTap and CM cache entries for the same doc', () => {
    let captured: ((docName: string) => void) | null = null;
    const fakePool = {
      entries: new Map<string, { provider: HocuspocusProvider }>(),
      onEvict: (cb: (docName: string) => void) => {
        captured = cb;
        return () => {
          captured = null;
        };
      },
    };
    const unsubscribe = subscribePoolEviction(fakePool);
    try {
      const tip = makeTiptapHarness('doc-shared');
      const cm = makeCmHarness('doc-shared');
      mountTiptapEditor({
        docName: tip.docName,
        container: tip.container as unknown as HTMLElement,
        factory: tip.factory as unknown as (el: HTMLElement) => ReturnType<typeof tip.factory>,
      });
      mountCmEditor({
        docName: cm.docName,
        container: cm.container as unknown as HTMLElement,
        factory: cm.factory as unknown as (el: HTMLElement) => ReturnType<typeof cm.factory>,
      });
      expect(peekTiptap('doc-shared')).toBeDefined();
      expect(__peekCm('doc-shared')).toBeDefined();
      expect(captured).not.toBeNull();

      captured?.('doc-shared');

      expect(peekTiptap('doc-shared')).toBeUndefined();
      expect(__peekCm('doc-shared')).toBeUndefined();
      expect(tip.spies.destroyCalls).toBe(1);
      expect(cm.spies.destroyCalls).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  test('eviction for unknown docName is a safe no-op (race-tolerant)', () => {
    let captured: ((docName: string) => void) | null = null;
    const fakePool = {
      entries: new Map<string, { provider: HocuspocusProvider }>(),
      onEvict: (cb: (docName: string) => void) => {
        captured = cb;
        return () => {
          captured = null;
        };
      },
    };
    const unsubscribe = subscribePoolEviction(fakePool);
    try {
      expect(captured).not.toBeNull();
      expect(peekTiptap('never-mounted')).toBeUndefined();
      expect(__peekCm('never-mounted')).toBeUndefined();
      expect(() => captured?.('never-mounted')).not.toThrow();
    } finally {
      unsubscribe();
    }
  });
});

describe('LRU eviction respects activity-mount list (never evicts active doc)', () => {
  beforeEach(() => __resetCacheForTests());
  afterEach(() => __resetCacheForTests());

  test('when cache is full, evicts oldest NON-active entry', () => {
    const harnesses: TiptapHarness[] = [];
    for (let i = 0; i < MAX_CACHE; i++) {
      const h = makeTiptapHarness(`doc-${i}`);
      harnesses.push(h);
      mountTiptapEditor({
        docName: h.docName,
        container: h.container as unknown as HTMLElement,
        factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
      });
    }
    setActivityMountList(['doc-0']);

    const extra = makeTiptapHarness('doc-extra');
    mountTiptapEditor({
      docName: extra.docName,
      container: extra.container as unknown as HTMLElement,
      factory: extra.factory as unknown as (el: HTMLElement) => ReturnType<typeof extra.factory>,
    });

    expect(peekTiptap('doc-0')).toBeDefined(); // Activity-mounted — spared
    expect(peekTiptap('doc-1')).toBeUndefined(); // Oldest non-active — evicted
    expect(harnesses[0].spies.destroyCalls).toBe(0);
    expect(harnesses[1].spies.destroyCalls).toBe(1);
  });

  test('degenerate fallback: all entries active → LRU picks the oldest anyway', () => {
    const harnesses: TiptapHarness[] = [];
    for (let i = 0; i < MAX_CACHE; i++) {
      const h = makeTiptapHarness(`doc-${i}`);
      harnesses.push(h);
      mountTiptapEditor({
        docName: h.docName,
        container: h.container as unknown as HTMLElement,
        factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
      });
    }
    setActivityMountList(harnesses.map((x) => x.docName));

    const extra = makeTiptapHarness('doc-extra');
    mountTiptapEditor({
      docName: extra.docName,
      container: extra.container as unknown as HTMLElement,
      factory: extra.factory as unknown as (el: HTMLElement) => ReturnType<typeof extra.factory>,
    });
    expect(__getCacheSize('tiptap')).toBe(MAX_CACHE);
  });
});

describe('telemetry marks', () => {
  beforeEach(() => {
    __resetCacheForTests();
    try {
      performance.clearMeasures();
    } catch {
    }
  });
  afterEach(() => __resetCacheForTests());

  test('mount emits ok/cache/hit on cache-hit path', () => {
    const h = makeTiptapHarness('doc-a');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    mountTiptapEditor({
      docName: h.docName,
      container: makeNode() as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    const hits = performance.getEntriesByName('ok/cache/hit');
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  test('mount emits ok/cache/miss on cache-miss cold path', () => {
    const h = makeTiptapHarness('doc-a');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    const misses = performance.getEntriesByName('ok/cache/miss');
    expect(misses.length).toBeGreaterThanOrEqual(1);
  });

  test('evict emits ok/cache/evict', () => {
    const h = makeTiptapHarness('doc-a');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    evictTiptapEditor(h.docName);
    const evicts = performance.getEntriesByName('ok/cache/evict');
    expect(evicts.length).toBeGreaterThanOrEqual(1);
  });

  test('setActivityMountList emits ok/cache/connect + ok/cache/disconnect', async () => {
    const h = makeTiptapHarness('doc-a');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    setActivityMountList(['doc-a']);
    await Promise.resolve();
    const connects = performance.getEntriesByName('ok/cache/connect');
    expect(connects.length).toBeGreaterThanOrEqual(1);

    setActivityMountList([]);
    const disconnects = performance.getEntriesByName('ok/cache/disconnect');
    expect(disconnects.length).toBeGreaterThanOrEqual(1);
  });

  test('connect telemetry is mutually exclusive: reject emits connect-failed only (no preceding connect)', async () => {
    const rejectingProvider = {
      document: new Y.Doc(),
      destroy: mock(() => {}),
      connect: mock(() => Promise.reject(new Error('connect failed'))),
      disconnect: mock(() => {}),
    } as unknown as HocuspocusProvider;
    const dom = makeNode();
    const editor = {
      editorView: { dom, scrollDOM: dom },
      commands: { focus: mock(() => {}) },
      destroy: mock(() => {}),
    } as unknown as Editor;
    const ytext = rejectingProvider.document.getText('source');
    mountTiptapEditor({
      docName: 'doc-reject',
      container: makeNode() as unknown as HTMLElement,
      factory: () => ({
        editor,
        ydoc: rejectingProvider.document,
        ytext,
        provider: rejectingProvider,
      }),
    });
    performance.clearMarks('ok/cache/connect');
    performance.clearMarks('ok/cache/connect-failed');
    setActivityMountList(['doc-reject']);
    await Promise.resolve();
    await Promise.resolve();
    const connects = performance.getEntriesByName('ok/cache/connect');
    const failed = performance.getEntriesByName('ok/cache/connect-failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(connects.length).toBe(0);
  });

  test('mount with sizeStats emits ok/cold/editor-mount-stats', () => {
    const h = makeTiptapHarness('doc-stats');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
      sizeStats: { viewCount: 10, bytes: 5_000 },
    });
    const stats = performance.getEntriesByName('ok/cold/editor-mount-stats');
    expect(stats.length).toBeGreaterThanOrEqual(1);
  });

  test('cache hit emits stats with cacheHit=true', () => {
    const h = makeTiptapHarness('doc-hit');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
      sizeStats: { viewCount: 10, bytes: 5_000 },
    });
    try {
      performance.clearMeasures('ok/cold/editor-mount-stats');
    } catch {
    }
    mountTiptapEditor({
      docName: h.docName,
      container: makeNode() as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
      sizeStats: { viewCount: 10, bytes: 5_000 },
    });
    const stats = performance.getEntriesByName('ok/cold/editor-mount-stats');
    expect(stats.length).toBeGreaterThanOrEqual(1);
  });
});


describe('US-001 (cap-calibration-probes): cache-hit reparent span marks', () => {
  beforeEach(() => {
    __resetCacheForTests();
    try {
      performance.clearMarks('ok/cache/reparent-start');
      performance.clearMarks('ok/cache/reparent-end');
      performance.clearMeasures('ok/cache/reparent-start');
      performance.clearMeasures('ok/cache/reparent-end');
    } catch {
    }
  });
  afterEach(() => __resetCacheForTests());

  test('TipTap cache-hit emits both ok/cache/reparent-start and ok/cache/reparent-end', () => {
    const h = makeTiptapHarness('doc-a');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    try {
      performance.clearMeasures('ok/cache/reparent-start');
      performance.clearMeasures('ok/cache/reparent-end');
    } catch {
    }
    mountTiptapEditor({
      docName: h.docName,
      container: makeNode() as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    const starts = performance.getEntriesByName('ok/cache/reparent-start');
    const ends = performance.getEntriesByName('ok/cache/reparent-end');
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(ends.length).toBeGreaterThanOrEqual(1);
    const firstStart = starts[0]?.startTime ?? 0;
    const firstEnd = ends[0]?.startTime ?? 0;
    expect(firstEnd).toBeGreaterThanOrEqual(firstStart);
  });

  test('TipTap cache-MISS does NOT emit reparent marks', () => {
    const h = makeTiptapHarness('doc-a');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(performance.getEntriesByName('ok/cache/reparent-start').length).toBe(0);
    expect(performance.getEntriesByName('ok/cache/reparent-end').length).toBe(0);
  });

  test('TipTap kill-switch / __uncached path does NOT emit reparent marks', () => {
    const h = makeTiptapHarness('big-doc');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
      sizeStats: { viewCount: 100, bytes: 1_000_000 },
    });
    expect(performance.getEntriesByName('ok/cache/reparent-start').length).toBe(0);
    expect(performance.getEntriesByName('ok/cache/reparent-end').length).toBe(0);
  });

  test('CM6 cache-hit emits both ok/cache/reparent-start and ok/cache/reparent-end', () => {
    const h = makeCmHarness('cm-doc-a');
    mountCmEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    try {
      performance.clearMeasures('ok/cache/reparent-start');
      performance.clearMeasures('ok/cache/reparent-end');
    } catch {
    }
    mountCmEditor({
      docName: h.docName,
      container: makeNode() as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    const starts = performance.getEntriesByName('ok/cache/reparent-start');
    const ends = performance.getEntriesByName('ok/cache/reparent-end');
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(ends.length).toBeGreaterThanOrEqual(1);
  });

  test('CM6 cache-MISS does NOT emit reparent marks', () => {
    const h = makeCmHarness('cm-doc-a');
    mountCmEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(performance.getEntriesByName('ok/cache/reparent-start').length).toBe(0);
    expect(performance.getEntriesByName('ok/cache/reparent-end').length).toBe(0);
  });

  test('reparent marks fire BEFORE ok/cache/hit (semantic ordering)', () => {
    const h = makeTiptapHarness('doc-order');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    try {
      performance.clearMeasures('ok/cache/reparent-start');
      performance.clearMeasures('ok/cache/reparent-end');
      performance.clearMeasures('ok/cache/hit');
    } catch {
    }
    mountTiptapEditor({
      docName: h.docName,
      container: makeNode() as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    const start = performance.getEntriesByName('ok/cache/reparent-start')[0];
    const end = performance.getEntriesByName('ok/cache/reparent-end')[0];
    const hit = performance.getEntriesByName('ok/cache/hit')[0];
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect(hit).toBeDefined();
    if (start && end && hit) {
      expect(start.startTime).toBeLessThanOrEqual(end.startTime);
      expect(end.startTime).toBeLessThanOrEqual(hit.startTime);
    }
  });

  test('existing ok/cache/hit emission is preserved (regression guard for AC 5)', () => {
    const h = makeTiptapHarness('doc-preserve');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    try {
      performance.clearMeasures('ok/cache/hit');
    } catch {
    }
    mountTiptapEditor({
      docName: h.docName,
      container: makeNode() as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(performance.getEntriesByName('ok/cache/hit').length).toBeGreaterThanOrEqual(1);
  });
});


let __us004DocumentStubInstalled = false;
function installDocumentStub(): void {
  if (typeof globalThis.document !== 'undefined') return;
  // biome-ignore lint/suspicious/noExplicitAny: minimal test-only stub for `document.createElement`
  (globalThis as any).document = {
    createElement: (_tag: string) => makeNode(),
  };
  __us004DocumentStubInstalled = true;
}

function uninstallDocumentStub(): void {
  if (!__us004DocumentStubInstalled) return;
  // biome-ignore lint/suspicious/noExplicitAny: tearing down the test-only stub installed above
  delete (globalThis as any).document;
  __us004DocumentStubInstalled = false;
}

describe('US-004: D20 mount-promise cancellation wired into park', () => {
  beforeEach(() => {
    __resetCacheForTests();
    __resetMountPromiseCache();
    installDocumentStub();
  });
  afterEach(() => {
    __resetCacheForTests();
    __resetMountPromiseCache();
    uninstallDocumentStub();
  });

  test('park-after-mount: PRESERVES the mount-promise cache so the next mount returns the same Promise reference (no Suspense flash)', async () => {
    const h = makeTiptapHarness('doc-park-preserves');
    const construct = () => ({
      editor: h.editor,
      ydoc: h.ydoc,
      ytext: h.ytext,
      provider: h.provider,
    });

    const firstPromise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct,
    });
    const entry = await firstPromise;

    expect(__mountPromiseCacheSize()).toBe(1);
    expect(__mountPromiseSettled(h.docName)).toBe(true);
    expect(__getCacheSize('tiptap')).toBe(1);
    expect(entry.activeMountKey).toBe(h.docName);

    parkTiptapEditor(entry);

    expect(__mountPromiseCacheSize()).toBe(1);
    expect(__mountPromiseSettled(h.docName)).toBe(true);
    expect(peekTiptap(h.docName)).toBeDefined();
    expect(h.spies.destroyCalls).toBe(0);

    const secondPromise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct,
    });
    expect(secondPromise).toBe(firstPromise);
  });

  test('park-on-already-parked entry: no-op for both V2 cache and mount-promise (preservation contract)', async () => {
    const h = makeTiptapHarness('doc-park-twice');
    const construct = () => ({
      editor: h.editor,
      ydoc: h.ydoc,
      ytext: h.ytext,
      provider: h.provider,
    });
    const entry = await mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct,
    });

    parkTiptapEditor(entry);
    expect(__mountPromiseCacheSize()).toBe(1);
    expect(entry.activeMountKey).toBeNull();
    expect(h.spies.destroyCalls).toBe(0);

    parkTiptapEditor(entry);
    expect(__mountPromiseCacheSize()).toBe(1);
    expect(h.spies.destroyCalls).toBe(0);
  });

  test('__uncached park: invalidates mount-promise BEFORE the kill-switch destroy fires (silent — no rejection)', async () => {
    const h = makeTiptapHarness('doc-uncached-park');
    h.container.appendChild(h.editorDom);
    const entry: TiptapCacheEntry = {
      editor: h.editor,
      ydoc: h.ydoc,
      ytext: h.ytext,
      provider: h.provider,
      scrollTop: 0,
      hadFocus: false,
      activeMountKey: h.docName,
      __uncached: true,
    };

    const primer = makeTiptapHarness(h.docName);
    const construct = () => ({
      editor: primer.editor,
      ydoc: primer.ydoc,
      ytext: primer.ytext,
      provider: primer.provider,
    });
    const pending = mountTiptapEditorPromise({ docName: h.docName, mountId: 'test-id', construct });
    let primerRejected = false;
    pending.catch(() => {
      primerRejected = true;
    });
    expect(__mountPromiseCacheSize()).toBe(1);

    expect(h.spies.destroyCalls).toBe(0);
    parkTiptapEditor(entry);
    expect(__mountPromiseCacheSize()).toBe(0);
    expect(h.spies.destroyCalls).toBe(1);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(primerRejected).toBe(false);
  });
});

describe('US-004: D20 mount-promise cancellation wired into evict', () => {
  beforeEach(() => {
    __resetCacheForTests();
    __resetMountPromiseCache();
    installDocumentStub();
  });
  afterEach(() => {
    __resetCacheForTests();
    __resetMountPromiseCache();
    uninstallDocumentStub();
  });

  test('evict-after-mount: invalidates mount-promise cache + destroys V2 entry', async () => {
    const h = makeTiptapHarness('doc-evict-invalidates');
    const construct = () => ({
      editor: h.editor,
      ydoc: h.ydoc,
      ytext: h.ytext,
      provider: h.provider,
    });
    await mountTiptapEditorPromise({ docName: h.docName, mountId: 'test-id', construct });

    expect(__mountPromiseCacheSize()).toBe(1);
    expect(__getCacheSize('tiptap')).toBe(1);

    const result = evictTiptapEditor(h.docName);

    expect(result).toBe(true);
    expect(__mountPromiseCacheSize()).toBe(0);
    expect(peekTiptap(h.docName)).toBeUndefined();
    expect(h.spies.destroyCalls).toBe(1);
    expect(h.providerSpies.destroyCalls).toBe(1);
  });

  test('evict-during-yield-window: tears down silently, body short-circuits, pre-mount editor destroyed (no rejection)', async () => {
    const h = makeTiptapHarness('doc-evict-during-yield');
    let constructed = false;
    const construct = () => {
      constructed = true;
      return {
        editor: h.editor,
        ydoc: h.ydoc,
        ytext: h.ytext,
        provider: h.provider,
      };
    };

    const origYield = scheduler.yield.bind(scheduler);
    let stallResolve: (() => void) | null = null;
    let yieldCallCount = 0;
    scheduler.yield = (() => {
      yieldCallCount++;
      if (yieldCallCount === 1) return Promise.resolve();
      return new Promise<void>((res) => {
        stallResolve = res;
      });
    }) as typeof scheduler.yield;

    try {
      const pending = mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'test-id',
        construct,
      });
      let consumerRejected = false;
      pending.catch(() => {
        consumerRejected = true;
      });
      expect(__mountPromiseCacheSize()).toBe(1);
      expect(__getCacheSize('tiptap')).toBe(0);

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(constructed).toBe(true);

      const result = evictTiptapEditor(h.docName);
      expect(result).toBe(false); // V2 had no entry to evict
      expect(__mountPromiseCacheSize()).toBe(0);

      if (stallResolve) (stallResolve as () => void)();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(consumerRejected).toBe(false);
      expect(h.spies.destroyCalls).toBe(1);
      expect(h.spies.mountCalls).toBe(0);
      expect(__getCacheSize('tiptap')).toBe(0);
    } finally {
      scheduler.yield = origYield;
    }
  });

  test('evict-on-no-entry-anywhere: safe no-op for both caches', () => {
    expect(__mountPromiseCacheSize()).toBe(0);
    expect(__getCacheSize('tiptap')).toBe(0);

    const result = evictTiptapEditor('never-existed');

    expect(result).toBe(false);
    expect(__mountPromiseCacheSize()).toBe(0);
    expect(__getCacheSize('tiptap')).toBe(0);
  });
});

describe('rename snapshot store', () => {
  afterEach(() => {
    __resetRenameSnapshotStore();
  });

  const baseSnap = (html: string): RenameSnapshot => ({ html, scrollTop: 0, selection: null });

  test('store + consume returns the stored snapshot', () => {
    storeRenameSnapshot('rename-to-doc', baseSnap('<p>hello</p>'));
    const consumed = __consumeRenameSnapshot('rename-to-doc');
    expect(consumed?.html).toBe('<p>hello</p>');
    expect(consumed?.scrollTop).toBe(0);
    expect(consumed?.selection).toBeNull();
  });

  test('consume is one-shot: second call returns null', () => {
    storeRenameSnapshot('rename-to-doc', baseSnap('<p>hello</p>'));
    __consumeRenameSnapshot('rename-to-doc');
    expect(__consumeRenameSnapshot('rename-to-doc')).toBeNull();
  });

  test('miss case: never-stored doc returns null', () => {
    expect(__consumeRenameSnapshot('never-stored-doc')).toBeNull();
  });

  test('multiple snapshots coexist independently', () => {
    storeRenameSnapshot('doc-a', baseSnap('<p>alpha</p>'));
    storeRenameSnapshot('doc-b', baseSnap('<p>beta</p>'));
    expect(__consumeRenameSnapshot('doc-a')?.html).toBe('<p>alpha</p>');
    expect(__consumeRenameSnapshot('doc-b')?.html).toBe('<p>beta</p>');
  });

  test('preserves scrollTop in the stored entry', () => {
    storeRenameSnapshot('rename-to-doc', { html: '<p>x</p>', scrollTop: 1500, selection: null });
    expect(__consumeRenameSnapshot('rename-to-doc')?.scrollTop).toBe(1500);
  });

  test('preserves TextSelection JSON in the stored entry', () => {
    const sel: RenameSelectionJSON = { type: 'text', anchor: 42, head: 50 };
    storeRenameSnapshot('rename-to-doc', { html: '<p>x</p>', scrollTop: 0, selection: sel });
    expect(__consumeRenameSnapshot('rename-to-doc')?.selection).toEqual(sel);
  });

  test('preserves NodeSelection JSON in the stored entry', () => {
    const sel: RenameSelectionJSON = { type: 'node', from: 8 };
    storeRenameSnapshot('rename-to-doc', { html: '<p>x</p>', scrollTop: 0, selection: sel });
    expect(__consumeRenameSnapshot('rename-to-doc')?.selection).toEqual(sel);
  });

  test('FIFO eviction: oldest snapshot dropped when MAX_CACHE exceeded', () => {
    for (let i = 0; i < MAX_CACHE; i++) {
      storeRenameSnapshot(`doc-${i}`, baseSnap(`<p>${i}</p>`));
    }
    storeRenameSnapshot('doc-overflow', baseSnap('<p>new</p>'));
    expect(__consumeRenameSnapshot('doc-0')).toBeNull();
    expect(__consumeRenameSnapshot('doc-overflow')?.html).toBe('<p>new</p>');
    expect(__consumeRenameSnapshot('doc-1')?.html).toBe('<p>1</p>');
  });

  test('peekRenameSnapshot is StrictMode-safe: double-invoke returns same value', () => {
    storeRenameSnapshot('notes/foo.md', baseSnap('<p>content</p>'));
    const first = peekRenameSnapshot('notes/foo.md');
    const second = peekRenameSnapshot('notes/foo.md');
    expect(first?.html).toBe('<p>content</p>');
    expect(second?.html).toBe('<p>content</p>');
  });
});

describe('captureRenameSnapshots', () => {
  beforeEach(() => {
    __resetCacheForTests();
    __resetRenameSnapshotStore();
  });
  afterEach(() => {
    __resetCacheForTests();
    __resetRenameSnapshotStore();
  });

  function installFakeSelection(h: ReturnType<typeof makeTiptapHarness>, sel: object): void {
    (h.editor as unknown as { state: { selection: unknown } }).state = { selection: sel };
  }

  function seedSource(h: ReturnType<typeof makeTiptapHarness>): void {
    h.ytext.insert(0, 'x');
  }

  test('stores under toDocName (not fromDocName) when editor is live — full capture→consume', () => {
    const h = makeTiptapHarness('from-doc');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    seedSource(h);
    (h.editor as unknown as { getHTML(): string }).getHTML = () => '<p>warm content</p>';

    captureRenameSnapshots([{ fromDocName: h.docName, toDocName: 'to-doc' }]);

    const snap = __consumeRenameSnapshot('to-doc');
    expect(snap?.html).toBe('<p>warm content</p>');
    expect(__consumeRenameSnapshot(h.docName)).toBeNull();
  });

  test('skips and does not store when editor.isDestroyed is true', () => {
    const h = makeTiptapHarness('from-doc');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    seedSource(h);
    (h.editor as unknown as { isDestroyed: boolean }).isDestroyed = true;

    captureRenameSnapshots([{ fromDocName: h.docName, toDocName: 'to-doc' }]);

    expect(__consumeRenameSnapshot('to-doc')).toBeNull();
  });

  test('swallows getHTML serialization errors — no snapshot stored, no throw', () => {
    const h = makeTiptapHarness('from-doc');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    seedSource(h);
    (h.editor as unknown as { getHTML(): string }).getHTML = () => {
      throw new Error('ProseMirror serialization failure');
    };

    expect(() =>
      captureRenameSnapshots([{ fromDocName: h.docName, toDocName: 'to-doc' }]),
    ).not.toThrow();
    expect(__consumeRenameSnapshot('to-doc')).toBeNull();
  });

  test('processes multiple renames independently', () => {
    const hA = makeTiptapHarness('from-a');
    const hB = makeTiptapHarness('from-b');
    mountTiptapEditor({
      docName: hA.docName,
      container: hA.container as unknown as HTMLElement,
      factory: hA.factory as unknown as (el: HTMLElement) => ReturnType<typeof hA.factory>,
    });
    mountTiptapEditor({
      docName: hB.docName,
      container: hB.container as unknown as HTMLElement,
      factory: hB.factory as unknown as (el: HTMLElement) => ReturnType<typeof hB.factory>,
    });
    seedSource(hA);
    seedSource(hB);
    (hA.editor as unknown as { getHTML(): string }).getHTML = () => '<p>alpha</p>';
    (hB.editor as unknown as { getHTML(): string }).getHTML = () => '<p>beta</p>';

    captureRenameSnapshots([
      { fromDocName: hA.docName, toDocName: 'to-a' },
      { fromDocName: hB.docName, toDocName: 'to-b' },
    ]);

    expect(__consumeRenameSnapshot('to-a')?.html).toBe('<p>alpha</p>');
    expect(__consumeRenameSnapshot('to-b')?.html).toBe('<p>beta</p>');
  });

  test('tolerates missing scroll container — scrollTop falls back to 0', () => {
    const h = makeTiptapHarness('from-doc');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    seedSource(h);
    (h.editor as unknown as { getHTML(): string }).getHTML = () => '<p>no scroll</p>';

    captureRenameSnapshots([{ fromDocName: h.docName, toDocName: 'to-doc' }]);

    const snap = __consumeRenameSnapshot('to-doc');
    expect(snap?.html).toBe('<p>no scroll</p>');
    expect(snap?.scrollTop).toBe(0);
  });

  test('captures TextSelection as {type:text, anchor, head}', async () => {
    const { TextSelection } = await import('@tiptap/pm/state');
    const fakeSel = Object.create(TextSelection.prototype, {
      anchor: { value: 10, writable: true, enumerable: true, configurable: true },
      head: { value: 20, writable: true, enumerable: true, configurable: true },
    }) as TextSelection;

    const h = makeTiptapHarness('from-doc');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    seedSource(h);
    (h.editor as unknown as { getHTML(): string }).getHTML = () => '<p>sel</p>';
    installFakeSelection(h, fakeSel);

    captureRenameSnapshots([{ fromDocName: h.docName, toDocName: 'to-doc' }]);

    expect(__consumeRenameSnapshot('to-doc')?.selection).toEqual({
      type: 'text',
      anchor: 10,
      head: 20,
    });
  });

  test('captures NodeSelection as {type:node, from}', async () => {
    const { NodeSelection } = await import('@tiptap/pm/state');
    const fakeSel = Object.create(NodeSelection.prototype, {
      from: { value: 8, writable: true, enumerable: true, configurable: true },
    }) as NodeSelection;

    const h = makeTiptapHarness('from-doc');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    seedSource(h);
    (h.editor as unknown as { getHTML(): string }).getHTML = () => '<p>node-sel</p>';
    installFakeSelection(h, fakeSel);

    captureRenameSnapshots([{ fromDocName: h.docName, toDocName: 'to-doc' }]);

    expect(__consumeRenameSnapshot('to-doc')?.selection).toEqual({ type: 'node', from: 8 });
  });

  test('captures null selection when editor selection is neither Text nor Node', () => {
    const h = makeTiptapHarness('from-doc');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    seedSource(h);
    (h.editor as unknown as { getHTML(): string }).getHTML = () => '<p>default</p>';

    captureRenameSnapshots([{ fromDocName: h.docName, toDocName: 'to-doc' }]);

    expect(__consumeRenameSnapshot('to-doc')?.selection).toBeNull();
  });

  test('skips empty Y.Text editors and emits ok/cache/snapshot-skipped-empty', () => {
    try {
      performance.clearMeasures();
    } catch {
    }

    const h = makeTiptapHarness('from-doc');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(h.ytext.length).toBe(0);
    (h.editor as unknown as { getHTML(): string }).getHTML = () => '<p></p>';

    captureRenameSnapshots([{ fromDocName: h.docName, toDocName: 'to-doc' }]);

    expect(__consumeRenameSnapshot('to-doc')).toBeNull();
    const emptyMarks = performance.getEntriesByName('ok/cache/snapshot-skipped-empty');
    expect(emptyMarks.length).toBeGreaterThanOrEqual(1);
  });

  test('keeps capture when ytext has content even if getHTML reports <p></p>', () => {
    const h = makeTiptapHarness('from-doc');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    seedSource(h);
    expect(h.ytext.length).toBeGreaterThan(0);
    (h.editor as unknown as { getHTML(): string }).getHTML = () => '<p></p>';

    captureRenameSnapshots([{ fromDocName: h.docName, toDocName: 'to-doc' }]);

    const snap = __consumeRenameSnapshot('to-doc');
    expect(snap?.html).toBe('<p></p>');
  });
});
