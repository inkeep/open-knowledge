import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

const MergeQueueStateSchema = z.enum([
  'AWAITING_CHECKS',
  'LOCKED',
  'MERGEABLE',
  'QUEUED',
  'UNMERGEABLE',
]);

const MergeStateSchema = z.enum([
  'BEHIND',
  'BLOCKED',
  'CLEAN',
  'DIRTY',
  'DRAFT',
  'HAS_HOOKS',
  'UNKNOWN',
  'UNSTABLE',
]);

const ReviewDecisionSchema = z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);

const ChecksStateSchema = z.enum(['ERROR', 'EXPECTED', 'FAILURE', 'PENDING', 'SUCCESS']);

const GitHubReferenceStatusSchema = z
  .object({
    mergeQueue: z
      .object({
        position: z.number().int().nonnegative(),
        state: MergeQueueStateSchema.nullable().catch(null),
      })
      .nullable()
      .catch(null),
    autoMerge: z.boolean(),
    mergeState: MergeStateSchema.nullable().catch(null),
    reviewDecision: ReviewDecisionSchema.nullable().catch(null),
    checks: ChecksStateSchema.nullable().catch(null),
  })
  .loose() satisfies StandardSchemaV1;
export type GitHubReferenceStatus = z.infer<typeof GitHubReferenceStatusSchema>;

export const GitHubReferencePreviewSchema = z
  .object({
    kind: z.enum(['pull', 'issue']),
    repo: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string(),
    author: z.string().nullable(),
    createdAt: z.string(),
    lifecycle: z.enum(['open', 'draft', 'merged', 'closed', 'completed', 'not-planned']),
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
    status: GitHubReferenceStatusSchema.optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type GitHubReferencePreview = z.infer<typeof GitHubReferencePreviewSchema>;

export const GitHubReferenceRequestSchema = z
  .object({ url: z.string() })
  .loose() satisfies StandardSchemaV1;

export const GitHubReferenceResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), preview: GitHubReferencePreviewSchema }).loose(),
  z.object({ ok: z.literal(false), reason: z.string() }).loose(),
]) satisfies StandardSchemaV1;
export type GitHubReferenceResponse = z.infer<typeof GitHubReferenceResponseSchema>;
