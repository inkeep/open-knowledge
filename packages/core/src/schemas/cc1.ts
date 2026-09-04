import { z } from 'zod';
import { ConfigValidationErrorSchema } from '../config/errors.ts';
import { CC1_CONTRACT_VERSION } from '../constants/cc1.ts';

export const CC1_CHANNEL_SERVER_INFO = 'server-info' as const;

export const CC1_CHANNEL_BRANCH_SWITCHED = 'branch-switched' as const;

export const CC1_CHANNEL_DISK_ACK = 'disk-ack' as const;

export const CC1_CHANNEL_CONFIG_VALIDATION_REJECTED = 'config-validation-rejected' as const;

export const CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR = 'config-ignore-nested-error' as const;

export const DerivedViewChannelSchema = z.enum([
  'files',
  'backlinks',
  'graph',
  'sync-status',
  'session-activity',
  'tags',
  'comments',
  'lint-config',
  'local-targets',
]);
export type DerivedViewChannel = z.infer<typeof DerivedViewChannelSchema>;

/**
 * Union of every CC1 channel identifier — the five derived-view channels
 * plus the four broadcast-shape channels (`server-info`, `branch-switched`,
 * `disk-ack`, `config-validation-rejected`). Tightening from `string` to
 * this union narrows the per-channel watermark map (`metrics.cc1LastSeq`)
 * to bounded cardinality at compile time, mirroring the cardinality
 * discipline applied to `bridgeToleranceApplied` (precedent #38).
 */
export type CC1Channel =
  | DerivedViewChannel
  | typeof CC1_CHANNEL_SERVER_INFO
  | typeof CC1_CHANNEL_BRANCH_SWITCHED
  | typeof CC1_CHANNEL_DISK_ACK
  | typeof CC1_CHANNEL_CONFIG_VALIDATION_REJECTED
  | typeof CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR;

export const CC1ServerInfoPayloadSchema = z
  .object({
    v: z.literal(CC1_CONTRACT_VERSION),
    ch: z.literal(CC1_CHANNEL_SERVER_INFO),
    seq: z.number(),
    serverInstanceId: z.string().min(1),
    currentBranch: z.string().min(1).optional(),
  })
  .loose();
export type CC1ServerInfoPayload = z.infer<typeof CC1ServerInfoPayloadSchema>;

export const CC1BranchSwitchedPayloadSchema = z
  .object({
    v: z.literal(CC1_CONTRACT_VERSION),
    ch: z.literal(CC1_CHANNEL_BRANCH_SWITCHED),
    seq: z.number(),
    branch: z.string().min(1),
  })
  .loose();
export type CC1BranchSwitchedPayload = z.infer<typeof CC1BranchSwitchedPayloadSchema>;

export const CC1DerivedViewPayloadSchema = z
  .object({
    v: z.literal(CC1_CONTRACT_VERSION),
    ch: DerivedViewChannelSchema,
    seq: z.number(),
  })
  .loose();
export type CC1DerivedViewPayload = z.infer<typeof CC1DerivedViewPayloadSchema>;

export const CC1DiskAckPayloadSchema = z
  .object({
    v: z.literal(CC1_CONTRACT_VERSION),
    ch: z.literal(CC1_CHANNEL_DISK_ACK),
    seq: z.number(),
    docName: z.string().min(1),
    sv: z.string().min(1),
  })
  .loose();
export type CC1DiskAckPayload = z.infer<typeof CC1DiskAckPayloadSchema>;

export const CC1ConfigValidationRejectedPayloadSchema = z
  .object({
    v: z.literal(CC1_CONTRACT_VERSION),
    ch: z.literal(CC1_CHANNEL_CONFIG_VALIDATION_REJECTED),
    seq: z.number(),
    docName: z.string().min(1),
    error: ConfigValidationErrorSchema,
  })
  .loose();
export type CC1ConfigValidationRejectedPayload = z.infer<
  typeof CC1ConfigValidationRejectedPayloadSchema
>;

export const CC1ConfigIgnoreNestedErrorPayloadSchema = z
  .object({
    v: z.literal(CC1_CONTRACT_VERSION),
    ch: z.literal(CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR),
    seq: z.number(),
    path: z.string().min(1),
    error: z.string().min(1),
  })
  .loose();
export type CC1ConfigIgnoreNestedErrorPayload = z.infer<
  typeof CC1ConfigIgnoreNestedErrorPayloadSchema
>;
