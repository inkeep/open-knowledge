import type * as Y from 'yjs';
import { UndoManager } from 'yjs';

/* STOP: an identity for this manager to track, not an origin to write under. Anything else
   stamping it becomes undoable by the user as though they had typed it. */
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
