import type { BridgeToleranceSignal, CC1Channel } from '@inkeep/open-knowledge-core';

export type MapDrivenSpliceFallbackReason =
  | 'text-mismatch'
  | 'synthetic-doc'
  | 'parse-error'
  | 'missing-position';

export type ResidualMergeSpliceUnavailableReason =
  | MapDrivenSpliceFallbackReason
  | 'composition-adjusted'
  | 'doc-edge-runs'
  | 'not-settled';

export type MapDrivenSpliceMemoSkipReason =
  | 'narrowed'
  | 'empty-children'
  | 'entry-already-current'
  | 'position-not-numeric'
  | 'compose-failed';

export type StoreDiskCompareOutcome =
  | 'match'
  | 'changed'
  | 'drift'
  | 'absent'
  | 'stale-refused'
  | StorePendingReason;

export type StorePendingReason =
  | 'pending-unreadable'
  | 'pending-exhausted'
  | 'pending-base-moved'
  | 'pending-no-intake'
  | 'pending-intake-failed'
  | 'pending-intake-failed-no-base'
  | 'pending-conflict';

export type ReceiptIntakeSkip = 'echo' | 'superseded';

export type ReceiptAtLoad = 'unchanged' | 'changed' | 'missing';

export type EnginelessStoreOutcome =
  | 'match'
  | 'kept-live'
  | 'held-no-history-or-backup'
  | 'held-unreadable'
  | 'held-exhausted'
  | 'held-not-utf8'
  | 'absent';

export type EnginelessIntakeOutcome =
  | 'applied'
  | 'kept-live'
  | 'unchanged'
  | 'held-no-history-or-backup'
  | 'held-not-utf8';

export type ManagedArtifactMergeOutcome =
  | 'applied'
  | 'unchanged'
  | 'merged'
  | 'both-kept'
  | 'kept-live'
  | 'stash-fallback'
  | 'held';

type ManagedArtifactMergeKey = `${'store' | 'intake'}:${ManagedArtifactMergeOutcome}`;

export type ConfigOutsideChangeOutcome =
  | 'applied'
  | 'applied-displaced'
  | 'rejected'
  | 'invalid-kept-live'
  | 'held-no-history-or-backup'
  | 'held-not-utf8'
  | 'held-exhausted'
  | 'deferred';

type ConfigOutsideChangeKey = `${'store' | 'intake'}:${ConfigOutsideChangeOutcome}`;

export interface ReconciliationMetrics {
  reconcileCount: number;
  conflictCount: number;
  reconcileInsertDedupSkipped: number;
  reconcileCheckFailed: number;
  reconcileConstructCheckSkipped: number;
  reconcileBothKept: number;
  reconcileBothKeptBlocks: number;
  reconcileKeptLive: number;
  mergeHistoryCheckpointCreated: number;
  mergeHistoryCheckpointFailures: number;
  mergeHistoryUnavailable: number;
  staleExternalWriteRefused: number;
  concurrentOverwriteRefused: number;
  batchCount: number;
  upstreamImportCount: number;
  persistenceStoreRemovedDocCount: number;
  persistenceStoreSupersededCount: number;
  rescueBufferCount: number;
  rescueCheckpointWriteFailures: number;
  rescueBufferWriteFailures: number;
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
  shadowExcludeIndexEntriesDropped: number;
  shadowExcludeIndexSweepFailures: number;
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
  mapDrivenSpliceMemoHits: number;
  mapDrivenSpliceMemoSkips: Partial<Record<MapDrivenSpliceMemoSkipReason, number>>;
  observerAResidualMergeRuns: number;
  observerAResidualMergeSpliceLanded: number;
  observerAResidualMergeSpliceBlockedLossy: number;
  observerAResidualMergeSpliceUnavailable: Partial<
    Record<ResidualMergeSpliceUnavailableReason, number>
  >;
  /**
   * Count of Observer A duplication-gate recoveries: a substantive body line materialized more times
   * in the fragment than clean Y.Text justified, provenance-confirmed as a server-versus-client
   * double-materialization and re-derived from Y.Text before it could persist (precedent #38).
   */
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
  persistenceDuplicationBaselineMissing: number;
  persistenceDuplicationBaselineRefusals: number;
  storeDiskCompare: Partial<Record<StoreDiskCompareOutcome, number>>;
  storeDiskCompareReadRetries: number;
  storeRestatRefused: number;
  receiptIntakeSkip: Partial<Record<ReceiptIntakeSkip, number>>;
  receiptAtLoad: Partial<Record<ReceiptAtLoad, number>>;
  receiptPersistFailures: number;
  receiptRecordsUnreadable: number;
  receiptRecordsOtherVersion: number;
  receiptLogRefused: number;
  managedArtifactReconcile: number;
  managedArtifactReconcileCheckpointCreated: number;
  managedArtifactReconcileDeduped: number;
  managedArtifactMerge: Partial<Record<ManagedArtifactMergeKey, number>>;
  enginelessStore: Partial<Record<EnginelessStoreOutcome, number>>;
  enginelessIntake: Partial<Record<EnginelessIntakeOutcome, number>>;
  configOutsideChange: Partial<Record<ConfigOutsideChangeKey, number>>;
  noEngineHistoryCheckpointCreated: number;
  noEngineHistoryCheckpointFailures: number;
  heldSaves: number;
  heldSaveRetries: number;
  heldSaveRetryFailures: number;
  displacedVersionBackups: number;
  displacedVersionBackupFailures: number;
  reDeriveBackstopTripped: number;
  /**
   * Count of Observer A settlement checks that detected a drain settling split-brain beyond
   * `normalizeBridge` tolerance (precedent #38) and enqueued a same-drain Observer B re-derive.
   * No organic input produces that divergence at HEAD, so a firing is itself the drift alert.
   */
  bridgeSplitBrainRederives: number;
  bridgeSplitBrainRederivesSuppressed: number;
  persistenceReconciliationFailures: number;
  externalChangeHandlerErrors: number;
  reconcileOwnFlushSkips: number;
  reconcileInFlightFallthroughs: number;
  diskAuthoritativeIngestCount: number;
  diskAuthoritativeIngestApplyFailures: number;
  diskAuthoritativeIngestUnrescuedCount: number;
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
  freshnessPasses: number;
  freshnessPassesIncomplete: number;
  freshnessFinds: number;
  freshnessFilesHashed: number;
  freshnessCarryOver: number;
  watcherErrors: number;
  watcherResubscribes: number;
  watcherRootMissing: number;
  watcherUnreadableEntries: number;
  inPlaceSkillRescanFailures: number;
  watcherResubscribesAbandoned: number;
  vanishPending: number;
  vanishPairedIdentity: number;
  vanishPairedHash: number;
  vanishRecreated: number;
  vanishDeleted: number;
  vanishShutdown: number;
  vanishUnconfirmed: number;
  outsideRenameRecordFailures: number;
  outsideRenameClaimFailures: number;
  branchSwitchRecheckShortfalls: number;
}

const counters: ReconciliationMetrics = {
  reconcileCount: 0,
  conflictCount: 0,
  reconcileInsertDedupSkipped: 0,
  reconcileCheckFailed: 0,
  reconcileConstructCheckSkipped: 0,
  reconcileBothKept: 0,
  reconcileBothKeptBlocks: 0,
  reconcileKeptLive: 0,
  mergeHistoryCheckpointCreated: 0,
  mergeHistoryCheckpointFailures: 0,
  mergeHistoryUnavailable: 0,
  staleExternalWriteRefused: 0,
  concurrentOverwriteRefused: 0,
  batchCount: 0,
  upstreamImportCount: 0,
  persistenceStoreRemovedDocCount: 0,
  persistenceStoreSupersededCount: 0,
  rescueBufferCount: 0,
  rescueCheckpointWriteFailures: 0,
  rescueBufferWriteFailures: 0,
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
  shadowExcludeIndexEntriesDropped: 0,
  shadowExcludeIndexSweepFailures: 0,
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
  mapDrivenSpliceMemoHits: 0,
  mapDrivenSpliceMemoSkips: {},
  mapDrivenSpliceFallback: {},
  observerAResidualMergeRuns: 0,
  observerAResidualMergeSpliceLanded: 0,
  observerAResidualMergeSpliceBlockedLossy: 0,
  observerAResidualMergeSpliceUnavailable: {},
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
  persistenceDuplicationBaselineMissing: 0,
  persistenceDuplicationBaselineRefusals: 0,
  storeDiskCompare: {},
  storeDiskCompareReadRetries: 0,
  storeRestatRefused: 0,
  receiptIntakeSkip: {},
  receiptAtLoad: {},
  receiptPersistFailures: 0,
  receiptRecordsUnreadable: 0,
  receiptRecordsOtherVersion: 0,
  receiptLogRefused: 0,
  managedArtifactReconcile: 0,
  managedArtifactReconcileCheckpointCreated: 0,
  managedArtifactReconcileDeduped: 0,
  managedArtifactMerge: {},
  enginelessStore: {},
  enginelessIntake: {},
  configOutsideChange: {},
  noEngineHistoryCheckpointCreated: 0,
  noEngineHistoryCheckpointFailures: 0,
  heldSaves: 0,
  heldSaveRetries: 0,
  heldSaveRetryFailures: 0,
  displacedVersionBackups: 0,
  displacedVersionBackupFailures: 0,
  reDeriveBackstopTripped: 0,
  bridgeSplitBrainRederives: 0,
  bridgeSplitBrainRederivesSuppressed: 0,
  persistenceReconciliationFailures: 0,
  externalChangeHandlerErrors: 0,
  reconcileOwnFlushSkips: 0,
  reconcileInFlightFallthroughs: 0,
  diskAuthoritativeIngestCount: 0,
  diskAuthoritativeIngestApplyFailures: 0,
  diskAuthoritativeIngestUnrescuedCount: 0,
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
  freshnessPasses: 0,
  freshnessPassesIncomplete: 0,
  freshnessFinds: 0,
  freshnessFilesHashed: 0,
  freshnessCarryOver: 0,
  watcherErrors: 0,
  watcherResubscribes: 0,
  watcherRootMissing: 0,
  watcherUnreadableEntries: 0,
  inPlaceSkillRescanFailures: 0,
  watcherResubscribesAbandoned: 0,
  vanishPending: 0,
  vanishPairedIdentity: 0,
  vanishPairedHash: 0,
  vanishRecreated: 0,
  vanishDeleted: 0,
  vanishShutdown: 0,
  vanishUnconfirmed: 0,
  outsideRenameRecordFailures: 0,
  outsideRenameClaimFailures: 0,
  branchSwitchRecheckShortfalls: 0,
};

export function incrementReconcile(): void {
  counters.reconcileCount++;
}

export function incrementConflict(): void {
  counters.conflictCount++;
}

export function incrementReconcileInsertDedupSkipped(): void {
  counters.reconcileInsertDedupSkipped++;
}

export function incrementReconcileCheckFailed(): void {
  counters.reconcileCheckFailed++;
}

export function incrementReconcileConstructCheckSkipped(): void {
  counters.reconcileConstructCheckSkipped++;
}

export function incrementReconcileBothKept(keptBlocks: number): void {
  counters.reconcileBothKept++;
  counters.reconcileBothKeptBlocks += keptBlocks;
}

export function incrementReconcileKeptLive(): void {
  counters.reconcileKeptLive++;
}

export function incrementMergeHistoryCheckpointCreated(): void {
  counters.mergeHistoryCheckpointCreated++;
}

export function incrementMergeHistoryCheckpointFailures(): void {
  counters.mergeHistoryCheckpointFailures++;
}

export function incrementMergeHistoryUnavailable(): void {
  counters.mergeHistoryUnavailable++;
}

export function incrementStaleExternalWriteRefused(): void {
  counters.staleExternalWriteRefused++;
}

export function incrementConcurrentOverwriteRefused(): void {
  counters.concurrentOverwriteRefused++;
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

export function incrementPersistenceStoreSuperseded(): void {
  counters.persistenceStoreSupersededCount++;
}

export function incrementRescueBuffer(): void {
  counters.rescueBufferCount++;
}

export function incrementRescueCheckpointWriteFailures(): void {
  counters.rescueCheckpointWriteFailures++;
}

export function incrementRescueBufferWriteFailures(): void {
  counters.rescueBufferWriteFailures++;
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

export function incrementMapDrivenSpliceMemoHit(): void {
  counters.mapDrivenSpliceMemoHits++;
}

export function incrementMapDrivenSpliceMemoSkip(reason: MapDrivenSpliceMemoSkipReason): void {
  counters.mapDrivenSpliceMemoSkips[reason] = (counters.mapDrivenSpliceMemoSkips[reason] ?? 0) + 1;
}

export function incrementObserverAResidualMergeRuns(): void {
  counters.observerAResidualMergeRuns++;
}

export function incrementObserverAResidualMergeSpliceLanded(): void {
  counters.observerAResidualMergeSpliceLanded++;
}

export function incrementObserverAResidualMergeSpliceBlockedLossy(): void {
  counters.observerAResidualMergeSpliceBlockedLossy++;
}

export function incrementObserverAResidualMergeSpliceUnavailable(
  reason: ResidualMergeSpliceUnavailableReason,
): void {
  counters.observerAResidualMergeSpliceUnavailable[reason] =
    (counters.observerAResidualMergeSpliceUnavailable[reason] ?? 0) + 1;
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

export function incrementPersistenceDuplicationBaselineMissing(): void {
  counters.persistenceDuplicationBaselineMissing++;
}

export function incrementPersistenceDuplicationBaselineRefusals(): void {
  counters.persistenceDuplicationBaselineRefusals++;
}

export function incrementStoreDiskCompare(outcome: StoreDiskCompareOutcome): void {
  counters.storeDiskCompare[outcome] = (counters.storeDiskCompare[outcome] ?? 0) + 1;
}

export function incrementStoreDiskCompareReadRetries(): void {
  counters.storeDiskCompareReadRetries++;
}

export function incrementStoreRestatRefused(): void {
  counters.storeRestatRefused++;
}

export function incrementReceiptIntakeSkip(kind: ReceiptIntakeSkip): void {
  counters.receiptIntakeSkip[kind] = (counters.receiptIntakeSkip[kind] ?? 0) + 1;
}

export function incrementReceiptAtLoad(outcome: ReceiptAtLoad): void {
  counters.receiptAtLoad[outcome] = (counters.receiptAtLoad[outcome] ?? 0) + 1;
}

export function incrementReceiptPersistFailures(): void {
  counters.receiptPersistFailures++;
}

export function incrementReceiptRecordsUnreadable(count = 1): void {
  counters.receiptRecordsUnreadable += count;
}

export function incrementReceiptRecordsOtherVersion(count: number): void {
  counters.receiptRecordsOtherVersion += count;
}

export function incrementReceiptLogRefused(): void {
  counters.receiptLogRefused++;
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

export function incrementManagedArtifactMerge(
  site: 'store' | 'intake',
  outcome: ManagedArtifactMergeOutcome,
): void {
  const key: ManagedArtifactMergeKey = `${site}:${outcome}`;
  counters.managedArtifactMerge[key] = (counters.managedArtifactMerge[key] ?? 0) + 1;
}

export function incrementEnginelessStore(outcome: EnginelessStoreOutcome): void {
  counters.enginelessStore[outcome] = (counters.enginelessStore[outcome] ?? 0) + 1;
}

export function incrementEnginelessIntake(outcome: EnginelessIntakeOutcome): void {
  counters.enginelessIntake[outcome] = (counters.enginelessIntake[outcome] ?? 0) + 1;
}

export function incrementConfigOutsideChange(
  site: 'store' | 'intake',
  outcome: ConfigOutsideChangeOutcome,
): void {
  const key: ConfigOutsideChangeKey = `${site}:${outcome}`;
  counters.configOutsideChange[key] = (counters.configOutsideChange[key] ?? 0) + 1;
}

export function incrementHeldSave(): void {
  counters.heldSaves++;
}

export function incrementHeldSaveRetry(): void {
  counters.heldSaveRetries++;
}

export function incrementHeldSaveRetryFailures(): void {
  counters.heldSaveRetryFailures++;
}

export function incrementDisplacedVersionBackups(): void {
  counters.displacedVersionBackups++;
}

export function incrementDisplacedVersionBackupFailures(): void {
  counters.displacedVersionBackupFailures++;
}

export function incrementNoEngineHistoryCheckpointCreated(): void {
  counters.noEngineHistoryCheckpointCreated++;
}

export function incrementNoEngineHistoryCheckpointFailures(): void {
  counters.noEngineHistoryCheckpointFailures++;
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

export function incrementDiskAuthoritativeIngest(): void {
  counters.diskAuthoritativeIngestCount++;
}

export function incrementDiskAuthoritativeIngestApplyFailures(): void {
  counters.diskAuthoritativeIngestApplyFailures++;
}

export function incrementDiskAuthoritativeIngestUnrescued(): void {
  counters.diskAuthoritativeIngestUnrescuedCount++;
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

export function incrementFreshnessPasses(): void {
  counters.freshnessPasses++;
}

export function incrementFreshnessPassesIncomplete(): void {
  counters.freshnessPassesIncomplete++;
}

export function addFreshnessFinds(count: number): void {
  counters.freshnessFinds += count;
}

export function addFreshnessFilesHashed(count: number): void {
  counters.freshnessFilesHashed += count;
}

export function addFreshnessCarryOver(count: number): void {
  counters.freshnessCarryOver += count;
}

export function incrementWatcherErrors(): void {
  counters.watcherErrors++;
}

export function incrementWatcherResubscribes(): void {
  counters.watcherResubscribes++;
}

export function incrementWatcherRootMissing(): void {
  counters.watcherRootMissing++;
}

export function incrementWatcherUnreadableEntries(): void {
  counters.watcherUnreadableEntries++;
}

export function incrementInPlaceSkillRescanFailures(): void {
  counters.inPlaceSkillRescanFailures++;
}

export function incrementWatcherResubscribesAbandoned(): void {
  counters.watcherResubscribesAbandoned++;
}

export type VanishOutcome =
  | 'pending'
  | 'paired-identity'
  | 'paired-hash'
  | 'recreated'
  | 'deleted'
  | 'shutdown'
  | 'unconfirmed';

export function recordVanishOutcome(outcome: VanishOutcome): void {
  switch (outcome) {
    case 'pending':
      counters.vanishPending++;
      return;
    case 'paired-identity':
      counters.vanishPairedIdentity++;
      return;
    case 'paired-hash':
      counters.vanishPairedHash++;
      return;
    case 'recreated':
      counters.vanishRecreated++;
      return;
    case 'deleted':
      counters.vanishDeleted++;
      return;
    case 'shutdown':
      counters.vanishShutdown++;
      return;
    case 'unconfirmed':
      counters.vanishUnconfirmed++;
      return;
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled vanish outcome: ${String(unhandled)}`);
    }
  }
}

export function incrementOutsideRenameRecordFailures(): void {
  counters.outsideRenameRecordFailures++;
}

export function incrementOutsideRenameClaimFailures(): void {
  counters.outsideRenameClaimFailures++;
}

export function incrementBranchSwitchRecheckShortfalls(): void {
  counters.branchSwitchRecheckShortfalls++;
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

export function incrementShadowExcludeIndexEntriesDropped(count: number): void {
  counters.shadowExcludeIndexEntriesDropped += count;
}

export function incrementShadowExcludeIndexSweepFailures(): void {
  counters.shadowExcludeIndexSweepFailures++;
}

export function incrementEffectDiffCaptureFailures(): void {
  counters.effectDiffCaptureFailures++;
}

export function incrementAgentPresenceMutationError(): void {
  counters.agentPresenceMutationErrors++;
}

/**
 * Returns `true` if the error is a known-safe kernel TCP-teardown signal (EPIPE or ECONNRESET) that
 * should be filtered out of logs per precedent #23.
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
    storeDiskCompare: { ...counters.storeDiskCompare },
    receiptIntakeSkip: { ...counters.receiptIntakeSkip },
    receiptAtLoad: { ...counters.receiptAtLoad },
    managedArtifactMerge: { ...counters.managedArtifactMerge },
    enginelessStore: { ...counters.enginelessStore },
    enginelessIntake: { ...counters.enginelessIntake },
    configOutsideChange: { ...counters.configOutsideChange },
    mapDrivenSpliceFallback: { ...counters.mapDrivenSpliceFallback },
    mapDrivenSpliceMemoSkips: { ...counters.mapDrivenSpliceMemoSkips },
    observerAResidualMergeSpliceUnavailable: {
      ...counters.observerAResidualMergeSpliceUnavailable,
    },
  };
}

export function resetMetrics(): void {
  counters.reconcileCount = 0;
  counters.conflictCount = 0;
  counters.reconcileInsertDedupSkipped = 0;
  counters.reconcileCheckFailed = 0;
  counters.reconcileConstructCheckSkipped = 0;
  counters.reconcileBothKept = 0;
  counters.reconcileBothKeptBlocks = 0;
  counters.reconcileKeptLive = 0;
  counters.mergeHistoryCheckpointCreated = 0;
  counters.mergeHistoryCheckpointFailures = 0;
  counters.mergeHistoryUnavailable = 0;
  counters.staleExternalWriteRefused = 0;
  counters.concurrentOverwriteRefused = 0;
  counters.batchCount = 0;
  counters.upstreamImportCount = 0;
  counters.persistenceStoreRemovedDocCount = 0;
  counters.persistenceStoreSupersededCount = 0;
  counters.rescueBufferCount = 0;
  counters.rescueCheckpointWriteFailures = 0;
  counters.rescueBufferWriteFailures = 0;
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
  counters.shadowExcludeIndexEntriesDropped = 0;
  counters.shadowExcludeIndexSweepFailures = 0;
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
  counters.mapDrivenSpliceMemoHits = 0;
  counters.mapDrivenSpliceMemoSkips = {};
  counters.observerAResidualMergeRuns = 0;
  counters.observerAResidualMergeSpliceLanded = 0;
  counters.observerAResidualMergeSpliceBlockedLossy = 0;
  counters.observerAResidualMergeSpliceUnavailable = {};
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
  counters.persistenceDuplicationBaselineMissing = 0;
  counters.persistenceDuplicationBaselineRefusals = 0;
  counters.storeDiskCompare = {};
  counters.storeDiskCompareReadRetries = 0;
  counters.storeRestatRefused = 0;
  counters.receiptIntakeSkip = {};
  counters.receiptAtLoad = {};
  counters.receiptPersistFailures = 0;
  counters.receiptRecordsUnreadable = 0;
  counters.receiptRecordsOtherVersion = 0;
  counters.receiptLogRefused = 0;
  counters.managedArtifactReconcile = 0;
  counters.managedArtifactReconcileCheckpointCreated = 0;
  counters.managedArtifactReconcileDeduped = 0;
  counters.managedArtifactMerge = {};
  counters.enginelessStore = {};
  counters.enginelessIntake = {};
  counters.configOutsideChange = {};
  counters.noEngineHistoryCheckpointCreated = 0;
  counters.noEngineHistoryCheckpointFailures = 0;
  counters.heldSaves = 0;
  counters.heldSaveRetries = 0;
  counters.heldSaveRetryFailures = 0;
  counters.displacedVersionBackups = 0;
  counters.displacedVersionBackupFailures = 0;
  counters.reDeriveBackstopTripped = 0;
  counters.bridgeSplitBrainRederives = 0;
  counters.bridgeSplitBrainRederivesSuppressed = 0;
  counters.persistenceReconciliationFailures = 0;
  counters.externalChangeHandlerErrors = 0;
  counters.reconcileOwnFlushSkips = 0;
  counters.reconcileInFlightFallthroughs = 0;
  counters.diskAuthoritativeIngestCount = 0;
  counters.diskAuthoritativeIngestApplyFailures = 0;
  counters.diskAuthoritativeIngestUnrescuedCount = 0;
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
  counters.freshnessPasses = 0;
  counters.freshnessPassesIncomplete = 0;
  counters.freshnessFinds = 0;
  counters.freshnessFilesHashed = 0;
  counters.freshnessCarryOver = 0;
  counters.watcherErrors = 0;
  counters.watcherResubscribes = 0;
  counters.watcherRootMissing = 0;
  counters.watcherUnreadableEntries = 0;
  counters.inPlaceSkillRescanFailures = 0;
  counters.watcherResubscribesAbandoned = 0;
  counters.vanishPending = 0;
  counters.vanishPairedIdentity = 0;
  counters.vanishPairedHash = 0;
  counters.vanishRecreated = 0;
  counters.vanishDeleted = 0;
  counters.vanishShutdown = 0;
  counters.vanishUnconfirmed = 0;
  counters.outsideRenameRecordFailures = 0;
  counters.outsideRenameClaimFailures = 0;
  counters.branchSwitchRecheckShortfalls = 0;
}
