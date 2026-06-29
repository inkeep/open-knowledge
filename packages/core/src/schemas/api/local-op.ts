import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

export const LocalOpOkInitRequestSchema = z
  .object({
    projectPath: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type LocalOpOkInitRequest = z.infer<typeof LocalOpOkInitRequestSchema>;

export const LocalOpOkInitFailureReasonSchema = z.enum([
  'not-a-git-worktree',
  'init-failed',
]) satisfies StandardSchemaV1;
export type LocalOpOkInitFailureReason = z.infer<typeof LocalOpOkInitFailureReasonSchema>;

export const LocalOpOkInitResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      projectPath: z.string().min(1),
    })
    .loose(),
  z
    .object({
      ok: z.literal(false),
      reason: LocalOpOkInitFailureReasonSchema,
      message: z.string().min(1),
    })
    .loose(),
]) satisfies StandardSchemaV1;
export type LocalOpOkInitResponse = z.infer<typeof LocalOpOkInitResponseSchema>;

export const LocalOpAuthHostRequestSchema = z
  .object({
    host: z.string().min(1).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type LocalOpAuthHostRequest = z.infer<typeof LocalOpAuthHostRequestSchema>;

export const LocalOpEmbeddingsSetKeyRequestSchema = z
  .object({
    key: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type LocalOpEmbeddingsSetKeyRequest = z.infer<typeof LocalOpEmbeddingsSetKeyRequestSchema>;

export const LocalOpEmbeddingsMutationSuccessSchema = z
  .object({
    keyPresent: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type LocalOpEmbeddingsMutationSuccess = z.infer<
  typeof LocalOpEmbeddingsMutationSuccessSchema
>;

export const LocalOpAuthSetIdentityRequestSchema = z
  .object({
    name: z.string().refine((s) => s.trim().length > 0, { message: 'name must be non-empty' }),
    email: z.string().refine((s) => s.trim().length > 0, { message: 'email must be non-empty' }),
  })
  .loose() satisfies StandardSchemaV1;
export type LocalOpAuthSetIdentityRequest = z.infer<typeof LocalOpAuthSetIdentityRequestSchema>;

export const LocalOpAuthStatusSuccessSchema = z
  .object({
    authenticated: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type LocalOpAuthStatusSuccess = z.infer<typeof LocalOpAuthStatusSuccessSchema>;

export const LocalOpAuthEmptySuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type LocalOpAuthEmptySuccess = z.infer<typeof LocalOpAuthEmptySuccessSchema>;
