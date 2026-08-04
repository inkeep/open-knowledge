/**
 * Checkpoint-kind metadata + the shared kind registry.
 *
 * Pure data and pure functions — no `node:fs`, no git, no runtime deps — so
 * this module is safe to import into the browser bundle. It is the single
 * source of truth both the server (GC partition, timeline query, bundle
 * staging) and the editor UI (which checkpoint rows surface as ordinary
 * versions) consume. `shadow-repo-layout.ts` re-exports everything here for
 * the Node-only subpath consumers; the browser barrel re-exports the registry
 * helpers so the editor can drive row visibility off the same attributes.
 */

/** Prefix for the versioned checkpoint-metadata body line. */
const OK_CHECKPOINT_PREFIX = 'ok-checkpoint-v1: ';

/**
 * Kind-discriminated checkpoint metadata parsed from the `ok-checkpoint-v1:`
 * body line. The body line coexists with `ok-contributors:` lines —
 * `parseContributors` skips unknown prefixes, so the two channels do not
 * interfere.
 *
 * `docName` and `size` are carried inline so the `/api/rescue` read path can
 * enumerate checkpoints via a single batched `git log` without a per-ref
 * `git ls-tree` fan-out. They are
 * optional in the parsed shape for backward-compatible reads: pre-enrichment
 * commits returned `null` for both and the rescue list fell back to
 * `ls-tree`. New writes (`saveInMemoryCheckpoint`) always populate them.
 */
/**
 * Why a service-authored consolidation fired. Bounded set so telemetry/diagnose
 * can read it back as a low-cardinality enum. Parsed back as a bare `string` for
 * forward-compatibility (a future trigger an old reader doesn't know about still
 * parses), so writers construct with this type but readers must not assume it.
 */
export type AutoConsolidationTrigger = 'dead-chain' | 'session-close' | 'boot' | 'ttl';

export type ParsedCheckpoint =
  | {
      // `which` distinguishes the post-condition verdict class ('substring' /
      // 'order' losses vs 'growth' gains) within the one merge checkpoint
      // kind. Optional: checkpoints written before the field existed parse
      // without it.
      kind: 'bridge-merge-loss';
      docName: string | null;
      size: number | null;
      metadata: { lostSubstrings: string[]; which?: string };
    }
  | {
      // Observer A's producer guard detected serialize output that fails
      // structural legality (a fresh parse loses authored content) at the
      // serialize boundary — distinct from `bridge-merge-loss` (a Path B merge
      // drop) so the two detection sites keep separate retention budgets and
      // TimelinePanel can tell serializer-corruption from merge-drop. `construct`
      // is a bounded, content-free locator of the danger-space node types
      // present (e.g. `jsxComponent,tableCell`), never raw content.
      kind: 'producer-guard-loss';
      docName: string | null;
      size: number | null;
      metadata: { construct: string };
    }
  | {
      // Observer A's duplication gate detected a CRDT double-materialization of
      // a bridge-derived span (a substantive body line present in the fragment
      // more times than Y.Text justified, provenance-confirmed as a
      // server-vs-client race) and re-derived the fragment from Y.Text before
      // it could persist. `contents` is the pre-recovery doubled fragment
      // serialization — the anchor if the re-derive was wrong.
      // `duplicatedLineCount` is a content-free count, never raw content.
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
      // The derive-timing defer guard reached its drain-count bound and
      // force-resolved. The re-derive then proceeds, dropping the un-propagated
      // WYSIWYG content from the live fragment; this checkpoint holds the
      // pre-resolve fragment serialization so that content stays restorable
      // through the timeline floor — the loud alternative to a silent clamp.
      // `deferCount` is a content-free count of the deferrals that preceded the
      // force-resolve.
      kind: 'defer-exhaustion-loss';
      docName: string | null;
      size: number | null;
      metadata: { deferCount: number };
    }
  | {
      // The Observer-A APPLY post-condition (XmlFragment→Y.Text direction)
      // detected that the byte-preserving apply arms (map-driven splice /
      // incremental diff) dropped content the fragment's intended markdown held.
      // Distinct from `bridge-merge-loss` (a Path-B MERGE drop) so the two
      // detection sites keep separate counters and retention budgets, and an
      // operator can tell an apply drop from a merge drop by kind alone.
      // `contents` is the pre-loss fragment serialization (the restore anchor);
      // `lostSubstrings` names the dropped content for diagnosis.
      kind: 'observer-a-apply-loss';
      docName: string | null;
      size: number | null;
      metadata: { lostSubstrings: string[] };
    }
  | {
      // The Y.Text→XmlFragment derive post-condition (Observer B direction)
      // detected that the pre-derive fragment held authored content the
      // authoritative Y.Text lacked — a paired agent-undo derive was about to
      // rebuild the fragment from Y.Text and discard it. Distinct from the
      // Observer-A merge/producer/duplication kinds so the derive direction
      // keeps its own retention budget and surfaces separately. `contents` is
      // the pre-derive fragment serialization (the restore anchor);
      // `lostSubstrings` names the dropped content for diagnosis.
      kind: 'bridge-derive-loss';
      docName: string | null;
      size: number | null;
      metadata: { lostSubstrings: string[] };
    }
  | {
      // The Y.Text→XmlFragment re-derive loop hit its drain-count backstop: a
      // run of re-derive drains never reached a raw-byte fixed point (the two
      // representations kept diverging). The B-direction re-derive is frozen to
      // stop the runaway loop; this checkpoint holds the Y.Text at freeze time
      // so that authoritative state stays restorable — the loud alternative to
      // silent truncate-and-continue. `rounds` is a content-free count of the
      // non-converging drains that preceded the trip.
      kind: 'bridge-backstop-trip';
      docName: string | null;
      size: number | null;
      metadata: { rounds: number };
    }
  | {
      // The persistence pre-write sanity check found a fragment/Y.Text
      // divergence it could NOT attribute to the derive-timing guard's
      // protected pending set, and is about to rebuild the fragment from
      // Y.Text. This checkpoint holds the pre-rebuild fragment serialization so
      // that view stays restorable — checkpoint-before-repair, the posture
      // `reports/tolerated-divergence-hygiene-layers/REPORT.md` draws from
      // e2fsck. Both metadata fields are content-free: `atRiskLines` counts the
      // fragment lines Y.Text lacked, `witnessAvailable` records whether the
      // tolerance could be evaluated at all (a detached observer publishes no
      // witness, which is itself a distinguishable trip class).
      kind: 'persistence-reconcile-loss';
      docName: string | null;
      size: number | null;
      metadata: { atRiskLines: number; witnessAvailable: boolean };
    }
  | {
      // The persistence structural-duplication tripwire refused a store whose
      // body was an integer doubling of the disk base and reset the live Y.Doc
      // from disk. That reset transacts under the file-watcher origin, which is
      // undo-eligible on neither the server UndoManager nor the client's, so
      // whatever the live document held is otherwise unrecoverable. Distinct
      // from `persistence-reconcile-loss` (the pre-write fragment rebuild) so an
      // operator can tell a duplication reset from a divergence repair by kind
      // alone, and from `observer-a-duplication` (the bridge layer's own gate)
      // so the two duplication classes keep separate budgets. `contents` is the
      // pre-reset document the reset discards — the restore anchor. Both
      // metadata fields are content-free counts.
      kind: 'persistence-duplication-reset';
      docName: string | null;
      size: number | null;
      metadata: { copies: number; fragmentChildren: number };
    }
  | {
      // The persistence L3 store-time divergence backstop found that disk had
      // moved away from the reconciled base between L1's check and this store,
      // declared disk the winner, and applied it over the live document. That
      // realign transacts under the file-watcher origin, so the live state it
      // discards — the agent's rejected write AND any human WYSIWYG edit that
      // had merged alongside it — is undo-eligible on neither side. Distinct
      // from `persistence-duplication-reset` (a duplication verdict) so an
      // operator can tell an external-writer conflict from a duplication trip
      // by kind alone. `contents` is the pre-realign document — the restore
      // anchor. Both metadata fields are content-free byte counts.
      kind: 'persistence-divergence-realign';
      docName: string | null;
      size: number | null;
      metadata: { diskBytes: number; discardedBytes: number };
    }
  | {
      // The managed-artifact store found the file changed under it by a second
      // writer (another OK window, a hand edit, a CLI write) and imported the
      // disk bytes over the live artifact doc rather than clobbering them. Same
      // file-watcher origin, same undo-inaccessibility; `contents` is the live
      // artifact the reconcile discards. Its own kind because the content class
      // differs — skills and templates, not primary prose — so an operator can
      // budget and triage it separately from the document-path realign. Both
      // metadata fields are content-free byte counts.
      kind: 'managed-artifact-reconcile';
      docName: string | null;
      size: number | null;
      metadata: { diskBytes: number; discardedBytes: number };
    }
  | {
      // Service-authored consolidation of dead/stale WIP chains.
      // GET /api/history excludes this kind by default so daily
      // auto-consolidations never pollute timelines; old readers that predate
      // this kind get `null` from parseCheckpoint (the unknown-kind fallback)
      // and render it as a plain Save Version — data-safe, cosmetic only.
      kind: 'auto-consolidation';
      docName: string | null;
      size: number | null;
      metadata: { foldedRefs: number; trigger: string };
    };

/**
 * Parse the `ok-checkpoint-v1:` metadata line from a commit message body.
 * Returns `null` when the line is absent, malformed JSON, has an unknown
 * `kind`, or has a metadata shape that doesn't match the expected kind.
 *
 * Parallel to `parseContributors` in spirit — silent fallback, no throws —
 * so TimelinePanel rendering can gracefully degrade to 'Save Version'
 * rendering for checkpoints without this body line.
 */
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
      // Both carry the identical content-free byte-count pair, so one guard
      // serves both discriminants without widening either metadata shape.
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

// ─── Checkpoint-kind registry ────────────────────────────────────────────────

/**
 * The typed checkpoint kinds. Derived from the parser union so every kind-keyed
 * partition (GC buckets, timeline visibility, bundle staging) stays tied to
 * what `parseCheckpoint` can actually return — a kind the parser produces but a
 * consumer forgot to handle becomes a compile error, not a silent gap.
 */
export type CheckpointKind = ParsedCheckpoint['kind'];

/**
 * Whether a checkpoint kind surfaces as an ordinary version-history row.
 * `hidden` kinds are still walked for ancestry but never shown — routine
 * service consolidations stay out of the timeline.
 */
export type CheckpointVisibility = 'surfaced' | 'hidden';

/**
 * How much of a checkpoint row may ride a consent-gated Detailed-diagnostics
 * bundle. This is a PRIVACY classification, and the distinction is real:
 *
 *  - `metadata` — the kind's `ok-checkpoint-v1:` metadata is content-free
 *    correlation data (counts, shas, bounded construct locators), so the whole
 *    body line may travel.
 *  - `subject-only` — the kind's metadata embeds RAW DOCUMENT CONTENT (the
 *    `lostSubstrings` kinds carry verbatim dropped lines), so only the
 *    content-free commit subject may travel. A bundle that staged the body for
 *    these kinds would exfiltrate the user's document.
 *  - `none` — the kind never appears in a bundle at all.
 *
 * The loss ring is content-free by schema regardless of this attribute; this
 * classifies the CHECKPOINT COMMIT, which is not.
 *
 * ADVISORY, not enforcement: the bundle staging path stages the content-free
 * commit subject UNIFORMLY for every kind (the `CHECKPOINT_REF_GIT_FORMAT`
 * for-each-ref format in the CLI bundle assembler) and never reads this
 * attribute — privacy holds by that uniform construction, guarded by a format
 * test. This documents each kind's content tier so a future staging change that
 * wants to expand a kind's body registers which kinds it must never expand; it
 * does not gate today's staging.
 */
export type CheckpointBundleExposure = 'metadata' | 'subject-only' | 'none';

/**
 * Per-kind attributes that drive surfacing, GC, restore, and bundle behavior
 * from one place, so those four consumers can't drift from each other. Both
 * this program's loss/rescue kinds and the conflict spec's future consumer
 * kinds register here.
 */
export interface CheckpointKindAttributes {
  /** Surfaced as an ordinary timeline row, or hidden from it. */
  visibility: CheckpointVisibility;
  /**
   * Retention partition this kind is GC'd under — the `gcCheckpointRefs`
   * byKind key. 1:1 with the kind today; the indirection lets a future kind
   * draw from an existing budget instead of minting its own.
   */
  gcBucket: CheckpointKind;
  /** How rows of this kind may appear in a consent-gated diagnostic bundle. */
  bundleExposure: CheckpointBundleExposure;
  /**
   * Whether a checkpoint of this kind may anchor the consolidation chain — the
   * set a new checkpoint adopts as parents so that reaping an older checkpoint
   * ref leaves its commit reachable.
   *
   * Only a kind GC cannot empty qualifies. A count-only bucket always retains
   * its newest N, so at least one survives to carry the ancestry; every
   * TTL-bounded bucket can be reaped to nothing, and a chain routed through one
   * would be severed the moment it was.
   *
   * `false` is also what keeps a kind whose metadata embeds verbatim document
   * content from being adopted: a parent edge would make it reachable for as
   * long as the chain lives and silently outlast the budget that expires it.
   */
  chainAnchor: boolean;
}

/**
 * Single source of truth for checkpoint-kind behavior. Visibility follows the
 * timeline-floor reshape: loss and rescue kinds surface as ordinary "recovered
 * content" rows; routine `auto-consolidation` stays hidden.
 *
 * The `satisfies Record<CheckpointKind, …>` makes this the enforced extension
 * point: a kind added to `ParsedCheckpoint` that is not registered here (or an
 * entry registered here with no matching parser kind) fails to compile. When
 * the conflict spec adds `auto-merge-rescue` it must register it here too, as
 * `visibility: 'surfaced'` — the "Before merge" row whose restore is a plain
 * restore-to-that-row.
 */
export const CHECKPOINT_KIND_REGISTRY = {
  // `lostSubstrings` is verbatim document content — subject-only.
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
  // `lostSubstrings` is verbatim document content — subject-only.
  'observer-a-apply-loss': {
    visibility: 'surfaced',
    gcBucket: 'observer-a-apply-loss',
    bundleExposure: 'subject-only',
    chainAnchor: false,
  },
  // `lostSubstrings` is verbatim document content — subject-only.
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
  // Both buckets below are TTL-bounded (`applyTtl: true` in `GC_BUCKET_POLICY`,
  // budgets `maxPersistenceDivergenceRealign` / `maxManagedArtifactReconcile`),
  // so either can be reaped to nothing and a chain routed through one would be
  // severed the moment it was. `auto-consolidation` remains the only count-only
  // bucket and the only anchor.
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

/** Every registered checkpoint kind, for exhaustive iteration. */
export const CHECKPOINT_KINDS = Object.keys(CHECKPOINT_KIND_REGISTRY) as CheckpointKind[];

/**
 * One representative checkpoint per kind, in the shape `parseCheckpoint`
 * returns for it.
 *
 * This lives beside the kinds rather than in the round-trip test because a
 * `satisfies` clause only binds where TypeScript reads it, and every package
 * tsconfig excludes `**\/*.test.ts` — a guard written there compiles nothing
 * and fails nothing. Sited here it is load-bearing: a kind added to
 * `ParsedCheckpoint` with no sample, or a sample whose metadata does not match
 * the kind it is keyed under, fails `tsc` in the same file as the registry
 * entry it is missing. The mapped type is what makes the second half true:
 * `Record<CheckpointKind, ParsedCheckpoint>` would accept any union member
 * under any key, so a sample keyed under one kind while carrying another
 * would compile.
 *
 * The parser and registry still have to AGREE at runtime, which no type can
 * show; the round-trip test drives these samples through
 * `formatCheckpointBodyLine` and `parseCheckpoint` to prove it.
 */
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

/**
 * Whether a checkpoint kind surfaces as an ordinary timeline row. `null` /
 * `undefined` (a non-checkpoint row, or a checkpoint whose body line was
 * missing or malformed) counts as surfaced — those are ordinary Save-Version /
 * WIP rows, not hidden kinds.
 */
export function isSurfacedCheckpointKind(kind: CheckpointKind | null | undefined): boolean {
  if (kind == null) return true;
  return CHECKPOINT_KIND_REGISTRY[kind].visibility === 'surfaced';
}

/**
 * Whether a checkpoint kind may anchor the consolidation chain.
 *
 * `null` / `undefined` — an untyped user `Save Version` checkpoint, or one
 * whose body line was missing or malformed — anchors. Those are retained
 * permanently, so a chain routed through one can never be severed by GC.
 */
export function isChainAnchorCheckpointKind(kind: CheckpointKind | null | undefined): boolean {
  if (kind == null) return true;
  return CHECKPOINT_KIND_REGISTRY[kind].chainAnchor;
}
