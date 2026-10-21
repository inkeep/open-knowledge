import { existsSync, readFileSync, realpathSync } from 'node:fs';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  BridgeInvariantViolationError,
  BridgeMergeContentLossError,
  type DiskEditReconciledWarning,
  normalizeBridge,
  type ParsedCheckpoint,
  prependFrontmatter,
  type ReconcileMergeOutcome,
  stripFrontmatter,
  toBridgeInvariantLog,
} from '@inkeep/open-knowledge-core';
import { formatReconcileSubject } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type * as Y from 'yjs';
import type { PrecomputedParse } from './bridge-intake.ts';
import {
  type BridgeDeriveLossReporter,
  DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE,
  type DeriveLossDetectOptions,
} from './bridge-loss-detector.ts';
import { shouldRunPairedIntakeDetection } from './bridge-loss-suppression.ts';
import {
  isConfigDoc,
  isEditableTextDoc,
  isExcalidrawDoc,
  isMermaidDoc,
  isPersistenceExcludedDoc,
  isSystemDoc,
} from './cc1-broadcast.ts';
import { type ConflictAuthority, isDocInConflict } from './conflict-authority.ts';
import { isRemovalLifecycleStatus, type ReconcileReason } from './conflict-kinds.ts';
import { safeContentPath } from './content-path.ts';
import { recordContributor } from './contributor-tracker.ts';
import { applyDiskContentToDoc, FILE_WATCHER_ORIGIN } from './disk-content-intake.ts';
import type { DocumentDurabilityState } from './document-durability-state.ts';
import { takeExternalChangeAttribution } from './external-change-attribution.ts';
import { recordFrontmatterEditSurface } from './frontmatter-telemetry.ts';
import { canonicalContentPathIsRefused } from './fs-safety.ts';
import { getLogger } from './logger.ts';
import type { MergeHistoryRecorder } from './merge-history.ts';
import {
  incrementExternalChangeHandlerErrors,
  incrementReconcileBothKept,
  incrementReconcileCheckFailed,
  incrementReconcileInFlightFallthroughs,
  incrementReconcileInsertDedupSkipped,
  incrementReconcileKeptLive,
  incrementReconcileOwnFlushSkips,
} from './metrics.ts';
import {
  countKeptBlocks,
  type KeptBlockCounts,
  type KeptBlockPair,
  type ReconcileOutcome,
  type ReconcileRefusalReason,
  reconcile,
} from './reconciliation.ts';
import { FILE_SYSTEM_WRITER } from './shadow-repo.ts';

export { FILE_WATCHER_ORIGIN } from './disk-content-intake.ts';

export function redactedErrorSummary(err: unknown): unknown {
  const verbose = process.env.OK_TELEMETRY_VERBOSE === '1';
  if (err instanceof BridgeMergeContentLossError) return err.toLog({ verbose });
  if (err instanceof BridgeInvariantViolationError) {
    return toBridgeInvariantLog(err.violation, { verbose });
  }
  return err instanceof Error ? err.message : String(err);
}

export function applyExternalChange(
  durabilityState: DocumentDurabilityState,
  hocuspocus: Hocuspocus,
  docName: string,
  content: string,
  resolveEmbed?: (basename: string, sourcePath: string) => string | null,
  resolveSize?: (basename: string, sourcePath: string) => number | null,
  bridgeLossReporter?: BridgeDeriveLossReporter,
  precomputed?: PrecomputedParse,
): void {
  if (
    isSystemDoc(docName) ||
    isConfigDoc(docName) ||
    isMermaidDoc(docName) ||
    isExcalidrawDoc(docName) ||
    isEditableTextDoc(docName)
  )
    return;
  const document = hocuspocus.documents.get(docName);
  if (!document) return;

  const currentSource = document.getText('source').toString();
  const bytesUnchanged = currentSource === content;

  const priorFm = stripFrontmatter(currentSource).frontmatter;
  const { frontmatter: nextFm } = stripFrontmatter(content);

  const detect: DeriveLossDetectOptions | undefined =
    bridgeLossReporter && shouldRunPairedIntakeDetection(FILE_WATCHER_ORIGIN.context.origin)
      ? {
          report: (obs) =>
            bridgeLossReporter(
              docName,
              obs,
              FILE_SYSTEM_WRITER.id,
              DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE,
            ),
          baselineFullMd: currentSource,
        }
      : undefined;

  try {
    document.transact(() => {
      applyDiskContentToDoc(
        document,
        content,
        resolveEmbed,
        docName,
        resolveSize,
        detect,
        precomputed,
      );
    }, FILE_WATCHER_ORIGIN);
  } catch (err) {
    try {
      durabilityState.setReconciledBase(docName, document.getText('source').toString());
    } catch (recoveryError) {
      getLogger('reconcile').error(
        { err: recoveryError, originalError: redactedErrorSummary(err), docName },
        'Unable to persist the reconciled base after an external-change failure',
      );
    }
    throw err;
  }

  if (priorFm !== nextFm) {
    recordFrontmatterEditSurface('file-watcher');
  }

  if (!bytesUnchanged) {
    const claimed = takeExternalChangeAttribution(docName);
    const writer = claimed ?? {
      writerId: FILE_SYSTEM_WRITER.id,
      displayName: FILE_SYSTEM_WRITER.name,
      colorSeed: FILE_SYSTEM_WRITER.id,
    };
    recordContributor(
      docName,
      writer.writerId,
      writer.displayName,
      writer.colorSeed,
      formatReconcileSubject(docName),
    );
  }

  durabilityState.setReconciledBase(docName, content);
}

export type FrozenResidentRevival = 'not-frozen' | 'revived' | 'failed';

export function reviveFrozenResidentDoc(
  durabilityState: DocumentDurabilityState,
  hocuspocus: Hocuspocus,
  docName: string,
  content: string,
  resolveEmbed?: (basename: string, sourcePath: string) => string | null,
  resolveSize?: (basename: string, sourcePath: string) => number | null,
  bridgeLossReporter?: BridgeDeriveLossReporter,
): FrozenResidentRevival {
  if (isPersistenceExcludedDoc(docName)) return 'not-frozen';
  const resident = hocuspocus.documents.get(docName);
  if (!resident) return 'not-frozen';
  const lifecycle = resident.getMap('lifecycle');
  const status = lifecycle.get('status');
  if (!isRemovalLifecycleStatus(status)) return 'not-frozen';
  const replacedInMemoryContent = resident.getText('source').toString() !== content;
  try {
    applyExternalChange(
      durabilityState,
      hocuspocus,
      docName,
      content,
      resolveEmbed,
      resolveSize,
      bridgeLossReporter,
    );
  } catch (err) {
    getLogger('reconcile').error(
      { err: redactedErrorSummary(err), docName, status },
      `[reconcile] could not revive ${docName}: it stays ${status} and keeps refusing stores until the server reloads it`,
    );
    return 'failed';
  }
  lifecycle.delete('status');
  lifecycle.delete('newPath');
  durabilityState.endRenameCarry(docName);
  getLogger('reconcile').info(
    { docName, status, replacedInMemoryContent },
    `[reconcile] revived ${docName}: its name is occupied on disk again, so the ${status} freeze no longer applies`,
  );
  return 'revived';
}

export function createExternalChangeHandler(
  durabilityState: DocumentDurabilityState,
  hocuspocus: Hocuspocus,
  resolveEmbed?: (basename: string, sourcePath: string) => string | null,
  resolveSize?: (basename: string, sourcePath: string) => number | null,
  bridgeLossReporter?: BridgeDeriveLossReporter,
): (docName: string, content: string) => Promise<void> {
  return async (docName: string, content: string): Promise<void> => {
    try {
      applyExternalChange(
        durabilityState,
        hocuspocus,
        docName,
        content,
        resolveEmbed,
        resolveSize,
        bridgeLossReporter,
      );
      getLogger('file-watcher').info({ docName }, 'applied external change');
    } catch (err) {
      if (
        err instanceof BridgeInvariantViolationError ||
        err instanceof BridgeMergeContentLossError
      ) {
        throw err;
      }
      incrementExternalChangeHandlerErrors();
      getLogger('file-watcher').error(
        { docName, err },
        `Failed to apply external change for ${docName}`,
      );
    }
  };
}

const STALE_EXTERNAL_WRITE_REASON = 'stale-external-write';

function clearStaleExternalWriteConflict(
  durabilityState: DocumentDurabilityState,
  document: Y.Doc | undefined,
  docName: string,
  conflicts?: Pick<ConflictAuthority, 'dissolveReconcile'>,
): void {
  const retained = durabilityState.getStaleExternalWrite(docName)?.retainedContent;
  if (retained !== undefined && retained !== durabilityState.getReconciledBase(docName)) return;
  durabilityState.clearStaleExternalWrite(docName);
  conflicts?.dissolveReconcile(docName, STALE_EXTERNAL_WRITE_REASON);
  const lifecycleMap = document?.getMap('lifecycle');
  if (lifecycleMap?.get('reason') !== STALE_EXTERNAL_WRITE_REASON) return;
  lifecycleMap.delete('status');
  lifecycleMap.delete('reason');
  lifecycleMap.delete('detectedAt');
}

type ReconcileCheckSite =
  | 'watcher'
  | 'agent-write'
  | 'branch-switch'
  | 'skill-store'
  | 'skill-intake';

export function reportReconcileCheckFailed(
  docName: string,
  outcome: ReconcileOutcome,
  site: ReconcileCheckSite,
): void {
  if (outcome.kind !== 'refused' || outcome.reason !== 'check-failed') return;
  incrementReconcileCheckFailed();
  getLogger('reconcile').warn(
    { docName, site, failure: outcome.failure },
    `[reconcile] ${site} ${docName} merge output failed the fidelity check (${outcome.failure.check})`,
  );
}

export function reportReconcileBothKept(
  docName: string,
  kept: readonly KeptBlockPair[],
  site: ReconcileCheckSite,
): void {
  const counts = countKeptBlocks(kept);
  incrementReconcileBothKept(counts.duplicated);
  getLogger('reconcile').info(
    { docName, site, ...counts },
    `[reconcile] ${site} ${docName} kept both versions of ${counts.duplicated} block(s), restored ${counts.restoredDeletedHere} block(s) deleted here and ${counts.restoredDeletedOutside} block(s) deleted outside`,
  );
}

export function reportReconcileKeptLive(
  docName: string,
  reason: Extract<ParsedCheckpoint, { kind: 'external-change-kept-live' }>['metadata']['reason'],
  site: ReconcileCheckSite,
): void {
  incrementReconcileKeptLive();
  getLogger('reconcile').warn(
    { docName, site, reason },
    `[reconcile] ${site} ${docName} could not be merged (${reason}); the live version stays and the other version was saved to history`,
  );
}

export function wireReasonForRefusal(reason: ReconcileRefusalReason): ReconcileReason {
  switch (reason) {
    case 'conflict-markers':
      return 'refused-conflict-markers';
    case 'no-base':
      return 'refused-no-base';
    case 'too-large':
    case 'check-failed':
      return 'refused-too-large';
    default: {
      const unhandled: never = reason;
      throw new Error(`unhandled reconcile refusal reason: ${String(unhandled)}`);
    }
  }
}

export function refuseStaleExternalWrite(
  durabilityState: DocumentDurabilityState,
  document: Y.Doc | undefined,
  docName: string,
  diskContent: string,
  conflicts?: Pick<ConflictAuthority, 'dissolveReconcile' | 'fileOf' | 'raise'>,
  retainedContent?: string,
): boolean {
  const currentBase = durabilityState.getReconciledBase(docName);
  const pending = durabilityState.getStaleExternalWrite(docName);
  const raise = (disk: string, retained: string | undefined): void => {
    const conflict = durabilityState.recordStaleExternalWrite(docName, disk, retained);
    if (conflicts) {
      conflicts.raise({
        kind: 'reconcile',
        file: conflicts.fileOf(docName),
        reason: STALE_EXTERNAL_WRITE_REASON,
        detectedAt: conflict.detectedAt,
        stages: {
          base: currentBase ?? disk,
          ours:
            conflict.retainedContent ??
            (document === undefined ? (currentBase ?? disk) : serializeYDocSource(document)),
          theirs: conflict.diskContent,
        },
      });
    }
  };
  if (pending?.retainedContent !== undefined && pending.retainedContent !== currentBase) {
    raise(diskContent, retainedContent ?? pending.retainedContent);
    return true;
  }
  if (currentBase === diskContent) {
    clearStaleExternalWriteConflict(durabilityState, document, docName, conflicts);
    return false;
  }

  if (durabilityState.staleExternalWriteMatches(docName, diskContent)) {
    raise(diskContent, retainedContent ?? pending?.retainedContent);
    return true;
  }

  if (!durabilityState.isDisplacedVersion(docName, diskContent)) {
    clearStaleExternalWriteConflict(durabilityState, document, docName, conflicts);
    return false;
  }

  getLogger('reconcile').warn(
    { docName, diskBytes: diskContent.length },
    `[reconcile] refused stale external write for ${docName}; disk restores a version this server already displaced`,
  );
  raise(diskContent, retainedContent);
  return true;
}

export interface ReconcileBeforeWriteResult {
  reconciled: boolean;
  baseBytes: number;
  diskBytes: number;
  mergeOutcome?: ReconcileMergeOutcome;
  keptBlocks?: KeptBlockCounts;
}

const RE_READ = 'Re-read the document (e.g. `exec("cat <path>")`)';

function blocks(count: number): string {
  return count === 1 ? '1 block' : `${count} blocks`;
}

function bothKeptHint(counts: KeptBlockCounts): string {
  const sentences: string[] = [];
  if (counts.duplicated > 0) {
    sentences.push(
      `An out-of-band edit changed ${blocks(counts.duplicated)} also edited here, so both versions were kept: the version here first, the out-of-band version directly under it.`,
    );
  }
  if (counts.restoredDeletedHere > 0) {
    sentences.push(
      `The deletion here of ${blocks(counts.restoredDeletedHere)} was undone because the out-of-band edit changed ${counts.restoredDeletedHere === 1 ? 'it' : 'them'}: the out-of-band version was restored.`,
    );
  }
  if (counts.restoredDeletedOutside > 0) {
    sentences.push(
      `The out-of-band deletion of ${blocks(counts.restoredDeletedOutside)} edited here was undone: the version here was kept.`,
    );
  }
  sentences.push('Your write landed; do not retry it.');
  const tidy = [
    ...(counts.duplicated > 0 ? ['remove the duplicate'] : []),
    ...(counts.restoredDeletedHere > 0 ? ['delete the restored block again'] : []),
  ];
  sentences.push(
    tidy.length > 0
      ? `${RE_READ} and, if your task calls for it, ${tidy.join(' or ')} with an ordinary edit.`
      : `${RE_READ} before continuing.`,
  );
  return sentences.join(' ');
}

function reconcileWarningHint(reconcile: ReconcileBeforeWriteResult): string {
  const outcome = reconcile.mergeOutcome;
  switch (outcome) {
    case 'merged':
      return 'An out-of-band edit was three-way merged into this document before your edit was applied on top; the merge may have interleaved content blocks. Re-read it (e.g. `exec("cat <path>")`) and review the combined result carefully before continuing.';
    case 'both-kept':
      return bothKeptHint(
        reconcile.keptBlocks ?? {
          duplicated: 1,
          restoredDeletedHere: 0,
          restoredDeletedOutside: 0,
        },
      );
    case 'kept-live':
      return 'An out-of-band edit to this file could not be merged safely, so the version here was kept and the out-of-band version was saved to the history of this document. Your write landed; do not retry it. Re-read the document (e.g. `exec("cat <path>")`) before continuing.';
    case 'clean':
    case undefined:
      return 'An out-of-band edit was reconciled into this document before your edit was applied on top; the document now reflects that edit plus yours. Re-read it (e.g. `exec("cat <path>")`) to see the combined result before continuing.';
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled merge outcome: ${String(unhandled)}`);
    }
  }
}

export function buildReconcileWarning(
  reconcile: ReconcileBeforeWriteResult,
): DiskEditReconciledWarning | undefined {
  if (!reconcile.reconciled) return undefined;
  const asksReRead =
    reconcile.mergeOutcome === 'both-kept' || reconcile.mergeOutcome === 'kept-live';
  return {
    kind: 'disk-edit-reconciled',
    intendedBytes: reconcile.baseBytes,
    actualBytes: reconcile.diskBytes,
    byteDelta: reconcile.diskBytes - reconcile.baseBytes,
    ...(reconcile.mergeOutcome ? { mergeOutcome: reconcile.mergeOutcome } : {}),
    ...(reconcile.keptBlocks === undefined
      ? {}
      : {
          duplicatedBlocks: reconcile.keptBlocks.duplicated,
          restoredDeletedHere: reconcile.keptBlocks.restoredDeletedHere,
          restoredDeletedOutside: reconcile.keptBlocks.restoredDeletedOutside,
        }),
    ...(asksReRead ? { nextStep: 're-read' as const } : {}),
    hint: reconcileWarningHint(reconcile),
  };
}

export const NOT_RECONCILED: ReconcileBeforeWriteResult = {
  reconciled: false,
  baseBytes: 0,
  diskBytes: 0,
};

export function serializeYDocSource(document: {
  getText(name: string): { toString(): string };
}): string {
  const ytextSnapshot = document.getText('source').toString();
  const { frontmatter, body } = stripFrontmatter(ytextSnapshot);
  return prependFrontmatter(frontmatter, body);
}

export async function reconcileDiskBeforeAgentWrite(
  durabilityState: DocumentDurabilityState,
  hocuspocus: Hocuspocus,
  docName: string,
  contentDir: string,
  resolveEmbed: ((basename: string, sourcePath: string) => string | null) | undefined,
  bridgeLossReporter: BridgeDeriveLossReporter | undefined,
  conflicts: Pick<ConflictAuthority, 'dissolveReconcile' | 'fileOf' | 'raise'>,
  history: MergeHistoryRecorder,
): Promise<ReconcileBeforeWriteResult> {
  if (
    isSystemDoc(docName) ||
    isConfigDoc(docName) ||
    isMermaidDoc(docName) ||
    isExcalidrawDoc(docName) ||
    isEditableTextDoc(docName)
  )
    return NOT_RECONCILED;

  const document = hocuspocus.documents.get(docName);
  if (
    document &&
    isDocInConflict(document) &&
    document.getMap('lifecycle').get('reason') !== STALE_EXTERNAL_WRITE_REASON
  ) {
    return NOT_RECONCILED;
  }

  const base = durabilityState.getReconciledBase(docName);
  if (base === undefined) return NOT_RECONCILED;

  let requestedPath: string;
  let canonical: string;
  try {
    requestedPath = safeContentPath(docName, contentDir);
    if (!existsSync(requestedPath)) return NOT_RECONCILED;
    canonical = realpathSync(requestedPath);
  } catch {
    return NOT_RECONCILED;
  }

  if (canonicalContentPathIsRefused(requestedPath, canonical, contentDir)) {
    getLogger('reconcile').warn(
      { docName, canonical, contentDir },
      `[reconcile] symlink-escape on disk read for ${docName}; skipping reconcile`,
    );
    return NOT_RECONCILED;
  }

  let diskContent: string;
  try {
    diskContent = readFileSync(canonical, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      getLogger('reconcile').warn(
        { docName, canonical, code },
        `[reconcile] disk read failed for ${docName} (${code ?? 'unknown'}); skipping reconcile`,
      );
    }
    return NOT_RECONCILED;
  }

  const normalizedDisk = normalizeBridge(diskContent);
  if (diskContent === base) {
    clearStaleExternalWriteConflict(durabilityState, document, docName, conflicts);
    return NOT_RECONCILED;
  }

  const pendingFlushes = durabilityState.inFlightFlushCount(docName);
  if (pendingFlushes > 0) {
    if (durabilityState.hasInFlightFlush(docName, normalizedDisk)) {
      incrementReconcileOwnFlushSkips();
      getLogger('reconcile').debug(
        { docName, diskBytes: diskContent.length, pendingFlushes },
        `[reconcile] disk matches own in-flight flush for ${docName}; skipping reconcile`,
      );
      return NOT_RECONCILED;
    }
    incrementReconcileInFlightFallthroughs();
    getLogger('reconcile').warn(
      { docName, diskBytes: diskContent.length, pendingFlushes },
      `[reconcile] disk matches none of ${pendingFlushes} in-flight flush snapshot(s) for ${docName}; falling through to merge`,
    );
  }

  if (!document) return NOT_RECONCILED;

  if (refuseStaleExternalWrite(durabilityState, document, docName, diskContent, conflicts)) {
    return NOT_RECONCILED;
  }
  if (normalizedDisk === normalizeBridge(base)) return NOT_RECONCILED;

  const ours = serializeYDocSource(document);

  const outcome = reconcile({ docName, base, ours, theirs: diskContent });
  getLogger('reconcile').info(
    { docName, result: outcome.kind, baseBytes: base.length, diskBytes: diskContent.length },
    `[reconcile] before-agent-write ${docName} result=${outcome.kind}`,
  );

  const reconciledResult = (
    mergeOutcome: ReconcileMergeOutcome,
    keptBlocks?: KeptBlockCounts,
  ): ReconcileBeforeWriteResult => ({
    reconciled: true,
    baseBytes: Buffer.byteLength(base, 'utf8'),
    diskBytes: Buffer.byteLength(diskContent, 'utf8'),
    mergeOutcome,
    ...(keptBlocks === undefined ? {} : { keptBlocks }),
  });

  switch (outcome.kind) {
    case 'noop':
      return NOT_RECONCILED;

    case 'refused': {
      reportReconcileCheckFailed(docName, outcome, 'agent-write');
      if (outcome.reason === 'check-failed' || outcome.reason === 'too-large') {
        if (
          await history.keptLive(docName, { side: 'theirs', bytes: diskContent }, outcome.reason)
        ) {
          durabilityState.setReconciledBase(docName, diskContent);
          reportReconcileKeptLive(docName, outcome.reason, 'agent-write');
          return reconciledResult('kept-live');
        }
      }
      conflicts.raise({
        kind: 'reconcile',
        file: conflicts.fileOf(docName),
        reason: wireReasonForRefusal(outcome.reason),
        stages: { base, ours, theirs: diskContent },
      });
      return NOT_RECONCILED;
    }

    case 'clean':
    case 'merged':
    case 'both-kept': {
      const ingest = outcome.kind === 'clean' ? diskContent : outcome.newContent;
      if (outcome.kind !== 'clean' && outcome.dedupSkipped) {
        incrementReconcileInsertDedupSkipped();
        getLogger('reconcile').warn(
          { docName },
          `[reconcile] ${docName} insert-group dedup skipped (LCS cell cap); union emitted with possible same-block duplication`,
        );
      }
      applyExternalChange(
        durabilityState,
        hocuspocus,
        docName,
        ingest,
        resolveEmbed,
        undefined,
        bridgeLossReporter,
      );
      if (outcome.kind !== 'clean') {
        durabilityState.setReconciledBase(docName, diskContent);
      }
      if (outcome.kind !== 'both-kept') return reconciledResult(outcome.kind);
      const keptBlocks = countKeptBlocks(outcome.kept);
      history.bothKept(docName, { ours, theirs: diskContent }, outcome.kept);
      reportReconcileBothKept(docName, outcome.kept, 'agent-write');
      return reconciledResult('both-kept', keptBlocks);
    }
  }
}
