import { z } from 'zod';
import { AGENT_MODES, type AgentMode } from './ids.ts';
import { type ExceptionLevel, KNOWN_SURFACE_STATES, type KnownSurfaceState } from './vocabulary.ts';

export interface StatePolicyRow {
  readonly counts: boolean;
  readonly exception: ExceptionLevel | null;
}

export const STATE_POLICY = {
  satisfied: { counts: true, exception: null },
  'present-consent-unknown': { counts: true, exception: 'info' },
  absent: { counts: false, exception: null },
  foreign: { counts: false, exception: 'warning' },
  'foreign-replaceable': { counts: false, exception: 'warning' },
  drifted: { counts: false, exception: 'warning' },
  excluded: { counts: false, exception: 'info' },
  'structural-na': { counts: false, exception: 'info' },
  undetected: { counts: false, exception: null },
  unprobeable: { counts: true, exception: 'info' },
  unprobed: { counts: false, exception: 'info' },
} as const satisfies Record<KnownSurfaceState, StatePolicyRow>;

export const UNPROBED_RESOLUTIONS = ['count-unverified', 'not-count'] as const;
export const UnprobedResolutionSchema = z.enum(UNPROBED_RESOLUTIONS);
export type UnprobedResolution = z.infer<typeof UnprobedResolutionSchema>;

export interface ModeGatePolicyRow {
  readonly unprobed: UnprobedResolution;
}

export const MODE_GATE_POLICY = {
  acp: { unprobed: 'count-unverified' },
  terminal: { unprobed: 'count-unverified' },
  external: { unprobed: 'not-count' },
} as const satisfies Record<AgentMode, ModeGatePolicyRow>;

export const VISIBILITY_SIGNALS = [
  'acp-catalog-supported',
  'harness-cli-on-path',
  'os-scheme-handler',
] as const;
export const VisibilitySignalSchema = z.enum(VISIBILITY_SIGNALS);
export type VisibilitySignal = z.infer<typeof VisibilitySignalSchema>;

export interface ModeVisibilityPolicyRow {
  readonly signal: VisibilitySignal;
  readonly unresolved: 'show' | 'hide';
  readonly negativeOutranksOverride: boolean;
}

export const MODE_VISIBILITY_POLICY = {
  acp: {
    signal: 'acp-catalog-supported',
    unresolved: 'show',
    negativeOutranksOverride: true,
  },
  terminal: {
    signal: 'harness-cli-on-path',
    unresolved: 'show',
    negativeOutranksOverride: false,
  },
  external: {
    signal: 'os-scheme-handler',
    unresolved: 'hide',
    negativeOutranksOverride: false,
  },
} as const satisfies Record<AgentMode, ModeVisibilityPolicyRow>;

export const POLICY_MODE_KEYS: readonly AgentMode[] = AGENT_MODES;

export const POLICY_STATE_KEYS: readonly KnownSurfaceState[] = KNOWN_SURFACE_STATES;
