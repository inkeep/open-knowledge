import { z } from 'zod';
import { ALL_EDITOR_IDS } from '../constants/editors.ts';
import {
  AcpHarnessCliIdSchema,
  AgentIdSchema,
  AgentModeSchema,
  GuidanceIdSchema,
  HandoffTargetIdSchema,
  IntegrationPieceSchema,
  PathIdSchema,
  SatisfierIdSchema,
  SatisfierScopeSchema,
} from './ids.ts';
import {
  ConsentClassSchema,
  ProbeStrictnessSchema,
  RequirementLevelSchema,
  SatisfierKindSchema,
} from './vocabulary.ts';

export const EditorIdSchema = z.enum(ALL_EDITOR_IDS);

export const EVIDENCE_KINDS = [
  'source-read',
  'measured',
  'vendor-doc',
  'upstream-issue',
  'observation',
] as const;

export const EvidenceRefSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  ref: z.string().min(1),
  note: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const VerifiedAgainstSchema = z.object({
  version: z.string().min(1).optional(),
  observedAt: z.string().min(1),
});
export type VerifiedAgainst = z.infer<typeof VerifiedAgainstSchema>;

export const AttestationSchema = z.discriminatedUnion('confidence', [
  z.object({
    confidence: z.literal('verified'),
    evidence: z.array(EvidenceRefSchema).min(1),
    verifiedAgainst: VerifiedAgainstSchema.optional(),
  }),
  z.object({
    confidence: z.literal('assumed'),
    evidence: z.array(EvidenceRefSchema).min(1),
    verifiedAgainst: VerifiedAgainstSchema.optional(),
  }),
  z.object({
    confidence: z.literal('contested'),
    evidence: z.array(EvidenceRefSchema).min(1),
    verifiedAgainst: VerifiedAgainstSchema,
  }),
]);
export type Attestation = z.infer<typeof AttestationSchema>;

export const GuidanceRefSchema = z.object({
  id: GuidanceIdSchema,
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type GuidanceRef = z.infer<typeof GuidanceRefSchema>;

export const UNPROBEABLE_REASONS = [
  'no-readable-state',
  'different-machine',
  'no-programmatic-path',
  'session-scoped',
] as const;

export const ProbeDeclarationSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('probeable'),
    strictness: z.array(ProbeStrictnessSchema).min(1),
  }),
  z.object({
    mode: z.literal('unprobeable'),
    reason: z.enum(UNPROBEABLE_REASONS),
    note: z.string().optional(),
  }),
]);
export type ProbeDeclaration = z.infer<typeof ProbeDeclarationSchema>;

export const AUDIENCE_CLASSES = ['this-project', 'this-user', 'this-machine'] as const;
export const AudienceClassSchema = z.enum(AUDIENCE_CLASSES);
export type AudienceClass = z.infer<typeof AudienceClassSchema>;

export const INSTALLABILITY_KINDS = ['installable', 'user-completes', 'not-installable'] as const;
export const InstallabilitySchema = z.enum(INSTALLABILITY_KINDS);
export type Installability = z.infer<typeof InstallabilitySchema>;

export const NOT_INSTALLABLE_REASONS = [
  'no-non-interactive-verb',
  'session-scoped',
  'no-surface',
] as const;

export const SatisfierRecordSchema = z.object({
  id: SatisfierIdSchema,
  agent: AgentIdSchema,
  piece: IntegrationPieceSchema,
  scope: SatisfierScopeSchema,
  kind: SatisfierKindSchema,
  pathId: PathIdSchema.optional(),
  sharedWith: z.array(AgentIdSchema).default([]),
  prerequisites: z.array(SatisfierIdSchema).default([]),
  consentClass: ConsentClassSchema.default('none'),
  probe: ProbeDeclarationSchema,
  attestation: AttestationSchema,
  audience: AudienceClassSchema,
  installability: InstallabilitySchema.default('installable'),
  notInstallableReason: z.enum(NOT_INSTALLABLE_REASONS).optional(),
  preferred: z.boolean().default(false),
  guidance: GuidanceRefSchema.optional(),
  followup: GuidanceRefSchema.optional(),
  troubleshooting: GuidanceRefSchema.optional(),
});
export type SatisfierRecord = z.infer<typeof SatisfierRecordSchema>;

export const RequirementRecordSchema = z.object({
  piece: IntegrationPieceSchema,
  level: RequirementLevelSchema,
  satisfiedByAny: z.array(SatisfierIdSchema),
});
export type RequirementRecord = z.infer<typeof RequirementRecordSchema>;

export const VERIFIED_POSTURES = ['asks', 'self-managed', 'autonomous'] as const;
export type VerifiedPosture = (typeof VERIFIED_POSTURES)[number];

export const AcpFacetSchema = z.object({
  acpAgentId: z.string().min(1),
  featuredOrder: z.number().int().nonnegative().nullable(),
  harnessCli: AcpHarnessCliIdSchema.nullable(),
  harnessReadsEditorConfig: EditorIdSchema.nullable(),
  harnessReadsEditorConfigAttestation: AttestationSchema,
  verifiedPosture: z.enum(VERIFIED_POSTURES).nullable(),
});
export type AcpFacet = z.infer<typeof AcpFacetSchema>;

export const TerminalFacetSchema = z.object({
  cliId: z.string().min(1),
});
export type TerminalFacet = z.infer<typeof TerminalFacetSchema>;

export const ExternalFacetSchema = z.object({
  targetId: HandoffTargetIdSchema,
  knownOrder: z.number().int().nonnegative(),
  visible: z.boolean(),
  displayName: z.string().min(1),
  appBrandName: z.string().min(1).optional(),
  schemes: z.array(z.string().min(1)),
  installUrl: z.string().min(1),
  tagline: z.string().min(1).optional(),
});
export type ExternalFacet = z.infer<typeof ExternalFacetSchema>;

export const ModeRecordSchema = z.object({
  requirements: z.array(RequirementRecordSchema),
  caveats: z.array(GuidanceRefSchema).default([]),
});
export type ModeRecord = z.infer<typeof ModeRecordSchema>;

export const AgentRecordSchema = z.object({
  id: AgentIdSchema,
  setupDocSlug: z.string().min(1).nullable(),
  offerOnlyWhenDetected: z.boolean().default(false),
  offersConnectionRow: z.boolean().default(false),
  detectionSources: z.array(z.string().min(1)).default([]),
  satisfiers: z.array(SatisfierRecordSchema),
  modes: z.partialRecord(AgentModeSchema, ModeRecordSchema),
  acp: AcpFacetSchema.optional(),
  terminal: TerminalFacetSchema.optional(),
  external: ExternalFacetSchema.optional(),
});
export type AgentRecord = z.infer<typeof AgentRecordSchema>;

export const CapabilityRecordSchema = z.object({
  id: z.string().min(1),
  requiredStrictness: ProbeStrictnessSchema,
  scope: SatisfierScopeSchema.optional(),
  piece: IntegrationPieceSchema,
  /**
   * STOP: set this on any grant that reads more than one scope. MCP
   * allow-lists match by server NAME, so a scope carrying somebody else's
   * server under OK's name can shadow a legitimate entry in another scope —
   * an either-scope test alone would grant on the strength of the good entry
   * while the bad one is what actually runs. A foreign entry in ANY scope the
   * grant reads revokes it.
   */
  revokedByForeignEntry: z.boolean().default(false),
  guidance: GuidanceRefSchema.optional(),
});
export type CapabilityRecord = z.infer<typeof CapabilityRecordSchema>;
