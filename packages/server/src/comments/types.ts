/**
 * Comment-thread data model — one file per thread under `<localDir>/comments/`:
 *
 *   <threadId>.meta.json   the whole thread — id, doc, anchor, current state,
 *                          and the comment text.
 *
 * One file, written atomically, so a thread is always either its previous
 * complete state or its next one. There is no second file to disagree with it
 * and therefore nothing to reconcile: a crash mid-write loses the transition
 * being written, never the thread.
 *
 * This deliberately drops the append-only event log the first cut carried. The
 * log recorded every transition and every superseded draft, and nothing read
 * any of it — the UI shows a thread's current request, never its history. What
 * it bought was the option to add replies or agent-authored comments as new
 * line forms rather than a schema change. That option is cheaper to buy later
 * (this data is machine-local, gitignored, and disposable) than to carry in
 * every write now.
 *
 * There is deliberately no schema-version field. A shape change already fails
 * validation, and an unreadable thread is skipped rather than migrated, so a
 * version literal added no detection — only the risk that a build reading a
 * newer build's files (beta and stable share `<localDir>` on one machine) would
 * treat every thread as garbage. Zod strips unknown keys, so the `version: 1`
 * that older threads carry parses fine and disappears on the next write.
 */

/**
 * The thread shape itself lives in `@inkeep/open-knowledge-core`, because the
 * app consumes these same objects over `/api/comments` and used to keep a
 * hand-written copy in step by hand. Re-exported here so this module stays the
 * one import site for everything thread-shaped on the server.
 */
import type { CommentThreadMeta } from '@inkeep/open-knowledge-core';

export {
  type Anchor,
  type CommentTarget,
  type CommentThreadMeta,
  CommentThreadMetaSchema,
  type PropertyPath,
} from '@inkeep/open-knowledge-core';

/**
 * The fields a caller may change. Identity and provenance are not among them —
 * `updatedAt` is the one time field here because it records a change rather than
 * the thread's origin.
 */
export type CommentThreadPatch = Partial<
  Pick<CommentThreadMeta, 'docName' | 'anchor' | 'state' | 'queued' | 'latestComment' | 'updatedAt'>
>;
