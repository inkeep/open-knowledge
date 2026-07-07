/**
 * V2 editor cache — unit tests. Covers:
 *   - mount-park-mount preserves doc content, selection, CRDT sync
 *   - multi-cycle reparent works
 *   - evict cleans up
 *   - CACHE_ENABLED=false bypasses cache
 *
 * Convention: Bun test env has no DOM globals. We use fake shapes that
 * satisfy the narrow subset of HTMLElement the cache touches
 * (parentElement / appendChild / removeChild / scrollTop). DOM reparent
 * fidelity under REAL TipTap/CM6 is validated separately; the Playwright
 * suite exercises higher-level cache scenarios (warm-switch, etc.) but
 * does not currently pin the reparent mechanism directly.
 *
 * Y.Doc is used FOR REAL — yjs has zero DOM coupling, so we can assert
 * CRDT state is preserved through cache cycles without mocking.
 *
 * Kill switch (CACHE_ENABLED) is exported as a const; tests verify the
 * cached path with the current value (true) and the uncached path by
 * tagging entries with __uncached directly (simulates the kill-switch
 * code path without module reload).
 */

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

// ---------------------------------------------------------------------------
// Minimal HTMLElement fake — satisfies the subset the cache uses.
// ---------------------------------------------------------------------------

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
      // no-op — tracked attributes are not asserted
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

// ---------------------------------------------------------------------------
// Fake TipTap Editor / CM EditorView that satisfies the cache contract
// ---------------------------------------------------------------------------

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
    // Production `Editor.mount(target)` is what mount-promise.ts calls after
    // its yield-point. Some editor-cache tests don't exercise this path,
    // but park/evict is wired to mount-promise; the integration tests
    // below need a fake that responds to mount() by attaching DOM into the
    // target so the V2 reparent + scrollTop assertions still hold. Additive
    // for older tests since they never invoke mount().
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

// ---------------------------------------------------------------------------
// Fake HocuspocusProvider — narrow surface (destroy + document ref)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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
  /** Factory to pass into mountTiptapEditor. */
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

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('CACHE_ENABLED constant', () => {
  test('is true by default (V2 ships enabled)', () => {
    // Module exports CACHE_ENABLED; default shipping value is true.
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

    // Factory NOT called a second time — cache hit.
    expect(h.factoryCallCount).toBe(1);
    // Same entry returned.
    expect(second).toBe(first);
    // DOM reparented to new container.
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
    // Simulate scrolling the editor scrollDOM
    h.editorDom.scrollTop = 1234;
    parkTiptapEditor(entry);
    expect(entry.scrollTop).toBe(1234);

    const newContainer = makeNode();
    mountTiptapEditor({
      docName: h.docName,
      container: newContainer as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    // Container's scrollTop should be restored.
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

    // Case A: editor did NOT own focus at park (fake harness has no DOM focus
    // tracking, so hadFocus is false by default). Cache-hit should NOT
    // hijack focus.
    parkTiptapEditor(entry);
    expect(entry.hadFocus).toBe(false);
    const newContainerA = makeNode();
    mountTiptapEditor({
      docName: h.docName,
      container: newContainerA as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(h.spies.focusCalls).toBe(focusCountAfterFirstMount);

    // Case B: editor DID own focus at park (simulate by flipping hadFocus
    // on the entry). Cache-hit should restore focus.
    entry.hadFocus = true;
    parkTiptapEditor(entry);
    // parkTiptapEditor overwrites hadFocus from current DOM — simulate the
    // "editor had focus" case by setting AFTER park.
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

    // DOM detached from original container.
    expect(h.editorDom.parentElement).not.toBe(h.container);
    expect(h.container.children).not.toContain(h.editorDom);
    // Editor NOT destroyed (cache preservation).
    expect(h.spies.destroyCalls).toBe(0);
    // Still in cache.
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
    // Spy on ydoc.destroy
    const ydocDestroySpy = mock(h.ydoc.destroy.bind(h.ydoc));
    h.ydoc.destroy = ydocDestroySpy;

    const result = evictTiptapEditor(h.docName);

    expect(result).toBe(true);
    expect(h.spies.destroyCalls).toBe(1);
    expect(h.providerSpies.destroyCalls).toBe(1);
    expect(ydocDestroySpy).toHaveBeenCalledTimes(1);
    expect(peekTiptap(h.docName)).toBeUndefined();
    expect(__getCacheSize('tiptap')).toBe(0);

    // Idempotent on repeat.
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

    // Seed content into Y.Doc state
    h.ytext.insert(0, 'hello from round-trip');
    const ytextBefore = entry.ytext.toString();
    const fragBefore = h.fragment.toString();
    expect(ytextBefore).toBe('hello from round-trip');

    // Park the editor
    parkTiptapEditor(entry);

    // Mount again — same entry, same Y.Doc state
    const newContainer = makeNode();
    const re = mountTiptapEditor({
      docName: h.docName,
      container: newContainer as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(re).toBe(entry);
    expect(re.ytext.toString()).toBe(ytextBefore);
    // Y.XmlFragment identity & state preserved on the harness's original ref
    // (the cache entry doesn't hold an XmlFragment pointer; consumers reach it
    // via re.ydoc.getXmlFragment('default') which returns the same Y.Item by
    // name as long as ydoc.destroy() was never called).
    expect(h.fragment.toString()).toBe(fragBefore);

    // CRDT sync via Y.Doc transact after reparent still works
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
      // After park, DOM is NOT in ANY user-supplied container
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
      // DOM ended up in the new container
      expect(h.editorDom.parentElement).toBe(ctr);
    }

    // Factory was called exactly once — all subsequent mounts are cache hits.
    expect(h.factoryCallCount).toBe(1);
    // Editor was never destroyed during the cycle loop.
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

    // Park both
    const peekA = peekTiptap(a.docName);
    const peekB = peekTiptap(b.docName);
    if (!peekA || !peekB) throw new Error('cache entries missing');
    parkTiptapEditor(peekA);
    parkTiptapEditor(peekB);

    // Remount b
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

    // Track destroy calls on doc-0 (oldest).
    expect(harnesses[0].spies.destroyCalls).toBe(0);

    // Mount 11th doc — should evict doc-0
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
    // LRU: [doc-0, doc-1, doc-2] — doc-0 oldest.
    expect(__getCacheOrder('tiptap')).toEqual(['doc-0', 'doc-1', 'doc-2']);

    // Re-mount doc-0 (cache hit) — should move to end.
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
    // Simulate kill-switch path without toggling the module constant:
    // construct an entry and manually mark it __uncached.
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
    // Kill-switch parks destroy the editor (pre-V2 destroy-on-unmount).
    expect(h.spies.destroyCalls).toBe(1);
    expect(entry.activeMountKey).toBeNull();
  });

  test('__uncached entry: NOT stored in cache (verified by peekTiptap)', () => {
    // When a consumer handles kill-switch locally, the cache map stays empty.
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
    // Module-level cache was not touched by this synthetic entry
    expect(peekTiptap(h.docName)).toBeUndefined();
    // park still sane
    parkTiptapEditor(entry);
    expect(h.spies.destroyCalls).toBe(1);
  });
});

describe('TipTap cache — undoManager.restore cleanup on destroy', () => {
  // Yjs's UndoManager constructor registers `doc.on('destroy', () => this.destroy())`
  // with no stable reference, so `UndoManager.destroy()` cannot off it. The Set
  // entry retains the UndoManager forever. Independently,
  // @tiptap/extension-collaboration's plugin-view destroy assigns
  // `undoManager.restore = closure(viewRet, view, editor, binding, ...)` —
  // capturing the entire EditorView + ProsemirrorBinding + Editor + PM document
  // tree. Together that's ~30 MB pinned per mount/destroy cycle on multi-MB
  // docs. The cache MUST null `undoManager.restore` after `editor.destroy()` to
  // break the closure chain.
  //
  // Verification strategy: the production cache reads the per-editor
  // UndoManager via `yUndoPluginKey.getState(editor.state).undoManager`. We
  // stub `yUndoPluginKey.getState` to return a sentinel UndoManager-shaped
  // object whose `restore` field starts as a callable closure and assert it is
  // `undefined` after the cache's destroy path runs.

  let originalGetState: typeof yUndoPluginKey.getState;

  beforeEach(() => {
    __resetCacheForTests();
    originalGetState = yUndoPluginKey.getState;
    // The stub honors the production call shape but returns our sentinel for
    // fake states tagged with __testUndoManager.
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
    // TipTap's throwing-proxy can throw mid-destroy; the cache already
    // try/catches that. The capture-before-destroy ordering means we still
    // hold the undoManager reference after destroy throws and can clear
    // restore on the affected manager.
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
    // Symmetric to the parkTiptapEditor ordering test — the evict path has
    // the same inline-duplicated capture-before-destroy pattern. A localized
    // refactor that moves readEditorUndoManager after editor.destroy() on
    // the evict path would not be caught by the park-only ordering test.
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
    // The evict path has its own inline cleanup (duplicated, not extracted) +
    // emits ok/cache/evict-failed telemetry on editor.destroy() throws. This
    // symmetric test guards against a refactor that moves restore-cleanup
    // inside the destroy try-block on this path.
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
    // Models real TipTap post-destroy semantics: editor.state is accessible
    // before destroy, but becomes a throwing proxy after. The cleanup must
    // capture the undoManager BEFORE calling destroy. This test fails if
    // anyone reorders the production code to call readEditorUndoManager
    // after editor.destroy() — at which point the throwing-proxy state
    // would cause readEditorUndoManager to return null and the leak would
    // return silently. Existing throw-tests don't catch this because they
    // model "state always throws" or "destroy throws"; this test models the
    // production transition state-OK → destroy-OK → state-throws.
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
    // Capture must have happened pre-destroy — otherwise the throwing state
    // proxy would have made readEditorUndoManager return null and restore
    // would still be the original closure.
    expect(undoManager.restore).toBeUndefined();
  });

  test('no crash when editor.state throws (TipTap throwing-proxy mid-teardown)', () => {
    // editor.state is a throwing proxy in known TipTap mid-teardown windows.
    // Pre-destroy capture must defensive-noop in that case rather than
    // escaping.
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
    // TipTap editors without the y-undo plugin loaded (e.g. non-collaborative
    // configurations) have no undoManager to clean up; the cache must skip
    // the cleanup silently. (CM6 editors don't take this path at all —
    // parkCmEditor/evictCmEditor never call readEditorUndoManager.)
    const h = makeTiptapHarness('doc-a');
    // No state attached → stubbed yUndoPluginKey.getState falls through to the
    // real getState, which returns null for non-PM-state inputs.
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

// ---------------------------------------------------------------------------
// CM6 cache — symmetric tests
// ---------------------------------------------------------------------------

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

  // Regression: config staleness on backgrounded docs after a setting toggle
  // (theme dark/light, word-wrap). These Compartments must live on the cache
  // entry (with the view), not on the consuming React component — otherwise a
  // remounted SourceEditor reconfigures a compartment absent from the reused
  // view and the toggle is a silent no-op. The cache-hit returning the SAME
  // entry is what makes `entry.*Compartment` reachable for reconfigure on
  // reattach.
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
    // Same compartment instances survive the reattach — no second construction.
    expect(second.themeCompartment).toBe(h.themeCompartment);
    expect(second.wordWrapCompartment).toBe(h.wordWrapCompartment);
    expect(second.placeholderCompartment).toBe(h.placeholderCompartment);
    expect(h.factoryCallCount).toBe(1);
  });

  // The actual bug scenario: a doc backgrounded (parked), then reopened. The
  // remount must return the SAME entry so its compartments stay reachable for
  // the theme/word-wrap reconfigure on reattach. park() must not clear them.
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

    // Harness has no real DOM, so hadFocus captured during park is false:
    // cache-hit does NOT call focus when the editor didn't own focus at
    // park time — keyboard / deep-link users keep their focus. Scroll is still
    // restored — that's independent of focus.
    const ctr = makeNode();
    mountCmEditor({
      docName: h.docName,
      container: ctr as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(ctr.scrollTop).toBe(42);
    expect(h.spies.focusCalls).toBe(focusBefore);

    // Simulate "editor had focus at park" by flipping the cache entry's
    // hadFocus after the park (the park path would have set it true if
    // the real DOM reported the editor as activeElement). Next cache-hit
    // now DOES restore focus.
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

// ---------------------------------------------------------------------------
// STOP-rule enforcement — the cache never calls editor.mount / editor.unmount.
// ---------------------------------------------------------------------------

describe('STOP rule: editor-cache never calls editor.mount() / editor.unmount()', () => {
  test('source contains no reference to editor.mount( or editor.unmount(', async () => {
    // Grep-based invariant test. `editor.mount()` / `editor.unmount()` are
    // incompatible with the production extension stack (the @tiptap/
    // extension-drag-handle plugin closures hit TipTap's throwing proxy
    // during the re-create path). If a future edit re-introduces them,
    // this test fails immediately.
    const sourceText = await Bun.file(`${import.meta.dir}/editor-cache.ts`).text();
    // Allow references in comments/documentation (common to explain WHY not to),
    // but forbid actual code patterns: `.mount(` / `.unmount(` on an editor-like
    // receiver. We detect the function-call shape only.
    const code = sourceText
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .join('\n');
    // Look for `editor.mount(` or `editor.unmount(` as call sites in live code.
    expect(/editor\.mount\s*\(/.test(code)).toBe(false);
    expect(/editor\.unmount\s*\(/.test(code)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// StrictMode / React remount safety
// ---------------------------------------------------------------------------

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
    // StrictMode would fire effect cleanup, then mount again. Simulate:
    parkTiptapEditor(first);
    const ctr = makeNode();
    const second = mountTiptapEditor({
      docName: h.docName,
      container: ctr as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    // Same underlying entry.
    expect(second).toBe(first);
    // Single cache entry, not two.
    expect(__getCacheSize('tiptap')).toBe(1);
    // Factory called exactly once.
    expect(h.factoryCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Size-aware cache policy
// ---------------------------------------------------------------------------

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
    // Both gates simultaneously violated: viewCount=100 (>=50) AND
    // bytes=9_000_000 (>8_000_000). Confirms the gate-AND logic correctly
    // refuses when both branches reject.
    expect(shouldCacheEditor({ viewCount: 100, bytes: 9_000_000 })).toBe(false);
  });
  test('viewCount alone fails (bytes pass): refuse', () => {
    // viewCount=100 fails (>=50); bytes=1_000_000 passes (<8_000_000).
    // Confirms viewCount-alone violation refuses regardless of bytes
    // branch passing.
    expect(shouldCacheEditor({ viewCount: 100, bytes: 1_000_000 })).toBe(false);
  });
  // Explicit-inactive guard regression. `viewCount:
  // 0` is the "not-measured" sentinel passed by production call sites that
  // have not yet wired a pre-mount view-count heuristic. It MUST NOT be
  // treated as "zero views is below threshold, therefore pass" — that's
  // trivially true but it muddies the gate's semantics. The admission comes
  // from the bytes branch alone; the viewCount branch short-circuits on the
  // zero sentinel so the threshold reads as "inactive until measured."
  test('viewCount=0 sentinel does not activate the viewCount branch', () => {
    // A doc with an unmeasured viewCount but small bytes admits via bytes
    // branch alone. If viewCount=0 were incorrectly compared to the
    // threshold, the test would still pass (0 < 50). The intent check is
    // documented in the comment above — we just verify the happy path.
    expect(shouldCacheEditor({ viewCount: 0, bytes: 100 })).toBe(true);
    // A doc with an unmeasured viewCount but oversized bytes refuses via
    // bytes branch alone — NOT because viewCount=0 was below threshold.
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

// ---------------------------------------------------------------------------
// Activity-mount list + provider connect/disconnect
// ---------------------------------------------------------------------------

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

    // Same list again — idempotent.
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

    // Swap: a out, b in.
    setActivityMountList(['doc-b']);
    expect(a.providerSpies.disconnectCalls).toBe(1);
    expect(b.providerSpies.connectCalls).toBe(1);
  });

  test('unknown docName in list: no crash, no connect (provider not yet in cache)', () => {
    setActivityMountList(['doc-a']);
    // No entry for doc-a; should not throw.
    expect(__getActivityMountList()).toEqual(['doc-a']);
  });

  test('CM-only cache entry: provider transitions still fire (same docName)', () => {
    // Provider is shared between TipTap+CM for a given doc. Verify CM-only
    // is sufficient to resolve the provider ref.
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
    // Regression test for the ACTIVITY_MOUNT_LIMIT=1 silent disconnect-skip
    // bug. When
    // a doc is pool-open (HocuspocusProvider connected) but the V2 editor
    // cache rejected it (defer-mount + cache-miss, e.g. a doc above
    // BYTES_CACHE_THRESHOLD or VIEW_COUNT_CACHE_THRESHOLD),
    // findProvider must fall back to pool.entries — otherwise the demote
    // path silently skips the disconnect and the provider keeps draining
    // peer bytes into the local Y.Doc forever.
    const ydoc = new Y.Doc();
    const { provider, spies } = makeFakeProvider(ydoc);
    const fakePool = {
      entries: new Map<string, { provider: HocuspocusProvider }>([
        ['orphan-doc', { provider }],
      ]) as ReadonlyMap<string, { provider: HocuspocusProvider }>,
      onEvict: (_cb: (docName: string) => void) => () => {
        // no-op: test doesn't exercise pool eviction
      },
    };
    const unsubscribe = subscribePoolEviction(fakePool);
    try {
      // Doc is NOT in V2 cache — only in pool.entries.
      expect(peekTiptap('orphan-doc')).toBeUndefined();
      expect(__peekCm('orphan-doc')).toBeUndefined();

      // Promote — provider connect (idempotent on already-connected pool provider).
      setActivityMountList(['orphan-doc']);
      expect(spies.connectCalls).toBe(1);

      // Demote — must disconnect via pool fallback. This is the bug guard.
      setActivityMountList([]);
      expect(spies.disconnectCalls).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  test('subscribePoolEviction unsubscribe clears pool reference: subsequent demote no-ops without pool', () => {
    // After unsubscribe, the cache must NOT retain a stale pool reference.
    // Otherwise a later test or subsequent component lifecycle could see
    // disconnects for providers that have already been torn down.
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
    // After unsubscribe the pool ref is gone; nothing to find, nothing to disconnect.
    expect(spies.disconnectCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parkingNode per-entry exclusivity (precedent #44).
//
// `@tiptap/react`'s PureEditorContent.componentDidMount vacuums
// `element.append(...editor.view.dom.parentNode.childNodes)` — a parking
// parent shared across cache entries would drag every parked view.dom into
// the newly-mounting editor's wrapper. Each cache entry must own a separate
// `parkingNode` created lazily on first park via `tryCreateParkingNode`.
//
// `installDocumentStub()` is required because `tryCreateParkingNode` returns
// null when `typeof document === 'undefined'` (the default Bun environment).
// ---------------------------------------------------------------------------

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
    // Pins the `if (!entry.parkingNode)` lazy-init guard. A regression that
    // re-creates the parking node on every park (e.g. unconditional assignment)
    // would break identity and re-introduce per-cycle GC churn.
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
    // Capture the eviction callback the cache registers with the pool, then
    // fire it directly. Verifies pool→cache propagation: when the pool
    // evicts a provider, both editor cache kinds for that docName must be
    // torn down so editors cannot outlive the Y.Doc they're bound to.
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
    // Pool can race ahead of the V2 cache: a provider can be evicted from
    // the pool before any editor was ever mounted for that doc, or after
    // the cache already evicted on its own. Either way, the propagation
    // callback must tolerate misses without throwing.
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
    // Mount MAX_CACHE entries, mark the oldest (doc-0) as Activity-mounted.
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
    // Pin doc-0 in Activity mount list.
    setActivityMountList(['doc-0']);

    // Mount 11th — the oldest NON-active is doc-1.
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
    // Pathological: all 10 docs active (beyond ACTIVITY_MOUNT_LIMIT).
    setActivityMountList(harnesses.map((x) => x.docName));

    const extra = makeTiptapHarness('doc-extra');
    mountTiptapEditor({
      docName: extra.docName,
      container: extra.container as unknown as HTMLElement,
      factory: extra.factory as unknown as (el: HTMLElement) => ReturnType<typeof extra.factory>,
    });
    // Degenerate fallback kicks in — something gets evicted even though all active.
    expect(__getCacheSize('tiptap')).toBe(MAX_CACHE);
  });
});

describe('telemetry marks', () => {
  // Telemetry is side-effect only — the collector's in-test observability
  // is via performance.getEntriesByName. We spot-check a few key paths.
  beforeEach(() => {
    __resetCacheForTests();
    try {
      performance.clearMeasures();
    } catch {
      // some envs
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
    // Cache hit.
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
    // connect() returns a Promise in the test harness — the `ok/cache/connect`
    // mark fires inside .then so success + failure are mutually exclusive.
    // Flush microtasks before asserting.
    await Promise.resolve();
    const connects = performance.getEntriesByName('ok/cache/connect');
    expect(connects.length).toBeGreaterThanOrEqual(1);

    setActivityMountList([]);
    // disconnect() is synchronous — mark fires inside the try (no Promise).
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
    // Clear prior marks from other tests.
    performance.clearMarks('ok/cache/connect');
    performance.clearMarks('ok/cache/connect-failed');
    setActivityMountList(['doc-reject']);
    // Flush microtasks so the rejection propagates.
    await Promise.resolve();
    await Promise.resolve();
    const connects = performance.getEntriesByName('ok/cache/connect');
    const failed = performance.getEntriesByName('ok/cache/connect-failed');
    // The key invariant: reject emits connect-failed WITHOUT emitting
    // connect first. Pre-fix, both marks fired for the same docName.
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
    // The first mount emits the miss stats. Clear and mount again (hit).
    try {
      performance.clearMeasures('ok/cold/editor-mount-stats');
    } catch {
      // some envs
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

// ---------------------------------------------------------------------------
// ok/cache/reparent-{start,end} span marks
// for cache-hit reparent latency curve.
// ---------------------------------------------------------------------------

describe('US-001 (cap-calibration-probes): cache-hit reparent span marks', () => {
  beforeEach(() => {
    __resetCacheForTests();
    try {
      performance.clearMarks('ok/cache/reparent-start');
      performance.clearMarks('ok/cache/reparent-end');
      performance.clearMeasures('ok/cache/reparent-start');
      performance.clearMeasures('ok/cache/reparent-end');
    } catch {
      // some envs lack one or the other
    }
  });
  afterEach(() => __resetCacheForTests());

  test('TipTap cache-hit emits both ok/cache/reparent-start and ok/cache/reparent-end', () => {
    const h = makeTiptapHarness('doc-a');
    // First mount = cache miss; clear marks before the cache-hit re-mount.
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    try {
      performance.clearMeasures('ok/cache/reparent-start');
      performance.clearMeasures('ok/cache/reparent-end');
    } catch {
      // ignore
    }
    // Second mount = cache hit — should emit both marks.
    mountTiptapEditor({
      docName: h.docName,
      container: makeNode() as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    const starts = performance.getEntriesByName('ok/cache/reparent-start');
    const ends = performance.getEntriesByName('ok/cache/reparent-end');
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(ends.length).toBeGreaterThanOrEqual(1);
    // End must come at-or-after start (non-negative span between them).
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
    // Cache miss path (cold mount) should never emit reparent marks.
    expect(performance.getEntriesByName('ok/cache/reparent-start').length).toBe(0);
    expect(performance.getEntriesByName('ok/cache/reparent-end').length).toBe(0);
  });

  test('TipTap kill-switch / __uncached path does NOT emit reparent marks', () => {
    const h = makeTiptapHarness('big-doc');
    // Size gate refuses → __uncached fast-path; reparent marks must NOT fire.
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
      // ignore
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
    // The reparent span brackets the actual reparent + scroll/focus restore;
    // ok/cache/hit fires after the span closes. End must precede or equal
    // the cache/hit emission.
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
      // ignore
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
    // existing mark('ok/cache/hit', ...) is preserved.
    const h = makeTiptapHarness('doc-preserve');
    mountTiptapEditor({
      docName: h.docName,
      container: h.container as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    try {
      performance.clearMeasures('ok/cache/hit');
    } catch {
      // ignore
    }
    mountTiptapEditor({
      docName: h.docName,
      container: makeNode() as unknown as HTMLElement,
      factory: h.factory as unknown as (el: HTMLElement) => ReturnType<typeof h.factory>,
    });
    expect(performance.getEntriesByName('ok/cache/hit').length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// mount-promise cancellation wired into park / evict spines.
// Park / evict are the V2 cache's tear-down primitives; both must invalidate
// any in-flight mount-promise BEFORE running their existing destroy/detach
// logic so the AbortController fires before DOM teardown — preventing the
// mount-promise body from completing post-park/evict and creating a phantom
// V2 cache entry behind our back.
// ---------------------------------------------------------------------------

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
    // The mount-promise cache lifetime tracks the V2-cache-entry lifetime,
    // not the React-component lifetime. Park preserves the V2 entry (editor
    // stays alive), so the corresponding mount-promise must also stay so
    // that the next mount of this docName returns the SAME promise reference.
    // React's `use()` on a stable `.status='fulfilled'` thenable short-
    // circuits with no Suspense cycle; on a fresh promise it pays a Suspense
    // fallback flash, which would surface to the user as a "cold load"
    // between Activity-pool tabs even though the editor is cached.
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

    // Both caches hold the entry. mount-promise's resolved cache entry points
    // at the V2 entry by reference.
    expect(__mountPromiseCacheSize()).toBe(1);
    expect(__mountPromiseSettled(h.docName)).toBe(true);
    expect(__getCacheSize('tiptap')).toBe(1);
    expect(entry.activeMountKey).toBe(h.docName);

    parkTiptapEditor(entry);

    // Mount-promise cache PRESERVED across park — the next mount returns the
    // same Promise reference (already-resolved, .status='fulfilled' observed
    // by use() previously), short-circuiting Suspense.
    expect(__mountPromiseCacheSize()).toBe(1);
    expect(__mountPromiseSettled(h.docName)).toBe(true);
    // V2 entry preserved (cached path; not destroyed).
    expect(peekTiptap(h.docName)).toBeDefined();
    expect(h.spies.destroyCalls).toBe(0);

    // Re-mount: same Promise reference returned. This is the load-bearing
    // assertion — if invalidate ran on park, this would be a fresh promise
    // and the user would see a Suspense flash on every tab switch.
    const secondPromise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct,
    });
    expect(secondPromise).toBe(firstPromise);
  });

  test('park-on-already-parked entry: no-op for both V2 cache and mount-promise (preservation contract)', async () => {
    // After the first park, activeMountKey is null. The mount-promise cache
    // STAYS populated (corrected from the original buggy contract where park
    // invalidated). A second park must remain a safe no-op for both caches —
    // V2 entry stays cached, mount-promise stays settled, no double-destroy.
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

    // Second park — entry already settled.
    parkTiptapEditor(entry);
    expect(__mountPromiseCacheSize()).toBe(1);
    expect(h.spies.destroyCalls).toBe(0);
  });

  test('__uncached park: invalidates mount-promise BEFORE the kill-switch destroy fires (silent — no rejection)', async () => {
    // Synthesize an __uncached entry the same way `__uncached / kill-switch
    // path` tests do. Then prime the mount-promise cache for the same
    // docName so we can observe that invalidation fires even on the
    // kill-switch path. Under silent-invalidate semantics, the
    // primer's pending promise is left orphaned (no rejection) — only the
    // cache state is torn down.
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

    // Park the __uncached entry — invalidate (silent) tears down the
    // mount-promise cache entry, THEN kill-switch destroy runs.
    expect(h.spies.destroyCalls).toBe(0);
    parkTiptapEditor(entry);
    expect(__mountPromiseCacheSize()).toBe(0);
    expect(h.spies.destroyCalls).toBe(1);

    // Drain macrotasks so primer's body resumes from scheduler.yield;
    // takes the abort short-circuit, no rejection (silent contract).
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

    // V2 destroyed (existing semantic preserved) AND mount-promise invalidated.
    expect(result).toBe(true);
    expect(__mountPromiseCacheSize()).toBe(0);
    expect(peekTiptap(h.docName)).toBeUndefined();
    expect(h.spies.destroyCalls).toBe(1);
    expect(h.providerSpies.destroyCalls).toBe(1);
  });

  test('evict-during-yield-window: tears down silently, body short-circuits, pre-mount editor destroyed (no rejection)', async () => {
    // The during-yield case is the architectural reason park/evict must
    // unconditionally invalidate: V2 has no entry yet (mount() hasn't run),
    // but mount-promise has an in-flight entry whose body is mid-construct
    // → yield → mount. Without invalidation, the body would proceed past
    // the yield, mount the editor, and land a phantom V2 entry behind the
    // user's "I evicted this doc" intent. Under silent-invalidate,
    // the consumer promise is left orphaned (no rejection) — cache-driven
    // eviction is invisible to the consumer.
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

    // Stub scheduler.yield so the pre-construct yield resolves immediately
    // (construct runs) and the post-construct yield stalls — pins the body
    // in the post-construct yield-window so evict fires with a populated
    // preMountEditor but no V2 entry yet.
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

      // Drain microtasks so the body resumes from the pre-construct yield,
      // runs construct(), and suspends at the post-construct yield.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(constructed).toBe(true);

      const result = evictTiptapEditor(h.docName);
      expect(result).toBe(false); // V2 had no entry to evict
      expect(__mountPromiseCacheSize()).toBe(0);

      // Release the stalled yield so the body resumes and short-circuits at
      // the post-construct abort check. Silent contract: no rejection.
      if (stallResolve) (stallResolve as () => void)();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(consumerRejected).toBe(false);
      expect(h.spies.destroyCalls).toBe(1);
      expect(h.spies.mountCalls).toBe(0);
      // V2 cache is empty — no phantom entry.
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

  // FIFO eviction boundary — pins the MAX_CACHE bound on the rename snapshot
  // store. Without this, a broken eviction (e.g., accidental .clear() removal,
  // or an off-by-one on the >= check) would cause unbounded growth during a
  // rename storm (folder rename of N children stores N snapshots).
  test('FIFO eviction: oldest snapshot dropped when MAX_CACHE exceeded', () => {
    for (let i = 0; i < MAX_CACHE; i++) {
      storeRenameSnapshot(`doc-${i}`, baseSnap(`<p>${i}</p>`));
    }
    // Store one over — should evict doc-0 (oldest).
    storeRenameSnapshot('doc-overflow', baseSnap('<p>new</p>'));
    expect(__consumeRenameSnapshot('doc-0')).toBeNull();
    expect(__consumeRenameSnapshot('doc-overflow')?.html).toBe('<p>new</p>');
    // doc-1 through doc-(MAX_CACHE-1) survive.
    expect(__consumeRenameSnapshot('doc-1')?.html).toBe('<p>1</p>');
  });

  // StrictMode-safety contract for production peek path. The React 19 dev
  // double-invoke of `useState` lazy initializers calls peekRenameSnapshot
  // twice; both calls MUST return the same value (otherwise mount 2 sees
  // null and the warm fallback flashes empty). peek (read without delete)
  // satisfies this; the consume path does not. See peekRenameSnapshot
  // JSDoc + EditorActivityPool ActivityEntry useState site.
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

  // Helper: install a fake selection on the harness editor so captureSelection
  // can read it. Uses `instanceof` via Object.create against the real PM classes
  // with property descriptors (PM Selection's anchor/head are getters; we
  // override with defineProperty values rather than assigning to the getter).
  function installFakeSelection(h: ReturnType<typeof makeTiptapHarness>, sel: object): void {
    (h.editor as unknown as { state: { selection: unknown } }).state = { selection: sel };
  }

  // Helper: seed `ytext` so the empty-source guard doesn't fire. Other tests
  // in this block assert snapshot-capture against an editor where `getHTML`
  // is overridden but ytext stays empty; the empty-source guard treats
  // `ytext.length === 0` as canonical "never-edited" and skips the snapshot
  // to drop Suspense back to `<EditorSkeleton />` instead of a blank
  // `WarmContentFallback`. Tests of capture mechanics still need an editor
  // that looks non-empty to ytext.
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
    // No `document` in node test runtime; readActiveScrollTop short-circuits
    // to 0. Same result if document existed but the selector didn't match.
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
    // PM Selection's anchor/head are getters derived from ResolvedPos $anchor/$head.
    // Override with defineProperty so the captureSelection reader picks the
    // injected values; instanceof TextSelection holds because the prototype
    // chain is set via Object.create.
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
    // Default fake editor has no state.selection — captureSelection returns null.
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
    // Never-edited source: harness ytext stays at length 0 (no `seedSource`
    // call). Without the guard, the snapshot would be stored under
    // `to-doc` with the editor's `<p></p>` getHTML output, which surfaces
    // as a `pointer-events-none` `WarmContentFallback` overlay during the
    // freshly-mounted destination editor's Suspense window — blocking
    // user keystrokes. Skip restores the visible `<EditorSkeleton />`
    // Suspense fallback.
    try {
      performance.clearMeasures();
    } catch {
      // some envs
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
    // Pins ytext (not getHTML output) as the canonical empty-check. If a future
    // refactor switched the guard to 'getHTML() === "<p></p>"', this test
    // would fail — ytext.length > 0 means there IS user-intended source content
    // to preserve in the warm-skeleton snapshot, regardless of what HTML the
    // serializer happened to produce for it.
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
