import type { BridgeToleranceClass, CC1Channel } from '@inkeep/open-knowledge-core';

export type MapDrivenSpliceFallbackReason =
  | 'text-mismatch'
  | 'synthetic-doc'
  | 'parse-error'
  | 'missing-position';

export interface ReconciliationMetrics {
  reconcileCount: number;
  conflictCount: number;
  batchCount: number;
  upstreamImportCount: number;
  rescueBufferCount: number;
  branchSwitchCount: number;
  parkCount: number;
  gitAutoSaveFailureCount: number;
  gitWriterCommitFailureCount: number;
  cc1BroadcastCount: number;
  cc1BroadcastDropCount: number;
  cc1SubscriberCount: number;
  /** Per-channel watermark of the most recent broadcast `seq`. Bounded
   *  cardinality: keys are constrained to the `CC1Channel` union (9 entries
   *  total — five derived-view channels + four broadcast-shape channels).
   *  Tightening from `string` to `Partial<Record<CC1Channel, number>>`
   *  enforces typo-resistance at compile time so no caller can silently
   *  pollute the map with arbitrary labels and inflate the operator
   *  metric surface. Mirrors the cardinality discipline applied to
   *  `bridgeToleranceApplied`. */
  cc1LastSeq: Partial<Record<CC1Channel, number>>;
  serverObserverFiresA: number;
  serverObserverFiresB: number;
  serverObserverErrorsA: number;
  serverObserverErrorsB: number;
  /** Count of successful atomic disk writes from persistence.onStoreDocument.
   *  Regression gate: if OBSERVER_SYNC_ORIGIN drops skipStoreHooks,
   *  onStoreDocument fires on every observer write and produces amplified
   *  disk I/O. Under skipStoreHooks: true, a single agent-write produces
   *  exactly one persistence disk write. */
  persistenceDiskWrites: number;
  /** Bridge-correctness SPEC §6 R9 — count of Observer A Path B
   *  content-preservation post-condition violations. Calibration signal
   *  for the parallel single-CRDT-collapse exploration. */
  bridgeMergeContentLoss: number;
  /** Bridge-correctness SPEC §6 R9 — count of successful silent rescue
   *  checkpoints written via saveInMemoryCheckpoint. Bounds the rate a user
   *  might see in TimelinePanel; if high, R7c coalescing becomes worth adding. */
  bridgeMergeCheckpointCreated: number;
  /** Y.Text-is-truth contract — count of bridge invariant violation events
   *  emitted by the watchdog (Observer B post-Phase-1, the persistence
   *  pre-write sanity check, and any test-harness watcher).
   *  Steady-state target: ~0 in production. A non-zero value means
   *  ytext bytes diverged from `serialize(fragment)` outside the tolerated
   *  equivalence classes enumerated in `normalizeBridge`. Surface via
   *  `bridge-invariant-violation` log events for triage. */
  bridgeInvariantViolations: number;
  /** Y.Text-is-truth contract — count of suppressed
   *  bridge-invariant-violation events that the rate-limiter dropped to
   *  prevent log flooding when a single (site, doc) tuple fires repeatedly
   *  within the debounce window. (Tolerance-class is NOT a rate-limit
   *  dimension on the violation path — by definition a violation is OUTSIDE
   *  any tolerated class. The bridge-tolerance-applied event has its own
   *  rate-limiter keyed by (site, class).) Reported counts are upper bounds
   *  — actual violation rate = `bridgeInvariantViolations` +
   *  `bridgeInvariantViolationsSuppressed`. */
  bridgeInvariantViolationsSuppressed: number;
  /** Quiescence gate — count of persistence cycles that the quiescence gate
   *  skipped because `isDocQuiescent` returned false (Hocuspocus's debounce
   *  fired mid-burst before `afterAllTransactions` had landed since the last
   *  user-origin transaction). The next debounce cycle retries; a healthy
   *  steady-state has occasional skips during heavy collaborative bursts but
   *  they always converge to a flush within `QUIESCENCE_MAX_DEFER` cycles.
   *  Persistent non-zero growth alongside `persistenceForceFlushDuringBurst`
   *  indicates the user has been typing without pause for ≥16 s — surfacing
   *  the force-flush backstop. */
  persistenceSkipNonQuiescent: number;
  /** Quiescence-gate backstop — count of force-flushes that
   *  proceeded despite the document not being quiescent because the
   *  per-doc deferral counter exceeded `QUIESCENCE_MAX_DEFER` (default 8
   *  ≈ 16 s of sustained typing under default 2 s debounce). Bounds
   *  staleness so sustained collaborative bursts can't leave material
   *  work undurable. The matching fragment-reconciliation queues
   *  unconditionally on the next settlement after the force-flush. */
  persistenceForceFlushDuringBurst: number;
  /** Collab WebSocket upgrade sockets emitting EPIPE from `ws.send()` AFTER
   *  the call returned control — kernel-level TCP race against a peer that
   *  has sent FIN. Filtered at the socket-boundary listener per precedent
   *  §23 (known-safe at half-close). Counted for observability: a spike
   *  indicates upstream network load or peer-disconnect patterns worth
   *  investigating, even though individual events are expected. */
  collabSocketEpipeCount: number;
  /** Collab WebSocket upgrade sockets emitting ECONNRESET — peer-side
   *  unclean close (RST). Same precedent §23 filter boundary; same
   *  observability rationale as `collabSocketEpipeCount`. */
  collabSocketEconnresetCount: number;
  /** Collab WebSocket messages rejected before Hocuspocus/Yjs processing
   *  because their frame exceeded the server-side byte cap. A non-zero
   *  value means a peer attempted to send an update large enough to risk
   *  monopolizing the single Node event loop during Yjs integration. */
  collabMessageTooLargeCount: number;
  /** Count of legacy WIP refs deleted by the allowlist-based sweep in
   *  initShadowRepo on first run post-upgrade. */
  shadowMigrationLegacyRefsDeleted: number;
  effectDiffCaptureFailures: number;
  /** Count of awareness-mutation failures in `AgentPresenceBroadcaster`
   *  (setPresence / clearPresence / touchMode catching a throw from
   *  `awareness.setLocalState`). Each failure logs at ERROR but the call
   *  sites (HTTP handlers, keepalive close) swallow the return and move
   *  on, so the counter is the operator-visible signal that presence is
   *  silently dropping. A non-zero value means the badge state on clients
   *  may disagree with what the server thinks it published — investigate
   *  the correlated `[agent-presence] awareness mutation failed` log line. */
  agentPresenceMutationErrors: number;
  /** Successful agent-write API calls that reached recordContributor —
   *  denominator for the summary-adoption metric. Incremented by the five
   *  agent-write handlers only AFTER a successful recordContributor;
   *  UI-driven rollback/rename without agentId does NOT increment. */
  agentWriteCalls: number;
  /** Agent-write calls that carried a non-empty summary through
   *  normalizeSummary — numerator for the summary-adoption metric.
   *  Adoption rate = summariesProvided / agentWriteCalls. */
  summariesProvided: number;
  /** Agent-write calls whose input summary exceeded the API cap and was
   *  truncated to 79 visible chars + `…`. Steady-state target <10 %. */
  summariesTruncated: number;
  /** Y.Text-is-truth contract — count of `agent-patch`
   *  invocations whose `find` target failed to match the document's source
   *  bytes (returns 404 not-found OR 409 stale-target). Useful for
   *  detecting downstream tools that compute offsets against canonical
   *  bytes (e.g. `serialize(fragment)`) rather than user-typed source
   *  bytes (`ytext.toString()`). Steady-state non-zero is acceptable
   *  (agents legitimately try-and-retry); spikes correlate with tool
   *  upgrades that bypass the user-bytes search surface. */
  agentPatchFindMismatches: number;
  /** Y.Text-is-truth contract — count of bridge-tolerance-applied
   *  events emitted per tolerance class. Each entry tracks how often the
   *  comparator passed via that tolerance class while bytes were not
   *  byte-equal pre-normalization. Steady-state non-zero is acceptable
   *  (architectural-floor cases like CRLF/leading-newline are normal); growth
   *  highlights which classes are most worth closing via fidelity attrs.
   *
   *  Keys are bounded to `BridgeToleranceClass` (the enumerated labels in
   *  `BRIDGE_TOLERANCE_CLASSES`). Lazy keys: a class only appears once the
   *  first event for it has fired. Tightening from `string` enforces typo-
   *  resistance at compile time so no caller can silently pollute the map
   *  with arbitrary labels and drop those counters from operator visibility. */
  bridgeToleranceApplied: Partial<Record<BridgeToleranceClass, number>>;
  /** Y.Text-is-truth contract — count of Observer A Path B
   *  fires (mergeThreeWay slow path triggered by ytext divergence from the
   *  baseline) that escaped the per-doc rate-limiter and emitted a
   *  structured `observer-a-path-b-fired` event. Steady-state non-zero is
   *  normal under collaborative editing; spikes correlate with reconcile
   *  contention or undo collisions. The counter increments only on emit,
   *  matching the bridge-invariant-violation pattern. The companion
   *  `observerAPathBFiresSuppressed` counts events the rate-limiter
   *  dropped within the per-doc debounce window. Each Path B fire bumps
   *  exactly one of the two, so `actual_rate = fires + suppressed`. */
  observerAPathBFires: number;
  /** Companion to `observerAPathBFires` — count of Path B fires the
   *  rate-limiter suppressed within the per-doc debounce window. The
   *  unsuppressed `console.warn` would flood the log under multi-peer
   *  concurrent editing. The counter increments only on suppress,
   *  matching the bridge-invariant-violation pattern; the emit counter
   *  is bumped only on the corresponding emit. Operators see the true
   *  Path-B rate via `actual_rate = observerAPathBFires +
   *  observerAPathBFiresSuppressed`. */
  observerAPathBFiresSuppressed: number;
  /** Count of Observer A drains where the map-driven block-aligned splice
   *  computed and applied — the byte-preserving default path that keeps
   *  untouched blocks byte-identical in Y.Text. The companion
   *  `mapDrivenSpliceFallback` records every drain the splice could NOT
   *  serve, keyed by reason; `splice_rate = applied / (applied + Σfallback)`
   *  is the health signal for the default fidelity path. */
  mapDrivenSpliceApplied: number;
  /** Companion to `mapDrivenSpliceApplied` — count of Observer A drains
   *  that fell back off the map-driven splice, keyed by reason:
   *  `text-mismatch` (Y.Text diverged from baseline → Path B; expected
   *  under concurrent edits), `synthetic-doc` (system/config docs never
   *  use the splice; expected), `parse-error` (parse/serialize threw
   *  inside the splice computation — a sustained non-zero here means a
   *  serializer/parser regression is silently routing every edit through
   *  the lossier incremental-diff fallback), and `missing-position` (a
   *  top-level mdast block lacked byte offsets). Keys are a closed
   *  4-value union, mirroring `bridgeToleranceApplied`'s compile-time
   *  bounded-cardinality guard. */
  mapDrivenSpliceFallback: Partial<Record<MapDrivenSpliceFallbackReason, number>>;
  /** Y.Text-is-truth contract — count of Observer A in-sync canonical-base
   *  residual merges: the byte-preserving slow path on docs whose settled
   *  bytes sit beyond `normalizeBridge` tolerance of the canonical witness.
   *  NOT a Path B fire — `observerAPathBFires`/`...Suppressed` stay scoped
   *  to real divergence. Increments on every run with no rate-limiter
   *  (there is no per-fire console event to flood), so growth on every
   *  WYSIWYG-edit drain of a beyond-tolerance doc is expected — this is the
   *  "merge machinery is hot on this doc class" volume signal operators
   *  need when triaging editor latency, which the divergence-scoped Path B
   *  counters deliberately exclude. */
  observerAResidualMergeRuns: number;
  /** Y.Text-is-truth contract (precedent #38) — count of Observer A
   *  settlement checks that detected a drain settling split-brain (Y.Text
   *  vs serialize(fragment) divergence beyond `normalizeBridge` tolerance)
   *  and enqueued a same-drain Observer B re-derive, that escaped the
   *  per-(site, doc) rate-limiter and emitted a structured
   *  `bridge-split-brain-rederive` event. No organic input produces this
   *  divergence at HEAD — producers were narrowed to dependency/plugin
   *  drift — so this firing in production is itself the drift alert: a
   *  new divergent fallback producer has appeared. Also the operator
   *  signal for a doc stuck re-deriving its fragment on every edit (the
   *  divergence is structural and persists by design; the re-derive cost
   *  recurs per drain). Counter increments only on emit; the companion
   *  suppressed counter preserves `actual_rate = fires + suppressed`. */
  bridgeSplitBrainRederives: number;
  /** Companion to `bridgeSplitBrainRederives` — count of split-brain
   *  re-derive detections the rate-limiter suppressed within the
   *  per-(site, doc) debounce window. On an irreducibly-divergent doc the
   *  check fires on every Observer A drain (every WYSIWYG keystroke), so
   *  the unsuppressed `console.warn` would drown the very drift signal
   *  operators need. Incremented only on suppress, mirroring
   *  `observerAPathBFiresSuppressed`. */
  bridgeSplitBrainRederivesSuppressed: number;
  /** Y.Text-is-truth contract — count of best-effort
   *  fragment-reconciliation attempts (`reconcileFragmentNow`) that
   *  threw inside persistence's pre-write sanity-check recovery path. The
   *  reconciliation is the second half of the contract's R7 hazard
   *  mitigation: when the watchdog fires `bridge-invariant-violation` at
   *  persistence-time, the disk write proceeds with ytext bytes and a
   *  fragment-reconciliation queues to re-derive fragment from `parse(ytext)`
   *  on the next settlement. A persistent non-zero value means the repair
   *  itself is failing — operator-visible signal that bridge divergence is
   *  stuck rather than self-healing. Distinct from
   *  `bridgeInvariantViolations` (which counts the detection signal). */
  persistenceReconciliationFailures: number;
  /** Count of non-contract errors swallowed by the file-watcher's
   *  external-change handler (`createExternalChangeHandler`). The handler
   *  intentionally re-throws `BridgeInvariantViolationError` and
   *  `BridgeMergeContentLossError` (those signal contract violations and
   *  trip the dev/test loud-failure gate), but logs and swallows everything
   *  else so a single doc's failure can't kill the watcher. The counter is
   *  the operator-visible signal: a parse pipeline failure leaves the Y.Doc
   *  unadvanced for that doc, and the next persistence flush would
   *  overwrite the external edit. Steady-state target ~0; non-zero growth
   *  indicates `parseWithFallback`'s paragraph fallback isn't catching some
   *  malformed-bytes class. */
  externalChangeHandlerErrors: number;
  /** Disk-reconcile guard outcomes inside the server's own flush-commit
   *  window. `reconcileOwnFlushSkips` counts agent writes where disk matched
   *  the in-flight flush snapshot (guard skipped; the flush continuation owns
   *  the base advance). `reconcileInFlightFallthroughs` counts the rare case
   *  where a flush was in flight but disk held OTHER bytes — a genuinely
   *  foreign edit landing inside the window, routed to the three-way merge.
   *  Both bounded; growth in fallthroughs under zero external editors would
   *  indicate the own-write discrimination is mis-matching. */
  reconcileOwnFlushSkips: number;
  reconcileInFlightFallthroughs: number;
  /** Y.Text-is-truth contract — count of persistence pre-write
   *  sanity-check cycles where `mdManager.serialize` itself threw, blocking
   *  the bridge invariant assertion from running. Distinct from
   *  `bridgeInvariantViolations` (assertion ran and detected divergence)
   *  and `persistenceReconciliationFailures` (queued repair failed). Schema-
   *  rejection errors (malformed remote-peer CRDT update, schema drift,
   *  exotic Y.XmlElement types) land here. The catch path conservatively
   *  treats a serialize throw as definite divergence: queues fragment
   *  reconciliation, proceeds to write Y.Text bytes verbatim (R7 hazard
   *  mitigation). Steady-state target ~0; non-zero growth means the
   *  fragment side is producing values the canonical serializer rejects —
   *  worth investigating before the divergence becomes systemic. */
  persistenceSanityCheckSerializeFailures: number;
  /** Audit-framework phase 2 — count of deferred-drain cycles in
   *  `flushDeferredStores` where `storeDocumentNow` threw past its inner
   *  catches. The deferred drain runs after a quiescence-gate timeout post-
   *  burst; the worst-case frequency is tens-per-day, so there is no rate-
   *  limit gate (suppressing real signal during a disk-failure outage would
   *  be the wrong default). Bounded-cardinality `errorClass` lives on the
   *  structured `deferred-store-failed` event, not on a per-class counter
   *  fan-out. Steady-state target ~0; non-zero growth on the `disk-write`
   *  class is the operator-visible signal of an unhealthy filesystem; growth
   *  on `unknown` warrants triage on whether the classifier needs a new bin. */
  deferredStoreFailures: number;
  /** Count of WebSocket connections rejected by `removalRedirectGuard` with
   *  the `'rename-redirect'` reason — incoming connections to a docName whose
   *  file has been renamed away and whose new target exists on disk. Each
   *  rejection corresponds to one prevented phantom-resurrection write that
   *  the IDB-resync would otherwise have produced. Steady-state non-zero is
   *  expected (every external rename closes existing tabs and they reconnect
   *  to the OLD name once before redirect); a sudden zero where you expected
   *  redirects suggests the cache populate sites have drifted from the auth
   *  extension. */
  authRenameRedirectCount: number;
  /** Count of WebSocket connections rejected by `removalRedirectGuard` with
   *  the `'doc-deleted'` reason — incoming connections to a docName that was
   *  deleted (no on-disk file, cache entry has `kind: 'deleted'`). Same
   *  observability rationale as `authRenameRedirectCount`. */
  authDocDeletedCount: number;
  /** Count of LRU evictions on the per-process `recentlyRemovedDocs` cache
   *  (oldest entry dropped when the cap is exceeded). Bounds the
   *  resurrection-protection window: evicted entries no longer trigger a
   *  redirect, so a stale client reconnecting to that exact docName after
   *  eviction may still resurrect the file. Frequent evictions mean the cap
   *  is too low for the workload — raise it (cap is 10 000 with headroom
   *  for AI-driven mass renames). */
  recentlyRemovedDocsEvictions: number;
  /** Gauge — current cardinality of the per-process `recentlyRemovedDocs`
   *  cache. Read directly from the cache's `size` getter; updated on every
   *  populate / eviction so operators can correlate evictions with the cap.
   *  Per-process, drops on restart along with the cache itself. */
  recentlyRemovedDocsSize: number;
  /** Count of `removalRedirectGuard` invocations that fell through to admit
   *  via the defensive try/catch — the guard's body threw something other
   *  than a `HocuspocusAuthRejection` (cache shape mismatch, fs probe
   *  failure, programming error introduced by a future refactor). Each
   *  fall-through silently disables the phantom-resurrection defense for
   *  that connection, so the counter is the operator-visible signal that
   *  the guard is being bypassed at scale. Steady-state target ~0; non-zero
   *  growth correlates with `removal-redirect-extension-error` warns and
   *  warrants investigation before resurrection events accumulate. */
  authRemovalGuardErrors: number;
  /** Count of pathological cache cycles (e.g. A → B → A) detected by the
   *  chain walk's visited-Set guard. Each detection admits the connection
   *  (the phantom-resurrection defense is bypassed for that admit) and
   *  emits a `removal-redirect-chain-cycle` warn. Steady-state target ~0;
   *  non-zero indicates a cache populator is producing inconsistent
   *  rename pairs and the defense is silently degrading. */
  removalRedirectChainCycles: number;
  /** Count of WebSocket connections rejected by `docLineageGuard` with the
   *  `'doc-lineage-mismatch'` reason — a client claimed a lineage epoch that
   *  doesn't match the live doc (or claimed against an unloaded doc, stale
   *  by construction). Each rejection is one prevented union-merge of a dead
   *  materialization, at the cost of a client close → clearIDB → reopen
   *  round-trip. Steady-state near-zero with bursts after external
   *  delete/recreate or rename; a high steady rate means the epoch minting
   *  or the client's record bookkeeping has drifted and every connection is
   *  paying the recovery round-trip. Lifetime total: the operator signal is
   *  the growth rate computed at the metrics consumer (burst = expected;
   *  sustained = drifted bookkeeping), not the absolute value. */
  authDocLineageMismatchCount: number;
  /** Count of `docLineageGuard` invocations that fell through to admit via
   *  the defensive try/catch — same fail-open philosophy and observability
   *  rationale as `authRemovalGuardErrors`: each fall-through silently
   *  disables the stale-lineage fence for that connection, so non-zero
   *  growth (correlated with `doc-lineage-guard-error` warns) means the
   *  corruption class the fence exists to prevent can reach docs unnoticed.
   *  Lifetime total with no built-in threshold: alert on sustained growth
   *  rate at the metrics consumer — a one-time blip is a transient, a
   *  climbing rate means the fence is silently disabled under live traffic. */
  authDocLineageGuardErrors: number;
}

const counters: ReconciliationMetrics = {
  reconcileCount: 0,
  conflictCount: 0,
  batchCount: 0,
  upstreamImportCount: 0,
  rescueBufferCount: 0,
  branchSwitchCount: 0,
  parkCount: 0,
  gitAutoSaveFailureCount: 0,
  gitWriterCommitFailureCount: 0,
  cc1BroadcastCount: 0,
  cc1BroadcastDropCount: 0,
  cc1SubscriberCount: 0,
  cc1LastSeq: {},
  serverObserverFiresA: 0,
  serverObserverFiresB: 0,
  serverObserverErrorsA: 0,
  serverObserverErrorsB: 0,
  persistenceDiskWrites: 0,
  bridgeMergeContentLoss: 0,
  bridgeMergeCheckpointCreated: 0,
  bridgeInvariantViolations: 0,
  bridgeInvariantViolationsSuppressed: 0,
  persistenceSkipNonQuiescent: 0,
  persistenceForceFlushDuringBurst: 0,
  collabSocketEpipeCount: 0,
  collabSocketEconnresetCount: 0,
  collabMessageTooLargeCount: 0,
  shadowMigrationLegacyRefsDeleted: 0,
  effectDiffCaptureFailures: 0,
  agentPresenceMutationErrors: 0,
  agentWriteCalls: 0,
  summariesProvided: 0,
  summariesTruncated: 0,
  agentPatchFindMismatches: 0,
  bridgeToleranceApplied: {},
  observerAPathBFires: 0,
  observerAPathBFiresSuppressed: 0,
  mapDrivenSpliceApplied: 0,
  mapDrivenSpliceFallback: {},
  observerAResidualMergeRuns: 0,
  bridgeSplitBrainRederives: 0,
  bridgeSplitBrainRederivesSuppressed: 0,
  persistenceReconciliationFailures: 0,
  externalChangeHandlerErrors: 0,
  reconcileOwnFlushSkips: 0,
  reconcileInFlightFallthroughs: 0,
  persistenceSanityCheckSerializeFailures: 0,
  deferredStoreFailures: 0,
  authRenameRedirectCount: 0,
  authDocDeletedCount: 0,
  recentlyRemovedDocsEvictions: 0,
  recentlyRemovedDocsSize: 0,
  authRemovalGuardErrors: 0,
  removalRedirectChainCycles: 0,
  authDocLineageMismatchCount: 0,
  authDocLineageGuardErrors: 0,
};

export function incrementReconcile(): void {
  counters.reconcileCount++;
}

export function incrementConflict(): void {
  counters.conflictCount++;
}

export function incrementBatch(): void {
  counters.batchCount++;
}

export function incrementUpstreamImport(): void {
  counters.upstreamImportCount++;
}

export function incrementRescueBuffer(): void {
  counters.rescueBufferCount++;
}

export function incrementBranchSwitch(): void {
  counters.branchSwitchCount++;
}

export function incrementPark(): void {
  counters.parkCount++;
}

export function incrementGitAutoSaveFailure(): void {
  counters.gitAutoSaveFailureCount++;
}

export function incrementGitWriterCommitFailure(): void {
  counters.gitWriterCommitFailureCount++;
}

export function incrementCC1Broadcast(): void {
  counters.cc1BroadcastCount++;
}

export function incrementCC1BroadcastDrop(): void {
  counters.cc1BroadcastDropCount++;
}

export function setCC1SubscriberCount(count: number): void {
  counters.cc1SubscriberCount = count;
}

export function incrementServerObserverFire(direction: 'a' | 'b'): void {
  if (direction === 'a') counters.serverObserverFiresA++;
  else counters.serverObserverFiresB++;
}

export function incrementPersistenceDiskWrite(): void {
  counters.persistenceDiskWrites++;
}

export function incrementServerObserverError(direction: 'a' | 'b'): void {
  if (direction === 'a') counters.serverObserverErrorsA++;
  else counters.serverObserverErrorsB++;
}

export function incrementBridgeMergeContentLoss(): void {
  counters.bridgeMergeContentLoss++;
}

export function incrementAgentWriteCalls(): void {
  counters.agentWriteCalls++;
}

export function incrementSummariesProvided(): void {
  counters.summariesProvided++;
}

export function incrementSummariesTruncated(): void {
  counters.summariesTruncated++;
}

export function incrementBridgeMergeCheckpointCreated(): void {
  counters.bridgeMergeCheckpointCreated++;
}

export function incrementBridgeInvariantViolations(): void {
  counters.bridgeInvariantViolations++;
}

export function incrementBridgeInvariantViolationsSuppressed(): void {
  counters.bridgeInvariantViolationsSuppressed++;
}

export function incrementPersistenceSkipNonQuiescent(): void {
  counters.persistenceSkipNonQuiescent++;
}

export function incrementPersistenceForceFlushDuringBurst(): void {
  counters.persistenceForceFlushDuringBurst++;
}

export function incrementAgentPatchFindMismatches(): void {
  counters.agentPatchFindMismatches++;
}

export function incrementBridgeToleranceApplied(toleranceClass: BridgeToleranceClass): void {
  counters.bridgeToleranceApplied[toleranceClass] =
    (counters.bridgeToleranceApplied[toleranceClass] ?? 0) + 1;
}

export function incrementObserverAPathBFires(): void {
  counters.observerAPathBFires++;
}

export function incrementObserverAPathBFiresSuppressed(): void {
  counters.observerAPathBFiresSuppressed++;
}

export function incrementMapDrivenSpliceApplied(): void {
  counters.mapDrivenSpliceApplied++;
}

export function incrementMapDrivenSpliceFallback(reason: MapDrivenSpliceFallbackReason): void {
  counters.mapDrivenSpliceFallback[reason] = (counters.mapDrivenSpliceFallback[reason] ?? 0) + 1;
}

export function incrementObserverAResidualMergeRuns(): void {
  counters.observerAResidualMergeRuns++;
}

export function incrementBridgeSplitBrainRederives(): void {
  counters.bridgeSplitBrainRederives++;
}

export function incrementBridgeSplitBrainRederivesSuppressed(): void {
  counters.bridgeSplitBrainRederivesSuppressed++;
}

export function incrementPersistenceReconciliationFailures(): void {
  counters.persistenceReconciliationFailures++;
}

export function incrementExternalChangeHandlerErrors(): void {
  counters.externalChangeHandlerErrors++;
}

export function incrementReconcileOwnFlushSkips(): void {
  counters.reconcileOwnFlushSkips++;
}

export function incrementReconcileInFlightFallthroughs(): void {
  counters.reconcileInFlightFallthroughs++;
}

export function incrementPersistenceSanityCheckSerializeFailures(): void {
  counters.persistenceSanityCheckSerializeFailures++;
}

export function incrementDeferredStoreFailures(): void {
  counters.deferredStoreFailures++;
}

export function incrementAuthRenameRedirect(): void {
  counters.authRenameRedirectCount++;
}

export function incrementAuthDocDeleted(): void {
  counters.authDocDeletedCount++;
}

export function incrementRecentlyRemovedDocsEviction(): void {
  counters.recentlyRemovedDocsEvictions++;
}

export function setRecentlyRemovedDocsSize(size: number): void {
  counters.recentlyRemovedDocsSize = size;
}

export function incrementAuthRemovalGuardError(): void {
  counters.authRemovalGuardErrors++;
}

export function incrementRemovalRedirectChainCycle(): void {
  counters.removalRedirectChainCycles++;
}

export function incrementAuthDocLineageMismatch(): void {
  counters.authDocLineageMismatchCount++;
}

export function incrementAuthDocLineageGuardError(): void {
  counters.authDocLineageGuardErrors++;
}

export function incrementCollabSocketFilteredError(code: 'EPIPE' | 'ECONNRESET'): void {
  if (code === 'EPIPE') counters.collabSocketEpipeCount++;
  else counters.collabSocketEconnresetCount++;
}

export function incrementCollabMessageTooLarge(): void {
  counters.collabMessageTooLargeCount++;
}

export function incrementShadowMigrationLegacyRefsDeleted(count: number): void {
  counters.shadowMigrationLegacyRefsDeleted += count;
}

export function incrementEffectDiffCaptureFailures(): void {
  counters.effectDiffCaptureFailures++;
}

export function incrementAgentPresenceMutationError(): void {
  counters.agentPresenceMutationErrors++;
}

export function handleCollabSocketError(err: NodeJS.ErrnoException): boolean {
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
    incrementCollabSocketFilteredError(err.code);
    return true;
  }
  return false;
}

export function setCC1LastSeq(channel: CC1Channel, seq: number): void {
  counters.cc1LastSeq[channel] = seq;
}

export function getMetrics(): ReconciliationMetrics {
  return {
    ...counters,
    cc1LastSeq: { ...counters.cc1LastSeq },
    bridgeToleranceApplied: { ...counters.bridgeToleranceApplied },
    mapDrivenSpliceFallback: { ...counters.mapDrivenSpliceFallback },
  };
}

export function resetMetrics(): void {
  counters.reconcileCount = 0;
  counters.conflictCount = 0;
  counters.batchCount = 0;
  counters.upstreamImportCount = 0;
  counters.rescueBufferCount = 0;
  counters.branchSwitchCount = 0;
  counters.parkCount = 0;
  counters.gitAutoSaveFailureCount = 0;
  counters.gitWriterCommitFailureCount = 0;
  counters.cc1BroadcastCount = 0;
  counters.cc1BroadcastDropCount = 0;
  counters.cc1SubscriberCount = 0;
  counters.cc1LastSeq = {};
  counters.serverObserverFiresA = 0;
  counters.serverObserverFiresB = 0;
  counters.serverObserverErrorsA = 0;
  counters.serverObserverErrorsB = 0;
  counters.persistenceDiskWrites = 0;
  counters.bridgeMergeContentLoss = 0;
  counters.bridgeMergeCheckpointCreated = 0;
  counters.bridgeInvariantViolations = 0;
  counters.bridgeInvariantViolationsSuppressed = 0;
  counters.persistenceSkipNonQuiescent = 0;
  counters.persistenceForceFlushDuringBurst = 0;
  counters.collabSocketEpipeCount = 0;
  counters.collabSocketEconnresetCount = 0;
  counters.collabMessageTooLargeCount = 0;
  counters.shadowMigrationLegacyRefsDeleted = 0;
  counters.effectDiffCaptureFailures = 0;
  counters.agentPresenceMutationErrors = 0;
  counters.agentWriteCalls = 0;
  counters.summariesProvided = 0;
  counters.summariesTruncated = 0;
  counters.agentPatchFindMismatches = 0;
  counters.bridgeToleranceApplied = {};
  counters.observerAPathBFires = 0;
  counters.observerAPathBFiresSuppressed = 0;
  counters.mapDrivenSpliceApplied = 0;
  counters.mapDrivenSpliceFallback = {};
  counters.observerAResidualMergeRuns = 0;
  counters.bridgeSplitBrainRederives = 0;
  counters.bridgeSplitBrainRederivesSuppressed = 0;
  counters.persistenceReconciliationFailures = 0;
  counters.externalChangeHandlerErrors = 0;
  counters.reconcileOwnFlushSkips = 0;
  counters.reconcileInFlightFallthroughs = 0;
  counters.persistenceSanityCheckSerializeFailures = 0;
  counters.deferredStoreFailures = 0;
  counters.authRenameRedirectCount = 0;
  counters.authDocDeletedCount = 0;
  counters.recentlyRemovedDocsEvictions = 0;
  counters.recentlyRemovedDocsSize = 0;
  counters.authRemovalGuardErrors = 0;
  counters.removalRedirectChainCycles = 0;
  counters.authDocLineageMismatchCount = 0;
  counters.authDocLineageGuardErrors = 0;
}
