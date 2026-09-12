import { type AgentId, isAgentId, type SatisfierId } from './ids.ts';
import type { ProbeStrictness, SurfaceState } from './vocabulary.ts';

export const ENV_TIERS = ['desktop', 'local-web', 'remote-web'] as const;
export type EnvTier = (typeof ENV_TIERS)[number];

export interface SatisfierProbe {
  readonly state: SurfaceState;
  readonly strictness?: readonly ProbeStrictness[];
  readonly sharedWith?: readonly AgentId[];
  readonly path?: string;
}

export interface ProbeSnapshot {
  readonly env: EnvTier;
  readonly satisfiers: Readonly<Partial<Record<string, SatisfierProbe>>>;
}

export interface DetectionSnapshot {
  readonly detected: readonly AgentId[];
  readonly probed: boolean;
}

export interface HostSnapshot {
  readonly probes: ProbeSnapshot;
  readonly detection: DetectionSnapshot;
}

export function emptyProbeSnapshot(env: EnvTier): ProbeSnapshot {
  return { env, satisfiers: {} };
}

export const EMPTY_PROBE_SNAPSHOT: ProbeSnapshot = emptyProbeSnapshot('desktop');

export const EMPTY_DETECTION_SNAPSHOT: DetectionSnapshot = { detected: [], probed: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function readSatisfierProbe(
  snapshot: ProbeSnapshot | null | undefined,
  id: SatisfierId | string,
): SatisfierProbe | undefined {
  if (!isRecord(snapshot)) return undefined;
  const { satisfiers } = snapshot as { satisfiers?: unknown };
  if (!isRecord(satisfiers)) return undefined;
  const entry = satisfiers[id];
  if (!isRecord(entry)) return undefined;
  const { state, strictness, sharedWith } = entry as {
    state?: unknown;
    strictness?: unknown;
    sharedWith?: unknown;
  };
  if (typeof state !== 'string' || state.length === 0) return undefined;
  const keys = Array.isArray(strictness)
    ? strictness.filter((key): key is ProbeStrictness => typeof key === 'string')
    : undefined;
  const shared = Array.isArray(sharedWith)
    ? sharedWith.filter((id): id is AgentId => typeof id === 'string' && isAgentId(id))
    : undefined;
  return {
    state,
    ...(keys === undefined ? {} : { strictness: keys }),
    ...(shared === undefined || shared.length === 0 ? {} : { sharedWith: shared }),
  };
}

export function isAgentDetected(
  snapshot: DetectionSnapshot | null | undefined,
  id: AgentId,
): boolean {
  if (!isRecord(snapshot)) return false;
  const { detected } = snapshot as { detected?: unknown };
  return Array.isArray(detected) && detected.includes(id);
}
