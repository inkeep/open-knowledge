/**
 * What the Comments tab is showing right now, published for the global chord.
 *
 * ⇧⌘Enter is a window listener — it fires while you are typing in the editor,
 * with the panel behind you — so it has no component to ask "which scope am I
 * in?". Without an answer it could only ever mean the widest thing, and the
 * This-doc footer beside a narrower button could not honestly carry the same
 * glyph.
 *
 * This is the missing half, and the same shape as `reusable-session-store`: the
 * surface that owns the state publishes it, so a caller outside can act on the
 * decision the user can actually see. The tab is conditionally rendered, so its
 * mount lifetime IS its visibility — `null` means nothing is on screen to scope
 * to, and the chord then does NOTHING and leaves the key to the browser. It used
 * to fall back to the whole checked queue, which gave it its widest reach
 * exactly when nothing on screen said what was in it.
 *
 * The scope narrows a send; it never widens one. A doc's checked comments are a
 * SUBSET of the project's, so a mis-scoped press under-sends and the rest stay
 * queued for the next one. That only holds while every hop between the button
 * and the dispatch carries the ids — `use-send-queue` once dropped them on the
 * open-chat path, and a This-doc send shipped the whole project queue.
 */

export interface VisibleCommentScope {
  readonly scope: 'doc' | 'project';
  /** The document the "This doc" side is listing. */
  readonly docName: string;
}

/**
 * A plain slot, not a subscribable store: the only reader is a keydown handler
 * that asks at the moment of the press, so there is nothing to notify.
 */
let current: VisibleCommentScope | null = null;

export function setVisibleCommentScope(next: VisibleCommentScope | null): void {
  current = next;
}

/**
 * Read at the moment of the press, never subscribed to. The chord's listener
 * installs once and never re-runs, so a React binding here would only buy
 * re-renders for a value nothing renders.
 */
export function getVisibleCommentScope(): VisibleCommentScope | null {
  return current;
}
