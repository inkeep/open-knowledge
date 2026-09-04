/**
 * Cluster A: agent-write / -write-md / -patch / -undo
 *
 * Mutating handlers that write to Y.Docs through the agent attribution path
 * (precedent #24). `withValidation()` enforces these schemas at the wire
 * boundary; the handler receives an already-typed body. Body-shape failures
 * (schema rejection) emit `urn:ok:error:invalid-request` PRE-identity —
 * semantically OK because no Y.Doc mutation is attempted. Semantic failures
 * (reserved docname, target-not-found, stale-target, no-active-session) emit
 * POST-identity. The `attribution-sweep-coverage.test.ts` ordering check
 * enforces this distinction.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { SUPPORTED_DOC_EXTENSIONS } from '../../constants/doc-extensions.ts';

import { FRONTMATTER_TYPES, FrontmatterValueSchema } from '../../frontmatter/schema.ts';
import { ProblemTypeSchema } from './_envelope.ts';
import {
  agentIdentityFields,
  requiredSafeDocNameField,
  safeDocNameField,
  summaryField,
} from './_shared.ts';

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
    scope: z.enum(['last', 'session', 'file', 'count']).optional(),
    count: z.number().int().positive().optional(),
    ...agentIdentityFields,
  })
  .loose()
  .refine((body) => body.scope !== 'count' || body.count !== undefined, {
    message: "count is required when scope is 'count'",
    path: ['count'],
  }) satisfies StandardSchemaV1;
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

export const LocalTargetDiagnosticEvidenceSchema = z
  .object({
    href: z.string(),
    targetKind: z.string(),
    role: z.string(),
    sourceForm: z.string(),
    resolvedTarget: z.string().nullable(),
    reason: z.string(),
    resolutionMethod: z.string(),
    fallbackTarget: z.string().nullable().optional(),
    definition: z
      .object({ line: z.number().int().nonnegative(), label: z.string() })
      .loose()
      .optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type LocalTargetDiagnosticEvidenceWire = z.infer<typeof LocalTargetDiagnosticEvidenceSchema>;

export const LintViolationWarningSchema = z
  .object({
    kind: z.literal('lint-violation'),
    source: z.string(),
    code: z.string(),
    message: z.string(),
    severity: z.enum(['error', 'warning', 'info', 'hint']),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    linkTarget: z.string().optional(),
    localTarget: LocalTargetDiagnosticEvidenceSchema.optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type LintViolationWarning = z.infer<typeof LintViolationWarningSchema>;

export const AdvisoryWarningSchema = z.discriminatedUnion('kind', [
  ContentDivergenceWarningSchema,
  DiskEditReconciledWarningSchema,
  RenderWarningSchema,
  LintViolationWarningSchema,
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
    localTarget: LocalTargetDiagnosticEvidenceSchema.optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type BrokenLink = z.infer<typeof BrokenLinkSchema>;

export const BrokenLinksSchema = z.array(BrokenLinkSchema);

export const AgentWriteSuccessSchema = z
  .object({
    timestamp: z.string().min(1),
    summary: SummaryResponseFieldSchema.optional(),
    /** @deprecated Read `warnings` — kept emitting in parallel for one deprecation window. */
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
    /** @deprecated Read `warnings` — kept emitting in parallel for one deprecation window. */
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
    /** @deprecated Read `warnings` — kept emitting in parallel for one deprecation window. */
    warning: WriteWarningSchema.optional(),
    warnings: AdvisoryWarningsSchema.optional(),
    brokenLinks: BrokenLinksSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentPatchSuccess = z.infer<typeof AgentPatchSuccessSchema>;

export const AgentUndoSuccessSchema = z
  .object({
    docName: z.string().min(1),
    scope: z.enum(['last', 'session', 'count']),
    undone: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type AgentUndoSuccess = z.infer<typeof AgentUndoSuccessSchema>;

export const AGENT_WRITE_BATCH_MAX_DOCS = 100;

export const AgentWriteBatchEntrySchema = z
  .object({
    docName: requiredSafeDocNameField,
    markdown: z.string(),
    position: z.enum(['append', 'prepend', 'replace']).optional(),
    extension: z.enum(SUPPORTED_DOC_EXTENSIONS).optional(),
    summary: summaryField,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentWriteBatchEntry = z.infer<typeof AgentWriteBatchEntrySchema>;

export const AgentWriteBatchRequestSchema = z
  .object({
    docs: z.array(AgentWriteBatchEntrySchema).min(1).max(AGENT_WRITE_BATCH_MAX_DOCS),
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentWriteBatchRequest = z.infer<typeof AgentWriteBatchRequestSchema>;

export const BatchEntryErrorSchema = z
  .object({
    type: ProblemTypeSchema,
    title: z.string(),
    detail: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type BatchEntryError = z.infer<typeof BatchEntryErrorSchema>;

export const AgentWriteBatchResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('written'),
      docName: z.string().min(1),
      summary: SummaryResponseFieldSchema.optional(),
      warnings: AdvisoryWarningsSchema.optional(),
      brokenLinks: BrokenLinksSchema,
    })
    .loose(),
  z
    .object({
      status: z.literal('error'),
      docName: z.string().min(1),
      error: BatchEntryErrorSchema,
    })
    .loose(),
]);
export type AgentWriteBatchResult = z.infer<typeof AgentWriteBatchResultSchema>;

export const AgentWriteBatchSuccessSchema = z
  .object({
    timestamp: z.string().min(1),
    results: z.array(AgentWriteBatchResultSchema),
    written: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .loose() satisfies StandardSchemaV1;
export type AgentWriteBatchSuccess = z.infer<typeof AgentWriteBatchSuccessSchema>;

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
    /** @deprecated Read `warnings` — kept emitting in parallel for one deprecation window. */
    warning: WriteWarningSchema.optional(),
    warnings: AdvisoryWarningsSchema.optional(),
    brokenLinks: BrokenLinksSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type FrontmatterPatchSuccess = z.infer<typeof FrontmatterPatchSuccessSchema>;
