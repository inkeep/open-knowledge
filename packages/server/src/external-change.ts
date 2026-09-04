import { existsSync, readFileSync, realpathSync } from 'node:fs';
import type { Hocuspocus } from '@hocuspocus/server';
import {
  BridgeInvariantViolationError,
  BridgeMergeContentLossError,
  normalizeBridge,
  prependFrontmatter,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { formatReconcileSubject } from '@inkeep/open-knowledge-core/shadow-repo-layout';
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
  isSystemDoc,
} from './cc1-broadcast.ts';
import { isDocInConflict } from './conflict-errors.ts';
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

/**
 * Apply external file content to a live Y.Doc — the throwing core of the
 * disk→CRDT bridge. Both server-factory.ts (CLI) and the dev plugin delegate here.
 *
 * Under the Y.Text-is-truth contract (precedent #38):
 *   1. Looks up the live Y.Doc by docName (no-op if missing; system + config
 *      docs short-circuit)
 *   2. Captures the prior FM region from `Y.Text('source')` for the
 *      edit-surface telemetry counter (FM lives in the YAML region of
 *      Y.Text — no Y.Map metadata cache)
 *   3. Routes through `composeAndWriteRawBody` inside
 *      `document.transact(..., FILE_WATCHER_ORIGIN)`: Y.Text receives the
 *      disk bytes verbatim via `applyFastDiff`; XmlFragment derives via
 *      `parse(body) → updateYFragment` (the post-write watchdog asserts
 *      the bridge invariant)
 *   4. Emits the FM-change telemetry counter when the captured FM
 *      differs from the disk content's FM
 *   5. Records the file-system contributor and advances reconciledBase to
 *      the raw disk bytes
 *
 * `FILE_WATCHER_ORIGIN` carries `context.paired: true` and
 * `skipStoreHooks: true` — the paired marker opts the bridge observers'
 * paired-write fast-paths in; skipStoreHooks prevents persistence feedback
 * loops.
 *
 * Throws on parse failure — callers choose their own error strategy.
 * `BridgeInvariantViolationError` re-throws past every soft-recovery layer
 * so dev/test surfaces regressions loudly.
 */
export function applyExternalChange(
  durabilityState: DocumentDurabilityState,
  hocuspocus: Hocuspocus,
  docName: string,
  content: string,
  resolveEmbed?: (basename: string, sourcePath: string) => string | null,
  resolveSize?: (basename: string, sourcePath: string) => number | null,
  bridgeLossReporter?: BridgeDeriveLossReporter,
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
      applyDiskContentToDoc(document, content, resolveEmbed, docName, resolveSize, detect);
    }, FILE_WATCHER_ORIGIN);
  } catch (err) {
    durabilityState.setReconciledBase(docName, document.getText('source').toString());
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
  resolveEmbed?: (basename: string, sourcePath: string) => string | null,
  bridgeLossReporter?: BridgeDeriveLossReporter,
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
  if (document && isDocInConflict(document)) return NOT_RECONCILED;

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
  if (normalizedDisk === normalizeBridge(base)) return NOT_RECONCILED;

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
      const lifecycleMap = document.getMap('lifecycle');
      lifecycleMap.set('status', 'conflict');
      lifecycleMap.set(
        'reason',
        outcome.kind === 'refused' ? outcome.reason : 'reconcile-conflicts',
      );
      return NOT_RECONCILED;
    }

    case 'clean':
    case 'merged': {
      const ingest = outcome.kind === 'clean' ? diskContent : outcome.newContent;
      applyExternalChange(
        durabilityState,
        hocuspocus,
        docName,
        ingest,
        resolveEmbed,
        undefined,
        bridgeLossReporter,
      );
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
