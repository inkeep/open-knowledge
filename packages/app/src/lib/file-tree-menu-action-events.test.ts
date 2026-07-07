/**
 * Coverage for the file-tree menu-action event buses. Mirrors the
 * `create-file-events.test.ts` pattern — same event-bus discipline. The
 * bus is the single rendezvous between FileSidebar's macOS File menu
 * subscriber (emitter) and FileTree's row-action spines
 * (subscriber); pinning emit + subscribe behavior keeps a refactor that
 * breaks either side from silently making File → Move to Trash a no-op.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { ResolvedNavigationTarget } from '@/components/navigation-targets';
import {
  emitFileTreeMenuActionDelete,
  emitFileTreeMenuActionDuplicate,
  emitFileTreeMenuActionRename,
  subscribeToFileTreeMenuActionDelete,
  subscribeToFileTreeMenuActionDuplicate,
  subscribeToFileTreeMenuActionRename,
} from './file-tree-menu-action-events';

// Bun's test runner doesn't ship a `window` global; install a minimal
// EventTarget-shaped fake mirroring `create-file-events.test.ts`'s
// precedent (same event-bus discipline). Restored after each test to
// keep other suites from inheriting the shim.
const originalWindow = globalThis.window;

type Listener = (event: Event) => void;

function installFakeWindow() {
  const listeners = new Map<string, Set<Listener>>();
  const fakeWindow = {
    addEventListener(type: string, listener: Listener) {
      const set = listeners.get(type) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event: Event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: fakeWindow,
    writable: true,
  });
  return fakeWindow;
}

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
    writable: true,
  });
});

const FOLDER_TARGET: ResolvedNavigationTarget = {
  kind: 'folder',
  target: 'reports',
  folderPath: 'reports',
};

const DOC_TARGET: ResolvedNavigationTarget = {
  kind: 'doc',
  target: 'specs/foo',
  docName: 'specs/foo',
};

describe('file-tree-menu-action-events bus', () => {
  test('subscribe delivers the emitted target verbatim', () => {
    installFakeWindow();
    const received: ResolvedNavigationTarget[] = [];
    const unsubscribe = subscribeToFileTreeMenuActionDelete((target) => received.push(target));
    emitFileTreeMenuActionDelete(DOC_TARGET);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(DOC_TARGET);
    unsubscribe();
  });

  test('multiple emits fan out to all live subscribers', () => {
    installFakeWindow();
    const a: ResolvedNavigationTarget[] = [];
    const b: ResolvedNavigationTarget[] = [];
    const unsubA = subscribeToFileTreeMenuActionDelete((target) => a.push(target));
    const unsubB = subscribeToFileTreeMenuActionDelete((target) => b.push(target));
    emitFileTreeMenuActionDelete(DOC_TARGET);
    emitFileTreeMenuActionDelete(FOLDER_TARGET);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(a[0]).toEqual(DOC_TARGET);
    expect(b[1]).toEqual(FOLDER_TARGET);
    unsubA();
    unsubB();
  });

  test('unsubscribe stops further deliveries', () => {
    installFakeWindow();
    const received: ResolvedNavigationTarget[] = [];
    const unsubscribe = subscribeToFileTreeMenuActionDelete((target) => received.push(target));
    emitFileTreeMenuActionDelete(DOC_TARGET);
    unsubscribe();
    emitFileTreeMenuActionDelete(FOLDER_TARGET);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(DOC_TARGET);
  });

  test('rename: subscribe delivers the emitted target verbatim', () => {
    installFakeWindow();
    const received: ResolvedNavigationTarget[] = [];
    const unsubscribe = subscribeToFileTreeMenuActionRename((target) => received.push(target));
    emitFileTreeMenuActionRename(DOC_TARGET);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(DOC_TARGET);
    unsubscribe();
  });

  test('rename + delete buses are independent channels', () => {
    installFakeWindow();
    const renameReceived: ResolvedNavigationTarget[] = [];
    const deleteReceived: ResolvedNavigationTarget[] = [];
    const unsubRename = subscribeToFileTreeMenuActionRename((t) => renameReceived.push(t));
    const unsubDelete = subscribeToFileTreeMenuActionDelete((t) => deleteReceived.push(t));
    emitFileTreeMenuActionRename(DOC_TARGET);
    emitFileTreeMenuActionDelete(FOLDER_TARGET);
    expect(renameReceived).toEqual([DOC_TARGET]);
    expect(deleteReceived).toEqual([FOLDER_TARGET]);
    unsubRename();
    unsubDelete();
  });

  test('rename unsubscribe stops further deliveries', () => {
    installFakeWindow();
    const received: ResolvedNavigationTarget[] = [];
    const unsubscribe = subscribeToFileTreeMenuActionRename((target) => received.push(target));
    emitFileTreeMenuActionRename(DOC_TARGET);
    unsubscribe();
    emitFileTreeMenuActionRename(FOLDER_TARGET);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(DOC_TARGET);
  });

  test('duplicate: subscribe delivers the emitted target verbatim', () => {
    installFakeWindow();
    const received: ResolvedNavigationTarget[] = [];
    const unsubscribe = subscribeToFileTreeMenuActionDuplicate((target) => received.push(target));
    emitFileTreeMenuActionDuplicate(DOC_TARGET);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(DOC_TARGET);
    unsubscribe();
  });

  test('duplicate bus is independent from rename and delete channels', () => {
    installFakeWindow();
    const duplicateReceived: ResolvedNavigationTarget[] = [];
    const renameReceived: ResolvedNavigationTarget[] = [];
    const deleteReceived: ResolvedNavigationTarget[] = [];
    const unsubDuplicate = subscribeToFileTreeMenuActionDuplicate((t) => duplicateReceived.push(t));
    const unsubRename = subscribeToFileTreeMenuActionRename((t) => renameReceived.push(t));
    const unsubDelete = subscribeToFileTreeMenuActionDelete((t) => deleteReceived.push(t));
    emitFileTreeMenuActionDuplicate(DOC_TARGET);
    emitFileTreeMenuActionRename(FOLDER_TARGET);
    emitFileTreeMenuActionDelete(FOLDER_TARGET);
    expect(duplicateReceived).toEqual([DOC_TARGET]);
    expect(renameReceived).toEqual([FOLDER_TARGET]);
    expect(deleteReceived).toEqual([FOLDER_TARGET]);
    unsubDuplicate();
    unsubRename();
    unsubDelete();
  });
});
