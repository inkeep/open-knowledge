import { existsSync, readFileSync, realpathSync } from 'node:fs';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  BridgeInvariantViolationError,
  BridgeMergeContentLossError,
  normalizeBridge,
  prependFrontmatter,
  stripFrontmatter,
  toBridgeInvariantLog,
} from '@inkeep/open-knowledge-core';
import { formatReconcileSubject } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type * as Y from 'yjs';
import {
  isConfigDoc,
  isEditableTextDoc,
  isExcalidrawDoc,
  isMermaidDoc,
  isSystemDoc,
} from './cc1-broadcast.ts';
import { type ConflictAuthority, isDocInConflict } from './conflict-authority.ts';
import { isWithinContentDir, safeContentPath } from './content-path.ts';
import { recordContributor } from './contributor-tracker.ts';
import { applyDiskContentToDoc, FILE_WATCHER_ORIGIN } from './disk-content-intake.ts';
import type { DocumentDurabilityState } from './document-durability-state.ts';
import { takeExternalChangeAttribution } from './external-change-attribution.ts';
import { recordFrontmatterEditSurface } from './frontmatter-telemetry.ts';
import { getLogger } from './logger.ts';
import {
  incrementExternalChangeHandlerErrors,
  incrementReconcileInFlightFallthroughs,
  incrementReconcileOwnFlushSkips,
} from './metrics.ts';
import { reconcile } from './reconciliation.ts';
import { FILE_SYSTEM_WRITER } from './shadow-repo.ts';

export { FILE_WATCHER_ORIGIN } from './disk-content-intake.ts';

function redactedErrorSummary(err: unknown): unknown {
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

  try {
    document.transact(() => {
      applyDiskContentToDoc(document, content);
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

export function createExternalChangeHandler(
  durabilityState: DocumentDurabilityState,
  hocuspocus: Hocuspocus,
): (docName: string, content: string) => Promise<void> {
  return async (docName: string, content: string): Promise<void> => {
    try {
      applyExternalChange(durabilityState, hocuspocus, docName, content);
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
  mergeOutcome?: 'clean' | 'merged';
}

const NOT_RECONCILED: ReconcileBeforeWriteResult = {
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

export function reconcileDiskBeforeAgentWrite(
  durabilityState: DocumentDurabilityState,
  hocuspocus: Hocuspocus,
  docName: string,
  contentDir: string,
  conflicts: Pick<ConflictAuthority, 'dissolveReconcile' | 'fileOf' | 'raise'>,
): ReconcileBeforeWriteResult {
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

  let canonical: string;
  try {
    const requestedPath = safeContentPath(docName, contentDir);
    if (!existsSync(requestedPath)) return NOT_RECONCILED;
    canonical = realpathSync(requestedPath);
  } catch {
    return NOT_RECONCILED;
  }

  if (!isWithinContentDir(canonical, contentDir)) {
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

  switch (outcome.kind) {
    case 'noop':
      return NOT_RECONCILED;

    case 'conflicts':
    case 'refused': {
      conflicts.raise({
        kind: 'reconcile',
        file: conflicts.fileOf(docName),
        reason:
          outcome.kind === 'conflicts'
            ? 'merged-with-markers'
            : outcome.reason === 'too-large'
              ? 'refused-too-large'
              : 'refused-conflict-markers',
        stages: { base, ours, theirs: diskContent },
      });
      return NOT_RECONCILED;
    }

    case 'clean':
    case 'merged': {
      const ingest = outcome.kind === 'clean' ? diskContent : outcome.newContent;
      applyExternalChange(durabilityState, hocuspocus, docName, ingest);
      if (outcome.kind === 'merged') {
        durabilityState.setReconciledBase(docName, diskContent);
      }
      return {
        reconciled: true,
        baseBytes: Buffer.byteLength(base, 'utf8'),
        diskBytes: Buffer.byteLength(diskContent, 'utf8'),
        mergeOutcome: outcome.kind,
      };
    }
  }
}
