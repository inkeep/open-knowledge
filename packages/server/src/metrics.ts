import type { BridgeToleranceSignal, CC1Channel } from '@inkeep/open-knowledge-core';

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
  persistenceStoreRemovedDocCount: number;
  rescueBufferCount: number;
  branchSwitchCount: number;
  parkCount: number;
  gitAutoSaveFailureCount: number;
  gitWriterCommitFailureCount: number;
  cc1BroadcastCount: number;
  cc1BroadcastDropCount: number;
  cc1SubscriberCount: number;
  cc1LastSeq: Partial<Record<CC1Channel, number>>;
  serverObserverFiresA: number;
  serverObserverFiresB: number;
  serverObserverErrorsA: number;
  serverObserverErrorsB: number;
  persistenceDiskWrites: number;
  bridgeMergeContentLoss: number;
  bridgeMergeContentGrowth: number;
  bridgeMergeCheckpointCreated: number;
  producerGuardFires: number;
  producerGuardFiresSuppressed: number;
  producerGuardCheckpointCreated: number;
  bridgeInvariantViolations: number;
  bridgeInvariantViolationsSuppressed: number;
  persistenceSkipNonQuiescent: number;
  persistenceForceFlushDuringBurst: number;
  persistenceStalenessDetected: number;
  persistenceStalenessForcedStores: number;
  persistenceStalenessStoodDown: number;
  persistenceStalenessForceStoreTimeouts: number;
  collabSocketEpipeCount: number;
  collabSocketEconnresetCount: number;
  collabMessageTooLargeCount: number;
  shadowMigrationLegacyRefsDeleted: number;
  effectDiffCaptureFailures: number;
  agentPresenceMutationErrors: number;
  agentWriteCalls: number;
  agentSessionEvictions: number;
  summariesProvided: number;
  summariesTruncated: number;
  agentPatchFindMismatches: number;
  bridgeToleranceApplied: Partial<Record<BridgeToleranceSignal, number>>;
  observerAPathBFires: number;
  observerAPathBFiresSuppressed: number;
  mapDrivenSpliceApplied: number;
  mapDrivenSpliceFallback: Partial<Record<MapDrivenSpliceFallbackReason, number>>;
  observerAResidualMergeRuns: number;
  /** Count of Observer A duplication-gate recoveries — a substantive body
   *  line materialized more times in the fragment than clean Y.Text justified,
   *  provenance-confirmed as a server-vs-client CRDT double-materialization
   *  (one copy minted by Observer B under the server's own clientID, another
   *  by a foreign client), and re-derived from Y.Text before it could persist
   *  (precedent #38, Y.Text-is-truth). Counter only, incremented once per
   *  confirmed recovery; the rate-limited `bridge-split-brain-rederive`
   *  console event under site `duplication-guard` carries the per-doc signal. */
  observerADuplicationRederives: number;
  observerADuplicationCheckpointCreated: number;
  observerAApplyLoss: number;
  observerAApplyLossCheckpointCreated: number;
  deriveTimingDeferForceResolved: number;
  persistenceDeferHold: number;
  persistenceReconcileLoss: number;
  persistenceReconcileLossCheckpointCreated: number;
  persistenceReconcileLossDeduped: number;
  persistenceDuplicationReset: number;
  persistenceDuplicationResetCheckpointCreated: number;
  persistenceDuplicationResetDeduped: number;
  persistenceDuplicationSpared: number;
  persistenceDivergenceRealign: number;
  persistenceDivergenceRealignCheckpointCreated: number;
  persistenceDivergenceRealignDeduped: number;
  managedArtifactReconcile: number;
  managedArtifactReconcileCheckpointCreated: number;
  managedArtifactReconcileDeduped: number;
  reDeriveBackstopTripped: number;
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
  bridgeSplitBrainRederivesSuppressed: number;
  persistenceReconciliationFailures: number;
  externalChangeHandlerErrors: number;
  reconcileOwnFlushSkips: number;
  reconcileInFlightFallthroughs: number;
  inFlightFlushExpired: number;
  persistenceSanityCheckSerializeFailures: number;
  deferredStoreFailures: number;
  authRenameRedirectCount: number;
  authDocDeletedCount: number;
  recentlyRemovedDocsEvictions: number;
  recentlyRemovedDocsSize: number;
  authRemovalGuardErrors: number;
  removalRedirectChainCycles: number;
  authDocLineageMismatchCount: number;
  authDocLineageGuardErrors: number;
}

const counters: ReconciliationMetrics = {
  reconcileCount: 0,
  conflictCount: 0,
  batchCount: 0,
  upstreamImportCount: 0,
  persistenceStoreRemovedDocCount: 0,
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
  bridgeMergeContentGrowth: 0,
  bridgeMergeCheckpointCreated: 0,
  producerGuardFires: 0,
  producerGuardFiresSuppressed: 0,
  producerGuardCheckpointCreated: 0,
  bridgeInvariantViolations: 0,
  bridgeInvariantViolationsSuppressed: 0,
  persistenceSkipNonQuiescent: 0,
  persistenceForceFlushDuringBurst: 0,
  persistenceStalenessDetected: 0,
  persistenceStalenessForcedStores: 0,
  persistenceStalenessStoodDown: 0,
  persistenceStalenessForceStoreTimeouts: 0,
  collabSocketEpipeCount: 0,
  collabSocketEconnresetCount: 0,
  collabMessageTooLargeCount: 0,
  shadowMigrationLegacyRefsDeleted: 0,
  effectDiffCaptureFailures: 0,
  agentPresenceMutationErrors: 0,
  agentWriteCalls: 0,
  agentSessionEvictions: 0,
  summariesProvided: 0,
  summariesTruncated: 0,
  agentPatchFindMismatches: 0,
  bridgeToleranceApplied: {},
  observerAPathBFires: 0,
  observerAPathBFiresSuppressed: 0,
  mapDrivenSpliceApplied: 0,
  mapDrivenSpliceFallback: {},
  observerAResidualMergeRuns: 0,
  observerADuplicationRederives: 0,
  observerADuplicationCheckpointCreated: 0,
  observerAApplyLoss: 0,
  observerAApplyLossCheckpointCreated: 0,
  deriveTimingDeferForceResolved: 0,
  persistenceDeferHold: 0,
  persistenceReconcileLoss: 0,
  persistenceReconcileLossCheckpointCreated: 0,
  persistenceReconcileLossDeduped: 0,
  persistenceDuplicationReset: 0,
  persistenceDuplicationResetCheckpointCreated: 0,
  persistenceDuplicationResetDeduped: 0,
  persistenceDuplicationSpared: 0,
  persistenceDivergenceRealign: 0,
  persistenceDivergenceRealignCheckpointCreated: 0,
  persistenceDivergenceRealignDeduped: 0,
  managedArtifactReconcile: 0,
  managedArtifactReconcileCheckpointCreated: 0,
  managedArtifactReconcileDeduped: 0,
  reDeriveBackstopTripped: 0,
  bridgeSplitBrainRederives: 0,
  bridgeSplitBrainRederivesSuppressed: 0,
  persistenceReconciliationFailures: 0,
  externalChangeHandlerErrors: 0,
  reconcileOwnFlushSkips: 0,
  reconcileInFlightFallthroughs: 0,
  inFlightFlushExpired: 0,
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

export function incrementPersistenceStoreRemovedDoc(): void {
  counters.persistenceStoreRemovedDocCount++;
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

export function incrementBridgeMergeContentGrowth(): void {
  counters.bridgeMergeContentGrowth++;
}

export function incrementAgentWriteCalls(): void {
  counters.agentWriteCalls++;
}

export function incrementAgentSessionEvictions(): void {
  counters.agentSessionEvictions++;
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

export function incrementProducerGuardCheckpointCreated(): void {
  counters.producerGuardCheckpointCreated++;
}

export function incrementProducerGuardFires(): void {
  counters.producerGuardFires++;
}

export function incrementProducerGuardFiresSuppressed(): void {
  counters.producerGuardFiresSuppressed++;
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

export function incrementPersistenceStalenessDetected(): void {
  counters.persistenceStalenessDetected++;
}

export function incrementPersistenceStalenessForcedStores(): void {
  counters.persistenceStalenessForcedStores++;
}

export function incrementPersistenceStalenessStoodDown(): void {
  counters.persistenceStalenessStoodDown++;
}

export function incrementAgentPatchFindMismatches(): void {
  counters.agentPatchFindMismatches++;
}

export function incrementBridgeToleranceApplied(toleranceClass: BridgeToleranceSignal): void {
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

export function incrementObserverADuplicationRederives(): void {
  counters.observerADuplicationRederives++;
}

export function incrementObserverADuplicationCheckpointCreated(): void {
  counters.observerADuplicationCheckpointCreated++;
}

export function incrementObserverAApplyLoss(): void {
  counters.observerAApplyLoss++;
}

export function incrementObserverAApplyLossCheckpointCreated(): void {
  counters.observerAApplyLossCheckpointCreated++;
}

export function incrementDeriveTimingDeferForceResolved(): void {
  counters.deriveTimingDeferForceResolved++;
}

export function incrementPersistenceDeferHold(): void {
  counters.persistenceDeferHold++;
}

export function incrementPersistenceReconcileLoss(): void {
  counters.persistenceReconcileLoss++;
}

export function incrementPersistenceReconcileLossCheckpointCreated(): void {
  counters.persistenceReconcileLossCheckpointCreated++;
}

export function incrementPersistenceReconcileLossDeduped(): void {
  counters.persistenceReconcileLossDeduped++;
}

export function incrementPersistenceDuplicationReset(): void {
  counters.persistenceDuplicationReset++;
}

export function incrementPersistenceDuplicationResetCheckpointCreated(): void {
  counters.persistenceDuplicationResetCheckpointCreated++;
}

export function incrementPersistenceDuplicationResetDeduped(): void {
  counters.persistenceDuplicationResetDeduped++;
}

export function incrementPersistenceDuplicationSpared(): void {
  counters.persistenceDuplicationSpared++;
}

export function incrementPersistenceDivergenceRealign(): void {
  counters.persistenceDivergenceRealign++;
}

export function incrementPersistenceDivergenceRealignCheckpointCreated(): void {
  counters.persistenceDivergenceRealignCheckpointCreated++;
}

export function incrementPersistenceDivergenceRealignDeduped(): void {
  counters.persistenceDivergenceRealignDeduped++;
}

export function incrementManagedArtifactReconcile(): void {
  counters.managedArtifactReconcile++;
}

export function incrementManagedArtifactReconcileCheckpointCreated(): void {
  counters.managedArtifactReconcileCheckpointCreated++;
}

export function incrementManagedArtifactReconcileDeduped(): void {
  counters.managedArtifactReconcileDeduped++;
}

export function incrementReDeriveBackstopTripped(): void {
  counters.reDeriveBackstopTripped++;
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

export function incrementInFlightFlushExpired(count: number): void {
  counters.inFlightFlushExpired += count;
}

export function incrementPersistenceStalenessForceStoreTimeouts(): void {
  counters.persistenceStalenessForceStoreTimeouts++;
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

/**
 * Classify a collab-socket error. Returns `true` if the error is a
 * known-safe kernel TCP-teardown signal (EPIPE or ECONNRESET) that should
 * be filtered out of logs per precedent #22. As a side effect, increments
 * the corresponding per-code metric counter so operators can see the rate
 * during incident triage.
 *
 * Returns `false` for any other error code — the caller surfaces those
 * via their normal logging path.
 *
 * Contract: callers MUST use this helper rather than re-implementing the
 * `code === 'EPIPE' || code === 'ECONNRESET'` check inline. Centralizing
 * the filter surface prevents future skew (e.g., if ETIMEDOUT or ECONNABORTED
 * become known-safe, the decision flips in one place).
 *
 * Usage shape:
 *
 *   socket.on('error', (err: NodeJS.ErrnoException) => {
 *     if (handleCollabSocketError(err)) return;
 *     log.error({ err }, 'Upgrade socket error');
 *   });
 *
 *   ws.on('error', (err: NodeJS.ErrnoException) => {
 *     if (!handleCollabSocketError(err)) {
 *       log.error({ err }, 'WebSocket error');
 *     }
 *     ws.terminate();
 *   });
 */
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
  counters.persistenceStoreRemovedDocCount = 0;
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
  counters.bridgeMergeContentGrowth = 0;
  counters.bridgeMergeCheckpointCreated = 0;
  counters.producerGuardFires = 0;
  counters.producerGuardFiresSuppressed = 0;
  counters.producerGuardCheckpointCreated = 0;
  counters.bridgeInvariantViolations = 0;
  counters.bridgeInvariantViolationsSuppressed = 0;
  counters.persistenceSkipNonQuiescent = 0;
  counters.persistenceForceFlushDuringBurst = 0;
  counters.persistenceStalenessDetected = 0;
  counters.persistenceStalenessForcedStores = 0;
  counters.persistenceStalenessStoodDown = 0;
  counters.persistenceStalenessForceStoreTimeouts = 0;
  counters.collabSocketEpipeCount = 0;
  counters.collabSocketEconnresetCount = 0;
  counters.collabMessageTooLargeCount = 0;
  counters.shadowMigrationLegacyRefsDeleted = 0;
  counters.effectDiffCaptureFailures = 0;
  counters.agentPresenceMutationErrors = 0;
  counters.agentWriteCalls = 0;
  counters.agentSessionEvictions = 0;
  counters.summariesProvided = 0;
  counters.summariesTruncated = 0;
  counters.agentPatchFindMismatches = 0;
  counters.bridgeToleranceApplied = {};
  counters.observerAPathBFires = 0;
  counters.observerAPathBFiresSuppressed = 0;
  counters.mapDrivenSpliceApplied = 0;
  counters.mapDrivenSpliceFallback = {};
  counters.observerAResidualMergeRuns = 0;
  counters.observerADuplicationRederives = 0;
  counters.observerADuplicationCheckpointCreated = 0;
  counters.observerAApplyLoss = 0;
  counters.observerAApplyLossCheckpointCreated = 0;
  counters.deriveTimingDeferForceResolved = 0;
  counters.persistenceDeferHold = 0;
  counters.persistenceReconcileLoss = 0;
  counters.persistenceReconcileLossCheckpointCreated = 0;
  counters.persistenceReconcileLossDeduped = 0;
  counters.persistenceDuplicationReset = 0;
  counters.persistenceDuplicationResetCheckpointCreated = 0;
  counters.persistenceDuplicationResetDeduped = 0;
  counters.persistenceDuplicationSpared = 0;
  counters.persistenceDivergenceRealign = 0;
  counters.persistenceDivergenceRealignCheckpointCreated = 0;
  counters.persistenceDivergenceRealignDeduped = 0;
  counters.managedArtifactReconcile = 0;
  counters.managedArtifactReconcileCheckpointCreated = 0;
  counters.managedArtifactReconcileDeduped = 0;
  counters.reDeriveBackstopTripped = 0;
  counters.bridgeSplitBrainRederives = 0;
  counters.bridgeSplitBrainRederivesSuppressed = 0;
  counters.persistenceReconciliationFailures = 0;
  counters.externalChangeHandlerErrors = 0;
  counters.reconcileOwnFlushSkips = 0;
  counters.reconcileInFlightFallthroughs = 0;
  counters.inFlightFlushExpired = 0;
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
