import { AGENT_REGISTRY } from './agents.ts';
import {
  type BlockedReason,
  resolveAgentFold,
  resolveBlockedReason,
  resolveSurfaceState,
  statePolicyFor,
  unmetPrerequisites,
} from './fold.ts';
import {
  type AgentId,
  ALL_AGENT_IDS,
  type IntegrationPiece,
  isAgentId,
  type PathId,
  SATISFIER_SCOPES,
  type SatisfierId,
  type SatisfierScope,
} from './ids.ts';
import type {
  AgentRecord,
  AudienceClass,
  GuidanceRef,
  Installability,
  SatisfierRecord,
} from './schema.ts';
import { type DetectionSnapshot, type ProbeSnapshot, readSatisfierProbe } from './snapshot.ts';
import {
  type ConsentClass,
  DISK_BACKED_SATISFIER_KINDS,
  type ExceptionLevel,
  type SatisfierKind,
  type SurfaceState,
} from './vocabulary.ts';

export interface ConnectionCell {
  readonly satisfierId: SatisfierId;
  readonly agentId: AgentId;
  readonly piece: IntegrationPiece;
  readonly scope: SatisfierScope;
  readonly kind: SatisfierKind;
  readonly pathId?: PathId;
  readonly resolvedPath?: string;
  readonly audience: AudienceClass;
  readonly state: SurfaceState;
  readonly checked: boolean;
  readonly exception: ExceptionLevel | null;
  readonly folded: boolean;
  readonly enabled: boolean;
  readonly disabledReason: BlockedReason | null;
  readonly sharedWith: readonly AgentId[];
  readonly sharedFolderWith: readonly AgentId[];
  readonly prerequisites: readonly SatisfierId[];
  readonly unmetPrerequisites: readonly SatisfierId[];
  readonly consentClass: ConsentClass;
  readonly installability: Installability;
  readonly guidance?: GuidanceRef;
  readonly followup?: GuidanceRef;
  readonly troubleshooting?: GuidanceRef;
}

export interface ConnectionScopeGroup {
  readonly scope: SatisfierScope;
  readonly cells: readonly ConnectionCell[];
}

export interface ConnectionRow {
  readonly agentId: AgentId;
  readonly detected: boolean | null;
  readonly folded: boolean;
  readonly setupDocSlug: string | null;
  readonly scopes: readonly ConnectionScopeGroup[];
}

export interface ConnectionsView {
  readonly rows: readonly ConnectionRow[];
}

export interface BuildConnectionsViewInput {
  readonly agentIds?: readonly string[] | null;
  readonly probes?: ProbeSnapshot | null;
  readonly detection?: DetectionSnapshot | null;
}

function sharedFolderWithFor(
  satisfier: SatisfierRecord,
  probes: ProbeSnapshot | null | undefined,
): readonly AgentId[] {
  const observed = readSatisfierProbe(probes, satisfier.id)?.sharedWith ?? [];
  return observed.filter((agent) => agent !== satisfier.agent);
}

const SETTINGS_SCOPE_ORDER: readonly SatisfierScope[] = SATISFIER_SCOPES.filter(
  (scope) => scope !== 'session',
);

function isSettingsCellKind(kind: SatisfierKind): boolean {
  return DISK_BACKED_SATISFIER_KINDS.includes(kind);
}

function buildCells(
  agent: AgentRecord,
  probes: ProbeSnapshot | null | undefined,
  rowFolded: boolean,
): ConnectionCell[] {
  const cells: ConnectionCell[] = [];

  for (const satisfier of agent.satisfiers) {
    if (!isSettingsCellKind(satisfier.kind)) continue;

    const state = resolveSurfaceState(satisfier, probes);
    const resolvedPath = probes?.satisfiers?.[satisfier.id]?.path;
    const policy = statePolicyFor(state);
    const unmet = unmetPrerequisites(satisfier.prerequisites, probes);
    const reason = resolveBlockedReason({
      state,
      installability: satisfier.installability,
      agentFolded: rowFolded,
    });

    cells.push({
      satisfierId: satisfier.id,
      agentId: agent.id,
      piece: satisfier.piece,
      scope: satisfier.scope,
      kind: satisfier.kind,
      ...(satisfier.pathId === undefined ? {} : { pathId: satisfier.pathId }),
      ...(resolvedPath === undefined ? {} : { resolvedPath }),
      audience: satisfier.audience,
      state,
      checked: policy.counts,
      exception: policy.exception,
      folded: state === 'undetected',
      enabled: reason === null,
      disabledReason: reason,
      sharedWith: satisfier.sharedWith,
      sharedFolderWith: sharedFolderWithFor(satisfier, probes),
      prerequisites: satisfier.prerequisites,
      unmetPrerequisites: unmet,
      consentClass: satisfier.consentClass,
      installability: satisfier.installability,
      ...(satisfier.guidance === undefined ? {} : { guidance: satisfier.guidance }),
      ...(satisfier.followup === undefined ? {} : { followup: satisfier.followup }),
      ...(satisfier.troubleshooting === undefined
        ? {}
        : { troubleshooting: satisfier.troubleshooting }),
    });
  }

  return cells;
}

function groupByScope(cells: readonly ConnectionCell[]): ConnectionScopeGroup[] {
  const groups: ConnectionScopeGroup[] = [];

  for (const scope of SETTINGS_SCOPE_ORDER) {
    const inScope = cells.filter((cell) => cell.scope === scope);
    if (inScope.length === 0) continue;
    groups.push({ scope, cells: inScope });
  }

  return groups;
}

function buildRow(
  agent: AgentRecord,
  probes: ProbeSnapshot | null | undefined,
  detection: DetectionSnapshot | null | undefined,
): ConnectionRow {
  const { detected, folded } = resolveAgentFold(agent, detection);

  const cells = buildCells(agent, probes, folded);

  return {
    agentId: agent.id,
    detected,
    folded,
    setupDocSlug: agent.setupDocSlug,
    scopes: groupByScope(cells),
  };
}

function requestedAgents(agentIds: readonly string[] | null | undefined): readonly AgentId[] {
  if (!Array.isArray(agentIds)) return ALL_AGENT_IDS;
  return agentIds.filter((id): id is AgentId => typeof id === 'string' && isAgentId(id));
}

export function buildConnectionsView(input: BuildConnectionsViewInput = {}): ConnectionsView {
  const { agentIds, probes, detection } = input;

  const rows = requestedAgents(agentIds)
    .map((id) => AGENT_REGISTRY[id])
    .filter((agent): agent is AgentRecord => agent !== undefined)
    .map((agent) => buildRow(agent, probes, detection));

  return { rows };
}
