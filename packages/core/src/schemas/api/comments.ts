/**
 * Comment threads — the shape shared by the store on disk and the wire.
 *
 * Here rather than in the server because the app consumes the same objects from
 * `/api/comments`, and it used to carry a hand-written copy of this interface
 * that had to be updated in lock-step. A field added on one side and forgotten
 * on the other is a silent runtime mismatch, which is exactly what a shared
 * schema removes.
 *
 * NOTE the absence of `.loose()`, which the response schemas in this directory
 * carry. This schema also parses the on-disk thread file, where stripping
 * unknown keys is load-bearing: a `version: 1` written by an older build has to
 * parse and then disappear on the next write. `.loose()` would persist it
 * instead, so the wire shape inherits the storage shape's strictness rather
 * than the other way round.
 */

import { z } from 'zod';

/**
 * Content-addressed anchor. `exact` (+ widened `prefix`/`suffix`) is the
 * durable record; `start`/`end` are a position hint only — a fast path, never
 * the authority (they drift the moment text above the anchor changes).
 */
const AnchorSchema = z.object({
  exact: z.string().min(1),
  prefix: z.string(),
  suffix: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type Anchor = z.infer<typeof AnchorSchema>;

/**
 * Which TEXT a thread's anchor is measured against — not the whole story of
 * what it points at, which is `target` plus `anchor` together.
 *
 * `body` is the markdown after the frontmatter. `property` narrows to one
 * frontmatter value: `key` alone is the whole property, and `path` walks into it
 * (`['tags', 2]` → the third tag; `['author', 'name']` → a nested field).
 *
 * The split is deliberate. Structure is addressed by NAME, which is exact and
 * needs no re-find — a key or an index either resolves or it does not. Prose
 * inside a value is addressed by its WORDS, which is what `anchor` is for. So a
 * paragraph-length `description` gets the same passage anchoring the body gets,
 * just with a haystack of one value instead of the whole document, where the
 * repeated-quote problem is far smaller.
 *
 * Absent on threads written before property targets existed, which are all body
 * threads; the default makes those parse unchanged.
 */
const PropertyPathSchema = z.array(z.union([z.string(), z.number().int().nonnegative()]));
const CommentTargetSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('body') }),
    z.object({
      kind: z.literal('property'),
      key: z.string().min(1),
      /** Steps INTO the key's value. Omitted / empty means the value itself. */
      path: PropertyPathSchema.default([]),
    }),
  ])
  .default({ kind: 'body' });
export type CommentTarget = z.infer<typeof CommentTargetSchema>;
export type PropertyPath = z.infer<typeof PropertyPathSchema>;

/**
 * A thread's single primary state: open+healthy, open with a lost anchor, or
 * closed. `resolved` subsumes the anchor distinction — a resolved thread isn't
 * highlighted, and its anchor is recomputed by re-find when it reopens, so
 * there is nothing to remember underneath.
 */
const ThreadStateSchema = z.enum(['anchored', 'orphaned', 'resolved']);

export const CommentThreadMetaSchema = z.object({
  threadId: z.string().min(1),
  docName: z.string().min(1),
  target: CommentTargetSchema,
  /**
   * A passage within the text `target` selects, or null for the whole thing.
   *
   * One field, two haystacks: with a `body` target it is a passage in the
   * markdown; with a `property` target it is a passage inside that value — which
   * is how a paragraph-length description gets commented on a sentence at a
   * time. Null means the target itself is the comment's subject: the whole
   * document is never that, so null + `body` cannot occur, but null + `property`
   * is the ordinary "comment on this field" case.
   *
   * Nullable rather than a filler anchor on purpose: every re-find call site has
   * to learn that some threads have no passage, and a stand-in `exact` would let
   * one that forgot go looking for the key's NAME in the body and match it. That
   * is the silently-wrong-target failure this whole subsystem is built to avoid,
   * so the type makes forgetting a compile error instead.
   */
  anchor: AnchorSchema.nullable(),
  state: ThreadStateSchema,
  /** In the dispatch queue, waiting to be sent in the next batch. */
  queued: z.boolean(),
  /**
   * What the thread is asking for. Editing replaces it — a thread holds one
   * comment that can be revised, not a discussion, because the reader is an
   * agent rather than a teammate.
   */
  latestComment: z.string(),
  createdBy: z.string().min(1),
  createdAt: z.number(),
  /**
   * When the comment text was last revised — absent on a thread nobody has
   * edited, which is most of them.
   *
   * Optional rather than defaulted to `createdAt`: a card that shows when a
   * comment was last touched has to be able to tell "written then" from
   * "rewritten then", and a filler value erases that difference on every thread
   * ever created. Optional also lets threads written before this field existed
   * parse unchanged.
   */
  updatedAt: z.number().optional(),
});
export type CommentThreadMeta = z.infer<typeof CommentThreadMetaSchema>;

/**
 * What the client needs to hand one comment to an agent.
 *
 * Shared for the same reason the thread shape is: the app carried a
 * hand-written copy of this interface, and `property` had to be added to both
 * by hand when value-level targets landed. A second edit nobody is reminded to
 * make is the whole failure mode.
 */
export const DispatchPayloadSchema = z
  .object({
    docName: z.string(),
    instruction: z.string(),
    /** The addressed property (`tags`, `tags[2]`, `author.name`); null for a body passage. */
    property: z.string().nullable(),
    /** Null when the comment is on a whole thing; with `property`, a passage inside that value. */
    passage: z.object({ exact: z.string(), prefix: z.string(), suffix: z.string() }).nullable(),
    /** The passage or key is gone — say so in the prompt, never silently retarget. */
    anchorLost: z.boolean(),
    /** The quote repeats in its document — the prompt must say which one is meant. */
    passageRepeats: z.boolean(),
  })
  .loose();
export type DispatchPayload = z.infer<typeof DispatchPayloadSchema>;

/**
 * Response envelopes. `.loose()` here, unlike the thread schema above: these are
 * wire-only, so an unknown key from a newer server should pass through rather
 * than fail the parse.
 *
 * One batch entry per requested id, in the requested order. A thread that has
 * since been deleted is reported in place rather than failing the whole batch —
 * the ids were chosen earlier and one going stale must not take the rest down.
 */
const BatchEntryBaseSchema = z.object({ threadId: z.string(), ok: z.literal(true) });
const BatchMissingSchema = z.object({
  threadId: z.string(),
  ok: z.literal(false),
  error: z.literal('not-found'),
});

export const ThreadListSuccessSchema = z
  .object({ threads: z.array(CommentThreadMetaSchema) })
  .loose();
export const QueueSuccessSchema = z
  .object({ meta: CommentThreadMetaSchema, orphaned: z.boolean() })
  .loose();
export const DeleteSuccessSchema = z.object({ threadId: z.string() }).loose();
export const PrepareDispatchSuccessSchema = z
  .object({ meta: CommentThreadMetaSchema, payload: DispatchPayloadSchema })
  .loose();
export const PrepareBatchSuccessSchema = z
  .object({
    results: z.array(
      z.union([
        BatchEntryBaseSchema.extend({
          meta: CommentThreadMetaSchema,
          payload: DispatchPayloadSchema,
        }),
        BatchMissingSchema,
      ]),
    ),
  })
  .loose();
export const CompleteBatchSuccessSchema = z
  .object({
    results: z.array(
      z.union([BatchEntryBaseSchema.extend({ meta: CommentThreadMetaSchema }), BatchMissingSchema]),
    ),
  })
  .loose();
