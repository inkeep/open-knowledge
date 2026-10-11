import {
  CONFLICT_KINDS,
  RECONCILE_REASONS,
  type RESOLVE_STRATEGIES,
} from '@inkeep/open-knowledge-core';

export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export type ReconcileReason = (typeof RECONCILE_REASONS)[number];

export type ResolveStrategy = (typeof RESOLVE_STRATEGIES)[number];

export interface ConflictStages {
  base: string;
  ours: string;
  theirs: string;
}

export type Conflict =
  | { kind: 'merge-native'; file: string; detectedAt: string }
  | {
      kind: 'working-tree';
      file: string;
      detectedAt: string;
      theirsSha: string;
      baseSha?: string;
    }
  | {
      kind: 'reconcile';
      file: string;
      detectedAt: string;
      branch: string;
      reason: ReconcileReason;
      stages: ConflictStages;
    };

type _ExhaustiveConflictKind =
  Exclude<ConflictKind, Conflict['kind']> extends never
    ? true
    : ['Conflict is missing a ConflictKind member:', Exclude<ConflictKind, Conflict['kind']>];
const _exhaustiveConflictKind: _ExhaustiveConflictKind = true;

export type LifecycleView =
  | {
      status: 'conflict';
      kind: ConflictKind;
      reason: ReconcileReason | 'merge-conflict' | 'pull-only-collision';
    }
  | { status: 'deleted-upstream' }
  | { status: 'renamed'; newPath: string };

const FREEZING_LIFECYCLE_STATUSES = [
  'conflict',
  'deleted-upstream',
  'renamed',
] as const satisfies readonly LifecycleView['status'][];

export type FreezingLifecycleStatus = (typeof FREEZING_LIFECYCLE_STATUSES)[number];

type _ExhaustiveFreezingLifecycleStatus =
  Exclude<LifecycleView['status'], FreezingLifecycleStatus> extends never
    ? true
    : [
        'LifecycleView gained a status that does not freeze the disk store:',
        Exclude<LifecycleView['status'], FreezingLifecycleStatus>,
      ];
const _exhaustiveFreezingLifecycleStatus: _ExhaustiveFreezingLifecycleStatus = true;

const REMOVAL_LIFECYCLE_STATUSES = [
  'deleted-upstream',
  'renamed',
] as const satisfies readonly FreezingLifecycleStatus[];

export type RemovalLifecycleStatus = (typeof REMOVAL_LIFECYCLE_STATUSES)[number];

type _ExhaustiveRemovalLifecycleStatus =
  Exclude<FreezingLifecycleStatus, RemovalLifecycleStatus | 'conflict'> extends never
    ? true
    : [
        'A freezing lifecycle status is neither a conflict nor a removal:',
        Exclude<FreezingLifecycleStatus, RemovalLifecycleStatus | 'conflict'>,
      ];
const _exhaustiveRemovalLifecycleStatus: _ExhaustiveRemovalLifecycleStatus = true;

export function isRemovalLifecycleStatus(value: unknown): value is RemovalLifecycleStatus {
  return (REMOVAL_LIFECYCLE_STATUSES as readonly unknown[]).includes(value);
}

export function isConflictKind(value: unknown): value is ConflictKind {
  return (CONFLICT_KINDS as readonly unknown[]).includes(value);
}

export function isReconcileReason(value: unknown): value is ReconcileReason {
  return (RECONCILE_REASONS as readonly unknown[]).includes(value);
}

const RECONCILE_MARKER_REASONS: ReadonlySet<ReconcileReason> = new Set<ReconcileReason>([
  'disk-markers',
  'refused-conflict-markers',
]);

const ALL_STRATEGIES = [
  'mine',
  'theirs',
  'content',
  'delete',
] as const satisfies readonly ResolveStrategy[];

const NO_THEIRS_STRATEGIES = [
  'mine',
  'content',
  'delete',
] as const satisfies readonly ResolveStrategy[];

const WHOLESALE_STRATEGIES = [
  'mine',
  'theirs',
  'delete',
] as const satisfies readonly ResolveStrategy[];

export function holdsMarkersOnDisk(entry: Conflict): boolean {
  switch (entry.kind) {
    case 'merge-native':
    case 'working-tree':
      return true;
    case 'reconcile':
      return RECONCILE_MARKER_REASONS.has(entry.reason);
    default: {
      const _exhaustive: never = entry;
      return true;
    }
  }
}

export function strategiesFor(
  kind: ConflictKind,
  reason?: ReconcileReason,
): readonly ResolveStrategy[] {
  if (kind !== 'reconcile' || reason === undefined) return ALL_STRATEGIES;
  if (RECONCILE_MARKER_REASONS.has(reason)) return NO_THEIRS_STRATEGIES;
  if (reason === 'refused-too-large') return WHOLESALE_STRATEGIES;
  return ALL_STRATEGIES;
}
