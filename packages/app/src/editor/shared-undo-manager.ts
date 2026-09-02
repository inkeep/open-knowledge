/**
 * One `Y.UndoManager` per document, over `Y.Text('source')`, shared by both
 * editing surfaces.
 *
 * Both surfaces write `Y.Text` under origins this manager tracks — source mode
 * through `yCollab`, WYSIWYG under `PROJECTION_WRITE_ORIGIN` — so every local
 * edit lands in one global LIFO and the most recent one retracts, whichever
 * view made it. A second manager over the same document would reintroduce the
 * cross-mode defect in a new shape: two stacks cannot agree on what "most
 * recent" means.
 *
 * `y-codemirror.next` adds its own sync config to `trackedOrigins` when it
 * installs, so handing this manager to `yCollab` is all source mode needs. The
 * `null` origin is tracked because that is what an unconfigured
 * `new Y.UndoManager(ytext)` defaults to, and what `yCollab` assumes when it
 * dispatches undoable transactions of its own.
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
