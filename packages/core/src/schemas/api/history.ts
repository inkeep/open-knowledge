import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

import { agentIdentityFields, summaryField } from './_shared.ts';

export const SaveVersionWriterSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    email: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SaveVersionWriter = z.infer<typeof SaveVersionWriterSchema>;

export const SaveVersionRequestSchema = z
  .object({
    writers: z.array(SaveVersionWriterSchema).optional(),
    summary: summaryField,
    ...agentIdentityFields,
  })
  .loose() satisfies StandardSchemaV1;
export type SaveVersionRequest = z.infer<typeof SaveVersionRequestSchema>;

export const SaveVersionSuccessSchema = z
  .object({
    checkpointRef: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type SaveVersionSuccess = z.infer<typeof SaveVersionSuccessSchema>;

export const HistoryShadowContributorSchema = z
  .object({
    v: z.number().int().optional(),
    id: z.string().min(1),
    name: z.string().min(1),
    colorSeed: z.string().optional(),
    docs: z.array(z.string()),
    summaries: z.array(z.string()).optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type HistoryShadowContributor = z.infer<typeof HistoryShadowContributorSchema>;

export const HistoryEntrySchema = z
  .object({
    sha: z.string().min(1),
    timestamp: z.string().min(1),
    author: z.string(),
    authorEmail: z.string(),
    type: z.enum(['checkpoint', 'wip', 'upstream', 'park']),
    message: z.string(),
    contributors: z.array(HistoryShadowContributorSchema),
    checkpoint: z.unknown().nullable(),
  })
  .loose() satisfies StandardSchemaV1;
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const HistorySuccessSchema = z
  .object({
    entries: z.array(HistoryEntrySchema),
    total: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    hasMore: z.boolean().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type HistorySuccess = z.infer<typeof HistorySuccessSchema>;

export const HistoryVersionSuccessSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{40}$/i),
    content: z.string(),
    timestamp: z.string(),
    author: z.string(),
  })
  .loose() satisfies StandardSchemaV1;
export type HistoryVersionSuccess = z.infer<typeof HistoryVersionSuccessSchema>;

export const WorkspaceSuccessSchema = z
  .object({
    contentDir: z.string().min(1),
    pathSeparator: z.enum(['/', '\\']),
    symlinkResolved: z.boolean(),
  })
  .loose() satisfies StandardSchemaV1;
export type WorkspaceSuccess = z.infer<typeof WorkspaceSuccessSchema>;

export const RescueEntryFlatSchema = z
  .object({
    docName: z.string().min(1),
    timestamp: z.string().min(1),
    size: z.number().int().nonnegative(),
    source: z.literal('flat'),
  })
  .loose() satisfies StandardSchemaV1;
export type RescueEntryFlat = z.infer<typeof RescueEntryFlatSchema>;

export const RescueEntryTimelineSchema = z
  .object({
    docName: z.string().min(1),
    timestamp: z.string().min(1),
    source: z.literal('timeline'),
    sha: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type RescueEntryTimeline = z.infer<typeof RescueEntryTimelineSchema>;

export const RescueListSuccessSchema = z
  .array(z.discriminatedUnion('source', [RescueEntryFlatSchema, RescueEntryTimelineSchema]))
  .meta({
    description: 'Flat array of rescue buffer entries; discriminated via `source`.',
  }) satisfies StandardSchemaV1;
export type RescueListSuccess = z.infer<typeof RescueListSuccessSchema>;
