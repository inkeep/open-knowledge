/**
 * The policy half of the fragment-derive demand gate: given the awareness
 * states of everyone connected to a document, decide whether the derived
 * WYSIWYG fragment still has to be kept fresh.
 *
 * Split from the wiring in `server-observer-extension.ts` so the decision is a
 * pure function over a plain map and can be tested without a Hocuspocus
 * server, an awareness protocol instance, or a live socket.
 *
 * FAIL-SAFE DIRECTION. Every uncertain case resolves to "yes, derive". The
 * cost of a wrong "yes" is the work we already do today; the cost of a wrong
 * "no" is a WYSIWYG showing stale content to somebody who is looking at it.
 * Those are not symmetric, and this file should stay biased accordingly. In
 * particular a peer whose `mode` is missing or unrecognised counts as
 * demanding — an older client that predates the `mode` field, or any
 * non-editor connection, must not be read as "not looking".
 */

/** Awareness field the editor publishes; see `TiptapEditor.tsx`'s single-writer note. */
export const SOURCE_MODE = 'source';

/**
 * Minimal shape this policy reads out of an awareness entry. Deliberately not
 * the editor's full awareness type — the policy depends on one field, and
 * widening the dependency would couple the server to the client's presence
 * schema.
 */
export interface DemandAwarenessState {
  mode?: unknown;
}

/**
 * True when some connected peer still needs the fragment derived.
 *
 * @param states Awareness states keyed by clientID, as `awareness.getStates()`
 *   returns them.
 * @param localClientId The server's OWN awareness clientID, skipped because
 *   the server publishes agent presence into this same map and is never a
 *   reader of the fragment.
 *
 * Returns true when ANY remaining peer is not explicitly in source mode, and
 * false only when every one of them explicitly is. An empty map means nobody
 * is connected, so nobody can be looking — the case that pays for this gate,
 * since a file-watcher or agent write to an unopened document currently
 * re-derives a fragment no one will read. (Agent and file-watcher writes keep
 * the fragment correct on their own: they go through the paired-write
 * primitives, which rebuild it inside the same transaction rather than relying
 * on Observer B.)
 */
export function anyPeerNeedsFragment(
  states: ReadonlyMap<number, DemandAwarenessState | undefined>,
  localClientId: number,
): boolean {
  for (const [clientId, state] of states) {
    if (clientId === localClientId) continue;
    if (state?.mode !== SOURCE_MODE) return true;
  }
  return false;
}
