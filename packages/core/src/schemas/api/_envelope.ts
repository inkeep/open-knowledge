
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

import { URN_UUID_RE } from './_shared.ts';
import { isValidBranchName } from './share.ts';

export const ServerInfoSuccessSchema = z
  .object({
    serverInstanceId: z.string().min(1),
    currentBranch: z.string().min(1).optional(),
    currentDiskAckSVs: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type ServerInfoSuccess = z.infer<typeof ServerInfoSuccessSchema>;

export const PrincipalSuccessSchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string().min(1),
    display_email: z.string(),
    source: z.enum(['git-config', 'synthesized']),
    created_at: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type PrincipalSuccess = z.infer<typeof PrincipalSuccessSchema>;

export const ApiConfigSuccessSchema = z
  .object({
    collabUrl: z.string().nullable(),
    previewUrl: z.string().nullable(),
    port: z.number(),
    paneTarget: z.string().nullable(),
    singleFile: z.boolean().default(false),
  })
  .loose() satisfies StandardSchemaV1;
export type ApiConfigSuccess = z.infer<typeof ApiConfigSuccessSchema>;


export const ProblemTypeSchema = z.enum([
  'urn:ok:error:malformed-upload',
  'urn:ok:error:collision-exhaustion',
  'urn:ok:error:storage-full',
  'urn:ok:error:storage-readonly',
  'urn:ok:error:storage-error',
  'urn:ok:error:no-file-received',
  'urn:ok:error:path-escape',
  'urn:ok:error:method-not-allowed',
  'urn:ok:error:invalid-request',
  'urn:ok:error:payload-too-large',
  'urn:ok:error:request-timeout',
  'urn:ok:error:internal-server-error',
  'urn:ok:error:loopback-required',
  'urn:ok:error:invalid-origin',
  'urn:ok:error:url-not-allowed',
  'urn:ok:error:dir-outside-home',
  'urn:ok:error:concurrent-operation',
  'urn:ok:error:clone-failed',
  'urn:ok:error:clone-timeout',
  'urn:ok:error:server-start-failed',
  'urn:ok:error:reserved-doc-name',
  'urn:ok:error:target-not-found',
  'urn:ok:error:stale-target',
  'urn:ok:error:frontmatter-edit-not-supported',
  'urn:ok:error:invalid-frontmatter-patch',
  'urn:ok:error:frontmatter-malformed',
  'urn:ok:error:no-active-session',
  'urn:ok:error:too-many-agent-sessions',
  'urn:ok:error:disk-divergence',
  'urn:ok:error:doc-not-found',
  'urn:ok:error:doc-already-exists',
  'urn:ok:error:doc-not-open',
  'urn:ok:error:rollback-not-configured',
  'urn:ok:error:doc-not-available',
  'urn:ok:error:backlink-index-not-configured',
  'urn:ok:error:file-rescan-not-configured',
  'urn:ok:error:shadow-not-configured',
  'urn:ok:error:host-not-allowed',
  'urn:ok:error:principal-not-available',
  'urn:ok:error:not-found',
  'urn:ok:error:auth-failed',
  'urn:ok:error:no-project-dir',
  'urn:ok:error:server-open-failed',
  'urn:ok:error:doc-in-conflict',
  'urn:ok:error:no-conflict-tracked',
  'urn:ok:error:sync-not-active',
  'urn:ok:error:project-repo-not-configured',
  'urn:ok:error:seed-prerequisite-missing',
  'urn:ok:error:seed-invalid-root',
  'urn:ok:error:tag-index-not-configured',
  'urn:ok:error:template-not-found',
  'urn:ok:error:unsupported-asset-type',
  'urn:ok:error:asset-not-found',
  'urn:ok:error:single-file-mode',
  'urn:ok:error:collab-server-not-running',
  'urn:ok:error:gateway-timeout',
  'urn:ok:error:cursor-not-installed',
  'urn:ok:error:cursor-spawn-timeout',
  'urn:ok:error:cursor-spawn-failed',
  'urn:ok:error:handoff-target-not-installed',
  'urn:ok:error:handoff-spawn-timeout',
  'urn:ok:error:handoff-spawn-failed',
]) satisfies StandardSchemaV1;
export type ProblemType = z.infer<typeof ProblemTypeSchema>;

export function assertNeverProblemType(value: never): never {
  throw new Error(`Unexpected ProblemType variant: ${JSON.stringify(value)}`);
}

export const ProblemDetailsSchema = z
  .object({
    type: ProblemTypeSchema,
    title: z.string().min(1),
    status: z.number().int().min(400).max(599),
    instance: z.string().regex(URN_UUID_RE, 'instance must be urn:uuid:<uuid>').optional(),
    detail: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;


export const UploadRequestSchema = z
  .object({
    parentDocName: z.string().min(1),
    agentId: z.string().min(1).optional(),
    agentName: z.string().min(1).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type UploadRequest = z.infer<typeof UploadRequestSchema>;

export const UploadAssetSuccessSchema = z
  .object({
    src: z.string().min(1),
    path: z.string().min(1).optional(),
    deduped: z.boolean().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type UploadAssetSuccess = z.infer<typeof UploadAssetSuccessSchema>;

export const LocalOpCloneRequestSchema = z
  .object({
    url: z.string().min(1),
    dir: z.string().min(1),
    branch: z.string().min(1).refine(isValidBranchName, 'invalid branch name').optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type LocalOpCloneRequest = z.infer<typeof LocalOpCloneRequestSchema>;

export const StreamingProblemEventSchema = z
  .object({
    type: z.literal('error'),
    problem: ProblemDetailsSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type StreamingProblemEvent = z.infer<typeof StreamingProblemEventSchema>;
