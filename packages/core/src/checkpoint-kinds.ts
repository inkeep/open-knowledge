const OK_CHECKPOINT_PREFIX = 'ok-checkpoint-v1: ';

export type AutoConsolidationTrigger = 'dead-chain' | 'session-close' | 'boot' | 'ttl';

export type ParsedCheckpoint =
  | {
      kind: 'bridge-merge-loss';
      docName: string | null;
      size: number | null;
      metadata: { lostSubstrings: string[]; which?: string };
    }
  | {
      kind: 'producer-guard-loss';
      docName: string | null;
      size: number | null;
      metadata: { construct: string };
    }
  | {
      kind: 'observer-a-duplication';
      docName: string | null;
      size: number | null;
      metadata: { duplicatedLineCount: number };
    }
  | {
      kind: 'external-change-rescue';
      docName: string | null;
      size: number | null;
      metadata: { incomingDiskSha: string };
    }
  | {
      kind: 'defer-exhaustion-loss';
      docName: string | null;
      size: number | null;
      metadata: { deferCount: number };
    }
  | {
      kind: 'observer-a-apply-loss';
      docName: string | null;
      size: number | null;
      metadata: { lostSubstrings: string[] };
    }
  | {
      kind: 'bridge-derive-loss';
      docName: string | null;
      size: number | null;
      metadata: { lostSubstrings: string[] };
    }
  | {
      kind: 'bridge-backstop-trip';
      docName: string | null;
      size: number | null;
      metadata: { rounds: number };
    }
  | {
      kind: 'persistence-reconcile-loss';
      docName: string | null;
      size: number | null;
      metadata: { atRiskLines: number; witnessAvailable: boolean };
    }
  | {
      kind: 'persistence-duplication-reset';
      docName: string | null;
      size: number | null;
      metadata: { copies: number; fragmentChildren: number };
    }
  | {
      kind: 'persistence-divergence-realign';
      docName: string | null;
      size: number | null;
      metadata: { diskBytes: number; discardedBytes: number };
    }
  | {
      kind: 'managed-artifact-reconcile';
      docName: string | null;
      size: number | null;
      metadata: { diskBytes: number; discardedBytes: number };
    }
  | {
      kind: 'auto-consolidation';
      docName: string | null;
      size: number | null;
      metadata: { foldedRefs: number; trigger: string };
    };

export function parseCheckpoint(body: string): ParsedCheckpoint | null {
  if (!body) return null;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(OK_CHECKPOINT_PREFIX)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice(OK_CHECKPOINT_PREFIX.length));
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object') return null;
    const obj = parsed as {
      kind?: unknown;
      metadata?: unknown;
      docName?: unknown;
      size?: unknown;
    };
    const kind = obj.kind;
    const metadata = obj.metadata;
    if (metadata === null || typeof metadata !== 'object') return null;
    const docName = typeof obj.docName === 'string' ? obj.docName : null;
    const size = typeof obj.size === 'number' && Number.isFinite(obj.size) ? obj.size : null;
    if (kind === 'bridge-merge-loss') {
      const m = metadata as { lostSubstrings?: unknown };
      if (Array.isArray(m.lostSubstrings) && m.lostSubstrings.every((s) => typeof s === 'string')) {
        return {
          kind: 'bridge-merge-loss',
          docName,
          size,
          metadata: { lostSubstrings: m.lostSubstrings as string[] },
        };
      }
      return null;
    }
    if (kind === 'producer-guard-loss') {
      const m = metadata as { construct?: unknown };
      if (typeof m.construct === 'string') {
        return {
          kind: 'producer-guard-loss',
          docName,
          size,
          metadata: { construct: m.construct },
        };
      }
      return null;
    }
    if (kind === 'observer-a-duplication') {
      const m = metadata as { duplicatedLineCount?: unknown };
      if (typeof m.duplicatedLineCount === 'number' && Number.isFinite(m.duplicatedLineCount)) {
        return {
          kind: 'observer-a-duplication',
          docName,
          size,
          metadata: { duplicatedLineCount: m.duplicatedLineCount },
        };
      }
      return null;
    }
    if (kind === 'external-change-rescue') {
      const m = metadata as { incomingDiskSha?: unknown };
      if (typeof m.incomingDiskSha === 'string') {
        return {
          kind: 'external-change-rescue',
          docName,
          size,
          metadata: { incomingDiskSha: m.incomingDiskSha },
        };
      }
      return null;
    }
    if (kind === 'defer-exhaustion-loss') {
      const m = metadata as { deferCount?: unknown };
      if (typeof m.deferCount === 'number' && Number.isFinite(m.deferCount)) {
        return {
          kind: 'defer-exhaustion-loss',
          docName,
          size,
          metadata: { deferCount: m.deferCount },
        };
      }
      return null;
    }
    if (kind === 'observer-a-apply-loss') {
      const m = metadata as { lostSubstrings?: unknown };
      if (Array.isArray(m.lostSubstrings) && m.lostSubstrings.every((s) => typeof s === 'string')) {
        return {
          kind: 'observer-a-apply-loss',
          docName,
          size,
          metadata: { lostSubstrings: m.lostSubstrings as string[] },
        };
      }
      return null;
    }
    if (kind === 'bridge-derive-loss') {
      const m = metadata as { lostSubstrings?: unknown };
      if (Array.isArray(m.lostSubstrings) && m.lostSubstrings.every((s) => typeof s === 'string')) {
        return {
          kind: 'bridge-derive-loss',
          docName,
          size,
          metadata: { lostSubstrings: m.lostSubstrings as string[] },
        };
      }
      return null;
    }
    if (kind === 'bridge-backstop-trip') {
      const m = metadata as { rounds?: unknown };
      if (typeof m.rounds === 'number' && Number.isFinite(m.rounds)) {
        return {
          kind: 'bridge-backstop-trip',
          docName,
          size,
          metadata: { rounds: m.rounds },
        };
      }
      return null;
    }
    if (kind === 'persistence-reconcile-loss') {
      const m = metadata as { atRiskLines?: unknown; witnessAvailable?: unknown };
      if (
        typeof m.atRiskLines === 'number' &&
        Number.isFinite(m.atRiskLines) &&
        typeof m.witnessAvailable === 'boolean'
      ) {
        return {
          kind: 'persistence-reconcile-loss',
          docName,
          size,
          metadata: { atRiskLines: m.atRiskLines, witnessAvailable: m.witnessAvailable },
        };
      }
      return null;
    }
    if (kind === 'persistence-duplication-reset') {
      const m = metadata as { copies?: unknown; fragmentChildren?: unknown };
      if (
        typeof m.copies === 'number' &&
        Number.isFinite(m.copies) &&
        typeof m.fragmentChildren === 'number' &&
        Number.isFinite(m.fragmentChildren)
      ) {
        return {
          kind: 'persistence-duplication-reset',
          docName,
          size,
          metadata: { copies: m.copies, fragmentChildren: m.fragmentChildren },
        };
      }
      return null;
    }
    if (kind === 'persistence-divergence-realign' || kind === 'managed-artifact-reconcile') {
      const m = metadata as { diskBytes?: unknown; discardedBytes?: unknown };
      if (
        typeof m.diskBytes === 'number' &&
        Number.isFinite(m.diskBytes) &&
        typeof m.discardedBytes === 'number' &&
        Number.isFinite(m.discardedBytes)
      ) {
        return {
          kind,
          docName,
          size,
          metadata: { diskBytes: m.diskBytes, discardedBytes: m.discardedBytes },
        };
      }
      return null;
    }
    if (kind === 'auto-consolidation') {
      const m = metadata as { foldedRefs?: unknown; trigger?: unknown };
      if (
        typeof m.foldedRefs === 'number' &&
        Number.isFinite(m.foldedRefs) &&
        typeof m.trigger === 'string'
      ) {
        return {
          kind: 'auto-consolidation',
          docName,
          size,
          metadata: { foldedRefs: m.foldedRefs, trigger: m.trigger },
        };
      }
      return null;
    }
    return null;
  }
  return null;
}

/**
 * Format the `ok-checkpoint-v1:` body line for a given kind+metadata. Produces
 * exactly one line (no trailing newline). Consumers embed it inside a full
 * commit message body as a sibling to `ok-contributors:` lines.
 *
 * Exported so `saveInMemoryCheckpoint` in the server package can share this
 * serialization rule with the parser — see precedent #4 (shared computation).
 */
export function formatCheckpointBodyLine(parsed: ParsedCheckpoint): string {
  const payload: {
    kind: ParsedCheckpoint['kind'];
    docName?: string;
    size?: number;
    metadata: ParsedCheckpoint['metadata'];
  } = {
    kind: parsed.kind,
    metadata: parsed.metadata,
  };
  if (parsed.docName !== null) payload.docName = parsed.docName;
  if (parsed.size !== null) payload.size = parsed.size;
  return `${OK_CHECKPOINT_PREFIX}${JSON.stringify(payload)}`;
}

export type CheckpointKind = ParsedCheckpoint['kind'];

export type CheckpointVisibility = 'surfaced' | 'hidden';

export type CheckpointBundleExposure = 'metadata' | 'subject-only' | 'none';

export interface CheckpointKindAttributes {
  visibility: CheckpointVisibility;
  gcBucket: CheckpointKind;
  bundleExposure: CheckpointBundleExposure;
  chainAnchor: boolean;
}

export const CHECKPOINT_KIND_REGISTRY = {
  'bridge-merge-loss': {
    visibility: 'surfaced',
    gcBucket: 'bridge-merge-loss',
    bundleExposure: 'subject-only',
    chainAnchor: false,
  },
  'producer-guard-loss': {
    visibility: 'surfaced',
    gcBucket: 'producer-guard-loss',
    bundleExposure: 'metadata',
    chainAnchor: false,
  },
  'observer-a-duplication': {
    visibility: 'surfaced',
    gcBucket: 'observer-a-duplication',
    bundleExposure: 'metadata',
    chainAnchor: false,
  },
  'external-change-rescue': {
    visibility: 'surfaced',
    gcBucket: 'external-change-rescue',
    bundleExposure: 'metadata',
    chainAnchor: false,
  },
  'defer-exhaustion-loss': {
    visibility: 'surfaced',
    gcBucket: 'defer-exhaustion-loss',
    bundleExposure: 'metadata',
    chainAnchor: false,
  },
  'observer-a-apply-loss': {
    visibility: 'surfaced',
    gcBucket: 'observer-a-apply-loss',
    bundleExposure: 'subject-only',
    chainAnchor: false,
  },
  'bridge-derive-loss': {
    visibility: 'surfaced',
    gcBucket: 'bridge-derive-loss',
    bundleExposure: 'subject-only',
    chainAnchor: false,
  },
  'bridge-backstop-trip': {
    visibility: 'surfaced',
    gcBucket: 'bridge-backstop-trip',
    bundleExposure: 'metadata',
    chainAnchor: false,
  },
  'persistence-reconcile-loss': {
    visibility: 'surfaced',
    gcBucket: 'persistence-reconcile-loss',
    bundleExposure: 'metadata',
    chainAnchor: false,
  },
  'persistence-duplication-reset': {
    visibility: 'surfaced',
    gcBucket: 'persistence-duplication-reset',
    bundleExposure: 'metadata',
    chainAnchor: false,
  },
  'persistence-divergence-realign': {
    visibility: 'surfaced',
    gcBucket: 'persistence-divergence-realign',
    bundleExposure: 'metadata',
    chainAnchor: false,
  },
  'managed-artifact-reconcile': {
    visibility: 'surfaced',
    gcBucket: 'managed-artifact-reconcile',
    bundleExposure: 'metadata',
    chainAnchor: false,
  },
  'auto-consolidation': {
    visibility: 'hidden',
    gcBucket: 'auto-consolidation',
    bundleExposure: 'none',
    chainAnchor: true,
  },
} as const satisfies Record<CheckpointKind, CheckpointKindAttributes>;

export const CHECKPOINT_KINDS = Object.keys(CHECKPOINT_KIND_REGISTRY) as CheckpointKind[];

export const CHECKPOINT_SAMPLE_BY_KIND = {
  'bridge-merge-loss': {
    kind: 'bridge-merge-loss',
    docName: 'notes',
    size: 12,
    metadata: { lostSubstrings: ['dropped'] },
  },
  'producer-guard-loss': {
    kind: 'producer-guard-loss',
    docName: 'notes',
    size: 12,
    metadata: { construct: 'tableCell' },
  },
  'observer-a-duplication': {
    kind: 'observer-a-duplication',
    docName: 'notes',
    size: 12,
    metadata: { duplicatedLineCount: 2 },
  },
  'external-change-rescue': {
    kind: 'external-change-rescue',
    docName: 'notes',
    size: 12,
    metadata: { incomingDiskSha: 'abc123' },
  },
  'defer-exhaustion-loss': {
    kind: 'defer-exhaustion-loss',
    docName: 'notes',
    size: 12,
    metadata: { deferCount: 8 },
  },
  'observer-a-apply-loss': {
    kind: 'observer-a-apply-loss',
    docName: 'notes',
    size: 12,
    metadata: { lostSubstrings: ['dropped'] },
  },
  'bridge-derive-loss': {
    kind: 'bridge-derive-loss',
    docName: 'notes',
    size: 12,
    metadata: { lostSubstrings: ['dropped'] },
  },
  'bridge-backstop-trip': {
    kind: 'bridge-backstop-trip',
    docName: 'notes',
    size: 12,
    metadata: { rounds: 8 },
  },
  'persistence-reconcile-loss': {
    kind: 'persistence-reconcile-loss',
    docName: 'notes',
    size: 12,
    metadata: { atRiskLines: 1, witnessAvailable: true },
  },
  'persistence-duplication-reset': {
    kind: 'persistence-duplication-reset',
    docName: 'notes',
    size: 12,
    metadata: { copies: 2, fragmentChildren: 18 },
  },
  'persistence-divergence-realign': {
    kind: 'persistence-divergence-realign',
    docName: 'notes',
    size: 12,
    metadata: { diskBytes: 37, discardedBytes: 79 },
  },
  'managed-artifact-reconcile': {
    kind: 'managed-artifact-reconcile',
    docName: '.ok/templates/daily',
    size: 12,
    metadata: { diskBytes: 41, discardedBytes: 66 },
  },
  'auto-consolidation': {
    kind: 'auto-consolidation',
    docName: null,
    size: null,
    metadata: { foldedRefs: 3, trigger: 'dead-chain' },
  },
} satisfies { [K in CheckpointKind]: Extract<ParsedCheckpoint, { kind: K }> };

export function isSurfacedCheckpointKind(kind: CheckpointKind | null | undefined): boolean {
  if (kind == null) return true;
  return CHECKPOINT_KIND_REGISTRY[kind].visibility === 'surfaced';
}

export function isChainAnchorCheckpointKind(kind: CheckpointKind | null | undefined): boolean {
  if (kind == null) return true;
  return CHECKPOINT_KIND_REGISTRY[kind].chainAnchor;
}
