import type { HocuspocusProvider } from '@hocuspocus/provider';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { __peekDocUndoManager, acquireDocUndoManager } from './doc-undo-manager';

function createStubProvider(): {
  provider: HocuspocusProvider;
  emitDestroy: () => void;
  listenerCount: () => number;
  destroyListener: () => (() => void) | undefined;
} {
  const listeners = new Set<() => void>();
  const provider = {
    on(name: string, f: () => void) {
      if (name === 'destroy') listeners.add(f);
    },
    off(name: string, f: () => void) {
      if (name === 'destroy') listeners.delete(f);
    },
  };
  return {
    provider: provider as unknown as HocuspocusProvider,
    emitDestroy: () => {
      const pending = [...listeners];
      listeners.clear();
      for (const f of pending) f();
    },
    listenerCount: () => listeners.size,
    destroyListener: () => [...listeners][0],
  };
}

function makeDoc(): { doc: Y.Doc; ytext: Y.Text } {
  const doc = new Y.Doc();
  return { doc, ytext: doc.getText('source') };
}

const EDIT_ORIGIN = Symbol('test-edit');

function destroyListeners(doc: Y.Doc): Set<unknown> {
  const observers = (doc as unknown as { _observers: Map<string, Set<unknown>> })._observers;
  return observers.get('destroy') ?? new Set();
}

describe('acquireDocUndoManager', () => {
  test('a second acquisition of the same Y.Text reuses the manager instead of orphaning one', () => {
    const { provider } = createStubProvider();
    const { ytext } = makeDoc();

    const first = acquireDocUndoManager(provider, ytext);
    const second = acquireDocUndoManager(provider, ytext);

    expect(second).toBe(first);
  });

  test('callers can add their own tracked origin to the shared manager', () => {
    const { provider } = createStubProvider();
    const { doc, ytext } = makeDoc();
    const undoManager = acquireDocUndoManager(provider, ytext);
    undoManager.addTrackedOrigin(EDIT_ORIGIN);

    doc.transact(() => ytext.insert(0, 'tracked'), EDIT_ORIGIN);
    expect(undoManager.undoStack.length).toBe(1);

    doc.transact(() => ytext.insert(0, 'untracked'), Symbol('other'));
    expect(undoManager.undoStack.length).toBe(1);
  });

  test('provider destroy clears the stacks and stops tracking', () => {
    const { provider, emitDestroy } = createStubProvider();
    const { doc, ytext } = makeDoc();
    const undoManager = acquireDocUndoManager(provider, ytext);
    undoManager.addTrackedOrigin(EDIT_ORIGIN);

    doc.transact(() => ytext.insert(0, 'tracked'), EDIT_ORIGIN);
    expect(undoManager.canUndo()).toBe(true);

    emitDestroy();

    expect(undoManager.undoStack.length).toBe(0);
    expect(undoManager.canUndo()).toBe(false);
    expect(__peekDocUndoManager(ytext)).toBeUndefined();

    doc.transact(() => ytext.insert(0, 'after'), EDIT_ORIGIN);
    expect(undoManager.undoStack.length).toBe(0);
  });

  test('acquiring after a release builds a fresh manager for the same Y.Text', () => {
    const { provider, emitDestroy } = createStubProvider();
    const { ytext } = makeDoc();

    const first = acquireDocUndoManager(provider, ytext);
    emitDestroy();
    const second = acquireDocUndoManager(provider, ytext);

    expect(second).not.toBe(first);
    expect(__peekDocUndoManager(ytext)).toBe(second);
  });

  test('a released manager does not evict the replacement when its doc is destroyed later', () => {
    const { provider, emitDestroy } = createStubProvider();
    const { doc, ytext } = makeDoc();

    const first = acquireDocUndoManager(provider, ytext);
    first.addTrackedOrigin(EDIT_ORIGIN);
    emitDestroy();
    const second = acquireDocUndoManager(provider, ytext);
    second.addTrackedOrigin(EDIT_ORIGIN);
    expect(__peekDocUndoManager(ytext)).toBe(second);

    doc.transact(() => ytext.insert(0, 'tracked'), EDIT_ORIGIN);
    expect(second.undoStack.length).toBe(1);

    doc.destroy();

    expect(first.undoStack.length).toBe(0);
    expect(second.undoStack.length).toBe(0);
    expect(__peekDocUndoManager(ytext)).toBeUndefined();
  });

  test('provider destroy detaches the paired document listener', () => {
    const { provider, emitDestroy, destroyListener } = createStubProvider();
    const { doc, ytext } = makeDoc();

    acquireDocUndoManager(provider, ytext);
    const release = destroyListener();
    if (!release) throw new Error('Expected a provider destroy listener');
    expect(destroyListeners(doc).has(release)).toBe(true);
    emitDestroy();

    expect(destroyListeners(doc).has(release)).toBe(false);
  });

  test('doc destroy releases a manager whose provider never emitted destroy', () => {
    const { provider, listenerCount } = createStubProvider();
    const { doc, ytext } = makeDoc();
    const undoManager = acquireDocUndoManager(provider, ytext);
    undoManager.addTrackedOrigin(EDIT_ORIGIN);

    doc.transact(() => ytext.insert(0, 'tracked'), EDIT_ORIGIN);
    expect(undoManager.canUndo()).toBe(true);
    expect(listenerCount()).toBe(1);

    doc.destroy();

    expect(undoManager.canUndo()).toBe(false);
    expect(__peekDocUndoManager(ytext)).toBeUndefined();
    expect(listenerCount()).toBe(0);
  });
});
