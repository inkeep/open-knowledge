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
]);
export type DerivedViewChannel = z.infer<typeof DerivedViewChannelSchema>;

export type CC1Channel =
  | DerivedViewChannel
  | typeof CC1_CHANNEL_SERVER_INFO
  | typeof CC1_CHANNEL_BRANCH_SWITCHED
  | typeof CC1_CHANNEL_DISK_ACK
  | typeof CC1_CHANNEL_CONFIG_VALIDATION_REJECTED
  | typeof CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR;

/** `server-info` broadcast shape.
 *
 * `currentBranch` is the late-join backstop for the cross-branch
 * invalidation flow — clients reconnecting after a branch switch
 * compare it against their last-observed branch and trigger
 * `handleBranchSwitched` on mismatch (`branch-switched` is stateless
 * and has no replay). Optional for backwards compat with non-git
 * deployments. */
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

/** `disk-ack` broadcast shape — per-document state-vector watermark.
 *
 * `docName` carries the target document because `__system__` is the
 * stateless carrier (broadcast doc) but the watermark applies to one
 * specific document — this is the first per-doc CC1 channel.
 *
 * `sv` is base64-encoded `Uint8Array` (the output of
 * `Y.encodeStateVector`). Base64 keeps the JSON wire-format printable
 * while preserving byte-fidelity.
 *
 * `seq` is per-channel monotonic, NOT per-doc. Disk-ack consumers do
 * NOT use it for ordering — `pool.observeDiskAck` ignores it entirely.
 * The field is retained for wire-format uniformity with other CC1
 * channels (debugging, future tooling that aggregates across
 * channels). Do NOT rely on it for inter-doc ordering — that semantic
 * is not preserved at this granularity. If per-doc ordering becomes
 * necessary, add a separate `docSeq` field (additive, `.loose()`-permitted). */
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

/** `config-validation-rejected` broadcast shape.
 *
 * Fired when the persistence-hook config-doc branch rejects a Y.Text
 * mutation that produces a syntactically broken or schema-failing
 * config document. The Settings pane subscribes to this channel and
 * surfaces a toast + flashes the affected field (mapped from
 * `error.issues[].path` for `SCHEMA_INVALID`).
 *
 * `error` carries the full `ConfigValidationError` envelope so consumers
 * can render the same `humanFormat` text that CLI / MCP do. */
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

/** `config-ignore-nested-error` broadcast shape — payload-bearing.
 *
 * `path` is the project-relative path of the malformed nested `.okignore`
 * file (full path is acceptable in CC1 payloads — only span/metric attrs
 * need cardinality bounding).
 *
 * `error` is a short human-readable message describing the parse failure
 * — already truncated/normalised at the emit site so the Settings toast
 * can render it directly.
 */
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
