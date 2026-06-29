
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
import type * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import { isDocInConflict } from './conflict-errors.ts';
import { recordContributor } from './contributor-tracker.ts';
import { recordFrontmatterEditSurface } from './frontmatter-telemetry.ts';
import { getLogger } from './logger.ts';
import {
  incrementExternalChangeHandlerErrors,
  incrementReconcileInFlightFallthroughs,
  incrementReconcileOwnFlushSkips,
} from './metrics.ts';
import {
  getReconciledBase,
  isWithinContentDir,
  peekInFlightFlush,
  safeContentPath,
  setReconciledBase,
} from './persistence.ts';
import { reconcile } from './reconciliation.ts';
import type { PairedWriteOrigin } from './server-observers.ts';
import { FILE_SYSTEM_WRITER } from './shadow-repo.ts';

export const FILE_WATCHER_ORIGIN = {
  source: 'local',
  skipStoreHooks: true,
  context: { origin: 'file-watcher', paired: true },
} as const satisfies PairedWriteOrigin;

export function applyDiskContentToDoc(
  document: Y.Doc,
  content: string,
  resolveEmbed?: (basename: string, sourcePath: string) => string | null,
  sourcePath?: string,
  resolveSize?: (basename: string, sourcePath: string) => number | null,
): void {
  const embedResolver =
    resolveEmbed && sourcePath ? { resolveEmbed, resolveSize, sourcePath } : undefined;
  composeAndWriteRawBody(document, content, 'file-watcher', embedResolver);
}

export function applyExternalChange(
  hocuspocus: Hocuspocus,
  docName: string,
  content: string,
  resolveEmbed?: (basename: string, sourcePath: string) => string | null,
  resolveSize?: (basename: string, sourcePath: string) => number | null,
): void {
  if (isSystemDoc(docName) || isConfigDoc(docName)) return;
  const document = hocuspocus.documents.get(docName);
  if (!document) return;

  const priorFm = stripFrontmatter(document.getText('source').toString()).frontmatter;
  const { frontmatter: nextFm } = stripFrontmatter(content);

  try {
    document.transact(() => {
      applyDiskContentToDoc(document, content, resolveEmbed, docName, resolveSize);
    }, FILE_WATCHER_ORIGIN);
  } catch (err) {
    setReconciledBase(docName, document.getText('source').toString());
    throw err;
  }

  if (priorFm !== nextFm) {
    recordFrontmatterEditSurface('file-watcher');
  }

  recordContributor(
    docName,
    FILE_SYSTEM_WRITER.id,
    FILE_SYSTEM_WRITER.name,
    FILE_SYSTEM_WRITER.id,
    formatReconcileSubject(docName),
  );

  setReconciledBase(docName, content);
}

export function createExternalChangeHandler(
  hocuspocus: Hocuspocus,
  resolveEmbed?: (basename: string, sourcePath: string) => string | null,
  resolveSize?: (basename: string, sourcePath: string) => number | null,
): (docName: string, content: string) => Promise<void> {
  return async (docName: string, content: string): Promise<void> => {
    try {
      applyExternalChange(hocuspocus, docName, content, resolveEmbed, resolveSize);
      getLogger('file-watcher').info({ docName }, 'applied external change');
    } catch (err) {
      if (
        err instanceof BridgeInvariantViolationError ||
        err instanceof BridgeMergeContentLossError
      ) {
        throw err;
      }
      incrementExternalChangeHandlerErrors();
      console.error(`[file-watcher] Failed to apply external change for ${docName}:`, err);
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
  hocuspocus: Hocuspocus,
  docName: string,
  contentDir: string,
  resolveEmbed?: (basename: string, sourcePath: string) => string | null,
): ReconcileBeforeWriteResult {
  if (isSystemDoc(docName) || isConfigDoc(docName)) return NOT_RECONCILED;

  const document = hocuspocus.documents.get(docName);
  if (document && isDocInConflict(document)) return NOT_RECONCILED;

  const base = getReconciledBase(docName);
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

  if (normalizeBridge(diskContent) === normalizeBridge(base)) return NOT_RECONCILED;

  const inFlightFlush = peekInFlightFlush(docName);
  if (inFlightFlush !== undefined) {
    if (normalizeBridge(diskContent) === inFlightFlush) {
      incrementReconcileOwnFlushSkips();
      getLogger('reconcile').debug(
        { docName, diskBytes: diskContent.length },
        `[reconcile] disk matches own in-flight flush for ${docName}; skipping reconcile`,
      );
      return NOT_RECONCILED;
    }
    incrementReconcileInFlightFallthroughs();
    getLogger('reconcile').warn(
      { docName, diskBytes: diskContent.length },
      `[reconcile] in-flight flush present but disk differs from snapshot for ${docName}; falling through to merge`,
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
      applyExternalChange(hocuspocus, docName, ingest, resolveEmbed);
      if (outcome.kind === 'merged') {
        setReconciledBase(docName, diskContent);
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
