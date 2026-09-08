import { z } from 'zod';

export const SATISFIER_KINDS = [
  'config-entry',
  'managed-file',
  'skill-bundle-copy',
  'central-store-copy',
  'session-injection',
] as const;

export const SatisfierKindSchema = z.enum(SATISFIER_KINDS);
export type SatisfierKind = z.infer<typeof SatisfierKindSchema>;

export const DISK_BACKED_SATISFIER_KINDS: readonly SatisfierKind[] = SATISFIER_KINDS.filter(
  (kind) => kind !== 'session-injection',
);

export const KNOWN_SURFACE_STATES = [
  'satisfied',
  'present-consent-unknown',
  'absent',
  'foreign',
  'foreign-replaceable',
  'drifted',
  'excluded',
  'structural-na',
  'undetected',
  'unprobeable',
  'unprobed',
] as const;

export type KnownSurfaceState = (typeof KNOWN_SURFACE_STATES)[number];

export type SurfaceState = KnownSurfaceState | (string & {});

export const SurfaceStateSchema: z.ZodType<SurfaceState> = z.union([
  z.enum(KNOWN_SURFACE_STATES),
  z.string(),
]);

export function isKnownSurfaceState(state: SurfaceState): state is KnownSurfaceState {
  return (KNOWN_SURFACE_STATES as readonly string[]).includes(state);
}

export const PROBE_STRICTNESS_KEYS = [
  'reclaim-permissive',
  'pre-approval-exact',
  'injection-functional',
] as const;

export const ProbeStrictnessSchema = z.enum(PROBE_STRICTNESS_KEYS);
export type ProbeStrictness = z.infer<typeof ProbeStrictnessSchema>;

export const CONSENT_CLASSES = ['none', 'approve-once', 'enable-manually', 'trust-gated'] as const;

export const ConsentClassSchema = z.enum(CONSENT_CLASSES);
export type ConsentClass = z.infer<typeof ConsentClassSchema>;

export const APPLY_ACTIONS = [
  'written',
  'overwritten',
  'skipped-unsupported',
  'skipped-prerequisite',
  'declined',
  'failed',
  'removed',
  'excluded',
  'unchanged',
  'handed-off',
  'skipped-foreign',
  'skipped-missing',
  'no-op',
] as const;

export const ApplyActionSchema = z.enum(APPLY_ACTIONS);
export type ApplyAction = z.infer<typeof ApplyActionSchema>;

export const EXCEPTION_LEVELS = ['info', 'warning', 'error'] as const;
export const ExceptionLevelSchema = z.enum(EXCEPTION_LEVELS);
export type ExceptionLevel = z.infer<typeof ExceptionLevelSchema>;

export const REQUIREMENT_LEVELS = ['required', 'recommended'] as const;
export const RequirementLevelSchema = z.enum(REQUIREMENT_LEVELS);
export type RequirementLevel = z.infer<typeof RequirementLevelSchema>;
