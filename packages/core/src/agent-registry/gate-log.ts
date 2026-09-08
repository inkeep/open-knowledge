import type { AgentId, AgentMode, IntegrationPiece } from './ids.ts';
import { isAgentId } from './ids.ts';
import type {
  MetConfidence,
  ReadinessAssessment,
  ReadinessVerdict,
  RequirementStatus,
} from './readiness.ts';

export const READINESS_LOG_SITES = ['acp-thread', 'deep-link', 'terminal'] as const;
export type ReadinessLogSite = (typeof READINESS_LOG_SITES)[number];

export const REQUIREMENT_LOG_STATUSES = [
  'met',
  'unmet',
  'nothing-required',
  'not-assessed',
] as const;
export type RequirementLogStatus = (typeof REQUIREMENT_LOG_STATUSES)[number];

export interface ReadinessLogFields {
  readonly site: ReadinessLogSite;
  readonly mode: AgentMode;
  readonly verdict: ReadinessVerdict;
  readonly agent: AgentId | null;
  readonly registered: boolean;
  readonly mcp: RequirementLogStatus;
  readonly skill: RequirementLogStatus;
  readonly mcpConfidence: MetConfidence | null;
  readonly skillConfidence: MetConfidence | null;
}

function statusOf(
  assessment: ReadinessAssessment,
  piece: IntegrationPiece,
): { status: RequirementLogStatus; confidence: MetConfidence | null } {
  const requirement = assessment.requirements.find((entry) => entry.piece === piece);
  if (requirement === undefined) return { status: 'not-assessed', confidence: null };
  const status: RequirementStatus = requirement.status;
  return { status, confidence: requirement.confidence };
}

export function summarizeReadinessForLog(
  site: ReadinessLogSite,
  assessment: ReadinessAssessment,
): ReadinessLogFields {
  const agent: AgentId | null =
    isAgentId(assessment.agentId) && assessment.verdict !== 'not-registered'
      ? assessment.agentId
      : null;
  const mcp = statusOf(assessment, 'mcp');
  const skill = statusOf(assessment, 'skill');
  return {
    site,
    mode: assessment.mode,
    verdict: assessment.verdict,
    agent,
    registered: agent !== null,
    mcp: mcp.status,
    skill: skill.status,
    mcpConfidence: mcp.confidence,
    skillConfidence: skill.confidence,
  };
}
