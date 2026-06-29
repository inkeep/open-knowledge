
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { SUPPORTED_DOC_EXTENSIONS } from '../../constants/doc-extensions.ts';

import { FRONTMATTER_TYPES, FrontmatterValueSchema } from '../../frontmatter/schema.ts';
import { agentIdentityFields, safeDocNameField, summaryField } from './_shared.ts';

export const AgentWriteRequestSchema = z
  .object({
    docName: safeDocNameField,
    summary: summaryField,
    content: z.string().optional(),
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentWriteRequest = z.infer<typeof AgentWriteRequestSchema>;

export const AgentWriteMdRequestSchema = z
  .object({
    docName: safeDocNameField,
    summary: summaryField,
    markdown: z.string(),
    position: z.enum(['append', 'prepend', 'replace']).optional(),
    extension: z.enum(SUPPORTED_DOC_EXTENSIONS).optional(),
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentWriteMdRequest = z.infer<typeof AgentWriteMdRequestSchema>;

export const AgentPatchRequestSchema = z
  .object({
    docName: safeDocNameField,
    summary: summaryField,
    find: z.string().min(1),
    replace: z.string(),
    offset: z.number().int().nonnegative().optional(),
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentPatchRequest = z.infer<typeof AgentPatchRequestSchema>;

export const AgentUndoRequestSchema = z
  .object({
    docName: safeDocNameField,
    connectionId: z.string().min(1),
    scope: z.enum(['last', 'session', 'file']).optional(),
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentUndoRequest = z.infer<typeof AgentUndoRequestSchema>;

export const SummaryResponseFieldSchema = z
  .object({
    value: z.string(),
    truncatedFrom: z.number().int().nonnegative().optional(),
    hint: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SummaryResponseField = z.infer<typeof SummaryResponseFieldSchema>;

export const ContentDivergenceCurrentStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), content: z.string() }),
  z.object({
    kind: z.literal('truncated'),
    byteLength: z.number().int().nonnegative(),
    hint: z.string(),
  }),
]);
export type ContentDivergenceCurrentState = z.infer<typeof ContentDivergenceCurrentStateSchema>;

export const ContentDivergenceWarningSchema = z
  .object({
    kind: z.literal('content-divergence'),
    intendedBytes: z.number().int().nonnegative(),
    actualBytes: z.number().int().nonnegative(),
    byteDelta: z.number().int(),
    divergenceType: z.string().optional(),
    currentState: ContentDivergenceCurrentStateSchema.optional(),
    hint: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type ContentDivergenceWarning = z.infer<typeof ContentDivergenceWarningSchema>;

export const OrphanHintSchema = z
  .object({
    type: z.literal('orphan'),
    parentCandidates: z.array(z.string()),
    message: z.string(),
  })
  .loose() satisfies StandardSchemaV1;
export type OrphanHint = z.infer<typeof OrphanHintSchema>;

export const DiskEditReconciledWarningSchema = z
  .object({
    kind: z.literal('disk-edit-reconciled'),
    intendedBytes: z.number().int().nonnegative(),
    actualBytes: z.number().int().nonnegative(),
    byteDelta: z.number().int(),
    mergeOutcome: z.string().optional(),
    hint: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type DiskEditReconciledWarning = z.infer<typeof DiskEditReconciledWarningSchema>;

export const WriteWarningSchema = z.discriminatedUnion('kind', [
  ContentDivergenceWarningSchema,
  DiskEditReconciledWarningSchema,
]);
export type WriteWarning = z.infer<typeof WriteWarningSchema>;

export const RenderWarningSchema = z
  .object({
    kind: z.literal('mermaid-parse-error'),
    fenceIndex: z.number().int().positive(),
    fenceFirstLine: z.string(),
    message: z.string(),
    line: z.number().int().positive().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type RenderWarning = z.infer<typeof RenderWarningSchema>;

export const AdvisoryWarningSchema = z.discriminatedUnion('kind', [
  ContentDivergenceWarningSchema,
  DiskEditReconciledWarningSchema,
  RenderWarningSchema,
]);
export type AdvisoryWarning = z.infer<typeof AdvisoryWarningSchema>;

export const AdvisoryWarningsSchema = z.array(AdvisoryWarningSchema).min(1);

export const BROKEN_LINK_REASONS = ['no-such-doc', 'no-such-file', 'unresolvable'] as const;
export type BrokenLinkReason = (typeof BROKEN_LINK_REASONS)[number];

export const BrokenLinkSchema = z
  .object({
    href: z.string(),
    resolvedTo: z.string().nullable(),
    reason: z.enum(BROKEN_LINK_REASONS),
  })
  .loose() satisfies StandardSchemaV1;
export type BrokenLink = z.infer<typeof BrokenLinkSchema>;

export const BrokenLinksSchema = z.array(BrokenLinkSchema);

export const AgentWriteSuccessSchema = z
  .object({
    timestamp: z.string().min(1),
    summary: SummaryResponseFieldSchema.optional(),
    warning: WriteWarningSchema.optional(),
    warnings: AdvisoryWarningsSchema.optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type AgentWriteSuccess = z.infer<typeof AgentWriteSuccessSchema>;

export const AgentWriteMdSuccessSchema = z
  .object({
    timestamp: z.string().min(1),
    subscriberCount: z.number().int().nonnegative(),
    systemSubscriberCount: z.number().int().nonnegative(),
    hints: z.array(OrphanHintSchema).optional(),
    summary: SummaryResponseFieldSchema.optional(),
    warning: WriteWarningSchema.optional(),
    warnings: AdvisoryWarningsSchema.optional(),
    brokenLinks: BrokenLinksSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentWriteMdSuccess = z.infer<typeof AgentWriteMdSuccessSchema>;

export const AgentPatchSuccessSchema = z
  .object({
    timestamp: z.string().min(1),
    subscriberCount: z.number().int().nonnegative(),
    systemSubscriberCount: z.number().int().nonnegative(),
    summary: SummaryResponseFieldSchema.optional(),
    warning: WriteWarningSchema.optional(),
    warnings: AdvisoryWarningsSchema.optional(),
    brokenLinks: BrokenLinksSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentPatchSuccess = z.infer<typeof AgentPatchSuccessSchema>;

export const AgentUndoSuccessSchema = z
  .object({
    docName: z.string().min(1),
    scope: z.enum(['last', 'session']),
    undone: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type AgentUndoSuccess = z.infer<typeof AgentUndoSuccessSchema>;

export const FrontmatterPatchRequestSchema = z
  .object({
    docName: safeDocNameField,
    patch: z.record(z.string(), z.union([FrontmatterValueSchema, z.null()])),
    types: z.record(z.string(), z.enum(FRONTMATTER_TYPES)).optional(),
    summary: summaryField,
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type FrontmatterPatchRequest = z.infer<typeof FrontmatterPatchRequestSchema>;

export const FrontmatterPatchSuccessSchema = z
  .object({
    timestamp: z.string().min(1),
    subscriberCount: z.number().int().nonnegative(),
    systemSubscriberCount: z.number().int().nonnegative(),
    appliedKeys: z.array(z.string()),
    summary: SummaryResponseFieldSchema.optional(),
    warning: WriteWarningSchema.optional(),
    warnings: AdvisoryWarningsSchema.optional(),
    brokenLinks: BrokenLinksSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type FrontmatterPatchSuccess = z.infer<typeof FrontmatterPatchSuccessSchema>;
