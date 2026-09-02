import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { FrontmatterDeltaSchema } from '../../frontmatter-diff.ts';

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
    before: z.string(),
    after: z.string(),
    properties: FrontmatterDeltaSchema,
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

export const AgentEffectEntrySchema = z
  .object({
    sessionId: z.string().min(1),
    agentType: z.string().min(1),
    ts: z.number().int().min(0),
    insertedChars: z.number().int().min(0),
    deletedChars: z.number().int().min(0),
  })
  .loose() satisfies StandardSchemaV1;
export type AgentEffectEntryWire = z.infer<typeof AgentEffectEntrySchema>;

export const AgentEffectsDocSchema = z
  .object({
    'doc.name': z.string().min(1),
    entries: z.array(AgentEffectEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type AgentEffectsDocWire = z.infer<typeof AgentEffectsDocSchema>;

export const MetricsAgentEffectsSuccessSchema = z
  .object({
    effects: z.array(AgentEffectsDocSchema),
  })
  .loose() satisfies StandardSchemaV1;
export type MetricsAgentEffectsSuccess = z.infer<typeof MetricsAgentEffectsSuccessSchema>;

export const WatcherDecisionEntrySchema = z
  .object({
    ts: z.number().int().min(0),
    decision: z.string().min(1),
    kind: z.string().min(1),
    'doc.name': z.string().min(1),
    pathRole: z.string().min(1),
  })
  .loose() satisfies StandardSchemaV1;
export type WatcherDecisionEntryWire = z.infer<typeof WatcherDecisionEntrySchema>;

export const MetricsWatcherRecentSuccessSchema = z
  .object({
    decisions: z.array(WatcherDecisionEntrySchema),
  })
  .loose() satisfies StandardSchemaV1;
export type MetricsWatcherRecentSuccess = z.infer<typeof MetricsWatcherRecentSuccessSchema>;

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
