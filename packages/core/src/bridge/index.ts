export { applyFastDiff, applyIncrementalDiff } from './apply-diff.ts';
export {
  bindFrontmatterDoc,
  FORM_WRITE_ORIGIN,
  type FrontmatterBinding,
  type FrontmatterBindingPatchResult,
  type FrontmatterBindingPatchSuccess,
  type FrontmatterBindingPathResult,
  type FrontmatterBindingPathSuccess,
  type FrontmatterBindingRenameResult,
  type FrontmatterBindingRenameSuccess,
  type FrontmatterBindingReorderResult,
  type FrontmatterBindingReorderSuccess,
  type FrontmatterDocProvider,
  type FrontmatterSnapshot,
  type Unsubscribe as FrontmatterBindingUnsubscribe,
} from './bind-frontmatter-doc.ts';
export {
  type BridgeInvariantLogPayload,
  type BridgeInvariantSite,
  type BridgeInvariantViolation,
  BridgeInvariantViolationError,
  type InvariantViolation,
  toBridgeInvariantLog,
} from './bridge-invariant.ts';
export {
  type BridgeComposition,
  type ComposeAdjustment,
  composeWithDerivedBody,
  composeWithDerivedFrontmatter,
} from './compose.ts';
export { type DiffChange, diffLinesFast } from './diff-lines.ts';
export {
  BRIDGE_LINE_KINDS,
  type BridgeDivergenceLocation,
  type BridgeLineKind,
  classifyBridgeLine,
  locateBridgeDivergence,
} from './divergence-locate.ts';
export {
  bodyEdgeEmpties,
  createMergeBoundarySpace,
  docEdgeRunsDiffer,
  type FmBoundarySlotSplit,
  type MergeBoundarySpace,
  splitFmBoundarySlot,
} from './doc-boundary-space.ts';
export {
  applyPatchToFm,
  applyPathDeleteToFm,
  applyPathRenameToFm,
  applyPathReorderSeqToFm,
  applyPathReorderToFm,
  applyPathSetToFm,
  applyRenameToFm,
  applyReorderToFm,
  detectFmRegion,
  type FmEditError,
  type FmEditResult,
  MAX_FM_REGION_BYTES,
  type ParsedFmRegion,
  parseFencedFmRegion,
  parseFmRegion,
  readFmKeys,
  readFmMap,
  readFmRegionWithError,
} from './frontmatter-region.ts';
export { DUPLICATION_GATE_MIN_LINE_LENGTH, overMultipliedBodyLines } from './growth-detect.ts';
export { fnv1aDigest } from './hash-util.ts';
export {
  fragmentHoldsPendingContent,
  pendingContentLines,
} from './intraline-predicate.ts';
export {
  assertContentPreservation,
  BridgeMergeContentLossError,
  type BridgeMergeContentLossInfo,
  type BridgeMergeContentLossLogPayload,
  type BridgeMergeContentLossSide,
  type BridgeMergeContentLossWhich,
  findDroppedContent,
  mergeThreeWay,
  tryLineLevelCombine,
} from './merge-three-way.ts';
export {
  addsBlankLines,
  BRIDGE_TOLERANCE_CLASSES,
  type BridgeToleranceClass,
  detectAppliedToleranceClasses,
  normalizeBridge,
} from './normalize.ts';
export {
  type BridgeToleranceSignal,
  isParseEquivalentBridge,
  PARSE_EQUIVALENCE_TOLERANCE,
} from './parse-equivalence.ts';
export {
  type ComparePmStructuralOptions,
  comparePmStructural,
  compareRoundTripStructural,
  type PmStructuralNode,
  type StructuralDegradeLabel,
  type StructuralDivergenceReason,
  type StructuralEquivalenceResult,
  structuralDivergence,
} from './pm-structural-equivalence.ts';
export { defaultScheduler, type Scheduler } from './scheduler.ts';
export {
  createStructuralFreshnessChecker,
  type StructuralFreshnessChecker,
  type StructuralFreshnessCheckerOptions,
} from './structural-freshness.ts';
export {
  classifySeverity,
  emitToleranceFire,
  findFirstDivergenceIndex,
  setToleranceTelemetryHook,
  type ToleranceClassSeverity,
  type ToleranceFireRecord,
  type ToleranceTelemetryHook,
} from './tolerance-telemetry.ts';
