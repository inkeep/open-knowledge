import type * as Y from 'yjs';
import { UndoManager } from 'yjs';

export const PROJECTION_WRITE_ORIGIN = Symbol('ok/projection-write');

const managers = new WeakMap<Y.Text, UndoManager>();

export function sharedUndoManagerFor(ytext: Y.Text): UndoManager {
  const existing = managers.get(ytext);
  if (existing !== undefined) return existing;
  const manager = new UndoManager(ytext, {
    trackedOrigins: new Set<unknown>([null, PROJECTION_WRITE_ORIGIN]),
  });
  managers.set(ytext, manager);
  return manager;
}
