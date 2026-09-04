import { z } from 'zod';

const AnchorSchema = z.object({
  exact: z.string().min(1),
  prefix: z.string(),
  suffix: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type Anchor = z.infer<typeof AnchorSchema>;

const PropertyPathSchema = z.array(z.union([z.string(), z.number().int().nonnegative()]));
const CommentTargetSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('body') }),
    z.object({
      kind: z.literal('property'),
      key: z.string().min(1),
      path: PropertyPathSchema.default([]),
    }),
  ])
  .default({ kind: 'body' });
export type CommentTarget = z.infer<typeof CommentTargetSchema>;
export type PropertyPath = z.infer<typeof PropertyPathSchema>;

const ThreadStateSchema = z.enum(['anchored', 'orphaned', 'resolved']);

export const CommentThreadMetaSchema = z.object({
  threadId: z.string().min(1),
  docName: z.string().min(1),
  target: CommentTargetSchema,
  anchor: AnchorSchema.nullable(),
  state: ThreadStateSchema,
  queued: z.boolean(),
  latestComment: z.string(),
  createdBy: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number().optional(),
});
export type CommentThreadMeta = z.infer<typeof CommentThreadMetaSchema>;

export const DispatchPayloadSchema = z
  .object({
    docName: z.string(),
    instruction: z.string(),
    property: z.string().nullable(),
    passage: z.object({ exact: z.string(), prefix: z.string(), suffix: z.string() }).nullable(),
    anchorLost: z.boolean(),
    passageRepeats: z.boolean(),
  })
  .loose();
export type DispatchPayload = z.infer<typeof DispatchPayloadSchema>;

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
