import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { APPLY_ACTIONS, PROBE_STRICTNESS_KEYS } from '../../agent-registry/vocabulary.ts';
import { agentIdentityFields, summaryField } from './_shared.ts';

export const AgentIntegrationsIntentSchema = z
  .object({
    satisfierId: z.string().min(1),
    desired: z.enum(['present', 'absent']),
  })
  .loose() satisfies StandardSchemaV1;
export type AgentIntegrationsIntentWire = z.infer<typeof AgentIntegrationsIntentSchema>;

export const AgentIntegrationsApplyRequestSchema = z
  .object({
    intents: z.array(AgentIntegrationsIntentSchema),
    ...agentIdentityFields,
    summary: summaryField,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentIntegrationsApplyRequest = z.infer<typeof AgentIntegrationsApplyRequestSchema>;

export const AgentIntegrationsAppliedStepSchema = z
  .object({
    satisfierId: z.string(),
    agentId: z.string(),
    piece: z.string(),
    scope: z.string(),
    kind: z.string(),
    pathId: z.string().optional(),
    desired: z.enum(['present', 'absent']),
    action: z.enum(APPLY_ACTIONS),
    errorId: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;

export const AgentIntegrationsPlanConflictSchema = z
  .object({
    kind: z.string(),
    satisfierIds: z.array(z.string()),
    agentIds: z.array(z.string()),
    pathId: z.string().optional(),
    blockedReason: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;

export const AgentIntegrationsProbeSchema = z
  .object({
    state: z.string(),
    strictness: z.array(z.enum(PROBE_STRICTNESS_KEYS)).optional(),
  })
  .loose() satisfies StandardSchemaV1;

export const AgentIntegrationsSnapshotSchema = z
  .object({
    probes: z
      .object({
        env: z.enum(['desktop', 'local-web', 'remote-web']),
        satisfiers: z.record(z.string(), AgentIntegrationsProbeSchema),
      })
      .loose(),
    detection: z
      .object({
        detected: z.array(z.string()),
        probed: z.boolean(),
      })
      .loose(),
  })
  .loose() satisfies StandardSchemaV1;

export const AgentIntegrationsApplySuccessSchema = z
  .object({
    actions: z.array(AgentIntegrationsAppliedStepSchema),
    conflicts: z.array(AgentIntegrationsPlanConflictSchema),
    withheld: z.array(z.string()),
    snapshot: AgentIntegrationsSnapshotSchema,
  })
  .loose() satisfies StandardSchemaV1;
export type AgentIntegrationsApplySuccess = z.infer<typeof AgentIntegrationsApplySuccessSchema>;
