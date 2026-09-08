import { getAgentRecord, getSatisfierRecord } from './agents.ts';
import { CAPABILITY_RECORDS } from './capabilities.ts';
import { resolveSurfaceState, statePolicyFor } from './fold.ts';
import {
  type AgentId,
  type AgentMode,
  type IntegrationPiece,
  isAgentId,
  type SatisfierId,
} from './ids.ts';
import {
  MODE_GATE_POLICY,
  MODE_VISIBILITY_POLICY,
  STATE_POLICY,
  type VisibilitySignal,
} from './policy.ts';
import type { AgentRecord, GuidanceRef, RequirementRecord } from './schema.ts';
import {
  type DetectionSnapshot,
  type ProbeSnapshot,
  readSatisfierProbe,
  type SatisfierProbe,
} from './snapshot.ts';
import {
  type ConsentClass,
  type ExceptionLevel,
  isKnownSurfaceState,
  type ProbeStrictness,
  type RequirementLevel,
  type SurfaceState,
} from './vocabulary.ts';

export const READINESS_VERDICTS = [
  'ready',
  'ready-with-nudges',
  'blocked',
  'mode-not-available',
  'not-registered',
] as const;
export type ReadinessVerdict = (typeof READINESS_VERDICTS)[number];

export const MET_CONFIDENCES = ['verified', 'unverifiable', 'unverified'] as const;
export type MetConfidence = (typeof MET_CONFIDENCES)[number];

export const REQUIREMENT_STATUSES = ['met', 'unmet', 'nothing-required'] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export interface SatisfierAssessment {
  readonly id: SatisfierId;
  readonly state: SurfaceState;
  readonly counts: boolean;
  readonly confidence: MetConfidence;
  readonly exception: ExceptionLevel | null;
  readonly consentClass: ConsentClass;
  readonly guidance?: GuidanceRef;
  readonly followup?: GuidanceRef;
  readonly troubleshooting?: GuidanceRef;
}

export interface RequirementAssessment {
  readonly piece: IntegrationPiece;
  readonly level: RequirementLevel;
  readonly status: RequirementStatus;
  readonly confidence: MetConfidence | null;
  readonly satisfiedBy: SatisfierId | null;
  readonly options: readonly SatisfierAssessment[];
}

export interface ModeVisibility {
  readonly signal: VisibilitySignal;
  readonly resolved: boolean | null;
  readonly show: boolean;
}

export interface ReadinessAssessment {
  readonly agentId: string;
  readonly mode: AgentMode;
  readonly verdict: ReadinessVerdict;
  readonly visibility: ModeVisibility;
  readonly requirements: readonly RequirementAssessment[];
  readonly grantedCapabilities: readonly string[];
  readonly modeCaveats: readonly GuidanceRef[];
}

export interface AssessReadinessInput {
  readonly agentId: string;
  readonly mode: AgentMode;
  readonly probes?: ProbeSnapshot | null;
  readonly detection?: DetectionSnapshot | null;
  readonly modeSignal?: boolean | null;
}

const CONFIDENCE_RANK: Record<MetConfidence, number> = {
  verified: 3,
  unverifiable: 2,
  unverified: 1,
};

function resolveVisibility(mode: AgentMode, signal: boolean | null | undefined): ModeVisibility {
  const policy = MODE_VISIBILITY_POLICY[mode];
  const resolved = typeof signal === 'boolean' ? signal : null;
  return {
    signal: policy.signal,
    resolved,
    show: resolved ?? policy.unresolved === 'show',
  };
}

function assessSatisfier(
  id: SatisfierId,
  mode: AgentMode,
  probes: ProbeSnapshot | null | undefined,
): SatisfierAssessment {
  const record = getSatisfierRecord(id);
  if (record === undefined) {
    return {
      id,
      state: 'absent',
      counts: false,
      confidence: 'unverified',
      exception: STATE_POLICY.absent.exception,
      consentClass: 'none',
    };
  }

  const state = resolveSurfaceState(record, probes);
  const known = isKnownSurfaceState(state);
  const ambiguous = !known || state === 'unprobed';
  const countsUnverified = MODE_GATE_POLICY[mode].unprobed === 'count-unverified';

  const counts = ambiguous ? countsUnverified : statePolicyFor(state).counts;
  const confidence: MetConfidence = ambiguous
    ? 'unverified'
    : state === 'unprobeable'
      ? 'unverifiable'
      : 'verified';

  return {
    id,
    state,
    counts,
    confidence,
    exception: statePolicyFor(state).exception,
    consentClass: record.consentClass,
    ...(record.guidance === undefined ? {} : { guidance: record.guidance }),
    ...(record.followup === undefined ? {} : { followup: record.followup }),
    ...(record.troubleshooting === undefined ? {} : { troubleshooting: record.troubleshooting }),
  };
}

function assessRequirement(
  requirement: RequirementRecord,
  mode: AgentMode,
  probes: ProbeSnapshot | null | undefined,
): RequirementAssessment {
  const options = requirement.satisfiedByAny.map((id) => assessSatisfier(id, mode, probes));

  if (options.length === 0) {
    return {
      piece: requirement.piece,
      level: requirement.level,
      status: 'nothing-required',
      confidence: null,
      satisfiedBy: null,
      options,
    };
  }

  let best: SatisfierAssessment | null = null;
  for (const option of options) {
    if (!option.counts) continue;
    if (best === null || CONFIDENCE_RANK[option.confidence] > CONFIDENCE_RANK[best.confidence]) {
      best = option;
    }
  }

  return {
    piece: requirement.piece,
    level: requirement.level,
    status: best === null ? 'unmet' : 'met',
    confidence: best?.confidence ?? null,
    satisfiedBy: best?.id ?? null,
    options,
  };
}

const NO_ENTRY_TO_SHADOW: readonly SurfaceState[] = ['absent', 'structural-na'];

function grantedCapabilities(
  agent: AgentRecord,
  probes: ProbeSnapshot | null | undefined,
): string[] {
  const granted: string[] = [];

  for (const capability of CAPABILITY_RECORDS) {
    const scoped = agent.satisfiers.filter(
      (satisfier) =>
        satisfier.piece === capability.piece &&
        satisfier.kind !== 'session-injection' &&
        (capability.scope === undefined || satisfier.scope === capability.scope),
    );

    const shadowed =
      capability.revokedByForeignEntry &&
      scoped.some((satisfier) => {
        if (NO_ENTRY_TO_SHADOW.includes(resolveSurfaceState(satisfier, probes))) return false;
        return !answeredAt(readSatisfierProbe(probes, satisfier.id), capability.requiredStrictness);
      });
    if (shadowed) continue;

    const authorized = scoped.some((satisfier) => {
      if (satisfier.probe.mode !== 'probeable') return false;
      if (!satisfier.probe.strictness.includes(capability.requiredStrictness)) return false;
      const state = resolveSurfaceState(satisfier, probes);
      if (!statePolicyFor(state).counts) return false;
      return answeredAt(readSatisfierProbe(probes, satisfier.id), capability.requiredStrictness);
    });

    if (authorized) granted.push(capability.id);
  }

  return granted;
}

function answeredAt(probe: SatisfierProbe | undefined, strictness: ProbeStrictness): boolean {
  return probe?.strictness?.includes(strictness) === true;
}

export function assessReadiness(input: AssessReadinessInput): ReadinessAssessment {
  const { agentId, mode, probes, modeSignal } = input;
  const record = isAgentId(agentId) ? getAgentRecord(agentId) : undefined;

  if (record === undefined) {
    return {
      agentId,
      mode,
      verdict: 'not-registered',
      visibility: { ...resolveVisibility(mode, modeSignal), show: true },
      requirements: [],
      grantedCapabilities: [],
      modeCaveats: [],
    };
  }

  const visibility = resolveVisibility(mode, modeSignal);
  const modeRecord = record.modes[mode];

  if (modeRecord === undefined) {
    return {
      agentId,
      mode,
      verdict: 'mode-not-available',
      visibility,
      requirements: [],
      grantedCapabilities: [],
      modeCaveats: [],
    };
  }

  const requirements = modeRecord.requirements.map((requirement) =>
    assessRequirement(requirement, mode, probes),
  );

  const blocked = requirements.some(
    (requirement) => requirement.level === 'required' && requirement.status === 'unmet',
  );
  const nudged = requirements.some((requirement) => requirement.status === 'unmet');

  return {
    agentId,
    mode,
    verdict: blocked ? 'blocked' : nudged ? 'ready-with-nudges' : 'ready',
    visibility,
    requirements,
    grantedCapabilities: grantedCapabilities(record, probes),
    modeCaveats: modeRecord.caveats,
  };
}

export function isRegisteredAgent(agentId: string): agentId is AgentId {
  return isAgentId(agentId) && getAgentRecord(agentId) !== undefined;
}
