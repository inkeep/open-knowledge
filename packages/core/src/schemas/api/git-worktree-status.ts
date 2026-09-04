import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

export const GIT_STATUS_CODES = ['M', 'A', 'D', 'R', 'C', 'U', 'T', '?', '!', ' '] as const;
export type GitStatusCode = (typeof GIT_STATUS_CODES)[number];

export const GitWorktreeEntrySchema = z
  .object({
    path: z.string().min(1),
    code: z.enum(GIT_STATUS_CODES),
    origPath: z.string().min(1).optional(),
    syncScoped: z.boolean(),
    open: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('doc'), docName: z.string().min(1) }),
        z.object({ kind: z.literal('asset'), path: z.string().min(1) }),
      ])
      .optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type GitWorktreeEntry = z.infer<typeof GitWorktreeEntrySchema>;
export type GitWorktreeOpenTarget = NonNullable<GitWorktreeEntry['open']>;

export const GitWorktreeStatusSuccessSchema = z
  .object({
    branch: z.string().nullable(),
    detached: z.boolean(),
    upstream: z.string().nullable(),
    staged: z.array(GitWorktreeEntrySchema),
    notStaged: z.array(GitWorktreeEntrySchema),
    untracked: z.array(GitWorktreeEntrySchema),
    incoming: z.array(GitWorktreeEntrySchema),
    truncated: z.boolean(),
    readable: z.boolean().default(true),
  })
  .loose() satisfies StandardSchemaV1;
export type GitWorktreeStatusSuccess = z.infer<typeof GitWorktreeStatusSuccessSchema>;
