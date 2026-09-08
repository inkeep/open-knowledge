import { getAgentRecord } from './agents.ts';
import {
  type BlockedReason,
  requiresExplicitConsent,
  resolveAgentFold,
  resolveBlockedReason,
  resolveSurfaceState,
  statePolicyFor,
  unmetPrerequisites,
} from './fold.ts';
import type { AgentId, IntegrationPiece, PathId, SatisfierId, SatisfierScope } from './ids.ts';
import type {
  AudienceClass,
  GuidanceRef,
  Installability,
  NOT_INSTALLABLE_REASONS,
  SatisfierRecord,
} from './schema.ts';
import type { DetectionSnapshot, ProbeSnapshot } from './snapshot.ts';
import {
  type ConsentClass,
  DISK_BACKED_SATISFIER_KINDS,
  type SatisfierKind,
  type SurfaceState,
} from './vocabulary.ts';

export const INSTALL_CHOICE_STATUSES = [
  'offer',
  'handled',
  'no-surface',
  'structurally-absent',
  'not-registered',
] as const;
export type InstallChoiceStatus = (typeof INSTALL_CHOICE_STATUSES)[number];

export interface InstallChoice {
  readonly satisfierId: SatisfierId;
  readonly agentId: AgentId;
  readonly piece: IntegrationPiece;
  readonly scope: SatisfierScope;
  readonly kind: SatisfierKind;
  readonly pathId?: PathId;
  readonly audience: AudienceClass;
  readonly installability: Installability;
  readonly notInstallableReason?: (typeof NOT_INSTALLABLE_REASONS)[number];
  readonly preferred: boolean;
  readonly state: SurfaceState;
  readonly present: boolean;
  readonly installable: boolean;
  readonly blockedReason: BlockedReason | null;
  readonly requiresExplicitConsent: boolean;
  readonly consentClass: ConsentClass;
  readonly unmetPrerequisites: readonly SatisfierId[];
  readonly sharedWith: readonly AgentId[];
  readonly caveats: readonly GuidanceRef[];
  readonly guidance?: GuidanceRef;
}

export interface InstallChoices {
  readonly agentId: string;
  readonly piece: IntegrationPiece;
  readonly status: InstallChoiceStatus;
  readonly choices: readonly InstallChoice[];
}

export interface InstallChoiceContext {
  readonly probes?: ProbeSnapshot | null;
  readonly detection?: DetectionSnapshot | null;
}

function toChoice(
  satisfier: SatisfierRecord,
  agentFolded: boolean,
  probes: ProbeSnapshot | null | undefined,
): InstallChoice {
  const state = resolveSurfaceState(satisfier, probes);
  const unmet = unmetPrerequisites(satisfier.prerequisites, probes);
  const blockedReason = resolveBlockedReason({
    state,
    installability: satisfier.installability,
    agentFolded,
  });

  return {
    satisfierId: satisfier.id,
    agentId: satisfier.agent,
    piece: satisfier.piece,
    scope: satisfier.scope,
    kind: satisfier.kind,
    ...(satisfier.pathId === undefined ? {} : { pathId: satisfier.pathId }),
    audience: satisfier.audience,
    installability: satisfier.installability,
    ...(satisfier.notInstallableReason === undefined
      ? {}
      : { notInstallableReason: satisfier.notInstallableReason }),
    preferred: satisfier.preferred,
    state,
    present: statePolicyFor(state).counts,
    installable: blockedReason === null,
    blockedReason,
    requiresExplicitConsent: requiresExplicitConsent(state),
    consentClass: satisfier.consentClass,
    unmetPrerequisites: unmet,
    sharedWith: satisfier.sharedWith,
    caveats: [satisfier.followup, satisfier.troubleshooting].filter(
      (ref): ref is GuidanceRef => ref !== undefined,
    ),
    ...(satisfier.guidance === undefined ? {} : { guidance: satisfier.guidance }),
  };
}

export function listInstallChoices(
  agentId: string,
  piece: IntegrationPiece,
  ctx: InstallChoiceContext = {},
): InstallChoices {
  const record = getAgentRecord(agentId);
  if (record === undefined) {
    return { agentId, piece, status: 'not-registered', choices: [] };
  }

  const forPiece = record.satisfiers.filter((satisfier) => satisfier.piece === piece);
  if (forPiece.length === 0) {
    return { agentId, piece, status: 'no-surface', choices: [] };
  }

  const { folded } = resolveAgentFold(record, ctx.detection);
  const onDisk = forPiece.filter((satisfier) =>
    DISK_BACKED_SATISFIER_KINDS.includes(satisfier.kind),
  );

  if (onDisk.length === 0) {
    return {
      agentId,
      piece,
      status: 'handled',
      choices: forPiece.map((satisfier) => toChoice(satisfier, folded, ctx.probes)),
    };
  }

  const choices = onDisk.map((satisfier) => toChoice(satisfier, folded, ctx.probes));
  const nowhereToWrite = choices.every((choice) => choice.state === 'structural-na');

  return {
    agentId,
    piece,
    status: nowhereToWrite ? 'structurally-absent' : 'offer',
    choices,
  };
}
