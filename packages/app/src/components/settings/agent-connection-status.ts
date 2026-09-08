import {
  type AgentId,
  type AgentMode,
  assessReadiness,
  type ConnectionCell,
  type ConsentClass,
  type GuidanceRef,
  type HostSnapshot,
  isAgentDetected,
  type RequirementAssessment,
} from '@inkeep/open-knowledge-core';

export type RowConnectionStatus = 'not-installed' | 'no-status' | 'not-connected' | 'connected';

export interface RowConnectionStatusInput {
  readonly agentId: AgentId;
  readonly mode: AgentMode;
  readonly snapshot: HostSnapshot | null;
  readonly detected?: boolean | null;
}

type RequirementVerdict = 'met' | 'unprobed' | 'unmet';

function requirementVerdict(requirement: RequirementAssessment): RequirementVerdict {
  if (requirement.status === 'nothing-required') return 'met';

  let anyUnprobed = false;
  for (const option of requirement.options) {
    if (option.confidence === 'unverified') {
      anyUnprobed = true;
      continue;
    }
    if (option.counts) return 'met';
  }
  return anyUnprobed ? 'unprobed' : 'unmet';
}

export type RowPresence = 'present' | 'absent' | 'unknown';

export function resolvePresence(
  agentId: AgentId,
  snapshot: HostSnapshot | null,
  rowProbe: boolean | null | undefined,
): RowPresence {
  if (rowProbe === false) return 'absent';
  if (rowProbe === true) return 'present';
  if (snapshot === null || !snapshot.detection.probed) return 'unknown';
  return isAgentDetected(snapshot.detection, agentId) ? 'present' : 'absent';
}

export function deriveRowConnectionStatus(input: RowConnectionStatusInput): RowConnectionStatus {
  const { agentId, mode, snapshot, detected } = input;

  if (resolvePresence(agentId, snapshot, detected) === 'absent') return 'not-installed';

  if (snapshot === null) return 'no-status';

  const required = assessReadiness({ agentId, mode, probes: snapshot.probes }).requirements.filter(
    (requirement) => requirement.level === 'required',
  );
  if (required.length === 0) return 'no-status';

  const verdicts = required.map(requirementVerdict);
  if (verdicts.includes('unprobed')) return 'no-status';
  if (verdicts.includes('unmet')) return 'not-connected';
  return 'connected';
}

export type FollowupRowFamily = 'terminal' | 'external';

export function followupRowFamily(consentClass: ConsentClass): FollowupRowFamily {
  return consentClass === 'enable-manually' ? 'external' : 'terminal';
}

export function deriveRowFollowup(
  input: RowConnectionStatusInput & { readonly projectMcp: ConnectionCell | undefined },
): GuidanceRef | undefined {
  const { agentId, mode, snapshot, projectMcp } = input;
  if (snapshot === null || projectMcp?.followup === undefined) return undefined;
  if (deriveRowConnectionStatus(input) !== 'connected') return undefined;
  const mcp = assessReadiness({ agentId, mode, probes: snapshot.probes }).requirements.find(
    (requirement) => requirement.level === 'required' && requirement.piece === 'mcp',
  );
  if (mcp === undefined || mcp.status !== 'met') return undefined;
  const counting = mcp.options.filter((option) => option.counts);
  if (counting.length !== 1 || counting[0]?.id !== projectMcp.satisfierId) return undefined;
  return projectMcp.followup;
}
