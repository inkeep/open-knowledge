/**
 * One `Y.UndoManager` per document, over `Y.Text('source')`, shared by both
 * editing surfaces.
 *
 * This is the fix the migration exists for. Today there are two undo stacks
 * over two CRDT types — `Y.UndoManager` on `Y.Text` for source mode, another on
 * the XmlFragment for WYSIWYG — so undo only ever retracts edits made in the
 * view you are undoing from, and the bridge's own rewrites are tracked by
 * NEITHER (they run under `OBSERVER_SYNC_ORIGIN`), which is how a bridge
 * rewrite can silently split a user's frame in half.
 *
 * Once WYSIWYG writes `Y.Text` under its own tracked origin
 * (`projection-binding.ts`), a single manager sees every local edit from both
 * surfaces in one global LIFO: the most recent edit retracts, whichever view
 * made it. There is nothing to coordinate between two stacks because there is
 * one stack.
 *
 * `y-codemirror.next` adds its own sync config to `trackedOrigins` when it
 * installs, so handing this manager to `yCollab` is all source mode needs. The
 * `null` origin is tracked to match what `yCollab` would have created on its
 * own (`new Y.UndoManager(ytext)` defaults to `{ null }`), so a build with the
 * projection flag off behaves exactly as before.
 */

import type * as Y from 'yjs';
import { UndoManager } from 'yjs';

/**
 * Stamped on WYSIWYG writes. Exported as the identity the manager tracks, not
 * as a value to reuse elsewhere: anything else writing under it would become
 * undoable by the user as though they had typed it.
 */
export const PROJECTION_WRITE_ORIGIN = Symbol('ok/projection-write');

const managers = new WeakMap<Y.Text, UndoManager>();

/**
 * The document's undo manager, created on first use.
 *
 * Keyed on the `Y.Text` rather than the `Y.Doc` so it cannot be shared across
 * documents that happen to travel together, and weakly so it is collected with
 * the document — the manager holds observers on the text, and the text holds
 * the manager, but neither outlives the doc that owns both.
 */
export function sharedUndoManagerFor(ytext: Y.Text): UndoManager {
  const existing = managers.get(ytext);
  if (existing !== undefined) return existing;
  const manager = new UndoManager(ytext, {
    trackedOrigins: new Set<unknown>([null, PROJECTION_WRITE_ORIGIN]),
  });
  managers.set(ytext, manager);
  return manager;
}
