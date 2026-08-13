/**
 * The client's view of a comment thread.
 *
 * A flattened projection of what the server returns — its cover sheet plus the
 * current comment — shaped for rendering rather than for storage. The
 * authoritative schema lives server-side in
 * `packages/server/src/comments/types.ts`; this is what survives the trip to
 * the UI.
 */

/** Thread lifecycle. `orphaned` = the anchored text is gone. */
type CommentStatus = 'open' | 'resolved' | 'orphaned';

/**
 * Content-addressed anchor sketch: we re-find the passage by its quote (plus a
 * little surrounding context for disambiguation), never by a saved position —
 * the whole point of REPORT §3. Exact-match-or-orphan, no fuzzy pass (matches
 * the OUTCOMES non-goal "No fuzzy re-anchoring at v1").
 */
interface CommentAnchor {
  quote: string;
  prefix: string;
  suffix: string;
  /**
   * Position of the passage in the doc's body, as resolved by the SERVER's
   * re-find (which disambiguates a repeated quote by context and by nearest
   * previous position). Highlights use this rather than re-running `indexOf`
   * on the client, which picks the first match and lands on the wrong
   * occurrence whenever a quote appears more than once.
   */
  start: number;
  end: number;
}

/**
 * Which text the comment's `anchor` is measured against.
 *
 * `body` is the markdown. `property` narrows to one frontmatter value — `key`
 * alone is the whole property, `path` walks into it (`['tags', 2]`). Structure is
 * addressed by name, which is exact; prose inside a value is addressed by its
 * words, which is what `anchor` is for.
 *
 * Either way a property thread has NO range in the document body, so surfaces
 * that draw there — the anchor decorations, and the rail's quote search — must
 * branch on the target rather than fall back to `anchor`, whose offsets index
 * the value, not the doc.
 */
type CommentTarget =
  | { kind: 'body' }
  | {
      kind: 'property';
      key: string;
      /** Steps into the value. Empty means the value itself. */
      path: readonly (string | number)[];
    };

export interface CommentThread {
  id: string;
  docName: string;
  target: CommentTarget;
  /**
   * A passage within the text `target` selects, or null for the whole thing.
   * With a property target its offsets index THAT VALUE, never the document.
   */
  anchor: CommentAnchor | null;
  status: CommentStatus;
  /** The comment's current text — its newest revision. */
  body: string;
  createdAt: number;
  /**
   * When `body` was last written — the comment's own creation time until someone
   * revises it. Always set here, unlike the server's optional field: every card
   * shows this, so the fallback belongs at the one place the projection is built
   * rather than at each render site.
   */
  updatedAt: number;
  /**
   * The comment is in the dispatch queue, waiting to be sent in the next batch.
   *
   * Deliberately NOT "an agent is working on it": the server does not persist
   * in-flight state (an ACP thread and its agent's writes share no join key),
   * so claiming work is underway would be a guess. Queued is a fact; working is
   * not.
   */
  queued: boolean;
}
