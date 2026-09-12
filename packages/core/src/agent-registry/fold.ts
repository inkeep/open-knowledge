import { getSatisfierRecord } from './agents.ts';
import type { SatisfierId } from './ids.ts';
import { STATE_POLICY, type StatePolicyRow } from './policy.ts';
import type { AgentRecord, Installability, SatisfierRecord } from './schema.ts';
import {
  type DetectionSnapshot,
  isAgentDetected,
  type ProbeSnapshot,
  readSatisfierProbe,
} from './snapshot.ts';
import { isKnownSurfaceState, type SurfaceState } from './vocabulary.ts';

export function resolveSurfaceState(
  record: SatisfierRecord,
  probes: ProbeSnapshot | null | undefined,
): SurfaceState {
  if (record.probe.mode === 'unprobeable') return 'unprobeable';
  return readSatisfierProbe(probes, record.id)?.state ?? 'unprobed';
}

export function statePolicyFor(state: SurfaceState): StatePolicyRow {
  return isKnownSurfaceState(state) ? STATE_POLICY[state] : STATE_POLICY.unprobed;
}

export const BLOCKED_REASONS = [
  'foreign',
  'structural-na',
  'not-installable',
  'agent-undetected',
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export type PrerequisiteBlocker = BlockedReason | 'foreign-replaceable';

export function unmetPrerequisites(
  ids: readonly SatisfierId[],
  probes: ProbeSnapshot | null | undefined,
): SatisfierId[] {
  const unmet = ids.filter((id) => {
    const record = getSatisfierRecord(id);
    if (record === undefined) return true;
    return !statePolicyFor(resolveSurfaceState(record, probes)).counts;
  });
  return unmet.length === ids.length ? unmet : [];
}

export function requiresExplicitConsent(state: SurfaceState): boolean {
  return statePolicyFor(state).exception === 'warning';
}

export function resolveBlockedReason(input: {
  state: SurfaceState;
  installability: Installability;
  agentFolded: boolean;
}): BlockedReason | null {
  if (input.state === 'foreign') return 'foreign';
  if (input.state === 'structural-na') return 'structural-na';
  if (input.installability === 'not-installable') return 'not-installable';
  if (input.agentFolded) return 'agent-undetected';
  return null;
}

export interface AgentFold {
  readonly detected: boolean | null;
  readonly folded: boolean;
}

export function resolveAgentFold(
  agent: AgentRecord,
  detection: DetectionSnapshot | null | undefined,
): AgentFold {
  const looked = detection?.probed === true;
  const detected = looked ? isAgentDetected(detection, agent.id) : null;
  return { detected, folded: agent.offerOnlyWhenDetected && detected === false };
}
