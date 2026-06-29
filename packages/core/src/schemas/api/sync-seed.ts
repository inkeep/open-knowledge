import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

export const SyncStateSchema = z.enum([
  'dormant',
  'idle',
  'fetching',
  'pulling',
  'pushing',
  'conflict',
  'offline',
  'auth-error',
  'disabled',
]) satisfies StandardSchemaV1;
export type SyncStateWire = z.infer<typeof SyncStateSchema>;

export const SyncRemoteSchema = z
  .object({
    label: z.string().min(1),
    webUrl: z.url().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type SyncRemoteWire = z.infer<typeof SyncRemoteSchema>;

export const PushPermissionSchema = z.discriminatedUnion('checkStatus', [
  z.object({ checkStatus: z.literal('allowed') }).loose(),
  z
    .object({
      checkStatus: z.literal('denied'),
      deniedReason: z.enum(['no-collaborator', 'private-no-access', 'repo-not-found']),
    })
    .loose(),
  z
    .object({
      checkStatus: z.literal('unknown'),
      unknownError: z
        .enum(['network', 'timeout', 'rate-limit', 'token-invalid', 'malformed-response'])
        .optional(),
    })
    .loose(),
]) satisfies StandardSchemaV1;
export type PushPermissionWire = z.infer<typeof PushPermissionSchema>;

export const SYNC_ERROR_CODES = [
  'auth-403',
  'auth-401',
  'auth-scope-mismatch',
  'auth-no-credential',
  'semantic-protected-branch',
] as const;

export const SyncErrorCodeSchema = z.enum(SYNC_ERROR_CODES);
export type SyncErrorCode = z.infer<typeof SyncErrorCodeSchema>;

export const SyncStatusSchema = z
  .object({
    state: SyncStateSchema,
    lastSyncUtc: z.string().nullable(),
    lastFetchUtc: z.string().nullable(),
    lastPushedSha: z.string().nullable(),
    ahead: z.number().int().min(0),
    behind: z.number().int().min(0),
    consecutiveFailures: z.number().int().min(0),
    conflictCount: z.number().int().min(0),
    hasRemote: z.boolean(),
    syncEnabled: z.boolean(),
    identityUnresolved: z.boolean(),
    remote: SyncRemoteSchema.nullable().optional(),
    pushError: z.string().optional(),
    pushErrorCode: SyncErrorCodeSchema.optional(),
    pullError: z.string().optional(),
    pullErrorCode: SyncErrorCodeSchema.optional(),
    pausedReason: z.string().optional(),
    pushPermission: PushPermissionSchema.optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SyncStatusWire = z.infer<typeof SyncStatusSchema>;

export const SyncTriggerRequestSchema = z
  .object({
    op: z.enum(['sync', 'push', 'pull']).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SyncTriggerRequest = z.infer<typeof SyncTriggerRequestSchema>;

export const SyncTriggerSuccessSchema = z
  .object({
    op: z.enum(['sync', 'push', 'pull']),
  })
  .loose() satisfies StandardSchemaV1;
export type SyncTriggerSuccess = z.infer<typeof SyncTriggerSuccessSchema>;

export const ConflictEntrySchema = z
  .object({
    file: z.string().min(1),
    detectedAt: z.string().min(1),
    oursSha: z.string().optional(),
    theirsSha: z.string().optional(),
    baseSha: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type ConflictEntryWire = z.infer<typeof ConflictEntrySchema>;

export const SyncConflictsSuccessSchema = z
  .object({
    conflicts: z.array(ConflictEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type SyncConflictsSuccess = z.infer<typeof SyncConflictsSuccessSchema>;

export const SyncResolveConflictRequestSchema = z
  .object({
    file: z.string().min(1),
    strategy: z.enum(['mine', 'theirs', 'content', 'delete']),
    content: z.string().optional(),
  })
  .loose()
  .refine((d) => d.strategy !== 'content' || (d.content !== undefined && d.content !== ''), {
    message: "content must be a non-empty string when strategy is 'content'",
    path: ['content'],
  }) satisfies StandardSchemaV1;
export type SyncResolveConflictRequest = z.infer<typeof SyncResolveConflictRequestSchema>;

export const SyncResolveConflictSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type SyncResolveConflictSuccess = z.infer<typeof SyncResolveConflictSuccessSchema>;

export const SyncConflictContentSuccessSchema = z
  .object({
    file: z.string().min(1),
    base: z.string(),
    ours: z.string(),
    theirs: z.string(),
    kind: z.enum(['both-modified', 'delete-modify', 'modify-delete']),
    lifecycleStatus: z.string().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type SyncConflictContentSuccess = z.infer<typeof SyncConflictContentSuccessSchema>;

export const SeedPlanSuccessSchema = z
  .object({
    plan: z.custom<unknown>((v) => v !== undefined, { message: 'plan is required' }),
  })
  .loose() satisfies StandardSchemaV1;
export type SeedPlanSuccess = z.infer<typeof SeedPlanSuccessSchema>;

export const SeedApplyRequestSchema = z
  .object({
    plan: z.custom<unknown>((v) => v !== undefined, { message: 'plan is required' }),
  })
  .loose() satisfies StandardSchemaV1;
export type SeedApplyRequest = z.infer<typeof SeedApplyRequestSchema>;

export const SeedApplySuccessSchema = z
  .object({
    result: z.custom<unknown>((v) => v !== undefined, { message: 'result is required' }),
  })
  .loose() satisfies StandardSchemaV1;
export type SeedApplySuccess = z.infer<typeof SeedApplySuccessSchema>;

export const SeedPackFolderInfoSchema = z
  .object({
    path: z.string().min(1),
    summary: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type SeedPackFolderInfo = z.infer<typeof SeedPackFolderInfoSchema>;

export const SeedPackEntryCountsSchema = z
  .object({
    files: z.number().int().nonnegative(),
    folders: z.number().int().nonnegative(),
  })
  .loose() satisfies StandardSchemaV1;
export type SeedPackEntryCounts = z.infer<typeof SeedPackEntryCountsSchema>;

export const SeedPackInfoSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    defaultSubfolder: z.string().optional(),
    folders: z.array(SeedPackFolderInfoSchema),
    entryCounts: SeedPackEntryCountsSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type SeedPackInfo = z.infer<typeof SeedPackInfoSchema>;

export const SeedListPacksSuccessSchema = z
  .object({
    packs: z.array(SeedPackInfoSchema),
  })
  .loose() satisfies StandardSchemaV1;
export type SeedListPacksSuccess = z.infer<typeof SeedListPacksSuccessSchema>;

export const InstallSkillRequestSchema = z
  .object({
    noOpen: z.boolean().optional(),
    out: z.string().min(1).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type InstallSkillRequest = z.infer<typeof InstallSkillRequestSchema>;

const InstallSkillHandoffErrorSchema = z
  .object({
    reason: z.enum(['unsupported-platform', 'spawn-error']),
    message: z.string(),
  })
  .loose();
export const InstallSkillSuccessSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('installed'),
      outputPath: z.string(),
      size: z.number().int().nonnegative(),
      sha256: z.string(),
      skillVersion: z.string(),
    })
    .loose(),
  z
    .object({
      status: z.literal('built'),
      outputPath: z.string(),
      size: z.number().int().nonnegative(),
      sha256: z.string(),
      skillVersion: z.string(),
      handoffError: InstallSkillHandoffErrorSchema.optional(),
    })
    .loose(),
  z
    .object({
      status: z.literal('failed'),
      buildError: z.string(),
    })
    .loose(),
  z
    .object({
      status: z.literal('skip-current'),
      skillVersion: z.string(),
      recordedAt: z.string().optional(),
    })
    .loose(),
]) satisfies StandardSchemaV1;
export type InstallSkillSuccess = z.infer<typeof InstallSkillSuccessSchema>;
