
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

export const ActivityBurstSchema = z
  .object({
    stackIndex: z.number().int().min(0),
    ts: z.number().int().min(0),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
  })
  .loose() satisfies StandardSchemaV1;
export type ActivityBurst = z.infer<typeof ActivityBurstSchema>;

export const ActivityFileSchema = z
  .object({
    docName: z.string().min(1),
    additionsTotal: z.number().int().min(0),
    deletionsTotal: z.number().int().min(0),
    lastTs: z.number().int().min(0),
    bursts: z.array(ActivityBurstSchema),
  })
  .loose() satisfies StandardSchemaV1;
export type ActivityFile = z.infer<typeof ActivityFileSchema>;

export const ActivityAgentHeaderSchema = z
  .object({
    displayName: z.string().min(1),
    color: z.string().min(1),
    icon: z.string().optional(),
    connectionId: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type ActivityAgentHeader = z.infer<typeof ActivityAgentHeaderSchema>;

export const AgentActivitySuccessSchema = z
  .object({
    sessionAlive: z.boolean(),
    agent: ActivityAgentHeaderSchema.nullable(),
    files: z.array(ActivityFileSchema),
  })
  .loose() satisfies StandardSchemaV1;
export type AgentActivitySuccess = z.infer<typeof AgentActivitySuccessSchema>;

export const AgentBurstDiffSuccessSchema = z
  .object({
    diff: z.string(),
    generatedAt: z.number().int().min(0),
  })
  .loose() satisfies StandardSchemaV1;
export type AgentBurstDiffSuccess = z.infer<typeof AgentBurstDiffSuccessSchema>;

export const TestResetSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type TestResetSuccess = z.infer<typeof TestResetSuccessSchema>;

export const TestRescanBacklinksSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type TestRescanBacklinksSuccess = z.infer<typeof TestRescanBacklinksSuccessSchema>;

export const TestRescanFilesSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type TestRescanFilesSuccess = z.infer<typeof TestRescanFilesSuccessSchema>;

/** Success body for `POST /api/test-flush-git` — flat empty object, same
 * dev-only test-route convention as the rescan siblings above. */
export const TestFlushGitSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type TestFlushGitSuccess = z.infer<typeof TestFlushGitSuccessSchema>;

export const MetricsReconciliationSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type MetricsReconciliationSuccess = z.infer<typeof MetricsReconciliationSuccessSchema>;

export const MetricsParseHealthSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type MetricsParseHealthSuccess = z.infer<typeof MetricsParseHealthSuccessSchema>;

export const AgentPresenceEntrySchema = z
  .object({
    displayName: z.string().min(1),
    icon: z.string(),
    color: z.string().min(1),
    currentDoc: z.string().nullable(),
    mode: z.enum(['idle', 'writing']),
    ts: z.number().int().min(0),
  })
  .loose() satisfies StandardSchemaV1;
export type AgentPresenceEntryWire = z.infer<typeof AgentPresenceEntrySchema>;

export const MetricsAgentPresenceSuccessSchema = z
  .object({
    presence: z.record(z.string().min(1), AgentPresenceEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type MetricsAgentPresenceSuccess = z.infer<typeof MetricsAgentPresenceSuccessSchema>;

export const InstalledAgentsSuccessSchema = z.record(z.string().min(1), z.boolean()).meta({
  description:
    'Flat boolean record keyed by agent-scheme name (claude / codex / cursor). True = installed.',
}) satisfies StandardSchemaV1;
export type InstalledAgentsSuccess = z.infer<typeof InstalledAgentsSuccessSchema>;

export const SpawnCursorRequestSchema = z
  .object({
    path: z.string().min(1, 'path must be non-empty'),
  })
  .loose() satisfies StandardSchemaV1;
export type SpawnCursorRequest = z.infer<typeof SpawnCursorRequestSchema>;

export const SpawnCursorSuccessSchema = z.object({}).loose() satisfies StandardSchemaV1;
export type SpawnCursorSuccess = z.infer<typeof SpawnCursorSuccessSchema>;
