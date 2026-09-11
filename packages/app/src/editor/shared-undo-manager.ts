import type * as Y from 'yjs';
import { UndoManager } from 'yjs';
import { mark } from '@/lib/perf';

/* STOP: an identity for this manager to track, not an origin to write under. Anything else
   stamping it becomes undoable by the user as though they had typed it. */
export const PROJECTION_WRITE_ORIGIN = Symbol('ok/projection-write');

const managers = new WeakMap<Y.Text, UndoManager>();

function isTrackedOrigin(undoManager: UndoManager, origin: unknown): boolean {
  const tracked = undoManager.trackedOrigins as Set<unknown>;
  if (tracked.has(origin)) return true;
  if (!origin) return false;
  return tracked.has((origin as { constructor?: unknown }).constructor);
}

function wholeTextReplacement(event: Y.YTextEvent): { deleted: number; inserted: number } | null {
  let deleted = 0;
  let inserted = 0;
  for (const delta of event.delta) {
    if (delta.retain !== undefined) return null;
    deleted += delta.delete ?? 0;
    if (delta.insert !== undefined) {
      inserted += typeof delta.insert === 'string' ? delta.insert.length : 1;
    }
  }
  const lengthBefore = event.target.length + deleted - inserted;
  return deleted > 0 && deleted === lengthBefore ? { deleted, inserted } : null;
}

export function sharedUndoManagerFor(ytext: Y.Text): UndoManager {
  const existing = managers.get(ytext);
  if (existing !== undefined) return existing;
  const manager = new UndoManager(ytext, {
    trackedOrigins: new Set<unknown>([null, PROJECTION_WRITE_ORIGIN]),
  });
  ytext.observe((event, transaction) => {
    if (isTrackedOrigin(manager, transaction.origin)) return;
    const replaced = wholeTextReplacement(event);
    if (replaced === null) return;
    manager.clear();
    mark('ok/undo/full-replace-clear', replaced);
  });
  managers.set(ytext, manager);
  return manager;
}
